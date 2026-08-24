import SwiftUI
import AppKit

struct RootView: View {
    @EnvironmentObject private var model: AppModel
    var body: some View {
        ZStack {
            AppBackdrop()
            if model.isAppleSilicon && !model.setupCompleted {
                SetupAssistantView()
            } else if model.isAppleSilicon {
                NavigationSplitView(columnVisibility: .constant(.all)) {
                    SidebarView()
                        .navigationSplitViewColumnWidth(min: 210, ideal: 236, max: 270)
                } detail: {
                    detail
                        .safeAreaInset(edge: .bottom, spacing: 0) {
                            GlobalOperationStatusBar()
                        }
                }
                .navigationSplitViewStyle(.balanced)
                .toolbar(removing: .sidebarToggle)
                .ignoresSafeArea(.container, edges: .top)
                .background(.clear)
            } else {
                UnsupportedPlatformView()
            }
            WindowChromeConfigurator()
                .frame(width: 1, height: 1)
                .allowsHitTesting(false)
        }
        .environment(\.locale, model.locale)
        .onAppear {
            MenuLocalization.apply(language: model.language)
            model.syncLanguageToBrowser()
        }
        .onChange(of: model.language) { _, language in
            model.didSelectLanguage(language)
            for delay in [0.0, 0.15, 0.5] {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                    MenuLocalization.apply(language: language)
                }
            }
            model.syncLanguageToBrowser()
            Task { await model.syncLanguageToRuntime() }
        }
        .alert(
            model.text("Yume Life After Mac Agent"),
            isPresented: Binding(
                get: { model.alertMessage != nil || model.showLanguageRestartPrompt },
                set: {
                    if !$0 {
                        model.alertMessage = nil
                        model.showLanguageRestartPrompt = false
                    }
                }
            )
        ) {
            if model.showLanguageRestartPrompt {
                Button(model.text("Restart App")) { model.restartForLanguage() }
                Button(model.text("Later"), role: .cancel) {
                    model.showLanguageRestartPrompt = false
                }
            } else {
                Button(model.text("OK")) { model.alertMessage = nil }
            }
        } message: {
            Text(
                model.showLanguageRestartPrompt
                    ? model.text("Restart the App to apply the macOS menu language.")
                    : (model.alertMessage ?? "")
            )
        }
        .sheet(isPresented: $model.showAbout) { AboutView() }
        .sheet(isPresented: $model.showUpdateWizard) { UpdateWizardView() }
        .sheet(isPresented: $model.showMigrationExportOptions) {
            MigrationExportOptionsView()
        }
    }

    @ViewBuilder private var detail: some View {
        switch model.selection ?? .admin {
        case .logs: LogsView()
        case .plugins: PluginsView()
        case .admin: AdminView()
        case .settings: SettingsView()
        }
    }
}

private struct WindowChromeConfigurator: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        WindowChromeView()
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        (nsView as? WindowChromeView)?.configureWindow()
    }

    private final class WindowChromeView: NSView {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            configureWindow()
        }

        func configureWindow() {
            guard let window else { return }
            NativeWindowChrome.configure(window)
        }
    }
}

struct SidebarView: View {
    @EnvironmentObject private var model: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Image(nsImage: NSApp.applicationIconImage)
                    .resizable().scaledToFit()
                    .frame(width: 42, height: 42)
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Yume Life After")
                        .font(.headline)
                    Text("MAC AGENT")
                        .font(.caption2.weight(.bold))
                        .tracking(2)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 14)
            List(SidebarSection.allCases, selection: $model.selection) { section in
                Label(model.text(section.titleKey), systemImage: section.symbol)
                    .tag(section)
                    .padding(.vertical, 5)
            }
            .scrollContentBackground(.hidden)
            Spacer()
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Circle()
                        .fill(model.health?.ok == true ? .green : .orange)
                        .frame(width: 8, height: 8)
                    Text(model.text(model.health?.ok == true ? "Agent online" : "Agent offline"))
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                HStack(spacing: 8) {
                    SidebarAgentButton(symbol: "play.fill", title: "Start", tint: .green) {
                        await model.performAgentAction("start")
                    }
                    SidebarAgentButton(symbol: "arrow.clockwise", title: "Restart", tint: YumePalette.gold) {
                        await model.performAgentAction("restart")
                    }
                    SidebarAgentButton(symbol: "stop.fill", title: "Stop", tint: .orange) {
                        await model.performAgentAction("stop")
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 20)
        }
        .padding(.top, 6)
        .background(.thinMaterial)
    }
}

