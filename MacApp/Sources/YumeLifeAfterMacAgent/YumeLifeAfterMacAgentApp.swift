import SwiftUI
import AppKit

@MainActor
final class YumeLifeAfterMacAgentAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var terminationInProgress = false
    private var windowObserver: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        windowObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didBecomeKeyNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let window = notification.object as? NSWindow else { return }
            Task { @MainActor [weak self] in
                self?.installBackgroundWindowPolicy(on: window)
            }
        }
        NSApp.windows.forEach { installBackgroundWindowPolicy(on: $0) }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        NSApp.windows.forEach { installBackgroundWindowPolicy(on: $0) }
    }

    private func installBackgroundWindowPolicy(on window: NSWindow) {
        // Sheets must keep their normal close behavior. Only top-level App
        // windows are hidden on X so the Agent process and polling remain alive.
        guard window.parent == nil, window.canBecomeKey else { return }
        window.delegate = self
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard !terminationInProgress else { return true }
        sender.orderOut(nil)
        return false
    }

    func applicationShouldTerminateAfterLastWindowClosed(
        _ sender: NSApplication
    ) -> Bool {
        // Closing the window hides the control surface but deliberately keeps
        // the Agent and its LaunchAgent alive. Use Dock > Quit for an explicit
        // application termination.
        false
    }

    func applicationShouldHandleReopen(
        _ sender: NSApplication,
        hasVisibleWindows flag: Bool
    ) -> Bool {
        showMainWindow()
        return true
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
