import Foundation

enum SidebarSection: String, CaseIterable, Identifiable {
    case admin, logs, taskResults, plugins, settings
    var id: String { rawValue }
    var titleKey: String {
        switch self {
        case .logs: "Logs"
        case .taskResults: "Task results"
        case .plugins: "Plugins"
        case .admin: "Camp admin"
        case .settings: "Settings"
        }
    }
    var symbol: String {
        switch self {
        case .logs: "text.alignleft"
        case .taskResults: "doc.text.magnifyingglass"
        case .plugins: "puzzlepiece.extension"
        case .admin: "building.columns"
        case .settings: "gearshape"
        }
    }
}

enum LogDisplayMode: String, CaseIterable, Identifiable {
    case simplified
    case raw

    var id: String { rawValue }
    var titleKey: String {
        switch self {
        case .simplified: "Simplified"
        case .raw: "Raw"
        }
    }
}

struct SimplifiedLogEntry: Identifiable {
    let id: String
    let timestamp: String
    let level: String
    let step: String
    let message: String
    let debugImagePath: String?
}

struct TaskDebugImage: Identifiable, Sendable {
    let id: String
    let sequence: Int
    let label: String
    let capturedAt: Date?
    let url: URL
}

struct TaskResultDocument: Identifiable, Sendable {
    let id: String
    let fileName: String
    let taskKey: String?
    let runId: String?
    let modifiedAt: Date
    let url: URL
}

struct TaskResultColumn: Identifiable {
    let key: String
    let titleKey: String
    var id: String { key }
}

struct TaskResultTable: Identifiable {
    let path: [String]
    let titleKey: String
    let columns: [TaskResultColumn]
    let rows: [[String: String]]
    var id: String { path.joined(separator: ".") }
}

struct TaskLogGroup: Identifiable {
    let id: String
    var taskKey: String
    var taskName: String
    var executionMode: String
    var startedAt: String
    var finishedAt: String?
    var status: String
    var finalMessage: String?
    var lines: [String]

    var isSuccessful: Bool {
        ["succeeded", "partially_succeeded", "success"].contains(status)
    }
}

enum L10n {
    static func string(_ key: String, language: String) -> String {
        if let path = Bundle.module.path(forResource: language, ofType: "lproj"),
           let bundle = Bundle(path: path) {
            return NSLocalizedString(key, tableName: nil, bundle: bundle, value: key, comment: "")
        }
        return NSLocalizedString(key, tableName: nil, bundle: Bundle.module, value: key, comment: "")
    }
}

struct AgentHealth: Decodable {
    let ok: Bool
    let activeRunId: String?
    let activeTaskKey: String?
    let activityMode: String?
    let adbSerial: String?
    let stopEmulatorAfterTask: Bool?
    let plugins: [HealthPlugin]?
}

struct ModelRuntimeInfo: Sendable {
    let path: String
    let isInstalled: Bool
    let isRuntimeAvailable: Bool

    static let missing = ModelRuntimeInfo(path: "", isInstalled: false, isRuntimeAvailable: false)
    var isReady: Bool { isInstalled && isRuntimeAvailable }
}

enum AdbRuntimeSource: String, Sendable {
    case system
    case missing
}

struct AdbRuntimeInfo: Sendable {
    let source: AdbRuntimeSource
    let path: String?
    let version: String?

    static let missing = AdbRuntimeInfo(source: .missing, path: nil, version: nil)
    var isAvailable: Bool { source != .missing }
}

struct HealthPlugin: Decodable, Identifiable {
    let id: String
    let version: String
    let build: Int?
    let taskKey: String
    let builtin: Bool
}

struct PluginEnvelope: Decodable {
    let ok: Bool
    let plugins: [AgentPlugin]?
    let error: String?
}

struct AgentPlugin: Decodable, Identifiable {
    let id: String
    let version: String?
    let build: Int?
    let builtin: Bool?
    let enabled: Bool?
    let signatureVerified: Bool?
    let invalid: Bool?
    let error: String?
    let task: PluginTask?
    let name: [String: String]?
    let summary: [String: String]?

    func localizedName(_ locale: String) -> String {
        name?[locale] ?? name?["en"] ?? id
    }
    func localizedSummary(_ locale: String) -> String {
        summary?[locale] ?? summary?["en"] ?? ""
    }
    var versionDescription: String {
        guard let version else { return "—" }
        return build.map { "\(version) (Build \($0))" } ?? version
    }
}

struct PluginTask: Decodable {
    let key: String
    let positionIndependent: Bool?
}