private struct SidebarAgentButton: View {
    @EnvironmentObject private var model: AppModel
    let symbol: String
    let title: String
    let tint: Color
    let action: () async -> Void

    var body: some View {
        Button {
            Task { await action() }
        } label: {
            Image(systemName: symbol)
                .font(.caption.weight(.bold))
                .frame(maxWidth: .infinity)
                .frame(height: 28)
                .foregroundStyle(tint)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        }
        .buttonStyle(.plain)
        .help(model.text(title))
        .disabled(model.isBusy)
    }
}

struct PageHeader: View {
    let eyebrow: LocalizedStringKey
    let title: LocalizedStringKey
    let summary: LocalizedStringKey
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(eyebrow)
                .font(.caption.weight(.bold))
                .tracking(2)
                .foregroundStyle(YumePalette.gold)
            Text(title)
                .font(.system(size: 34, weight: .bold, design: .rounded))
            Text(summary)
                .foregroundStyle(.secondary)
        }
    }
}

struct UpdateWizardView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.text("Update runtime")).font(.title2.bold())
                    Text(model.text("The App runtime, dependencies and OCR helper are updated together."))
                        .font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                if model.isBusy { ProgressView().controlSize(.small) }
            }
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(model.text("Update progress"))
                        .font(.caption.weight(.semibold))
                    Spacer()
                    Text("\(Int((model.updateProgress * 100).rounded()))%")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                ProgressView(value: model.updateProgress, total: 1)
                    .tint(model.updateResult?.contains("失败") == true || model.updateResult?.localizedCaseInsensitiveContains("failed") == true ? .orange : YumePalette.gold)
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(model.updateSteps.enumerated()), id: \.offset) { _, step in
                        Label(step, systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                    if model.updateSteps.isEmpty {
                        Text(model.text("Preparing update…")).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: 10) {
                Label(
                    model.nodeSummary,
                    systemImage: model.nodeInfo.isAvailable ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
                )
                .foregroundStyle(model.nodeInfo.isAvailable ? Color.secondary : Color.orange)
                if !model.nodeInfo.isAvailable && !model.isBusy {
                    Button(model.text("Download external Node.js")) {
                        Task { await model.downloadExternalNode() }
                    }
                    .buttonStyle(GlassButtonStyle())
                }
                Spacer()
                Label(
                    model.adbSummary,
                    systemImage: model.adbInfo.isAvailable ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
                )
                .foregroundStyle(model.adbInfo.isAvailable ? Color.secondary : Color.orange)
                if !model.adbInfo.isAvailable {
                    Button(model.text("Install Android platform-tools")) {
                        model.openAdbInstallGuide()
                    }
                    .buttonStyle(GlassButtonStyle())
                }
            }
            if let result = model.updateResult {
                Text(result)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(
                        result.localizedCaseInsensitiveContains("failed") || result.contains("失败")
                            ? .orange
                            : .green
                    )
            }
            Divider().opacity(0.35)
            HStack(spacing: 10) {
                Image(systemName: model.modelInfo.isInstalled ? "checkmark.circle.fill" : "arrow.down.circle")
                    .foregroundStyle(model.modelInfo.isInstalled ? .green : .orange)
                VStack(alignment: .leading, spacing: 3) {
                    Text(model.modelInfo.isInstalled
                        ? model.text("External Qwen model found.")
                        : model.text("External Qwen model is not installed."))
                        .font(.callout.weight(.semibold))
                    Text(model.text("The model is stored in Application Support and is not bundled in the App."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if !model.isBusy {
                    Button(model.modelInfo.isInstalled
                        ? model.text("Prepare Qwen runtime")
                        : model.text("Download Qwen model")) {
                        Task {
                            if model.modelInfo.isInstalled {
                                await model.prepareModelRuntime()
                            } else {
                                await model.downloadModel()
                            }
                        }
                    }
                    .buttonStyle(GlassButtonStyle())
                }
            }
            HStack {
                Spacer()
                if !model.isBusy, model.updateResult != nil {
                    Button(model.text("Close")) { dismiss() }
                        .buttonStyle(PrimaryButtonStyle())
                }
            }
        }
        .padding(24)
        .frame(width: 560, height: 420)
        .background(AppBackdrop())
        .interactiveDismissDisabled(model.isBusy || model.updateResult == nil)
    }
}

struct MetricCard: View {
    let title: LocalizedStringKey
    let value: String
    let symbol: String
    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: symbol).foregroundStyle(YumePalette.gold).font(.title2)
            VStack(alignment: .leading) {
                Text(value).font(.title2.bold())
                Text(title).font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel(radius: 18, padding: 12)
    }
}

private struct GlobalOperationStatusBar: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if !model.statusMessage.isEmpty {
            HStack(spacing: 12) {
                Group {
                    if model.isBusy {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    }
                }
                .frame(width: 22, height: 22)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Operation status")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(model.statusMessage)
                        .font(.callout.monospaced())
                        .lineLimit(2)
                        .textSelection(.enabled)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Button {
                    withAnimation(.easeOut(duration: 0.18)) {
                        model.statusMessage = ""
                    }
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.bold))
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .background(.thinMaterial, in: Circle())
                .help(model.text("Close"))
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(.white.opacity(0.18), lineWidth: 1)
            }
            .shadow(color: .black.opacity(0.22), radius: 18, y: 8)
            .padding(.horizontal, 30)
            .padding(.bottom, 18)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}

