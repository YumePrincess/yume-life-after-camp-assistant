import Foundation
import SwiftUI
import AppKit

@MainActor
final class AppModel: ObservableObject {
    @Published var selection: SidebarSection? = .admin
    @Published var health: AgentHealth?
    @Published var plugins: [AgentPlugin] = []
    @Published var logText = ""
    @Published var logRunIdFilter: String?
    @Published private(set) var taskLogGroups: [TaskLogGroup] = []
    @Published private(set) var selectedTaskDebugImages: [TaskDebugImage] = []
    @Published var selectedTaskLogID: String?
    @Published var logDisplayMode: LogDisplayMode
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
    @Published var timezone: String
    @Published var showLanguageRestartPrompt = false
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
    @Published private(set) var qwenEnabled = true
    @Published var debugMode: Bool

    let browser = AdminBrowser()
    private let runtime = RuntimeService.shared
    private var pollingTask: Task<Void, Never>?
    // A stop initiated from this still-open App must not be undone if SwiftUI
    // recreates the root view and runs bootstrap again.
    private var agentStoppedByUser = false
    private let logPageSize = 250
    private var timezoneConfigured: Bool
    private var cachedLogLinesSource = ""
    private var cachedLogLines: [String] = []
    private var logRevision = 0
    private var visibleCacheRevision = -1
    private var visibleCacheFilter: String?
    private var visibleCachePage = -1
    private var visibleCacheLanguage = ""
    private var cachedVisibleLogLines: [String] = []
    private var cachedVisibleLogEntries: [SimplifiedLogEntry] = []

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
        agentToken = ""
        debugToken = ""
        adminKey = ""
        mumuInstanceName = defaults.string(forKey: "mumuInstanceName") ?? "Life After CN Auto"
        allowUnsignedPlugins = defaults.bool(forKey: "allowUnsignedPlugins")
        debugMode = defaults.bool(forKey: "debugMode")
        let selectedLanguage = defaults.string(forKey: "language") ?? Self.preferredLanguage()
        language = selectedLanguage
        timezone = defaults.string(forKey: "timezone") ?? "Asia/Shanghai"
        timezoneConfigured = defaults.string(forKey: "timezone") != nil
        defaults.set([selectedLanguage], forKey: "AppleLanguages")
        defaults.set(Self.appleLocale(for: selectedLanguage), forKey: "AppleLocale")
        theme = AppTheme(rawValue: defaults.string(forKey: "theme") ?? "system") ?? .system
        logDisplayMode = LogDisplayMode(
            rawValue: defaults.string(forKey: "logDisplayMode") ?? LogDisplayMode.raw.rawValue
        ) ?? .raw
        setupCompleted = defaults.bool(forKey: "setupCompleted")
        logRunIdFilter = nil
        selectedTaskLogID = nil
        latestRunId = nil
        isAppleSilicon = Self.platformIsAppleSilicon()
    }

    deinit { pollingTask?.cancel() }

    var locale: Locale { Locale(identifier: language) }
    var timezoneOptions: [String] {
        let common = [
            "Asia/Shanghai", "Asia/Tokyo", "Asia/Seoul", "Asia/Singapore",
            "Asia/Kolkata", "Europe/London", "Europe/Paris", "Europe/Berlin",
            "America/Los_Angeles", "America/Denver", "America/Chicago",
            "America/New_York", "Australia/Sydney", "Pacific/Auckland", "UTC"
        ]
        return Array(NSOrderedSet(array: common + TimeZone.knownTimeZoneIdentifiers)).compactMap { $0 as? String }
            .filter { TimeZone(identifier: $0) != nil }
    }

    func displayTimestamp(_ value: String) -> String {
        guard let date = Self.parseTimestamp(value) else { return value }
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = locale
        formatter.timeZone = TimeZone(identifier: timezone) ?? .current
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss zzz"
        return formatter.string(from: date)
    }
    func text(_ key: String) -> String { L10n.string(key, language: language) }

    func localizedTaskName(_ group: TaskLogGroup) -> String {
        let key: String
        switch group.taskKey {
        case "contribution_sync": key = "Task contribution_sync"
        case "inactivity_sync": key = "Task inactivity_sync"
        case "member_profile_sync": key = "Task member_profile_sync"
        case "weekly_activity_sync": key = "Task weekly_activity_sync"
        case "patrol": key = "Task patrol"
        case "tech_switch": key = "Task tech_switch"
        case "automation_routine": key = "Task automation_routine"
        default: return group.taskName
        }
        let localized = text(key)
        return localized == key ? group.taskName : localized
    }

    func localizedExecutionMode(_ mode: String) -> String {
        let normalized = mode.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let key: String
        switch normalized {
        case "scheduled": key = "Execution mode scheduled"
        case "manual": key = "Execution mode manual"
        case "scheduled_window": key = "Execution mode scheduled_window"
        case "retry": key = "Execution mode retry"
        case "unknown", "": key = "Execution mode unknown"
        default: return mode
        }
        let localized = text(key)
        return localized == key ? mode : localized
    }
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
            qwenEnabled = await runtime.localVisionEnabled()
            debugMode = await runtime.debugCaptureEnabled()
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
            } else if setupCompleted && !agentStoppedByUser {
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
        if agentStoppedByUser {
            health = nil
        } else if !debugToken.isEmpty {
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
                logRevision += 1
                logPage = 0
                latestRunId = Self.latestRunId(in: refreshedLogs) ?? latestRunId
                taskLogGroups = Self.taskLogGroups(in: refreshedLogs)
            } else if taskLogGroups.isEmpty, !logText.isEmpty {
                taskLogGroups = Self.taskLogGroups(in: logText)
            }
            if let selectedTaskLogID,
               !taskLogGroups.contains(where: { $0.id == selectedTaskLogID }) {
                self.selectedTaskLogID = nil
                selectedTaskDebugImages = []
                logRunIdFilter = nil
            }
            // A running debug task appends immutable image files while the
            // log text may remain unchanged between polls. Refresh the
            // selected task's directory on every log poll so newly captured
            // screenshots appear without leaving and reopening the task.
            await refreshSelectedTaskDebugImages()
        }
    }

    private func refreshSelectedTaskDebugImages(for requestedRunID: String? = nil) async {
        let runID = requestedRunID ?? selectedTaskLogID
        guard let runID, !runID.isEmpty else { return }
        let refreshedImages = await runtime.debugImages(runID: runID)
        // Selection can change while the actor-backed directory read is in
        // flight. Never apply a previous task's images to the newly selected
        // task.
        guard selectedTaskLogID == runID else { return }
        if selectedTaskDebugImages.map(\.id) != refreshedImages.map(\.id) {
            selectedTaskDebugImages = refreshedImages
        }
    }

    private var filteredLogLines: [String] {
        if cachedLogLinesSource != logText {
            cachedLogLinesSource = logText
            cachedLogLines = logText
                .split(separator: "\n", omittingEmptySubsequences: false)
                .map(String.init)
        }
        let allLines = cachedLogLines
        guard let runId = logRunIdFilter, !runId.isEmpty else { return allLines }
        return allLines.filter { $0.contains(runId) }
    }

    var visibleLogLines: [String] {
        rebuildVisibleLogCacheIfNeeded()
        return cachedVisibleLogLines
    }

    var visibleLogText: String {
        visibleLogLines
            .map { Self.localizedRawLine($0, language: language) }
            .joined(separator: "\n")
    }

    func localizedLogLine(_ line: String) -> String {
        Self.localizedRawLine(line, language: language)
    }

    var visibleLogEntries: [SimplifiedLogEntry] {
        rebuildVisibleLogCacheIfNeeded()
        return cachedVisibleLogEntries
    }

    var logPageCount: Int {
        max(1, Int(ceil(Double(filteredLogLines.count) / Double(logPageSize))))
    }

    var logPageLabel: String {
        let current = min(logPage + 1, logPageCount)
        return text("Page {current} of {total}")
            .replacingOccurrences(of: "{current}", with: String(current))
            .replacingOccurrences(of: "{total}", with: String(logPageCount))
    }

    func previousLogPage() {
        logPage = max(0, logPage - 1)
    }

    func nextLogPage() {
        logPage = min(logPageCount - 1, logPage + 1)
    }

    func openCurrentTaskLogs() {
        selectTaskLog(health?.activeRunId ?? latestRunId)
        selection = .logs
    }

    func selectTaskLog(_ runID: String?) {
        selectedTaskLogID = runID
        logRunIdFilter = runID
        logPage = 0
        guard let runID, !runID.isEmpty else {
            selectedTaskDebugImages = []
            return
        }
        Task { [weak self] in
            guard let self else { return }
            await refreshSelectedTaskDebugImages(for: runID)
        }
    }

    func debugImageID(for entry: SimplifiedLogEntry) -> String? {
        if let path = entry.debugImagePath, !path.isEmpty {
            let filename = URL(fileURLWithPath: path).lastPathComponent
            if let exact = selectedTaskDebugImages.first(where: {
                $0.url.lastPathComponent == filename
            }) {
                return exact.id
            }
        }
        guard !entry.step.isEmpty else { return nil }
        let step = entry.step.lowercased()
        return selectedTaskDebugImages.first(where: { image in
            let label = image.label.lowercased()
            return label == step || label == "log-\(step)" || label.hasSuffix("-\(step)")
        })?.id
    }

    /// Select the log page that owns a debug image and return the stable row
    /// id used by ScrollViewReader. Images are loaded for the whole task, so
    /// the matching log may be on a page other than the currently visible
    /// one; changing logPage here keeps image -> log navigation deterministic.
    func focusLogEntry(for image: TaskDebugImage) -> String? {
        let lines = filteredLogLines
        let parsed = lines.enumerated().map { index, line in
            Self.simplifiedLogEntry(line, index: index, language: language)
        }
        let exactImageName = image.url.lastPathComponent
        var absoluteIndex = parsed.firstIndex { entry in
            guard let path = entry.debugImagePath, !path.isEmpty else { return false }
            return URL(fileURLWithPath: path).lastPathComponent == exactImageName
        }
        if absoluteIndex == nil, !image.label.isEmpty {
            let step = image.label
                .replacingOccurrences(of: "^log-", with: "", options: .regularExpression)
                .lowercased()
            absoluteIndex = parsed.firstIndex { entry in
                entry.step.lowercased() == step
            }
        }
        if absoluteIndex == nil, !parsed.isEmpty {
            // OCR/crop captures can be useful evidence without being the
            // extra log capture attached to a task event. Associate them
            // with the nearest event capture so every visible image still
            // has a deterministic log destination.
            let directCaptures: [(index: Int, sequence: Int)] = parsed.enumerated().compactMap { entryIndex, entry in
                guard let path = entry.debugImagePath, !path.isEmpty,
                      let image = selectedTaskDebugImages.first(where: {
                          $0.url.lastPathComponent == URL(fileURLWithPath: path).lastPathComponent
                      }) else { return nil }
                return (index: entryIndex, sequence: image.sequence)
            }
            if let nearest = directCaptures.min(by: {
                abs($0.sequence - image.sequence) < abs($1.sequence - image.sequence)
            }) {
                absoluteIndex = nearest.index
            }
        }
        guard let absoluteIndex else { return nil }
        let distanceFromEnd = lines.count - 1 - absoluteIndex
        logPage = max(0, distanceFromEnd / logPageSize)
        let pageLines = visibleLogLines
        let end = max(0, lines.count - logPage * logPageSize)
        let start = max(0, end - logPageSize)
        let visibleIndex = absoluteIndex - start
        guard pageLines.indices.contains(visibleIndex) else { return nil }
        return Self.simplifiedLogEntry(pageLines[visibleIndex], index: visibleIndex, language: language).id
    }

    func cancelCurrentTask() async {
        guard health?.activeRunId != nil else {
            statusMessage = text("No active task")
            return
        }
        guard !debugToken.isEmpty else {
            alertMessage = text("The local debug token is required to cancel a task.")
            return
        }
        do {
            try await runtime.abort(debugToken: debugToken)
            statusMessage = text("Cancellation requested")
            await refreshStatusAndLogs(loadLogs: true)
        } catch {
            alertMessage = error.localizedDescription
        }
    }

    func showAllLogs() {
        logRunIdFilter = nil
        selectedTaskLogID = nil
        selectedTaskDebugImages = []
        logPage = 0
    }

    func setLogDisplayMode(_ mode: LogDisplayMode) {
        logDisplayMode = mode
        UserDefaults.standard.set(mode.rawValue, forKey: "logDisplayMode")
    }

    func setDebugMode(_ enabled: Bool) async {
        let previous = debugMode
        debugMode = enabled
        do {
            try await runtime.setDebugCaptureEnabled(enabled)
            await runtime.setRuntimeDebugCapture(enabled, debugToken: debugToken)
            UserDefaults.standard.set(enabled, forKey: "debugMode")
            statusMessage = text(enabled
                ? "Debug screenshots enabled."
                : "Debug screenshots disabled and cleared.")
            if !enabled { selectedTaskDebugImages = [] }
        } catch {
            debugMode = previous
            alertMessage = error.localizedDescription
        }
    }

    func clearLogs() async {
        do {
            try await runtime.clearLogs()
            logText = ""
            logRevision += 1
            logRunIdFilter = nil
            taskLogGroups = []
            selectedTaskLogID = nil
            selectedTaskDebugImages = []
            logPage = 0
            statusMessage = text("Logs cleared")
        } catch {
            alertMessage = error.localizedDescription
        }
    }

    private func rebuildVisibleLogCacheIfNeeded() {
        if visibleCacheRevision == logRevision,
           visibleCacheFilter == logRunIdFilter,
           visibleCachePage == logPage,
           visibleCacheLanguage == language {
            return
        }
        let lines = filteredLogLines
        let pageCount = max(1, Int(ceil(Double(lines.count) / Double(logPageSize))))
        let currentPage = min(max(0, logPage), pageCount - 1)
        let end = max(0, lines.count - currentPage * logPageSize)
        let start = max(0, end - logPageSize)
        let visible = Array(lines[start..<end])
        cachedVisibleLogLines = visible
        cachedVisibleLogEntries = visible.enumerated().map { index, line in
            Self.simplifiedLogEntry(line, index: index, language: language)
        }
        visibleCacheRevision = logRevision
        visibleCacheFilter = logRunIdFilter
        visibleCachePage = logPage
        visibleCacheLanguage = language
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
            if action == "stop", !debugToken.isEmpty {
                // Ask the Node runtime to stop its polling loop first. The
                // launchd unload below remains the final process-level guard,
                // including when the debug endpoint is already unavailable.
                try? await runtime.shutdown(debugToken: debugToken)
            }
            let output = try await runtime.run([action], timeout: timeout)
            statusMessage = output.trimmingCharacters(in: .whitespacesAndNewlines)
            if action == "stop" {
                agentStoppedByUser = true
                health = nil
            } else if ["start", "restart", "install", "repair", "update"].contains(action) {
                agentStoppedByUser = false
            }
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

    func openSetupAssistant() {
        setupStep = 0
        setupProgressMessage = ""
        setupCompleted = false
        Task {
            nodeInfo = await runtime.nodeStatus()
            adbInfo = await runtime.adbStatus()
            modelInfo = await runtime.modelStatus()
            qwenEnabled = await runtime.localVisionEnabled()
        }
    }

    func setQwenEnabled(_ enabled: Bool) async {
        let previous = qwenEnabled
        qwenEnabled = enabled
        do {
            try await runtime.setLocalVisionEnabled(enabled)
            statusMessage = text(enabled
                ? "Qwen visual assistance enabled."
                : "Qwen visual assistance disabled.")
        } catch {
            qwenEnabled = previous
            alertMessage = error.localizedDescription
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
        let workerTimezone = try await runtime.registerAgent(
            baseURL: serverURL,
            agentID: agentID,
            agentName: agentName,
            agentToken: agentToken
        )
        if !timezoneConfigured,
           let workerTimezone,
           TimeZone(identifier: workerTimezone) != nil {
            timezone = workerTimezone
        }
        try await runtime.saveConnection(
            baseURL: serverURL,
            agentID: agentID,
            agentName: agentName,
            agentToken: agentToken,
            debugToken: debugToken,
            adminKey: adminKey,
            mumuInstanceName: mumuInstanceName,
            allowUnsignedLocalPlugins: allowUnsignedPlugins,
            locale: language,
            timezone: timezone,
            captureDebugArtifacts: debugMode
        )
        await runtime.setRuntimeLocale(language, debugToken: debugToken)
        let defaults = UserDefaults.standard
        defaults.set(serverURL, forKey: "serverURL")
        defaults.set(agentID, forKey: "agentID")
        defaults.set(agentName, forKey: "agentName")
        defaults.set(mumuInstanceName, forKey: "mumuInstanceName")
        defaults.set(allowUnsignedPlugins, forKey: "allowUnsignedPlugins")
        defaults.set(language, forKey: "language")
        defaults.set(timezone, forKey: "timezone")
        timezoneConfigured = true
        defaults.set(theme.rawValue, forKey: "theme")
        defaults.set(logDisplayMode.rawValue, forKey: "logDisplayMode")
        defaults.set(debugMode, forKey: "debugMode")
    }

    func syncLanguageToRuntime() async {
        await runtime.setRuntimeLocale(language, debugToken: debugToken)
    }

    func syncLanguageToBrowser() {
        browser.setLanguage(language)
    }

    func didSelectLanguage(_ language: String) {
        let defaults = UserDefaults.standard
        defaults.set(language, forKey: "language")
        defaults.set([language], forKey: "AppleLanguages")
        defaults.set(Self.appleLocale(for: language), forKey: "AppleLocale")
        showLanguageRestartPrompt = true
    }

    func restartForLanguage() {
        showLanguageRestartPrompt = false
        // AppKit localizes the process-owned menu bar while the application is
        // launching. Open a fresh instance after writing AppleLanguages so the
        // menu bar follows the in-App language choice without requiring the
        // user to open macOS System Settings.
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.createsNewApplicationInstance = true
        configuration.activates = true
        NSWorkspace.shared.openApplication(
            at: Bundle.main.bundleURL,
            configuration: configuration
        ) { _, _ in
            DispatchQueue.main.async {
                NSApp.terminate(nil)
            }
        }
    }

    private static func appleLocale(for language: String) -> String {
        switch language {
        case "zh-Hans": return "zh_CN"
        case "zh-Hant": return "zh_TW"
        case "ja": return "ja_JP"
        case "fr": return "fr_FR"
        default: return "en_US"
        }
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

    private static func taskLogGroups(in text: String) -> [TaskLogGroup] {
        var groups: [String: TaskLogGroup] = [:]
        var order: [String] = []
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let jsonStart = trimmed.firstIndex(of: "{"),
                  let data = String(trimmed[jsonStart...]).data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let runID = object["runId"] as? String,
                  !runID.isEmpty
            else { continue }
            let timestamp = (object["timestamp"] as? String)
                ?? (object["time"] as? String)
                ?? String(trimmed.prefix(24))
            var group = groups[runID] ?? TaskLogGroup(
                id: runID,
                taskKey: (object["taskKey"] as? String) ?? "",
                taskName: (object["taskName"] as? String) ?? (object["taskKey"] as? String) ?? "Task",
                executionMode: (object["executionMode"] as? String) ?? (object["mode"] as? String) ?? "unknown",
                startedAt: (object["startedAt"] as? String) ?? timestamp,
                finishedAt: nil,
                status: "running",
                finalMessage: nil,
                lines: []
            )
            group.lines.append(line)
            if let taskKey = object["taskKey"] as? String, !taskKey.isEmpty { group.taskKey = taskKey }
            if let taskName = object["taskName"] as? String, !taskName.isEmpty { group.taskName = taskName }
            if let mode = (object["executionMode"] as? String) ?? (object["mode"] as? String), !mode.isEmpty {
                group.executionMode = mode
            }
            if let startedAt = object["startedAt"] as? String, !startedAt.isEmpty { group.startedAt = startedAt }
            let event = object["event"] as? String
            if event == "task_finished" {
                group.finishedAt = (object["finishedAt"] as? String) ?? timestamp
                if let state = object["state"] as? String { group.status = state }
                else if let success = object["success"] as? Bool { group.status = success ? "succeeded" : "failed" }
                group.finalMessage = object["message"] as? String
            } else if event == "task_failure_detailed" {
                group.status = "failed"
                group.finalMessage = (object["message"] as? String) ?? (object["errorMessage"] as? String)
            }
            if !groups.keys.contains(runID) { order.append(runID) }
            groups[runID] = group
        }
        return order.compactMap { groups[$0] }.sorted {
            if $0.startedAt == $1.startedAt { return $0.id > $1.id }
            return $0.startedAt > $1.startedAt
        }
    }

    private static func simplifiedLogEntry(
        _ line: String,
        index: Int,
        language: String
    ) -> SimplifiedLogEntry {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        let jsonStart = trimmed.firstIndex(of: "{")
        let prefix = jsonStart.map { String(trimmed[..<$0]).trimmingCharacters(in: .whitespaces) } ?? ""
        let jsonText = jsonStart.map { String(trimmed[$0...]) } ?? ""
        let object = jsonText.data(using: .utf8)
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        let timestamp = (object?["timestamp"] as? String)
            ?? (object?["time"] as? String)
            ?? prefix
        let level = ((object?["level"] as? String) ?? "info").lowercased()
        let step = (object?["step"] as? String)
            ?? (object?["event"] as? String)
            ?? ""
        let fallbackMessage = (object?["message"] as? String)
            ?? (object?["error"] as? String)
            ?? (jsonStart == nil ? trimmed : jsonText)
        let message = localizedMessage(
            in: object,
            fallback: fallbackMessage,
            language: language
        )
        let debugImagePath = ((object?["detail"] as? [String: Any])?["debugImage"] as? String)
            ?? (object?["debugImage"] as? String)
        return SimplifiedLogEntry(
            id: "\(index)-\(trimmed.hashValue)",
            timestamp: timestamp,
            level: level,
            step: step,
            message: message,
            debugImagePath: debugImagePath
        )
    }

    private static func localizedRawLine(_ line: String, language: String) -> String {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let jsonStart = trimmed.firstIndex(of: "{"),
              let data = String(trimmed[jsonStart...]).data(using: .utf8),
              var object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let message = object["message"] as? String else {
            return line
        }
        let localized = localizedMessage(in: object, fallback: message, language: language)
        guard localized != message else { return line }
        object["message"] = localized
        guard let localizedData = try? JSONSerialization.data(
            withJSONObject: object,
            options: [.sortedKeys]
        ), let localizedJSON = String(data: localizedData, encoding: .utf8) else {
            return line
        }
        return String(trimmed[..<jsonStart]) + localizedJSON
    }

    private static func localizedMessage(
        in object: [String: Any]?,
        fallback: String,
        language: String
    ) -> String {
        let locale = taskLocale(for: language)
        let detail = object?["detail"] as? [String: Any]
        let messages = detail?["localizedMessages"] as? [String: Any]
        return messages?[locale] as? String ?? fallback
    }

    private static func taskLocale(for language: String) -> String {
        switch language {
        case "zh-Hant": return "zh-tw"
        case "zh-Hans": return "zh-cn"
        case "en": return "en"
        case "fr": return "fr"
        case "ja": return "ja"
        default: return "zh-cn"
        }
    }

    private static func preferredLanguage() -> String {
        let preferred = Locale.preferredLanguages.first ?? "en"
        if preferred.hasPrefix("zh-Hant") || preferred.hasPrefix("zh-TW") || preferred.hasPrefix("zh-HK") { return "zh-Hant" }
        if preferred.hasPrefix("zh") { return "zh-Hans" }
        if preferred.hasPrefix("ja") { return "ja" }
        if preferred.hasPrefix("fr") { return "fr" }
        return "en"
    }

    private static func parseTimestamp(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
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
