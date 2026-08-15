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
    @Published var updateSteps: [String] = []
    @Published var updateResult: String?
    @Published var updateProgress = 0.0
    @Published var showUpdateWizard = false
    @Published var showMigrationExportOptions = false
    @Published var migrationIncludeModel = false
    @Published var migrationIncludeCredentials = false
    @Published private(set) var isAppleSilicon = false
    @Published private(set) var nodeInfo = NodeRuntimeInfo.missing
    @Published private(set) var adbInfo = AdbRuntimeInfo.missing
    @Published private(set) var modelInfo = ModelRuntimeInfo.missing

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

    var adbSummary: String {
        if adbInfo.isAvailable {
            return "ADB \(adbInfo.version ?? text("ADB available"))"
        }
        return text("ADB not detected")
    }

    func bootstrap() async {
        guard isAppleSilicon else { return }
        do {
            let runtimeWasUpdated = try await runtime.installBundledRuntimeIfNeeded()
            nodeInfo = await runtime.nodeStatus()
            adbInfo = await runtime.adbStatus()
            modelInfo = await runtime.modelStatus()
            if runtimeWasUpdated {
                updateSteps = [text("Synchronizing bundled runtime…")]
                updateResult = nil
                updateProgress = 0.15
                showUpdateWizard = true
                updateSteps.append(text("Bundled runtime replaced."))
                updateProgress = 0.3
                updateSteps.append(modelInfo.isInstalled
                    ? text("External Qwen model found.")
                    : text("External Qwen model is not installed."))
                // The previous launchd process may still have the old modules
                // in memory after Runtime/current is replaced. Repairing here
                // unloads that process and starts the newly installed bundle.
                if nodeInfo.isAvailable && adbInfo.isAvailable {
                    updateSteps.append(text("Updating npm dependencies and rebuilding OCR…"))
                    updateProgress = 0.55
                    _ = try await runtime.run(["repair"], timeout: 300)
                    updateSteps.append(text("Dependencies and OCR runtime updated."))
                    updateProgress = 1
                    updateResult = text("Update completed successfully.")
                } else {
                    updateSteps.append(text("Update failed. Review the error and retry."))
                    updateProgress = 0.75
                    updateResult = text("Install Android platform-tools too. The App detects the system adb and does not package it.")
                }
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
        catch {
            if showUpdateWizard {
                updateSteps.append(error.localizedDescription)
                updateProgress = min(updateProgress, 0.99)
                updateResult = text("Update failed. Review the error and retry.")
            }
            alertMessage = error.localizedDescription
        }
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
        adbInfo = await runtime.adbStatus()
        modelInfo = await runtime.modelStatus()
    }

    func refreshStatusAndLogs(loadLogs: Bool = false) async {
        if !debugToken.isEmpty {
            // Keep the last successful health snapshot during a short
            // transient launchd/HTTP gap. Clearing it on one failed poll was
            // why a running task briefly appeared as “Agent offline”.
            if let current = try? await runtime.health(debugToken: debugToken) {
                health = current
            }
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
        if action == "update" {
            updateSteps = []
            updateResult = nil
            updateProgress = 0
            showUpdateWizard = true
        }
        defer { isBusy = false }
        do {
            if action == "update" {
                updateSteps.append(text("Synchronizing bundled runtime…"))
                updateProgress = 0.15
                let runtimeChanged = try await runtime.installBundledRuntimeIfNeeded()
                updateSteps.append(runtimeChanged
                    ? text("Bundled runtime replaced.")
                    : text("Bundled runtime already current."))
                updateProgress = 0.3
                updateSteps.append(text("Checking macOS Node.js…"))
                nodeInfo = try await runtime.ensureLocalNodeForUpdate()
                updateProgress = 0.45
                adbInfo = await runtime.adbStatus()
                guard adbInfo.isAvailable else {
                    throw RuntimeError.failed(text("ADB is required. Install Android platform-tools, then retry."))
                }
                modelInfo = await runtime.modelStatus()
                updateSteps.append(modelInfo.isInstalled
                    ? text("External Qwen model found.")
                    : text("External Qwen model is not installed."))
                updateProgress = 0.5
                updateSteps.append(text("Updating npm dependencies and rebuilding OCR…"))
                updateProgress = 0.55
            }
            let timeout: TimeInterval = switch action {
            case "install": 1800
            case "repair", "update", "uninstall": 300
            default: 180
            }
            let output = try await runtime.run([action], timeout: timeout)
            statusMessage = output.trimmingCharacters(in: .whitespacesAndNewlines)
            if action == "update" {
                updateSteps.append(text("Dependencies and OCR runtime updated."))
                updateProgress = 1
                updateResult = text("Update completed successfully.")
            }
            await refreshAll()
        } catch {
            alertMessage = error.localizedDescription
            statusMessage = text("Action failed")
            if action == "update" {
                updateSteps.append(error.localizedDescription)
                updateProgress = min(updateProgress, 0.99)
                updateResult = text("Update failed. Review the error and retry.")
            }
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
        Task {
            nodeInfo = await runtime.nodeStatus()
            adbInfo = await runtime.adbStatus()
            modelInfo = await runtime.modelStatus()
        }
    }

    func openNodeInstallGuide() {
        guard let url = URL(string: "https://nodejs.org/en/download") else { return }
        NSWorkspace.shared.open(url)
    }

    func openAdbInstallGuide() {
        guard let url = URL(string: "https://developer.android.com/tools/releases/platform-tools") else { return }
        NSWorkspace.shared.open(url)
    }

    func downloadExternalNode() async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            nodeInfo = try await runtime.ensureLocalNodeForUpdate()
            updateSteps.append(text("External Node.js is ready."))
            updateProgress = max(updateProgress, 0.35)
        } catch {
            alertMessage = error.localizedDescription
        }
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
        adbInfo = await runtime.adbStatus()
        guard adbInfo.isAvailable else {
            setupStep = 0
            alertMessage = text("ADB is required. Install Android platform-tools, then retry.")
            return
        }
        modelInfo = await runtime.modelStatus()
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
        migrationIncludeModel = false
        migrationIncludeCredentials = false
        showMigrationExportOptions = true
    }

    func confirmExportMigration(includeModel: Bool, includeCredentials: Bool) async {
        showMigrationExportOptions = false
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "Yume-Life-After-Mac-Agent.ylabackup"
        panel.allowedContentTypes = [.zip]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try await runtime.exportMigrationArchive(
                to: url,
                includeModel: includeModel,
                includeCredentials: includeCredentials
            )
            alertMessage = text("Migration archive exported.")
        } catch { alertMessage = error.localizedDescription }
    }

    func prepareModelRuntime() async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            modelInfo = try await runtime.prepareModelRuntime()
            statusMessage = modelInfo.isReady
                ? text("Qwen model runtime is ready.")
                : text("Qwen model was copied, but its runtime is not ready.")
        } catch {
            alertMessage = error.localizedDescription
        }
    }

    func downloadModel() async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            modelInfo = try await runtime.installExternalModel()
            statusMessage = modelInfo.isInstalled
                ? text("Qwen model is ready.")
                : text("Qwen model download is incomplete.")
        } catch {
            alertMessage = error.localizedDescription
        }
    }

    func importMigration() async {
        await importMigration(showSetupMessage: false)
    }

    func restoreMigrationForSetup() async {
        await importMigration(showSetupMessage: true)
    }

    private func importMigration(showSetupMessage: Bool) async {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.zip]
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try await runtime.importMigrationArchive(from: url)
            if let credentials = try? await runtime.loadCredentials() {
                agentToken = credentials.agentToken
                debugToken = credentials.debugToken
                adminKey = credentials.adminKey ?? ""
            }
            modelInfo = await runtime.modelStatus()
            alertMessage = text(showSetupMessage
                ? "Migration archive restored. Review the settings, then finish installation."
                : "Migration archive imported. Enter the tokens on this Mac, then restart the Agent.")
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