struct LogsView: View {
    @EnvironmentObject private var model: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                VStack(alignment: .leading, spacing: 8) {
                    Text(model.text("Observability"))
                        .font(.caption.weight(.bold))
                        .tracking(2)
                        .foregroundStyle(YumePalette.gold)
                    Text(model.text("Runtime logs"))
                        .font(.system(size: 34, weight: .bold, design: .rounded))
                    Text(model.text("The latest Agent output refreshes automatically."))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Picker(
                    model.text("Log display"),
                    selection: Binding(
                        get: { model.logDisplayMode },
                        set: { model.setLogDisplayMode($0) }
                    )
                ) {
                    ForEach(LogDisplayMode.allCases) { mode in
                        Text(model.text(mode.titleKey)).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 180)
                if model.logRunIdFilter != nil {
                    Button(model.text("Current task only")) { }
                        .buttonStyle(GlassButtonStyle())
                } else if model.latestRunId != nil {
                    Button(model.text("Current task")) { model.openCurrentTaskLogs() }
                        .buttonStyle(GlassButtonStyle())
                }
                if model.health?.activeRunId != nil {
                    Button(model.text("Cancel task")) {
                        Task { await model.cancelCurrentTask() }
                    }
                    .buttonStyle(GlassButtonStyle())
                }
                if model.logRunIdFilter != nil {
                    Button(model.text("All logs")) { model.showAllLogs() }
                        .buttonStyle(GlassButtonStyle())
                }
                Button(model.text("Clear logs")) { Task { await model.clearLogs() } }
                    .buttonStyle(GlassButtonStyle())
                Button(model.text("Refresh")) { Task { await model.refreshStatusAndLogs(loadLogs: true) } }
                    .buttonStyle(GlassButtonStyle())
            }
            ScrollViewReader { proxy in
                ScrollView {
                    if model.visibleLogLines.isEmpty {
                        Text(model.text("No log entries yet."))
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                            .id("bottom")
                    } else if model.logDisplayMode == .raw {
                        Text(verbatim: model.visibleLogText)
                            .font(.system(size: 12, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .id("raw")
                        Color.clear.frame(height: 1).id("bottom")
                    } else {
                        LazyVStack(alignment: .leading, spacing: 8) {
                            ForEach(model.visibleLogEntries) { entry in
                                SimpleLogRow(entry: entry)
                            }
                            Color.clear.frame(height: 1).id("bottom")
                        }
                    }
                }
                .glassPanel(radius: 20, padding: 16)
                .onChange(of: model.visibleLogLines) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
            }
            HStack {
                Spacer(minLength: 0)
                HStack(spacing: 12) {
                    Button(model.text("Previous")) { model.previousLogPage() }
                        .disabled(model.logPage == 0)
                    Text(model.logPageLabel)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .accessibilityLabel(model.text("Log page"))
                    Button(model.text("Next")) { model.nextLogPage() }
                        .disabled(model.logPage >= model.logPageCount - 1)
                }
                Spacer(minLength: 0)
            }
            .buttonStyle(GlassButtonStyle())
        }
        .frame(maxWidth: 900, maxHeight: .infinity, alignment: .topLeading)
        .padding(30)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .task { await model.refreshStatusAndLogs(loadLogs: true) }
    }
}

private struct SimpleLogRow: View {
    let entry: SimplifiedLogEntry

