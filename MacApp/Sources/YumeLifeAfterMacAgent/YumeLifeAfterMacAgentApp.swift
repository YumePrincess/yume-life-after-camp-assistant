import SwiftUI
import AppKit

@MainActor
enum NativeWindowChrome {
    static func configure(_ window: NSWindow) {
        // Keep the native macOS title bar and traffic lights. The title bar is
        // transparent so the SwiftUI content still fills the window.
        window.styleMask.insert(.titled)
        window.styleMask.insert(.closable)
        window.styleMask.insert(.miniaturizable)
        window.styleMask.insert(.resizable)
        window.styleMask.insert(.fullSizeContentView)
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true

        // NavigationSplitView can add a sidebar-toggle NSToolbar. This App
        // has no titlebar actions of its own, so remove the toolbar itself;
        // the native titlebar and traffic lights remain intact.
        if window.toolbar != nil {
            window.toolbar = nil
        }

        for button in [
            window.standardWindowButton(.closeButton),
            window.standardWindowButton(.miniaturizeButton),
            window.standardWindowButton(.zoomButton)
        ] {
            button?.isHidden = false
            button?.alphaValue = 1
            button?.isEnabled = true
            button?.superview?.isHidden = false
            var ancestor = button?.superview
            while let view = ancestor {
                view.isHidden = false
                ancestor = view.superview
            }
        }
    }

    static func configureMainWindow() {
        let rootWindows = NSApp.windows.filter { window in
            window.isVisible
                && window.sheetParent == nil
                && window.styleMask.contains(.titled)
        }
        guard let window = rootWindows.first(where: { $0 === NSApp.mainWindow })
            ?? rootWindows.first(where: { $0.isMainWindow })
            ?? rootWindows.first(where: { $0.frame.width >= 900 && $0.frame.height >= 550 })
            ?? rootWindows.first
        else { return }
        configure(window)
    }
}

@MainActor
final class YumeLifeAfterMacAgentAppDelegate: NSObject, NSApplicationDelegate {
    private var terminationInProgress = false
    private var windowObservers: [NSObjectProtocol] = []
    private var menuLocalizationTimer: Timer?
    private var windowChromeTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let center = NotificationCenter.default
        let language = UserDefaults.standard.string(forKey: "language") ?? "zh-Hans"
        for name in [
            NSWindow.didBecomeMainNotification,
            NSWindow.didBecomeKeyNotification,
            NSWindow.didEndSheetNotification,
            NSApplication.didBecomeActiveNotification
        ] {
            windowObservers.append(
                center.addObserver(forName: name, object: nil, queue: .main) { _ in
                    Task { @MainActor in
                        NativeWindowChrome.configureMainWindow()
                        MenuLocalization.apply(language: language)
                    }
                }
            )
        }
        for name in [
            NSMenu.didAddItemNotification,
            NSMenu.didChangeItemNotification,
            NSMenu.didRemoveItemNotification
        ] {
            windowObservers.append(
                center.addObserver(forName: name, object: nil, queue: .main) { _ in
                    Task { @MainActor in
                        MenuLocalization.apply(
                            language: UserDefaults.standard.string(forKey: "language") ?? "zh-Hans"
                        )
                    }
                }
            )
        }
        NativeWindowChrome.configureMainWindow()
        menuLocalizationTimer = Timer.scheduledTimer(
            timeInterval: 0.25,
            target: self,
            selector: #selector(refreshMenuLocalization),
            userInfo: nil,
            repeats: true
        )
        windowChromeTimer = Timer.scheduledTimer(
            timeInterval: 0.05,
            target: self,
            selector: #selector(refreshWindowChrome),
            userInfo: nil,
            repeats: true
        )
        for delay in [0.0, 0.15, 0.5, 1.0] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                MenuLocalization.apply(language: language)
            }
        }
    }

    @objc private func refreshMenuLocalization() {
        MenuLocalization.apply(
            language: UserDefaults.standard.string(forKey: "language") ?? "zh-Hans"
        )
    }

    @objc private func refreshWindowChrome() {
        NativeWindowChrome.configureMainWindow()
    }

    func applicationShouldTerminateAfterLastWindowClosed(
        _ sender: NSApplication
    ) -> Bool {
        // Closing the window keeps the local Agent and its LaunchAgent alive.
        // The App can be reopened from the Dock; no menu-bar resident icon is
        // installed.
        false
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
                .toggleStyle(GlassCheckboxToggleStyle())
                .preferredColorScheme(model.theme.colorScheme)
                .frame(minWidth: 1040, minHeight: 680)
                .task { await model.bootstrap() }
        }
        // Keep the native macOS title bar and all three traffic-light actions.
        .windowStyle(.titleBar)
        .commands {
            CommandGroup(replacing: .appInfo) {
                Button(model.text("About Yume Camp Assistant")) {
                    model.showAbout = true
                }
            }
        }
        Settings {
            SettingsView()
                .environmentObject(model)
                .toggleStyle(GlassCheckboxToggleStyle())
                .preferredColorScheme(model.theme.colorScheme)
                .frame(width: 620, height: 520)
        }
    }
}

