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
                NavigationSplitView {
                    SidebarView()
                        .navigationSplitViewColumnWidth(min: 210, ideal: 236, max: 270)
                } detail: {
                    detail
                        .safeAreaInset(edge: .bottom, spacing: 0) {
                            GlobalOperationStatusBar()
                        }
                }
                .background(.clear)
            } else {
                UnsupportedPlatformView()
            }
        }
        .environment(\.locale, model.locale)
        .alert(
            model.text("Yume Life After Mac Agent"),
            isPresented: Binding(
                get: { model.alertMessage != nil },
                set: { if !$0 { model.alertMessage = nil } }
            )
        ) {
            Button(model.text("OK")) { model.alertMessage = nil }
        } message: {
            Text(model.alertMessage ?? "")
        }
        .sheet(isPresented: $model.showAbout) { AboutView() }
    }

    @ViewBuilder private var detail: some View {
        switch model.selection ?? .overview {
        case .overview: OverviewView()
        case .tasks: TasksView()
        case .logs: LogsView()
        case .plugins: PluginsView()
        case .admin: AdminView()
        case .settings: SettingsView()
        }
    }
}

struct SidebarView: View {
    @EnvironmentObject private var model: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
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
            HStack(spacing: 8) {
                Circle()
                    .fill(model.health?.ok == true ? .green : .orange)
                    .frame(width: 8, height: 8)
                Text(model.text(model.health?.ok == true ? "Agent online" : "Agent offline"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(14)
        }
        .padding(.top, 12)
        .background(.thinMaterial)
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

struct OverviewView: View {
    @EnvironmentObject private var model: AppModel
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                PageHeader(eyebrow: "LOCAL AGENT", title: "Control center", summary: "Run, inspect and maintain the Mac automation runtime.")
                HStack(alignment: .top, spacing: 16) {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            Label(model.text(model.health?.ok == true ? "Online" : "Offline"), systemImage: model.health?.ok == true ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                                .font(.title3.weight(.semibold))
                            Spacer()
                            Text(model.health?.activeTaskKey ?? model.text("Idle"))
                                .font(.caption.monospaced())
                                .padding(.horizontal, 10).padding(.vertical, 6)
                                .background(.thinMaterial, in: Capsule())
                        }
                        Text(model.health?.adbSerial ?? model.text("ADB not connected"))
                            .font(.callout.monospaced())
                            .foregroundStyle(.secondary)
                        HStack(spacing: 8) {
                            Label(
                                model.nodeSummary,
                                systemImage: model.nodeInfo.isAvailable ? "checkmark.circle" : "exclamationmark.triangle"
                            )
                            .font(.caption)
                            .foregroundStyle(model.nodeInfo.isAvailable ? Color.secondary : Color.orange)
                            if !model.nodeInfo.isAvailable {
                                Button("Install Node.js") { model.openNodeInstallGuide() }
                                    .buttonStyle(.link)
                            }
                        }
                        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                            OverviewActionButton("Start", primary: true) { await model.performAgentAction("start") }
                            OverviewActionButton("Stop") { await model.performAgentAction("stop") }
                            OverviewActionButton("Restart") { await model.performAgentAction("restart") }
                            OverviewActionButton(
                                "Repair Agent",
                                help: model.text("Repair Agent help")
                            ) { await model.performAgentAction("repair") }
                            OverviewActionButton("Update runtime") { await model.performAgentAction("update") }
                            OverviewActionButton("Uninstall Agent") { await model.performAgentAction("uninstall") }
                        }
                        .disabled(model.isBusy)
                    }
                    .frame(maxWidth: .infinity, minHeight: 220, maxHeight: 220, alignment: .topLeading)
                    .glassPanel()
                    VStack(spacing: 10) {
                        MetricCard(title: "Installed plugins", value: "\(model.plugins.count)", symbol: "puzzlepiece.extension")
                        MetricCard(title: "Enabled plugins", value: "\(model.plugins.filter { $0.enabled != false && $0.invalid != true }.count)", symbol: "checkmark.circle")
                        Button {
                            model.openCurrentTaskLogs()
                        } label: {
                            MetricCard(title: "Current task", value: model.health?.activeTaskKey == nil ? model.text("None") : "1", symbol: "play.circle")
                        }
                        .buttonStyle(.plain)
                        .disabled(model.health?.activeRunId == nil)
                    }
                    .frame(maxWidth: .infinity, minHeight: 220, maxHeight: 220, alignment: .center)
                    .glassPanel()
                }
            }
            .padding(30)
        }
    }
}

private struct OverviewActionButton: View {
    let title: LocalizedStringKey
    let primary: Bool
    let help: String?
    let action: () async -> Void

    init(
        _ title: LocalizedStringKey,
        primary: Bool = false,
        help: String? = nil,
        action: @escaping () async -> Void
    ) {
        self.title = title
        self.primary = primary
        self.help = help
        self.action = action
    }

