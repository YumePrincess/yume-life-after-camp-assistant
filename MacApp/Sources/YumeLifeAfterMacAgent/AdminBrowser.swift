import SwiftUI
import WebKit

@MainActor
final class AdminBrowser: NSObject, ObservableObject, WKNavigationDelegate {
    let webView: WKWebView
    @Published var isLoading = false
    @Published var pageTitle = ""
    @Published var lastError: String?
    private(set) var baseURL = URL(string: "https://lifeafter.yume.zone")!

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.navigationDelegate = self
    }

    func load(baseURL: String) {
        guard let url = URL(string: baseURL), url.scheme == "https" else { return }
        self.baseURL = url
        let admin = url.appending(path: "admin")
        if webView.url?.host == admin.host { return }
        webView.load(URLRequest(url: admin, cachePolicy: .reloadRevalidatingCacheData))
    }

    func reload() { webView.reload() }

    func submit(taskKey: String) async throws {
        guard webView.url?.host == baseURL.host else {
            throw RuntimeError.failed(String(localized: "Open Camp admin and sign in first."))
        }
        let escaped = taskKey.replacingOccurrences(of: "'", with: "\\'")
        let script = """
        (async () => {
          const bootstrap = await fetch('/api/admin/bootstrap', { credentials: 'same-origin' });
          if (!bootstrap.ok) return JSON.stringify({ ok:false, status:bootstrap.status, login:true });
          const data = await bootstrap.json();
          const response = await fetch('/api/admin/run', {
            method:'POST', credentials:'same-origin',
            headers:{'Content-Type':'application/json','X-CSRF-Token':data.session.csrfToken},
            body:JSON.stringify({taskKey:'\(escaped)'})
          });
          const payload = await response.json().catch(() => ({}));
          return JSON.stringify({ok:response.ok,status:response.status,payload});
        })()
        """
        let value = try await webView.callAsyncJavaScript(script, arguments: [:], in: nil, contentWorld: .page)
        guard let json = value as? String,
              let data = json.data(using: .utf8),
              let result = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw RuntimeError.failed(String(localized: "The admin response was invalid.")) }
        guard result["ok"] as? Bool == true else {
            throw RuntimeError.failed(String(localized: "Open Camp admin and sign in first."))
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        isLoading = true
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        isLoading = false
        pageTitle = webView.title ?? ""
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        isLoading = false
        lastError = error.localizedDescription
    }
}

struct AdminWebView: NSViewRepresentable {
    @ObservedObject var browser: AdminBrowser
    func makeNSView(context: Context) -> WKWebView { browser.webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
