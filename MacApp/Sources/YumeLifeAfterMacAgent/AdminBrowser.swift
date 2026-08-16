import SwiftUI
import WebKit
import Foundation
import AppKit

@MainActor
final class AdminBrowser: NSObject, ObservableObject, WKNavigationDelegate {
    let webView: WKWebView
    @Published var isLoading = false
    @Published var pageTitle = ""
    @Published var lastError: String?
    private(set) var baseURL = URL(string: "https://lifeafter.yume.zone")!
    private var pendingAdminKey: String?
    private var adminKeyLoginInFlight = false
    private var pendingLanguage = "en"

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.navigationDelegate = self
    }

    func hideScrollIndicators() {
        DispatchQueue.main.async { [weak self] in
            guard let webView = self?.webView,
                  let scrollView = webView.enclosingScrollView ?? Self.firstScrollView(in: webView)
            else { return }
            scrollView.hasVerticalScroller = true
            scrollView.hasHorizontalScroller = false
            scrollView.scrollerStyle = .overlay
            scrollView.verticalScroller?.isHidden = true
            scrollView.horizontalScroller?.isHidden = true
        }
    }

    private static func firstScrollView(in view: NSView) -> NSScrollView? {
        if let scrollView = view as? NSScrollView { return scrollView }
        for child in view.subviews {
            if let scrollView = firstScrollView(in: child) { return scrollView }
        }
        return nil
    }

    func load(baseURL: String, adminKey: String? = nil) {
        guard let url = URL(string: baseURL), url.scheme == "https" else { return }
        self.baseURL = url
        let trimmedKey = adminKey?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        pendingAdminKey = trimmedKey.isEmpty ? nil : trimmedKey
        adminKeyLoginInFlight = false
        let admin = url.appending(path: "admin")
        if webView.url?.host == admin.host,
           webView.url?.path == admin.path,
           pendingAdminKey == nil {
            return
        }
        webView.load(URLRequest(url: admin, cachePolicy: .reloadRevalidatingCacheData))
    }

    func reload() { webView.reload() }

    func setLanguage(_ language: String) {
        pendingLanguage = language == "zh-Hans"
            ? "zh-cn"
            : language == "zh-Hant" ? "zh-tw" : language
        guard webView.url != nil else { return }
        applyPendingLanguage()
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        isLoading = true
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        isLoading = false
        pageTitle = webView.title ?? ""
        hideScrollIndicators()
        let path = webView.url?.path ?? ""
        if path == "/login" {
            loginWithPendingAdminKeyIfNeeded()
        } else if path == "/admin" {
            pendingAdminKey = nil
            adminKeyLoginInFlight = false
        }
        applyPendingLanguage()
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        isLoading = false
        lastError = error.localizedDescription
    }

    private func applyPendingLanguage() {
        guard let languageData = try? JSONEncoder().encode(pendingLanguage),
              let languageLiteral = String(data: languageData, encoding: .utf8) else {
            return
        }
        let script = """
        (() => {
          const language = \(languageLiteral);
          if (!window.YumePreferences) return false;
          window.YumePreferences.setLanguageChoice(language);
          window.MrzhI18n?.apply();
          return true;
        })();
        """
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    private func loginWithPendingAdminKeyIfNeeded() {
        guard let key = pendingAdminKey, !key.isEmpty, !adminKeyLoginInFlight else { return }
        guard let encodedKey = try? JSONEncoder().encode(key),
              let keyLiteral = String(data: encodedKey, encoding: .utf8) else {
            lastError = String(localized: "The admin access Key is invalid.")
            pendingAdminKey = nil
            return
        }
        adminKeyLoginInFlight = true
        let script = """
        (() => {
          const key = \(keyLiteral);
          fetch('/auth/key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, returnTo: '/admin' })
          }).then(async response => {
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload.error || 'Temporary Key login failed.');
            window.location.replace(payload.returnTo || '/admin');
          }).catch(error => {
            document.title = `Yume Life After Mac Agent · ${error.message || 'login failed'}`;
          });
          return true;
        })();
        """
        webView.evaluateJavaScript(script) { [weak self] _, error in
            guard let self else { return }
            if let error {
                self.adminKeyLoginInFlight = false
                self.lastError = error.localizedDescription
            }
        }
    }
}

struct AdminWebView: NSViewRepresentable {
    @ObservedObject var browser: AdminBrowser
    func makeNSView(context: Context) -> WKWebView {
        browser.hideScrollIndicators()
        return browser.webView
    }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