    @ViewBuilder var body: some View {
        if primary {
            button.buttonStyle(PrimaryButtonStyle())
        } else {
            button.buttonStyle(GlassButtonStyle())
        }
    }

    private var button: some View {
        Button { Task { await action() } } label: {
            Text(title)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity, minHeight: 40)
        }
        .help(help ?? "")
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

struct TasksView: View {
    @EnvironmentObject private var model: AppModel
    let columns = [GridItem(.adaptive(minimum: 260), spacing: 16)]
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                PageHeader(eyebrow: "WORKERS QUEUE", title: "Manual tasks", summary: "Submit a task using the authenticated Camp admin session.")
                if model.browser.webView.url?.host != URL(string: model.serverURL)?.host {
                    Label("Open Camp admin and sign in before submitting a task.", systemImage: "person.crop.circle.badge.exclamationmark")
                        .glassPanel(radius: 18, padding: 14)
                }
                LazyVGrid(columns: columns, spacing: 16) {
                    ForEach(ManualTask.supported) { task in
                        VStack(alignment: .leading, spacing: 12) {
                            Image(systemName: task.symbol)
                                .font(.title2)
                                .foregroundStyle(YumePalette.gold)
                            Text(model.text(task.titleKey)).font(.headline)
                            Text(model.text(task.summaryKey))
                                .font(.callout).foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Button("Run now") { Task { await model.submit(task) } }
                                .buttonStyle(PrimaryButtonStyle())
                                .disabled(model.isBusy)
                        }
                        .frame(minHeight: 150, alignment: .topLeading)
                        .glassPanel()
                    }
                }
            }
            .padding(30)
        }
    }
}

struct LogsView: View {
    @EnvironmentObject private var model: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                PageHeader(eyebrow: "OBSERVABILITY", title: "Runtime logs", summary: "The latest Agent output refreshes automatically.")
                Spacer()
                if model.logRunIdFilter != nil {
                    Button("Current task only") { }
                        .buttonStyle(GlassButtonStyle())
                } else if model.latestRunId != nil {
                    Button("Current task") { model.openCurrentTaskLogs() }
                        .buttonStyle(GlassButtonStyle())
                }
                if model.logRunIdFilter != nil {
                    Button("All logs") { model.showAllLogs() }
                        .buttonStyle(GlassButtonStyle())
                }
                Button("Clear logs") { Task { await model.clearLogs() } }
                    .buttonStyle(GlassButtonStyle())
                Button("Refresh") { Task { await model.refreshStatusAndLogs(loadLogs: true) } }.buttonStyle(GlassButtonStyle())
            }
            ScrollViewReader { proxy in
                ScrollView {
                    if model.visibleLogLines.isEmpty {
                        Text(model.text("No log entries yet."))
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                            .id("bottom")
                    } else {
                        LazyVStack(alignment: .leading, spacing: 2) {
                            ForEach(Array(model.visibleLogLines.enumerated()), id: \.offset) { _, line in
                                Text(verbatim: line)
                                    .font(.system(size: 12, design: .monospaced))
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            Color.clear.frame(height: 1).id("bottom")
                        }
                    }
                }
                .glassPanel(radius: 20, padding: 16)
                .onChange(of: model.visibleLogLines) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
            }
            HStack {
                Button("Previous") { model.previousLogPage() }
                    .disabled(model.logPage == 0)
                Text(model.logPageLabel).monospacedDigit().foregroundStyle(.secondary)
                Button("Next") { model.nextLogPage() }
                    .disabled(model.logPage >= model.logPageCount - 1)
                Spacer()
            }
            .buttonStyle(GlassButtonStyle())
        }
        .padding(30)
        .task { await model.refreshStatusAndLogs(loadLogs: true) }
    }
}

struct PluginsView: View {
    @EnvironmentObject private var model: AppModel
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(alignment: .bottom) {
                    PageHeader(eyebrow: "EXTENSIONS", title: "Plugins", summary: "Five plugins are bundled with the App. Add extra folder plugins from Application Support.")
                    Spacer()
                    Button("Open plugin folder") { model.openPluginDirectory() }.buttonStyle(PrimaryButtonStyle())
                    Button("Refresh") { Task { await model.refreshPlugins() } }.buttonStyle(GlassButtonStyle())
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
                                Text(plugin.builtin == true ? "Built-in" : "Installed")
                                if plugin.builtin != true {
                                    Label(plugin.signatureVerified == true ? "Verified" : "Unverified", systemImage: plugin.signatureVerified == true ? "checkmark.seal.fill" : "exclamationmark.shield")
                                }
                            }.font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button(plugin.enabled == false ? "Enable" : "Disable") {
                            Task { await model.setPlugin(plugin, enabled: plugin.enabled == false) }
                        }
                        .buttonStyle(GlassButtonStyle())
                        if plugin.builtin != true {
                            Button("Remove") { Task { await model.removePlugin(plugin) } }
                                .buttonStyle(GlassButtonStyle())
                        }
                    }
                    .glassPanel(radius: 20, padding: 16)
                }
            }.padding(30)
        }
    }
}

