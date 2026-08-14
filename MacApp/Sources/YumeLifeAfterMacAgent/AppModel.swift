import Foundation
import SwiftUI
import AppKit

@MainActor
final class AppModel: ObservableObject {
    @Published var selection: SidebarSection? = .overview
    @Published var health: AgentHealth?
    @Published var plugins: [AgentPlugin] = []
    @Published var logText = ""
    @Published var logRunIdFilter: String?
    @Published private(set) var logPage = 0
    @Published private(set) var latestRunId: String?
    @Published var isBusy = false
    @Published var statusMessage = ""
    @Published var alertMessage: String?
    @Published var showAbout = false
    @Published var serverURL: String
    @Published var agentID: String
    @Published var agentName: String
    @Published var agentToken: String
    @Published var debugToken: String
    @Published var adminKey: String
    @Published var mumuInstanceName: String
    @Published var allowUnsignedPlugins: Bool
    @Published var language: String
    @Published var theme: AppTheme
    @Published var setupCompleted: Bool
    @Published var setupStep = 0
    @Published var setupProgressMessage = ""
    @Published private(set) var isAppleSilicon = false
    @Published private(set) var nodeInfo = NodeRuntimeInfo.missing

    let browser = AdminBrowser()
    private let runtime = RuntimeService.shared
    private var pollingTask: Task<Void, Never>?
    private let logPageSize = 250

    init() {
        let defaults = UserDefaults.standard
        serverURL = defaults.string(forKey: "serverURL") ?? "https://lifeafter.yume.zone"
        let storedAgentID = defaults.string(forKey: "agentID")
        if let storedAgentID, !storedAgentID.isEmpty,
           !["mumu-main", "main-mumu"].contains(storedAgentID) {
            agentID = storedAgentID
        } else if defaults.bool(forKey: "setupCompleted") || storedAgentID != nil {
            agentID = "mac-life-after-agent"
        } else {
            agentID = "mac-\(UUID().uuidString.lowercased())"
        }
        agentName = defaults.string(forKey: "agentName")
            ?? Host.current().localizedName
            ?? "Mac Agent"
        // Do not request access to existing Keychain items while the App is
        // launching. A newly signed build may need one explicit macOS approval;
        // that approval belongs to a user-initiated credential action.
        agentToken = ""
        debugToken = ""
        adminKey = ""
        mumuInstanceName = defaults.string(forKey: "mumuInstanceName") ?? "Life After CN Auto"
        allowUnsignedPlugins = defaults.bool(forKey: "allowUnsignedPlugins")
        language = defaults.string(forKey: "language") ?? Self.preferredLanguage()
        theme = AppTheme(rawValue: defaults.string(forKey: "theme") ?? "system") ?? .system
        setupCompleted = defaults.bool(forKey: "setupCompleted")
        logRunIdFilter = nil
        latestRunId = nil
        isAppleSilicon = Self.platformIsAppleSilicon()
    }

    deinit { pollingTask?.cancel() }

    var locale: Locale { Locale(identifier: language) }
    func text(_ key: String) -> String { L10n.string(key, language: language) }
    var nodeSummary: String {
        if nodeInfo.isAvailable {
            return "Node.js \(nodeInfo.version ?? "available")"
        }
        return text("Node.js not detected")
    }