@MainActor
enum MenuLocalization {
    private static let keys = ["File", "Edit", "View", "Window", "Help"]
    private static let aliases: [String: String] = [
        "file": "File", "ファイル": "File", "文件": "File", "檔案": "File", "fichier": "File",
        "edit": "Edit", "編集": "Edit", "编辑": "Edit", "編輯": "Edit", "édition": "Edit",
        "view": "View", "表示": "View", "显示": "View", "檢視": "View", "présentation": "View",
        "window": "Window", "ウインドウ": "Window", "窗口": "Window", "視窗": "Window", "fenêtre": "Window",
        "help": "Help", "ヘルプ": "Help", "帮助": "Help", "說明": "Help", "aide": "Help"
    ]

    static func apply(language: String) {
        guard let menu = NSApp.mainMenu else { return }
        var changed = false
        for item in menu.items {
            changed = apply(item, language: language) || changed
        }
        if changed {
            menu.update()
            // SwiftUI may replace its menu object while rebuilding commands;
            // assigning the updated menu back makes the live change visible
            // immediately, while a relaunch applies AppKit's native menu
            // localization for the next process as well.
            NSApp.mainMenu = menu
        }
    }

    @discardableResult
    private static func apply(_ item: NSMenuItem, language: String) -> Bool {
        var changed = false
        let normalized = item.title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if let key = aliases[normalized], keys.contains(key) {
            let localizedTitle = title(for: key, language: language)
            if item.title != localizedTitle {
                item.title = localizedTitle
                changed = true
            }
            if item.attributedTitle?.string != localizedTitle {
                item.attributedTitle = NSAttributedString(
                    string: localizedTitle,
                    attributes: [.font: NSFont.menuBarFont(ofSize: NSFont.systemFontSize)]
                )
                changed = true
            }
        }
        item.submenu?.items.forEach {
            changed = apply($0, language: language) || changed
        }
        return changed
    }

    private static func title(for key: String, language: String) -> String {
        switch language {
        case "zh-Hans":
            return ["File": "文件", "Edit": "编辑", "View": "显示", "Window": "窗口", "Help": "帮助"][key] ?? key
        case "zh-Hant":
            return ["File": "檔案", "Edit": "編輯", "View": "檢視", "Window": "視窗", "Help": "說明"][key] ?? key
        case "ja":
            return ["File": "ファイル", "Edit": "編集", "View": "表示", "Window": "ウインドウ", "Help": "ヘルプ"][key] ?? key
        case "fr":
            return ["File": "Fichier", "Edit": "Édition", "View": "Présentation", "Window": "Fenêtre", "Help": "Aide"][key] ?? key
        default:
            return key
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