struct AdminView: View {
    @EnvironmentObject private var model: AppModel
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label(model.browser.pageTitle.isEmpty ? model.text("Camp admin") : model.browser.pageTitle, systemImage: "lock.shield")
                Spacer()
                if model.browser.isLoading { ProgressView().controlSize(.small) }
                Button("Reload") { model.browser.reload() }.buttonStyle(GlassButtonStyle())
            }
            .padding(14)
            Divider().opacity(0.35)
            AdminWebView(browser: model.browser)
        }
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).stroke(.white.opacity(0.15)))
        .padding(22)
    }
}

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    var body: some View {
        ScrollView {
            Form {
                Section("Connection") {
                    TextField("Workers URL", text: $model.serverURL)
                    TextField("Agent device name", text: $model.agentName)
                    LabeledContent("Device ID") {
                        Text(model.agentID).font(.caption.monospaced()).textSelection(.enabled)
                    }
                    TextField("MuMu container name", text: $model.mumuInstanceName)
                    SecureField("Agent token", text: $model.agentToken)
                    SecureField("Local debug token", text: $model.debugToken)
                    SecureField("Admin access Key (optional)", text: $model.adminKey)
                    Button("Import legacy Keychain credentials…") {
                        Task { await model.loadStoredCredentials() }
                    }
                    .buttonStyle(GlassButtonStyle())
                    Text("The Agent matches this MuMu container name and discovers its current loopback ADB port automatically.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("Appearance") {
                    Picker("Language", selection: $model.language) {
                        Text("简体中文").tag("zh-Hans")
                        Text("繁體中文").tag("zh-Hant")
                        Text("English").tag("en")
                        Text("日本語").tag("ja")
                        Text("Français").tag("fr")
                    }
                    Picker("Theme", selection: $model.theme) {
                        ForEach(AppTheme.allCases) { theme in Text(model.text(theme.titleKey)).tag(theme) }
                    }
                }
                Section("Plugin security") {
                    Toggle("Allow unsigned local plugins (developer mode)", isOn: $model.allowUnsignedPlugins)
                    Text("Extra plugins are loaded from the Application Support plugin folder. Bundled plugins cannot be removed or replaced.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("Migration") {
                    Text("The migration archive includes settings and user plugins, but never credentials.")
                        .font(.caption).foregroundStyle(.secondary)
                    HStack {
                        Button("Export migration archive…") { Task { await model.exportMigration() } }
                            .buttonStyle(GlassButtonStyle())
                        Button("Import migration archive…") { Task { await model.importMigration() } }
                            .buttonStyle(GlassButtonStyle())
                    }
                }
                Button("Save settings") { Task { await model.saveSettings() } }
                    .buttonStyle(PrimaryButtonStyle())
                Button("Run setup assistant again") { model.openSetupAssistant() }
                    .buttonStyle(GlassButtonStyle())
            }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
        }
        .padding(22)
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
                        .disabled(model.setupStep == 0 && !model.nodeInfo.isAvailable)
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
            Text("Install Node.js 22 arm64 on this Mac before continuing. The App does not package Node.js.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var tokenStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Secure credentials").font(.title.bold())
            Text("Tokens are stored in an owner-only local credentials file and are never included in the App or migration archive.")
                .foregroundStyle(.secondary)
            SecureField("Agent token", text: $model.agentToken).textFieldStyle(.roundedBorder)
            SecureField("Local debug token", text: $model.debugToken).textFieldStyle(.roundedBorder)
            SecureField("Admin access Key (optional)", text: $model.adminKey).textFieldStyle(.roundedBorder)
                    Button("Import legacy Keychain credentials…") {
                        Task { await model.loadStoredCredentials() }
            }
            .buttonStyle(GlassButtonStyle())
        }
    }

    private var finishStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Ready to install").font(.title.bold())
            Text("The assistant will create config.json, register the launch agent, verify macOS Node.js and keep arm64 ADB/OCR resources inside the App.")
                .foregroundStyle(.secondary)
            Label(model.serverURL, systemImage: "network")
            Label(model.agentName, systemImage: "desktopcomputer")
            Label(model.agentID, systemImage: "number")
                .font(.caption.monospaced())
            Label(model.mumuInstanceName, systemImage: "square.stack.3d.up")
            Label("5 bundled task plugins", systemImage: "puzzlepiece.extension.fill")
            if model.isBusy {
                ProgressView(model.setupProgressMessage.isEmpty ? model.text("Preparing installation…") : model.setupProgressMessage)
            } else if !model.setupProgressMessage.isEmpty {
                Label(model.setupProgressMessage, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
            }
        }
    }
}
