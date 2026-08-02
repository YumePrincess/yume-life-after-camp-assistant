import AppKit
import ApplicationServices
import Foundation

private struct HelperResult: Encodable {
    let processId: Int32
    let keyCode: Int
    let bringToFront: Bool
    let mouseReleased: Bool
    let mouseButtonsReleasedBefore: Bool
    let mouseButtonsReleasedAfter: Bool
    let skippedBecauseAlreadyReleased: Bool
}

private struct PermissionResult: Encodable {
    let permissionGranted: Bool
}

private struct HelperErrorResult: Encodable {
    let error: String
}

private enum HelperFailure: Error, CustomStringConvertible {
    case invalidArguments(String)
    case accessibilityDenied(String)
    case eventCreationFailed

    var description: String {
        switch self {
        case .invalidArguments(let message):
            return "YLA_HOST_INPUT_INVALID_ARGUMENTS: \(message)"
        case .accessibilityDenied(let message):
            return "YLA_HOST_INPUT_PERMISSION_DENIED: \(message)"
        case .eventCreationFailed:
            return "YLA_HOST_INPUT_EVENT_FAILED: macOS could not create the keyboard event"
        }
    }
}

private func argument(_ name: String, in arguments: [String]) -> String? {
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else {
        return nil
    }
    return arguments[index + 1]
}

private func boundedDelay(_ milliseconds: Int) -> Double {
    Double(max(100, min(10_000, milliseconds))) / 1_000
}

private func mouseButtonsReleased() -> Bool {
    let source = CGEventSourceStateID.combinedSessionState
    return !CGEventSource.buttonState(source, button: .left)
        && !CGEventSource.buttonState(source, button: .right)
        && !CGEventSource.buttonState(source, button: .center)
}

private func waitForPostEventPermission(timeoutMilliseconds: Int) -> Bool {
    if CGPreflightPostEventAccess() { return true }
    _ = CGRequestPostEventAccess()
    openAccessibilitySettings()
    let deadline = Date().addingTimeInterval(Double(timeoutMilliseconds) / 1_000)
    while Date() < deadline {
        if CGPreflightPostEventAccess() { return true }
        Thread.sleep(forTimeInterval: 0.5)
    }
    return CGPreflightPostEventAccess()
}

private let launchArguments = Array(CommandLine.arguments.dropFirst())

private func resultURL(in arguments: [String]) -> URL? {
    guard let resultPath = argument("--result-path", in: arguments) else { return nil }
    let url = URL(fileURLWithPath: resultPath).standardizedFileURL
    guard
        url.deletingLastPathComponent().path == "/private/tmp",
        url.lastPathComponent.hasPrefix("yume-life-after-input-"),
        url.pathExtension == "json"
    else { return nil }
    return url
}

private func emit<T: Encodable>(_ value: T, arguments: [String]) throws {
    let data = try JSONEncoder().encode(value)
    if let url = resultURL(in: arguments) {
        try data.write(to: url, options: .atomic)
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

private func openAccessibilitySettings() {
    guard let url = URL(
        string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
    ) else { return }
    let opener = Process()
    opener.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    opener.arguments = [url.absoluteString]
    try? opener.run()
    opener.waitUntilExit()
}

do {
    let arguments = launchArguments
    let permissionTimeoutMilliseconds = max(
        5_000,
        min(170_000, Int(argument("--permission-timeout-ms", in: arguments) ?? "120000") ?? 120_000)
    )
    if arguments.contains("--preflight-only") {
        try emit(
            PermissionResult(permissionGranted: CGPreflightPostEventAccess()),
            arguments: arguments
        )
        exit(0)
    }
    if arguments.contains("--request-permission-only") {
        guard waitForPostEventPermission(timeoutMilliseconds: permissionTimeoutMilliseconds) else {
            throw HelperFailure.accessibilityDenied(
                "Enable ‘Yume Life After Mac Agent Input Helper’ in System Settings > Privacy & Security > Accessibility."
            )
        }
        try emit(PermissionResult(permissionGranted: true), arguments: arguments)
        exit(0)
    }
    guard let pidText = argument("--pid", in: arguments),
          let processId = Int32(pidText),
          processId > 0
    else {
        throw HelperFailure.invalidArguments("--pid must be a positive process identifier")
    }
    let keyCode = max(0, min(255, Int(argument("--key-code", in: arguments) ?? "50") ?? 50))
    let foregroundDelay = boundedDelay(Int(argument("--foreground-settle-ms", in: arguments) ?? "4000") ?? 4000)
    let postKeyDelay = boundedDelay(Int(argument("--post-key-settle-ms", in: arguments) ?? "4000") ?? 4000)
    let bringToFront = argument("--bring-to-front", in: arguments) != "false"

    guard waitForPostEventPermission(timeoutMilliseconds: permissionTimeoutMilliseconds) else {
        throw HelperFailure.accessibilityDenied(
            "Enable ‘Yume Life After Mac Agent Input Helper’ in System Settings > Privacy & Security > Accessibility. Permission granted only to the main App does not authorize the helper's separate keyboard-event permission."
        )
    }
    if bringToFront {
        guard let target = NSRunningApplication(processIdentifier: processId) else {
            throw HelperFailure.invalidArguments("MuMu process \(processId) is no longer running")
        }
        _ = target.activate(options: [.activateAllWindows])
        Thread.sleep(forTimeInterval: foregroundDelay)
    }

    // Foreground activation must happen before this check. MuMu's private
    // cursor capture is meaningful only while its Android container owns the
    // active window; never send `~` when the already-foreground container is
    // demonstrably released, because `~` is a toggle and would recapture it.
    let releasedBefore = mouseButtonsReleased()
    if releasedBefore {
        try emit(
            HelperResult(
                processId: processId,
                keyCode: keyCode,
                bringToFront: bringToFront,
                mouseReleased: true,
                mouseButtonsReleasedBefore: true,
                mouseButtonsReleasedAfter: true,
                skippedBecauseAlreadyReleased: true
            ),
            arguments: arguments
        )
        exit(0)
    }

    let eventSource = CGEventSource(stateID: .combinedSessionState)
    guard
        let keyDown = CGEvent(
            keyboardEventSource: eventSource,
            virtualKey: CGKeyCode(keyCode),
            keyDown: true
        ),
        let keyUp = CGEvent(
            keyboardEventSource: eventSource,
            virtualKey: CGKeyCode(keyCode),
            keyDown: false
        )
    else { throw HelperFailure.eventCreationFailed }
    keyDown.postToPid(processId)
    Thread.sleep(forTimeInterval: 0.08)
    keyUp.postToPid(processId)
    Thread.sleep(forTimeInterval: postKeyDelay)

    let releasedAfter = mouseButtonsReleased()
    let result = HelperResult(
        processId: processId,
        keyCode: keyCode,
        bringToFront: bringToFront,
        mouseReleased: releasedAfter,
        mouseButtonsReleasedBefore: releasedBefore,
        mouseButtonsReleasedAfter: releasedAfter,
        skippedBecauseAlreadyReleased: false
    )
    try emit(result, arguments: arguments)
} catch {
    let message = String(describing: error)
    try? emit(HelperErrorResult(error: message), arguments: launchArguments)
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(1)
}
