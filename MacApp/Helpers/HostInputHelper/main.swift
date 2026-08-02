import AppKit
import ApplicationServices
import Foundation

private struct HelperResult: Encodable {
    let processId: Int32
    let keyCode: Int
    let bringToFront: Bool
    let mouseReleased: Bool
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
    let deadline = Date().addingTimeInterval(Double(timeoutMilliseconds) / 1_000)
    while Date() < deadline {
        if CGPreflightPostEventAccess() { return true }
        Thread.sleep(forTimeInterval: 0.5)
    }
    return CGPreflightPostEventAccess()
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    let permissionTimeoutMilliseconds = max(
        5_000,
        min(170_000, Int(argument("--permission-timeout-ms", in: arguments) ?? "120000") ?? 120_000)
    )
    if arguments.contains("--request-permission-only") {
        guard waitForPostEventPermission(timeoutMilliseconds: permissionTimeoutMilliseconds) else {
            throw HelperFailure.accessibilityDenied(
                "Enable ‘Yume Life After Mac Agent Input Helper’ in System Settings > Privacy & Security > Accessibility."
            )
        }
        FileHandle.standardOutput.write(Data("{\"permissionGranted\":true}\n".utf8))
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

    let result = HelperResult(
        processId: processId,
        keyCode: keyCode,
        bringToFront: bringToFront,
        mouseReleased: mouseButtonsReleased()
    )
    let data = try JSONEncoder().encode(result)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
