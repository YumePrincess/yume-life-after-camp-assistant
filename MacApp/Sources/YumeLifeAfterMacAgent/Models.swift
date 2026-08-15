import Foundation

enum SidebarSection: String, CaseIterable, Identifiable {
    case overview, logs, plugins, admin, settings
    var id: String { rawValue }
    var titleKey: String {
        switch self {
        case .overview: "Overview"
        case .logs: "Logs"
        case .plugins: "Plugins"
        case .admin: "Camp admin"
        case .settings: "Settings"
        }
    }
    var symbol: String {
        switch self {
        case .overview: "square.grid.2x2"
        case .logs: "text.alignleft"
        case .plugins: "puzzlepiece.extension"
        case .admin: "building.columns"
        case .settings: "gearshape"
        }
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

struct ManualTask: Identifiable {
    let id: String
    let symbol: String
    let titleKey: String
    let summaryKey: String

    static let supported: [ManualTask] = [
        .init(id: "tech_switch", symbol: "cpu", titleKey: "Update technology", summaryKey: "Apply fixed technology and vote results."),
        .init(id: "member_profile_sync", symbol: "person.3", titleKey: "Update member profiles", summaryKey: "Refresh members, officers and profile details."),
        .init(id: "contribution_sync", symbol: "chart.bar", titleKey: "Update contributions", summaryKey: "Read the latest contribution table."),
        .init(id: "inactivity_sync", symbol: "exclamationmark.triangle", titleKey: "Update inactivity alerts", summaryKey: "Refresh the latest offline warning list."),
        .init(id: "patrol", symbol: "figure.walk", titleKey: "Camp patrol", summaryKey: "Create and operate the configured patrol team.")
    ]
}