    private var levelColor: Color {
        switch entry.level {
        case "error", "fatal": .red
        case "warn", "warning": .orange
        default: .secondary
        }
    }

    private var symbol: String {
        switch entry.level {
        case "error", "fatal": "xmark.octagon.fill"
        case "warn", "warning": "exclamationmark.triangle.fill"
        default: "info.circle.fill"
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol)
                .foregroundStyle(levelColor)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    Text(entry.level.uppercased())
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(levelColor)
                    if !entry.step.isEmpty {
                        Text(entry.step)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer()
                    if !entry.timestamp.isEmpty {
                        Text(entry.timestamp)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.tertiary)
                    }
                }
                Text(entry.message)
                    .font(.callout)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(10)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

struct PluginsView: View {
    @EnvironmentObject private var model: AppModel
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(alignment: .bottom) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(model.text("Extensions"))
                            .font(.caption.weight(.bold))
                            .tracking(2)
                            .foregroundStyle(YumePalette.gold)
                        Text(model.text("Plugins"))
                            .font(.system(size: 34, weight: .bold, design: .rounded))
                        Text(model.text("Five plugins are bundled with the App. Add extra folder plugins from Application Support."))
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button(model.text("Open plugin folder")) { model.openPluginDirectory() }
                        .buttonStyle(PrimaryButtonStyle())
                    Button(model.text("Refresh")) { Task { await model.refreshPlugins() } }
                        .buttonStyle(GlassButtonStyle())
                }
                HStack(spacing: 12) {
                    MetricCard(
                        title: "Installed plugins",
                        value: "\(model.plugins.count)",
                        symbol: "puzzlepiece.extension"
                    )
                    MetricCard(
                        title: "Enabled plugins",
                        value: "\(model.plugins.filter { $0.enabled != false && $0.invalid != true }.count)",
                        symbol: "checkmark.circle"
                    )
                }
                ForEach(model.plugins) { plugin in
                    HStack(spacing: 16) {
                        Image(systemName: plugin.invalid == true ? "exclamationmark.triangle" : "puzzlepiece.extension.fill")
                            .font(.title2).foregroundStyle(plugin.invalid == true ? .red : YumePalette.gold)
                            .frame(width: 48, height: 48)
                            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        VStack(alignment: .leading, spacing: 4) {
                            Text(plugin.localizedName(model.language)).font(.headline)
                            Text(plugin.localizedSummary(model.language)).font(.callout).foregroundStyle(.secondary)
                            HStack {
                                Text(plugin.versionDescription)
                                Text(model.text(plugin.builtin == true ? "Built-in" : "Installed"))
                                if plugin.builtin != true {
                                    Label(
                                        model.text(plugin.signatureVerified == true ? "Verified" : "Unverified"),
                                        systemImage: plugin.signatureVerified == true ? "checkmark.seal.fill" : "exclamationmark.shield"
                                    )
                                }
                            }.font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button(model.text(plugin.enabled == false ? "Enable" : "Disable")) {
                            Task { await model.setPlugin(plugin, enabled: plugin.enabled == false) }
                        }
                        .buttonStyle(GlassButtonStyle())
                        if plugin.builtin != true {
                            Button(model.text("Remove")) { Task { await model.removePlugin(plugin) } }
                                .buttonStyle(GlassButtonStyle())
                        }
                    }
                    .glassPanel(radius: 20, padding: 16)
                }
            }
            .frame(maxWidth: 900, alignment: .leading)
            .padding(30)
        }
    }
}

