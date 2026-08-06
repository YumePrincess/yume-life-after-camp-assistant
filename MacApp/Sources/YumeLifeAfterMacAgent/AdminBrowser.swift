import SwiftUI
import WebKit
import Foundation

@MainActor
final class AdminBrowser: NSObject, ObservableObject, WKNavigationDelegate {
    let webView: WKWebView
    @Published var isLoading = false
    @Published var pageTitle = ""
    @Published var lastError: String?
    private(set) var baseURL = URL(string: "https://lifeafter.yume.zone")!
    private var pendingAdminKey: String?
    private var adminKeyLoginInFlight = false

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.navigationDelegate = self
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

    func submit(taskKey: String) async throws {
        guard webView.url?.host == baseURL.host else {
            throw RuntimeError.failed(String(localized: "Open Camp admin and sign in first."))
        }
        // Do not execute a long async fetch chain inside the WKWebView page.
        // On recent macOS releases that can leave the embedded admin page
        // showing an unresponsive-page dialog even though the API is healthy.
        // Reuse the WebView's authenticated cookie and call the two same-origin
        // APIs directly instead.
        let cookieHeader = await sessionCookieHeader()
        guard !cookieHeader.isEmpty else {
            throw RuntimeError.failed(String(localized: "Open Camp admin and sign in first."))
        }
        let bootstrap = try await apiRequest(
            path: "api/admin/bootstrap",
            method: "GET",
            body: nil,
            cookieHeader: cookieHeader
        )
        guard bootstrap.status == 200 else {
            if bootstrap.status == 401 {
                throw RuntimeError.failed(String(localized: "Open Camp admin and sign in first."))
            }
            throw RuntimeError.failed(serverMessage(from: bootstrap.data, status: bootstrap.status))
        }
        guard let object = try? JSONSerialization.jsonObject(with: bootstrap.data) as? [String: Any],
              let session = object["session"] as? [String: Any],
              let csrfToken = session["csrfToken"] as? String,
              !csrfToken.isEmpty else {
            throw RuntimeError.failed(String(localized: "The admin response was invalid."))
        }

        let body = try JSONSerialization.data(withJSONObject: [
            "taskKey": taskKey
        ])
        let response = try await apiRequest(
            path: "api/admin/run",
            method: "POST",
            body: body,
            cookieHeader: cookieHeader,
            csrfToken: csrfToken
        )
        guard (200..<300).contains(response.status) else {
            if response.status == 401 {
                throw RuntimeError.failed(String(localized: "Open Camp admin and sign in first."))
            }
            throw RuntimeError.failed(serverMessage(from: response.data, status: response.status))
        }
    }

    private func sessionCookieHeader() async -> String {
        let cookies = await withCheckedContinuation { continuation in
            webView.configuration.websiteDataStore.httpCookieStore.getAllCookies {
                continuation.resume(returning: $0)
            }
        }
        let host = baseURL.host ?? ""
        return cookies
            .filter { cookie in
                let domain = cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))
                return host == domain || host.hasSuffix(".\(domain)")
            }
            .map { "\($0.name)=\($0.value)" }
            .joined(separator: "; ")
    }

    private func apiRequest(
        path: String,
        method: String,
        body: Data?,
        cookieHeader: String,
        csrfToken: String? = nil
    ) async throws -> (status: Int, data: Data) {
        let endpoint = baseURL.appending(path: path)
        var request = URLRequest(url: endpoint)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.httpShouldHandleCookies = false
        request.setValue(cookieHeader, forHTTPHeaderField: "Cookie")
        if body != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        if let csrfToken {
            request.setValue(csrfToken, forHTTPHeaderField: "X-CSRF-Token")
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    }

    private func serverMessage(from data: Data, status: Int) -> String {
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let error = object["error"] as? String,
           !error.isEmpty {
            return error
        }
        return "HTTP \(status)"
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        isLoading = true
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        isLoading = false
        pageTitle = webView.title ?? ""
        let path = webView.url?.path ?? ""
        if path == "/login" {
            loginWithPendingAdminKeyIfNeeded()
        } else if path == "/admin" {
            pendingAdminKey = nil
            adminKeyLoginInFlight = false
        }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        isLoading = false
        lastError = error.localizedDescription
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
    func makeNSView(context: Context) -> WKWebView { browser.webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
