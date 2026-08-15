import SwiftUI
import AppKit

@MainActor
final class YumeLifeAfterMacAgentAppDelegate: NSObject, NSApplicationDelegate {
    private var terminationInProgress = false
    private var statusItem: NSStatusItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            button.image = NSImage(
                systemSymbolName: "gamecontroller.fill",
                accessibilityDescription: "Yume Life After Mac Agent"
            )
            button.imagePosition = .imageOnly
            button.toolTip = "Yume Life After Mac Agent"
            button.target = self
            button.action = #selector(statusItemAction(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        statusItem = item
    }

    func applicationShouldTerminateAfterLastWindowClosed(
        _ sender: NSApplication
    ) -> Bool {
        // Closing the window hides the control surface but deliberately keeps
        // the Agent and its LaunchAgent alive. Use the status-item right click
        // to perform the explicit application quit below.
        false
    }

    @objc private func statusItemAction(_ sender: Any?) {
        let event = NSApp.currentEvent
        if event?.type == .rightMouseUp || event?.buttonNumber == 2 {
            NSApp.terminate(nil)
            return
        }
        showMainWindow()
    }

    private func showMainWindow() {
        NSApp.activate(ignoringOtherApps: true)
        let windows = NSApp.windows.filter { $0.canBecomeKey && !$0.isSheet }
        let window = windows.first(where: { $0.level == .normal }) ?? windows.first
        window?.makeKeyAndOrderFront(nil)
    }

    func applicationShouldTerminate(
        _ sender: NSApplication
    ) -> NSApplication.TerminateReply {
        guard !terminationInProgress else { return .terminateNow }
        terminationInProgress = true
        Task {
            // The LaunchAgent is owned by the App. Stopping it on normal App
            // termination prevents the web console from keeping this device
            // online and accepting tasks after the UI has been closed.
            _ = try? await RuntimeService.shared.run(["stop"], timeout: 30)
            await MainActor.run {
                NSApp.reply(toApplicationShouldTerminate: true)
            }
        }
        return .terminateLater
    }
}

@main
struct YumeLifeAfterMacAgentApp: App {
    @NSApplicationDelegateAdaptor(YumeLifeAfterMacAgentAppDelegate.self)
    private var appDelegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .preferredColorScheme(model.theme.colorScheme)
                .frame(minWidth: 1040, minHeight: 680)
                .task { await model.bootstrap() }
        }
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .appInfo) {
                Button(model.text("About Yume Life After Mac Agent")) {
                    model.showAbout = true
                }
            }
        }
        Settings {
            SettingsView()
                .environmentObject(model)
                .preferredColorScheme(model.theme.colorScheme)
                .frame(width: 620, height: 520)
        }
    }
}

enum AppTheme: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
    var titleKey: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }
}