struct AdminView: View {
    @EnvironmentObject private var model: AppModel
    var body: some View {
        ZStack(alignment: .topTrailing) {
            AdminWebView(browser: model.browser)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            HStack(spacing: 10) {
                Label(
                    model.browser.pageTitle.isEmpty ? model.text("Camp admin") : model.browser.pageTitle,
                    systemImage: "lock.shield"
                )
                if model.browser.isLoading { ProgressView().controlSize(.small) }
                Button(model.text("Reload")) { model.browser.reload() }
                    .buttonStyle(GlassButtonStyle())
            }
            .padding(10)
            .background(.regularMaterial, in: Capsule())
            .padding(12)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.opacity(0.18))
        .ignoresSafeArea(.container, edges: .top)
    }
}

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(model.text("System section"))
                        .font(.caption.weight(.bold))
                        .tracking(2)
                        .foregroundStyle(YumePalette.gold)
                    Text(model.text("Settings"))
                        .font(.system(size: 34, weight: .bold, design: .rounded))
                    Text(model.text("Configure the Agent runtime, language and local data."))
                        .foregroundStyle(.secondary)
                }

                SettingsCard(title: model.text("Appearance"), symbol: "paintbrush.fill") {
                    Picker(model.text("Language"), selection: $model.language) {
                        Text("简体中文").tag("zh-Hans")
                        Text("繁體中文").tag("zh-Hant")
                        Text("English").tag("en")
                        Text("日本語").tag("ja")
                        Text("Français").tag("fr")
                    }
                    Picker(model.text("Theme"), selection: $model.theme) {
                        ForEach(AppTheme.allCases) { theme in
                            Text(model.text(theme.titleKey)).tag(theme)
                        }
                    }
                    Picker(
                        model.text("Log display"),
                        selection: Binding(
                            get: { model.logDisplayMode },
                            set: { model.setLogDisplayMode($0) }
                        )
                    ) {
                        ForEach(LogDisplayMode.allCases) { mode in
                            Text(model.text(mode.titleKey)).tag(mode)
                        }
                    }
                }

                SettingsCard(title: model.text("Runtime tools"), symbol: "wrench.and.screwdriver.fill") {
                    HStack(spacing: 12) {
                        SettingsStatusRow(
                            title: "Node.js",
                            value: model.nodeSummary,
                            available: model.nodeInfo.isAvailable
                        )
                        SettingsStatusRow(
                            title: "ADB",
                            value: model.adbSummary,
                            available: model.adbInfo.isAvailable
                        )
                    }
                    HStack(spacing: 10) {
                        Button(model.text("Update runtime")) {
                            Task { await model.performAgentAction("update") }
                        }
                        .buttonStyle(PrimaryButtonStyle())
                        Button(model.text("Repair Agent")) {
                            Task { await model.performAgentAction("repair") }
                        }
                        .buttonStyle(GlassButtonStyle())
                        .help(model.text("Repair Agent help"))
                        Button(model.text("Uninstall Agent")) {
                            Task { await model.performAgentAction("uninstall") }
                        }
                        .buttonStyle(GlassButtonStyle())
                    }
                    HStack(spacing: 10) {
                        if !model.nodeInfo.isAvailable {
                            Button(model.text("Install Node.js")) { model.openNodeInstallGuide() }
                                .buttonStyle(.link)
                        }
                        if !model.adbInfo.isAvailable {
                            Button(model.text("Install Android platform-tools")) { model.openAdbInstallGuide() }
                                .buttonStyle(.link)
                        }
                    }
                }

                SettingsCard(title: model.text("Connection"), symbol: "network") {
                    SettingsField(label: model.text("Workers URL")) {
                        TextField("", text: $model.serverURL)
                            .textFieldStyle(.roundedBorder)
                    }
                    SettingsField(label: model.text("Agent device name")) {
                        TextField("", text: $model.agentName)
                            .textFieldStyle(.roundedBorder)
                    }
                    SettingsField(label: model.text("MuMu container name")) {
                        TextField("", text: $model.mumuInstanceName)
                            .textFieldStyle(.roundedBorder)
                        Text(model.text("The Agent matches this MuMu container name and discovers its current loopback ADB port automatically."))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    SettingsField(label: model.text("Device ID")) {
                        Text(model.agentID)
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 9)
                            .padding(.vertical, 7)
                            .background(.black.opacity(0.24), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                    }
                    SettingsField(label: model.text("Agent token")) {
                        SecureField("", text: $model.agentToken)
                            .textFieldStyle(.roundedBorder)
                    }
                    SettingsField(label: model.text("Local debug token")) {
                        SecureField("", text: $model.debugToken)
                            .textFieldStyle(.roundedBorder)
                    }
                    SettingsField(label: model.text("Admin access Key (optional)")) {
                        SecureField("", text: $model.adminKey)
                            .textFieldStyle(.roundedBorder)
                    }
                }

                SettingsCard(title: model.text("External Qwen model"), symbol: "eye.circle.fill") {
                    Text(model.modelInfo.path.isEmpty
                        ? model.text("The external Qwen model has not been checked yet.")
                        : model.modelInfo.path)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                    HStack {
                        Label(
                            model.modelInfo.isInstalled
                                ? (model.modelInfo.isReady
                                    ? model.text("Qwen model runtime is ready.")
                                    : model.text("Qwen model runtime needs preparation."))
                                : model.text("External Qwen model is not installed."),
                            systemImage: model.modelInfo.isReady ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
                        )
                        Spacer()
                        if !model.modelInfo.isReady {
                            Button(model.modelInfo.isInstalled
                                ? model.text("Prepare Qwen runtime")
                                : model.text("Download Qwen model")) {
                                Task {
                                    if model.modelInfo.isInstalled {
                                        await model.prepareModelRuntime()
                                    } else {
                                        await model.downloadModel()
                                    }
                                }
                            }
                            .buttonStyle(GlassButtonStyle())
                        }
                    }
                    Toggle(
                        model.text("Enable Qwen visual assistance for tasks"),
                        isOn: Binding(
                            get: { model.qwenEnabled },
                            set: { enabled in Task { await model.setQwenEnabled(enabled) } }
                        )
                    )
                    .disabled(model.isBusy)
                    Text(model.qwenEnabled
                        ? model.text("Qwen visual assistance is enabled for task runs.")
                        : model.text("Qwen visual assistance is disabled; tasks use OCR and deterministic steps."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                SettingsCard(title: model.text("Plugin security"), symbol: "puzzlepiece.extension.fill") {
                    Toggle(model.text("Allow unsigned local plugins (developer mode)"), isOn: $model.allowUnsignedPlugins)
                    Text(model.text("Extra plugins are loaded from the Application Support plugin folder. Bundled plugins cannot be removed or replaced."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                SettingsCard(title: model.text("Migration"), symbol: "arrow.triangle.2.circlepath") {
                    Text(model.text("Choose whether to include the external Qwen model and saved credentials when exporting. Credentials are sensitive."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    HStack(spacing: 10) {
                        Button(model.text("Export migration archive…")) { Task { await model.exportMigration() } }
                            .buttonStyle(GlassButtonStyle())
                        Button(model.text("Import migration archive…")) { Task { await model.importMigration() } }
                            .buttonStyle(GlassButtonStyle())
                    }
                }

                HStack(spacing: 10) {
                    Button(model.text("Save settings")) { Task { await model.saveSettings() } }
                        .buttonStyle(PrimaryButtonStyle())
                    Button(model.text("Run setup assistant again")) { model.openSetupAssistant() }
                        .buttonStyle(GlassButtonStyle())
                }
            }
            .frame(maxWidth: 900, alignment: .leading)
            .padding(30)
        }
        .frame(maxWidth: .infinity, alignment: .center)
    }
}

private struct SettingsCard<Content: View>: View {
    let title: String
    let symbol: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(title, systemImage: symbol)
                .font(.headline)
                .foregroundStyle(YumePalette.gold)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel(radius: 20, padding: 18)
    }
}

private struct SettingsField<Content: View>: View {
    let label: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            content()
        }
    }
}

private struct SettingsStatusRow: View {
    let title: String
    let value: String
    let available: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            Label(value, systemImage: available ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(available ? Color.secondary : Color.orange)
                .font(.callout.monospaced())
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
    }
}

struct UnsupportedPlatformView: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "cpu.fill").font(.system(size: 52)).foregroundStyle(YumePalette.gold)
            Text("Apple Silicon required").font(.largeTitle.bold())
            Text("Yume Life After Mac Agent supports M-series Macs only. Intel Macs and Rosetta are not supported.")
                .multilineTextAlignment(.center).foregroundStyle(.secondary).frame(maxWidth: 520)
        }.glassPanel().padding(60)
    }
}

