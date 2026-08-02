import Foundation
import SwiftUI
import AppKit

@MainActor
final class AppModel: ObservableObject {
    @Published var selection: SidebarSection? = .overview
    @Published var health: AgentHealth?
    @Published var plugins: [AgentPlugin] = []
    @Published var updates: [RemotePlugin] = []
    @Published var logText = ""
    @Published var isBusy = false
    @Published var statusMessage = ""
    @Published var alertMessage: String?
    @Published var showAbout = false
    @Published var pluginImporterPresented = false
    @Published var serverURL: String
    @Published var agentID: String
    @Published var agentToken: String
    @Published var debugToken: String
    @Published var mumuInstanceName: String
    @Published var allowUnsignedPlugins: Bool
    @Published var language: String
    @Published var theme: AppTheme
    @Published var setupCompleted: Bool
    @Published var setupStep = 0
    @Published var setupProgressMessage = ""
    @Published private(set) var isAppleSilicon = false

    let browser = AdminBrowser()
    private let runtime = RuntimeService.shared
    private var pollingTask: Task<Void, Never>?

    init() {
        let defaults = UserDefaults.standard
        serverURL = defaults.string(forKey: "serverURL") ?? "https://lifeafter.yume.zone"
        let storedAgentID = defaults.string(forKey: "agentID")
        agentID = storedAgentID == nil || storedAgentID == "mumu-main"
            ? "mac-life-after-agent"
            : storedAgentID!
        // Do not request access to existing Keychain items while the App is
        // launching. A newly signed build may need one explicit macOS approval;
        // that approval belongs to a user-initiated credential action.
        agentToken = ""
        debugToken = ""
        mumuInstanceName = defaults.string(forKey: "mumuInstanceName") ?? "Life After CN Auto"
        allowUnsignedPlugins = defaults.bool(forKey: "allowUnsignedPlugins")
        language = defaults.string(forKey: "language") ?? Self.preferredLanguage()
        theme = AppTheme(rawValue: defaults.string(forKey: "theme") ?? "system") ?? .system
        setupCompleted = defaults.bool(forKey: "setupCompleted")
        isAppleSilicon = Self.platformIsAppleSilicon()
    }

    deinit { pollingTask?.cancel() }

    var locale: Locale { Locale(identifier: language) }
    func text(_ key: String) -> String { L10n.string(key, language: language) }

    func bootstrap() async {
        guard isAppleSilicon else { return }
        do {
            try await runtime.installBundledRuntimeIfNeeded()
            if let credentials = try? await runtime.loadCredentials() {
                agentToken = credentials.agentToken
                debugToken = credentials.debugToken
            }
        }
        catch { alertMessage = error.localizedDescription }
        browser.load(baseURL: serverURL)
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
        await checkPluginUpdates(silent: true)
    }

    func refreshStatusAndLogs() async {
        if !debugToken.isEmpty {
            health = try? await runtime.health(debugToken: debugToken)
        } else {
            health = nil
        }
        logText = await runtime.logs()
    }

    func performAgentAction(_ action: String) async {
        guard !isBusy else { return }
        isBusy = true
        statusMessage = text("Working…")
        defer { isBusy = false }
        do {
            let output = try await runtime.run([action], timeout: action == "install" ? 1800 : 180)
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

    func installPlugin(from url: URL) async {
        guard url.startAccessingSecurityScopedResource() else {
            alertMessage = text("The selected plugin could not be accessed.")
            return
        }
        defer { url.stopAccessingSecurityScopedResource() }
        isBusy = true
        defer { isBusy = false }
        do {
            var arguments = ["install", url.path]
            if allowUnsignedPlugins { arguments.append("--allow-unsigned") }
            _ = try await runtime.plugin(arguments)
            statusMessage = text("Plugin installed. Restart the Agent to activate it.")
            await refreshPlugins()
        } catch { alertMessage = error.localizedDescription }
    }

    func removePlugin(_ plugin: AgentPlugin) async {
        do {
            _ = try await runtime.plugin(["remove", plugin.id])
            await refreshPlugins()
        } catch { alertMessage = error.localizedDescription }
    }

    func restoreBundledPlugins() async {
        do {
            _ = try await runtime.plugin(["restore-all-builtins"])
            await refreshPlugins()
            statusMessage = text("Bundled plugins restored. Restart the Agent to activate them.")
        } catch { alertMessage = error.localizedDescription }
    }

    func setPlugin(_ plugin: AgentPlugin, enabled: Bool) async {
        do {
            _ = try await runtime.plugin([enabled ? "enable" : "disable", plugin.id])
            await refreshPlugins()
        } catch { alertMessage = error.localizedDescription }
    }

    func checkPluginUpdates(silent: Bool = false) async {
        do {
            let output = try await runtime.plugin(["updates"])
            let envelope = try decodeEnvelope(output)
            updates = envelope.updates ?? []
            if !silent && updates.isEmpty {
                alertMessage = text("All plugins are up to date.")
            }
        } catch {
            if !silent { alertMessage = error.localizedDescription }
        }
    }

    func installRemotePlugin(_ plugin: RemotePlugin) async {
        isBusy = true
        defer { isBusy = false }
        do {
            _ = try await runtime.plugin(["install-remote", plugin.id], timeout: 300)
            await refreshPlugins()
            await checkPluginUpdates(silent: true)
        } catch { alertMessage = error.localizedDescription }
    }

    func saveSettings() async {
        guard !agentToken.isEmpty, !debugToken.isEmpty else {
            alertMessage = text("Enter both Agent tokens to continue.")
            return
        }
        do {
            try await persistSettings()
            browser.load(baseURL: serverURL)
            statusMessage = text("Settings saved")
        } catch { alertMessage = error.localizedDescription }
    }

    func loadStoredCredentials() async {
        if let credentials = try? await runtime.loadCredentials() {
            agentToken = credentials.agentToken
            debugToken = credentials.debugToken
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
        statusMessage = text("Saved credentials loaded")
    }

    func openSetupAssistant() {
        setupStep = 0
        setupProgressMessage = ""
        setupCompleted = false
    }

    func completeSetup() async {
        guard URL(string: serverURL)?.scheme == "https",
              !agentID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !mumuInstanceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            alertMessage = text("Enter a valid Workers URL, Agent ID and MuMu container name.")
            setupStep = 0
            return
        }
        guard !agentToken.isEmpty, !debugToken.isEmpty else {
            alertMessage = text("Enter both Agent tokens to continue.")
            setupStep = 1
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
            browser.load(baseURL: serverURL)
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
            agentToken: agentToken,
            debugToken: debugToken,
            mumuInstanceName: mumuInstanceName
        )
        try await runtime.registerAgent(
            baseURL: serverURL,
            agentID: agentID,
            agentToken: agentToken
        )
        let defaults = UserDefaults.standard
        defaults.set(serverURL, forKey: "serverURL")
        defaults.set(agentID, forKey: "agentID")
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
