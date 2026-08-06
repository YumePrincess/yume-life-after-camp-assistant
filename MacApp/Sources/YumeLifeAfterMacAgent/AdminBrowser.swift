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