struct AboutView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    private var versionDescription: String {
        let version = Bundle.main.object(
            forInfoDictionaryKey: "CFBundleShortVersionString"
        ) as? String ?? "—"
        let build = Bundle.main.object(
            forInfoDictionaryKey: "CFBundleVersion"
        ) as? String ?? "—"
        return "\(version) (Build \(build)) · Apple Silicon · arm64"
    }
    var body: some View {
        VStack(spacing: 14) {
            HStack {
                Spacer()
                Button { dismiss() } label: { Image(systemName: "xmark") }
                    .buttonStyle(GlassButtonStyle())
                    .accessibilityLabel("Close")
            }
            Image(nsImage: NSApp.applicationIconImage).resizable().scaledToFit().frame(width: 72, height: 72)
            Text("Yume Life After Mac Agent").font(.title.bold())
            Text(versionDescription).foregroundStyle(.secondary)
            Text(model.text("A local control center for the LifeAfter camp assistant."))
                .multilineTextAlignment(.center)
            Text(model.text("Copyright © 2026 Yume Internet LLC. All rights reserved."))
                .font(.caption).foregroundStyle(.secondary)
        }.padding(22).frame(width: 460, height: 350).background(AppBackdrop())
    }
}

struct SetupAssistantView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 22) {
            HStack(spacing: 12) {
                Image(nsImage: NSApp.applicationIconImage)
                    .resizable().scaledToFit().frame(width: 48, height: 48)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Yume Life After Mac Agent").font(.title2.bold())
                    Text("SETUP ASSISTANT").font(.caption2.bold()).tracking(2).foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 8) {
                ForEach(0..<3) { step in
                    Capsule()
                        .fill(step <= model.setupStep ? YumePalette.gold : .secondary.opacity(0.25))
                        .frame(width: step == model.setupStep ? 46 : 20, height: 6)
                        .animation(.spring(response: 0.3), value: model.setupStep)
                }
            }
            Group {
                if model.setupStep == 0 { connectionStep }
                else if model.setupStep == 1 { tokenStep }
                else { finishStep }
            }
            .frame(maxWidth: .infinity, minHeight: 270, alignment: .topLeading)
            HStack {
                if model.setupStep > 0 {
                    Button("Back") { model.setupStep -= 1 }.buttonStyle(GlassButtonStyle())
                }
                Spacer()
                if model.setupStep < 2 {
                    Button("Continue") { model.setupStep += 1 }
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(model.setupStep == 0 && (!model.nodeInfo.isAvailable || !model.adbInfo.isAvailable))
                } else {
                    Button("Save, install and finish") { Task { await model.completeSetup() } }
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(model.isBusy)
                }
            }
        }
        .padding(30)
        .frame(width: 680)
        .glassPanel(radius: 30, padding: 0)
        .padding(50)
    }

    private var connectionStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Connect to Workers and MuMu").font(.title.bold())
            Text("Enter the public HTTPS site, a device name and the exact MuMu container name. The stable device ID is generated automatically.")
                .foregroundStyle(.secondary)
            TextField("Workers URL", text: $model.serverURL).textFieldStyle(.roundedBorder)
            TextField("Agent device name", text: $model.agentName).textFieldStyle(.roundedBorder)
            TextField("MuMu container name", text: $model.mumuInstanceName).textFieldStyle(.roundedBorder)
            HStack(spacing: 10) {
                Label(
                    model.nodeSummary,
                    systemImage: model.nodeInfo.isAvailable ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
                )
                .foregroundStyle(model.nodeInfo.isAvailable ? Color.secondary : Color.orange)
                if !model.nodeInfo.isAvailable {
                    Button("Install Node.js") { model.openNodeInstallGuide() }
                        .buttonStyle(GlassButtonStyle())
                }
            }
            HStack(spacing: 10) {
                Label(
                    model.adbSummary,
                    systemImage: model.adbInfo.isAvailable ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
                )
                .foregroundStyle(model.adbInfo.isAvailable ? Color.secondary : Color.orange)
                if !model.adbInfo.isAvailable {
                    Button("Install Android platform-tools") { model.openAdbInstallGuide() }
                        .buttonStyle(GlassButtonStyle())
                }
            }
            Text("Install Node.js 22 arm64 on this Mac before continuing. The App does not package Node.js.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("Install Android platform-tools too. The App detects the system adb and does not package it.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var tokenStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Secure credentials").font(.title.bold())
            Text("Tokens are stored in an owner-only local credentials file. Migration export includes them only if you explicitly select saved credentials.")
                .foregroundStyle(.secondary)
            SecureField("Agent token", text: $model.agentToken).textFieldStyle(.roundedBorder)
            SecureField("Local debug token", text: $model.debugToken).textFieldStyle(.roundedBorder)
            SecureField("Admin access Key (optional)", text: $model.adminKey).textFieldStyle(.roundedBorder)
        }
    }

    private var finishStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Ready to install").font(.title.bold())
            Text("The assistant will create config.json, register the launch agent, verify macOS Node.js and system ADB, then keep OCR resources inside the App.")
                .foregroundStyle(.secondary)
            Label(model.serverURL, systemImage: "network")
            Label(model.agentName, systemImage: "desktopcomputer")
            Label(model.agentID, systemImage: "number")
                .font(.caption.monospaced())
            Label(model.mumuInstanceName, systemImage: "square.stack.3d.up")
            Label("5 bundled task plugins", systemImage: "puzzlepiece.extension.fill")
            HStack(spacing: 10) {
                Label(
                    model.modelInfo.isInstalled
                        ? model.text("External Qwen model found.")
                        : model.text("External Qwen model is not installed."),
                    systemImage: model.modelInfo.isInstalled ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
                )
                .foregroundStyle(model.modelInfo.isInstalled ? Color.secondary : Color.orange)
                Spacer()
                if !model.modelInfo.isInstalled && !model.isBusy {
                    Button(model.text("Download Qwen model")) {
                        Task { await model.downloadModel() }
                    }
                    .buttonStyle(GlassButtonStyle())
                } else if model.modelInfo.isInstalled && !model.modelInfo.isReady && !model.isBusy {
                    Button(model.text("Prepare Qwen runtime")) {
                        Task { await model.prepareModelRuntime() }
                    }
                    .buttonStyle(GlassButtonStyle())
                }
            }
            Button(model.text("Restore from migration archive…")) {
                Task { await model.restoreMigrationForSetup() }
            }
            .buttonStyle(GlassButtonStyle())
            if model.isBusy {
                ProgressView(model.setupProgressMessage.isEmpty ? model.text("Preparing installation…") : model.setupProgressMessage)
            } else if !model.setupProgressMessage.isEmpty {
                Label(model.setupProgressMessage, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
            }
        }
    }
}

struct MigrationExportOptionsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(model.text("Export migration archive")).font(.title2.bold())
            Text(model.text("Choose which external data to include. The App never includes these items unless you select them."))
                .foregroundStyle(.secondary)
            Toggle(
                model.text("Include external Qwen model"),
                isOn: Binding(
                    get: { model.migrationIncludeModel },
                    set: { model.migrationIncludeModel = $0 }
                )
            )
            Toggle(
                model.text("Include saved credentials"),
                isOn: Binding(
                    get: { model.migrationIncludeCredentials },
                    set: { model.migrationIncludeCredentials = $0 }
                )
            )
            if model.migrationIncludeCredentials {
                Label(model.text("Credentials are sensitive and will be included in the archive."), systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            HStack {
                Spacer()
                Button(model.text("Cancel")) { dismiss() }
                    .buttonStyle(GlassButtonStyle())
                Button(model.text("Export")) {
                    Task {
                        await model.confirmExportMigration(
                            includeModel: model.migrationIncludeModel,
                            includeCredentials: model.migrationIncludeCredentials
                        )
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
            }
        }
        .padding(24)
        .frame(width: 520)
        .background(AppBackdrop())
    }
}
