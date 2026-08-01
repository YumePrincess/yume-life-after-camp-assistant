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
    case automationDenied(String)

    var description: String {
        switch self {
        case .invalidArguments(let message):
            return "YLA_HOST_INPUT_INVALID_ARGUMENTS: \(message)"
        case .automationDenied(let message):
            return "YLA_HOST_INPUT_PERMISSION_DENIED: \(message)"
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

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
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

    let source = [
        "tell application \"System Events\"",
        "  set targetProcess to first application process whose unix id is \(processId)",
        bringToFront ? "  set frontmost of targetProcess to true" : nil,
        bringToFront ? "  delay \(foregroundDelay)" : nil,
        "  key code \(keyCode)",
        "  delay \(postKeyDelay)",
        "end tell"
    ].compactMap { $0 }.joined(separator: "\n")

    var error: NSDictionary?
    guard NSAppleScript(source: source)?.executeAndReturnError(&error) != nil else {
        let number = error?[NSAppleScript.errorNumber] as? Int ?? 0
        let message = error?[NSAppleScript.errorMessage] as? String
            ?? "macOS did not allow the signed App helper to control System Events"
        throw HelperFailure.automationDenied("\(message) (\(number))")
    }

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