    func bootstrap() async {
        guard isAppleSilicon else { return }
        do {
            let runtimeWasUpdated = try await runtime.installBundledRuntimeIfNeeded()
            nodeInfo = await runtime.nodeStatus()
            if runtimeWasUpdated {
                // The previous launchd process may still have the old modules
                // in memory after Runtime/current is replaced. Repairing here
                // unloads that process and starts the newly installed bundle.
                _ = try await runtime.run(["repair"], timeout: 300)
            } else if setupCompleted {
                // Opening the App is also the explicit local-agent start
                // action. This keeps the web console online after a normal
                // macOS/App restart without requiring a second manual click.
                _ = try await runtime.run(["start"], timeout: 60)
            }
            if let credentials = try? await runtime.loadCredentials() {
                agentToken = credentials.agentToken
                debugToken = credentials.debugToken
                adminKey = credentials.adminKey ?? ""
            }
        }
        catch { alertMessage = error.localizedDescription }
        browser.load(baseURL: serverURL, adminKey: adminKey)
        await refreshAll()
        pollingTask?.cancel()
        pollingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                await self?.refreshStatusAndLogs()
            }
        }
    }

    func refreshAll() async {
        await refreshStatusAndLogs()
        await refreshPlugins()
        nodeInfo = await runtime.nodeStatus()
    }

    func refreshStatusAndLogs(loadLogs: Bool = false) async {
        if !debugToken.isEmpty {
            health = try? await runtime.health(debugToken: debugToken)
        } else {
            health = nil
        }
        if loadLogs || selection == .logs || logText.isEmpty {
            let refreshedLogs = await runtime.logs()
            if refreshedLogs != logText {
                logText = refreshedLogs
                logPage = 0
                latestRunId = Self.latestRunId(in: refreshedLogs) ?? latestRunId
            }
        }
    }

    private var filteredLogLines: [String] {
        let allLines = logText
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map(String.init)
        guard let runId = logRunIdFilter, !runId.isEmpty else { return allLines }
        return allLines.filter { $0.contains(runId) }
    }

    var visibleLogLines: [String] {
        let lines = filteredLogLines
        let pageCount = max(1, Int(ceil(Double(lines.count) / Double(logPageSize))))
        let currentPage = min(max(0, logPage), pageCount - 1)
        let end = max(0, lines.count - currentPage * logPageSize)
        let start = max(0, end - logPageSize)
        return Array(lines[start..<end])
    }

    var visibleLogText: String { visibleLogLines.joined(separator: "\n") }

    var logPageCount: Int {
        max(1, Int(ceil(Double(filteredLogLines.count) / Double(logPageSize))))
    }

    var logPageLabel: String {
        "\(min(logPage + 1, logPageCount)) / \(logPageCount)"
    }

    func previousLogPage() {
        logPage = max(0, logPage - 1)
    }

    func nextLogPage() {
        logPage = min(logPageCount - 1, logPage + 1)
    }

    func openCurrentTaskLogs() {
        logRunIdFilter = health?.activeRunId ?? latestRunId
        selection = .logs
    }

    func showAllLogs() {
        logRunIdFilter = nil
        logPage = 0
    }

    func clearLogs() async {
        do {
            try await runtime.clearLogs()
            logText = ""
            logRunIdFilter = nil
            logPage = 0
            statusMessage = text("Logs cleared")
        } catch {
            alertMessage = error.localizedDescription
        }
    }

    func performAgentAction(_ action: String) async {
        guard !isBusy else { return }
        isBusy = true
        statusMessage = text("Working…")
        defer { isBusy = false }
        do {
            if action == "update" {
                nodeInfo = try await runtime.ensureLocalNodeForUpdate()
            }
            let timeout: TimeInterval = switch action {
            case "install": 1800
            case "repair", "update", "uninstall": 300
            default: 180
            }
            let output = try await runtime.run([action], timeout: timeout)
            statusMessage = output.trimmingCharacters(in: .whitespacesAndNewlines)
            await refreshAll()
        } catch {
            alertMessage = error.localizedDescription
            statusMessage = text("Action failed")
        }
    }

    func submit(_ task: ManualTask) async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            try await browser.submit(taskKey: task.id)
            statusMessage = text("Task submitted")
            alertMessage = text("Task submitted successfully.")
        } catch {
            alertMessage = error.localizedDescription
        }
    }

    func refreshPlugins() async {
        do {
            let output = try await runtime.plugin(["list"])
            let envelope = try decodeEnvelope(output)
            plugins = envelope.plugins ?? []
        } catch { alertMessage = error.localizedDescription }
    }

    func removePlugin(_ plugin: AgentPlugin) async {
        guard plugin.builtin != true else {
            alertMessage = text("Bundled plugins cannot be removed. Disable the plugin instead.")
            return
        }
        do {
            _ = try await runtime.plugin(["remove", plugin.id])
            await refreshPlugins()
        } catch { alertMessage = error.localizedDescription }
    }

    func openPluginDirectory() {
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appending(path: "Yume Life After Mac Agent/Plugins", directoryHint: .isDirectory)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            NSWorkspace.shared.open(directory)
        } catch {
            alertMessage = error.localizedDescription
        }
    }

    func setPlugin(_ plugin: AgentPlugin, enabled: Bool) async {
        do {
            _ = try await runtime.plugin([enabled ? "enable" : "disable", plugin.id])
            await refreshPlugins()
        } catch { alertMessage = error.localizedDescription }
    }

    func saveSettings() async {
        guard URL(string: serverURL)?.scheme == "https",
              !agentName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              agentName.count <= 80,
              !mumuInstanceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            alertMessage = text("Enter a valid Workers URL, device name and MuMu container name.")
            return
        }
        guard !agentToken.isEmpty, !debugToken.isEmpty else {
            alertMessage = text("Enter both Agent tokens to continue.")
            return
        }
        do {
            try await persistSettings()
            browser.load(baseURL: serverURL, adminKey: adminKey)
            statusMessage = text("Settings saved")
        } catch { alertMessage = error.localizedDescription }
    }

    func loadStoredCredentials() async {
        if let credentials = try? await runtime.loadCredentials() {
            agentToken = credentials.agentToken
            debugToken = credentials.debugToken
            adminKey = credentials.adminKey ?? ""
            statusMessage = text("Saved credentials loaded")
            return
        }
        // One-time migration for Beta 53 and earlier. This user-initiated read
        // may show one native App Keychain prompt; saving immediately migrates
        // the values to the owner-only runtime file and removes the old items.
        let storedAgentToken = KeychainStore.get(account: "agent-token")
        let storedDebugToken = KeychainStore.get(account: "debug-token")
        guard let storedAgentToken, let storedDebugToken else {
            alertMessage = text("No saved credentials were found.")
            return
        }
        agentToken = storedAgentToken
        debugToken = storedDebugToken
        adminKey = ""
        statusMessage = text("Saved credentials loaded")
    }

    func openSetupAssistant() {
        setupStep = 0
        setupProgressMessage = ""
        setupCompleted = false
        Task { nodeInfo = await runtime.nodeStatus() }
    }

    func openNodeInstallGuide() {
        guard let url = URL(string: "https://nodejs.org/en/download") else { return }
        NSWorkspace.shared.open(url)
    }

    func completeSetup() async {
        guard URL(string: serverURL)?.scheme == "https",
              !agentName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              agentName.count <= 80,
              !mumuInstanceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            alertMessage = text("Enter a valid Workers URL, device name and MuMu container name.")
            setupStep = 0
            return
        }
        guard !agentToken.isEmpty, !debugToken.isEmpty else {
            alertMessage = text("Enter both Agent tokens to continue.")
            setupStep = 1
            return
        }
        nodeInfo = await runtime.nodeStatus()
        guard nodeInfo.isAvailable else {
            setupStep = 0
            alertMessage = text("Node.js is required. Install Node.js 22 arm64, then retry.")
            return
        }
        isBusy = true
        setupProgressMessage = ""
        defer { isBusy = false }
        do {
            setupProgressMessage = text("Saving secure settings…")
            try await persistSettings()
            setupProgressMessage = text("Registering background Agent…")
            _ = try await runtime.run(["repair"], timeout: 300)
            setupProgressMessage = text("Verifying local Agent…")
            _ = try await runtime.health(debugToken: debugToken)
            UserDefaults.standard.set(true, forKey: "setupCompleted")
            setupCompleted = true
            browser.load(baseURL: serverURL, adminKey: adminKey)
            statusMessage = text("Setup completed")
            setupProgressMessage = ""
            await refreshAll()
        } catch {
            setupProgressMessage = text("Installation stopped. Review the error and try again.")
            alertMessage = error.localizedDescription
        }
    }

    private func persistSettings() async throws {
        try await runtime.saveConnection(
            baseURL: serverURL,
            agentID: agentID,
            agentName: agentName,
            agentToken: agentToken,
            debugToken: debugToken,
            adminKey: adminKey,
            mumuInstanceName: mumuInstanceName,
            allowUnsignedLocalPlugins: allowUnsignedPlugins
        )
        try await runtime.registerAgent(
            baseURL: serverURL,
            agentID: agentID,
            agentName: agentName,
            agentToken: agentToken
        )
        let defaults = UserDefaults.standard
        defaults.set(serverURL, forKey: "serverURL")
        defaults.set(agentID, forKey: "agentID")
        defaults.set(agentName, forKey: "agentName")
        defaults.set(mumuInstanceName, forKey: "mumuInstanceName")
        defaults.set(allowUnsignedPlugins, forKey: "allowUnsignedPlugins")
        defaults.set(language, forKey: "language")
        defaults.set(theme.rawValue, forKey: "theme")
    }

    func exportMigration() async {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "Yume-Life-After-Mac-Agent.ylabackup"
        panel.allowedContentTypes = [.zip]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try await runtime.exportMigrationArchive(to: url)
            alertMessage = text("Migration archive exported without tokens.")
        } catch { alertMessage = error.localizedDescription }
    }

    func importMigration() async {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.zip]
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try await runtime.importMigrationArchive(from: url)
            alertMessage = text("Migration archive imported. Enter the tokens on this Mac, then restart the Agent.")
            await refreshPlugins()
        } catch { alertMessage = error.localizedDescription }
    }

    private func decodeEnvelope(_ output: String) throws -> PluginEnvelope {
        guard let line = output.split(separator: "\n").last,
              let data = String(line).data(using: .utf8)
        else { throw RuntimeError.failed(text("The plugin response was invalid.")) }
        return try JSONDecoder().decode(PluginEnvelope.self, from: data)
    }

    private static func preferredLanguage() -> String {
        let preferred = Locale.preferredLanguages.first ?? "en"
        if preferred.hasPrefix("zh-Hant") || preferred.hasPrefix("zh-TW") || preferred.hasPrefix("zh-HK") { return "zh-Hant" }
        if preferred.hasPrefix("zh") { return "zh-Hans" }
        if preferred.hasPrefix("ja") { return "ja" }
        if preferred.hasPrefix("fr") { return "fr" }
        return "en"
    }

    private static func latestRunId(in logs: String) -> String? {
        for line in logs.split(separator: "\n", omittingEmptySubsequences: true).reversed() {
            let value = String(line)
            let jsonText = value.split(separator: " ", maxSplits: 1).last.map(String.init) ?? value
            guard let data = jsonText.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let runId = object["runId"] as? String,
                  !runId.isEmpty else { continue }
            return runId
        }
        return nil
    }

    private static func platformIsAppleSilicon() -> Bool {
        var system = utsname()
        uname(&system)
        let machine = withUnsafePointer(to: &system.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
        }
        var translated: Int32 = 0
        var size = MemoryLayout<Int32>.size
        let translation = sysctlbyname("sysctl.proc_translated", &translated, &size, nil, 0)
        return machine == "arm64" && !(translation == 0 && translated == 1)
    }
}
