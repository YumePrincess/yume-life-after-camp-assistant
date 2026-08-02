import Foundation
@preconcurrency import Dispatch

actor RuntimeService {
    static let shared = RuntimeService()
    private let fileManager = FileManager.default

    var applicationSupport: URL {
        fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appending(path: "Yume Life After Mac Agent", directoryHint: .isDirectory)
    }

    var runtimeRoot: URL {
        let installed = applicationSupport.appending(path: "Runtime/current", directoryHint: .isDirectory)
        if fileManager.fileExists(atPath: installed.appending(path: "src/main.mjs").path) {
            return installed
        }
        if let bundled = Bundle.main.resourceURL?.appending(path: "Runtime", directoryHint: .isDirectory),
           fileManager.fileExists(atPath: bundled.appending(path: "src/main.mjs").path) {
            return bundled
        }
        let development = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "Mac", directoryHint: .isDirectory)
        return development
    }

    var credentialsFile: URL {
        applicationSupport.appending(path: "credentials.json")
    }

    func installBundledRuntimeIfNeeded() throws {
        guard let bundled = Bundle.main.resourceURL?.appending(path: "Runtime", directoryHint: .isDirectory),
              fileManager.fileExists(atPath: bundled.appending(path: "src/main.mjs").path)
        else { return }
        let destination = applicationSupport.appending(path: "Runtime/current", directoryHint: .isDirectory)
        let marketingVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "development"
        let buildVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        let bundleVersion = "\(marketingVersion)-\(buildVersion)"
        let marker = destination.appending(path: ".bundle-version")
        if fileManager.fileExists(atPath: destination.appending(path: "src/main.mjs").path),
           (try? String(contentsOf: marker, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)) == bundleVersion {
            try ensureRuntimeConfig(at: destination)
            return
        }
        try fileManager.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        let staging = destination.deletingLastPathComponent().appending(path: "installing", directoryHint: .isDirectory)
        let previous = destination.deletingLastPathComponent().appending(path: "previous", directoryHint: .isDirectory)
        try? fileManager.removeItem(at: staging)
        try fileManager.copyItem(at: bundled, to: staging)
        for name in ["config.json", "logs"] {
            let existing = destination.appending(path: name)
            let replacement = staging.appending(path: name)
            if fileManager.fileExists(atPath: existing.path) {
                try? fileManager.removeItem(at: replacement)
                try fileManager.copyItem(at: existing, to: replacement)
            }
        }
        try ensureRuntimeConfig(at: staging)
        try Data("\(bundleVersion)\n".utf8).write(to: staging.appending(path: ".bundle-version"), options: .atomic)
        try? fileManager.removeItem(at: previous)
        if fileManager.fileExists(atPath: destination.path) {
            try fileManager.moveItem(at: destination, to: previous)
        }
        do {
            try fileManager.moveItem(at: staging, to: destination)
            try? fileManager.removeItem(at: previous)
        } catch {
            try? fileManager.moveItem(at: previous, to: destination)
            throw error
        }
    }

    /// Creates a secret-free first-launch configuration. Existing settings are
    /// never overwritten during an App update. Both tokens live in an
    /// owner-only credentials file outside the replaceable runtime and config
    /// only contains a marker.
    private func ensureRuntimeConfig(at runtime: URL) throws {
        let config = runtime.appending(path: "config.json")
        if fileManager.fileExists(atPath: config.path) {
            // 27.0 renamed only the historical built-in identity. A custom
            // administrator-defined Agent ID is never overwritten.
            var object = try JSONSerialization.jsonObject(with: Data(contentsOf: config)) as! [String: Any]
            var server = object["server"] as? [String: Any] ?? [:]
            var changed = false
            if object.removeValue(forKey: "memberKick") != nil {
                changed = true
            }
            if server["agentId"] as? String == "mumu-main" {
                server["agentId"] = "mac-life-after-agent"
                changed = true
            }
            if server["agentToken"] as? String == "KEYCHAIN" {
                server["agentToken"] = "CREDENTIALS_FILE"
                changed = true
            }
            object["server"] = server
            var debug = object["debug"] as? [String: Any] ?? [:]
            let storedDebugToken = debug["token"] as? String
            let credentialsExist = fileManager.fileExists(atPath: credentialsFile.path)
            if storedDebugToken == "KEYCHAIN" ||
                (storedDebugToken != nil && storedDebugToken != "" && credentialsExist) {
                debug["token"] = "CREDENTIALS_FILE"
                object["debug"] = debug
                changed = true
            }
            if changed {
                let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
                try data.write(to: config, options: .atomic)
                try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: config.path)
            }
            return
        }
        let template = runtime.appending(path: "config.example.json")
        guard fileManager.fileExists(atPath: template.path) else {
            throw RuntimeError.failed(String(localized: "The bundled runtime configuration template is missing."))
        }
        var object = try JSONSerialization.jsonObject(with: Data(contentsOf: template)) as! [String: Any]
        var server = object["server"] as? [String: Any] ?? [:]
        server["agentToken"] = "CREDENTIALS_FILE"
        object["server"] = server
        var debug = object["debug"] as? [String: Any] ?? [:]
        debug["token"] = "CREDENTIALS_FILE"
        object["debug"] = debug
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: config, options: .atomic)
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: config.path)
    }

    func run(_ arguments: [String], timeout: TimeInterval = 120) async throws -> String {
        let root = runtimeRoot
        let script = root.appending(path: "scripts/manage-local-agent.sh").path
        return try await process("/bin/zsh", [script] + arguments, workingDirectory: root, timeout: timeout)
    }

    func plugin(_ arguments: [String], timeout: TimeInterval = 120) async throws -> String {
        let root = runtimeRoot
        let node = bundledNode(root: root)
        let manager = root.appending(path: "src/plugin-manager.mjs").path
        return try await process(node, [manager] + arguments, workingDirectory: root, timeout: timeout)
    }

    func health(debugToken: String) async throws -> AgentHealth {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8091/health")!)
        request.timeoutInterval = 3
        request.setValue("Bearer \(debugToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw RuntimeError.failed(String(localized: "Agent health check failed."))
        }
        return try JSONDecoder().decode(AgentHealth.self, from: data)
    }

    func registerAgent(baseURL: String, agentID: String, agentToken: String) async throws {
        guard let endpoint = URL(string: baseURL)?.appending(path: "api/agent/register") else {
            throw RuntimeError.failed(String(localized: "The Workers URL is invalid."))
        }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(agentToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["agentId": agentID])
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let message = payload?["error"] as? String ?? "HTTP \(status)"
            throw RuntimeError.failed(
                "\(String(localized: "The Agent could not be registered with Workers.")) \(message)"
            )
        }
    }

    func logs() async -> String {
        let root = runtimeRoot
        let candidates = [
            root.appending(path: "logs/agent.log"),
            root.appending(path: "logs/agent-error.log")
        ]
        return candidates.compactMap { try? String(contentsOf: $0, encoding: .utf8) }
            .joined(separator: "\n")
            .split(separator: "\n", omittingEmptySubsequences: false)
            .suffix(600)
            .joined(separator: "\n")
    }

    func saveConnection(
        baseURL: String,
        agentID: String,
        agentToken: String,
        debugToken: String,
        mumuInstanceName: String
    ) throws {
        try saveCredentials(agentToken: agentToken, debugToken: debugToken)
        let root = runtimeRoot
        let path = root.appending(path: "config.json")
        let template = root.appending(path: "config.example.json")
        let source = fileManager.fileExists(atPath: path.path) ? path : template
        var object = try JSONSerialization.jsonObject(with: Data(contentsOf: source)) as! [String: Any]
        object.removeValue(forKey: "memberKick")
        var server = object["server"] as? [String: Any] ?? [:]
        server["baseUrl"] = baseURL
        server["agentId"] = agentID
        server["agentToken"] = "CREDENTIALS_FILE"
        object["server"] = server
        var mumu = object["mumu"] as? [String: Any] ?? [:]
        mumu["instanceName"] = mumuInstanceName
        object["mumu"] = mumu
        var adb = object["adb"] as? [String: Any] ?? [:]
        // The matching MuMu instance reports its current loopback ADB port.
        // It is intentionally not persisted as a fragile, hard-coded port.
        adb["serial"] = "auto"
        object["adb"] = adb
        var debug = object["debug"] as? [String: Any] ?? [:]
        debug["token"] = "CREDENTIALS_FILE"
        object["debug"] = debug
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: path, options: [.atomic])
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
    }

    func loadCredentials() throws -> StoredCredentials {
        let metadata = try credentialsFile.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        guard metadata.isRegularFile == true, metadata.isSymbolicLink != true else {
            throw RuntimeError.failed(String(localized: "The saved credentials file is invalid."))
        }
        let attributes = try fileManager.attributesOfItem(atPath: credentialsFile.path)
        let permissions = (attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0
        guard permissions & 0o077 == 0 else {
            throw RuntimeError.failed(String(localized: "The saved credentials file permissions are unsafe."))
        }
        let credentials = try JSONDecoder().decode(StoredCredentials.self, from: Data(contentsOf: credentialsFile))
        guard !credentials.agentToken.isEmpty, !credentials.debugToken.isEmpty else {
            throw RuntimeError.failed(String(localized: "The saved credentials are incomplete."))
        }
        return credentials
    }

    private func saveCredentials(agentToken: String, debugToken: String) throws {
        try fileManager.createDirectory(at: applicationSupport, withIntermediateDirectories: true)
        try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: applicationSupport.path)
        let credentials = StoredCredentials(agentToken: agentToken, debugToken: debugToken)
        let data = try JSONEncoder().encode(credentials)
        try data.write(to: credentialsFile, options: [.atomic, .completeFileProtection])
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: credentialsFile.path)
    }

    func exportMigrationArchive(to archive: URL) async throws {
        let stagingRoot = fileManager.temporaryDirectory
            .appending(path: "yla-backup-\(UUID().uuidString)", directoryHint: .isDirectory)
        let payload = stagingRoot.appending(path: "YumeLifeAfterBackup", directoryHint: .isDirectory)
        defer { try? fileManager.removeItem(at: stagingRoot) }
        try fileManager.createDirectory(at: payload, withIntermediateDirectories: true)
        let manifest: [String: Any] = [
            "schemaVersion": 1,
            "createdAt": ISO8601DateFormatter().string(from: Date()),
            "containsSecrets": false
        ]
        try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
            .write(to: payload.appending(path: "manifest.json"), options: .atomic)
        let config = runtimeRoot.appending(path: "config.json")
        if fileManager.fileExists(atPath: config.path) {
            var object = try JSONSerialization.jsonObject(with: Data(contentsOf: config)) as! [String: Any]
            object.removeValue(forKey: "memberKick")
            var server = object["server"] as? [String: Any] ?? [:]
            server["agentToken"] = "CREDENTIALS_FILE"
            object["server"] = server
            var debug = object["debug"] as? [String: Any] ?? [:]
            debug["token"] = "CREDENTIALS_FILE"
            object["debug"] = debug
            try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
                .write(to: payload.appending(path: "config.json"), options: .atomic)
        }
        let plugins = applicationSupport.appending(path: "Plugins", directoryHint: .isDirectory)
        if fileManager.fileExists(atPath: plugins.path) {
            try fileManager.copyItem(at: plugins, to: payload.appending(path: "Plugins", directoryHint: .isDirectory))
        }
        try? fileManager.removeItem(at: archive)
        _ = try await process("/usr/bin/ditto", ["-c", "-k", "--keepParent", payload.path, archive.path], workingDirectory: stagingRoot, timeout: 120)
    }

    func importMigrationArchive(from archive: URL) async throws {
        let listing = try await process("/usr/bin/unzip", ["-Z1", archive.path], workingDirectory: fileManager.temporaryDirectory, timeout: 30)
        let entries = listing.split(separator: "\n").map(String.init)
        guard entries.count <= 2_000,
              entries.allSatisfy({ !$0.hasPrefix("/") && !$0.split(separator: "/").contains("..") })
        else { throw RuntimeError.failed(String(localized: "The migration archive is unsafe.")) }
        let stagingRoot = fileManager.temporaryDirectory
            .appending(path: "yla-restore-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? fileManager.removeItem(at: stagingRoot) }
        try fileManager.createDirectory(at: stagingRoot, withIntermediateDirectories: true)
        _ = try await process("/usr/bin/ditto", ["-x", "-k", archive.path, stagingRoot.path], workingDirectory: stagingRoot, timeout: 120)
        let payload = stagingRoot.appending(path: "YumeLifeAfterBackup", directoryHint: .isDirectory)
        let manifestURL = payload.appending(path: "manifest.json")
        let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: manifestURL)) as? [String: Any]
        guard manifest?["schemaVersion"] as? Int == 1 else {
            throw RuntimeError.failed(String(localized: "The migration archive is invalid."))
        }
        try fileManager.createDirectory(at: applicationSupport, withIntermediateDirectories: true)
        let importedPlugins = payload.appending(path: "Plugins", directoryHint: .isDirectory)
        if fileManager.fileExists(atPath: importedPlugins.path) {
            let target = applicationSupport.appending(path: "Plugins", directoryHint: .isDirectory)
            let previous = applicationSupport.appending(path: "Plugins.previous", directoryHint: .isDirectory)
            try? fileManager.removeItem(at: previous)
            if fileManager.fileExists(atPath: target.path) { try fileManager.moveItem(at: target, to: previous) }
            do {
                try fileManager.copyItem(at: importedPlugins, to: target)
                try? fileManager.removeItem(at: previous)
            } catch {
                try? fileManager.moveItem(at: previous, to: target)
                throw error
            }
        }
        let importedConfig = payload.appending(path: "config.json")
        if fileManager.fileExists(atPath: importedConfig.path) {
            try fileManager.copyItemReplacing(at: importedConfig, to: runtimeRoot.appending(path: "config.json"))
            try ensureRuntimeConfig(at: runtimeRoot)
        }
    }

    private func bundledNode(root: URL) -> String {
        let candidate = root.appending(path: "Toolchain/node/bin/node").path
        return fileManager.isExecutableFile(atPath: candidate) ? candidate : "/opt/homebrew/bin/node"
    }

    private func process(
        _ executable: String,
        _ arguments: [String],
        workingDirectory: URL,
        timeout: TimeInterval
    ) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            let task = Process()
            let pipe = Pipe()
            task.executableURL = URL(fileURLWithPath: executable)
            task.arguments = arguments
            task.currentDirectoryURL = workingDirectory
            // App launches do not inherit an interactive shell PATH. Always
            // put the portable toolchain first so management scripts use the
            // Node/npm/ADB shipped with this exact runtime instead of relying
            // on Homebrew or a user-installed Node.js.
            var environment = ProcessInfo.processInfo.environment
            let portablePaths = [
                workingDirectory.appending(path: "Toolchain/node/bin").path,
                workingDirectory.appending(path: "Toolchain/platform-tools").path
            ]
            let inheritedPath = environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
            environment["PATH"] = (portablePaths + [inheritedPath]).joined(separator: ":")
            task.environment = environment
            task.standardOutput = pipe
            task.standardError = pipe
            do {
                try task.run()
            } catch {
                continuation.resume(throwing: error)
                return
            }
            let timer = DispatchWorkItem {
                if task.isRunning { task.terminate() }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: timer)
            task.terminationHandler = { process in
                timer.cancel()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let output = String(decoding: data, as: UTF8.self)
                if process.terminationStatus == 0 {
                    continuation.resume(returning: output)
                } else {
                    continuation.resume(throwing: RuntimeError.failed(output.trimmingCharacters(in: .whitespacesAndNewlines)))
                }
            }
        }
    }
}

struct StoredCredentials: Codable, Sendable {
    let agentToken: String
    let debugToken: String
}

private extension FileManager {
    func copyItemReplacing(at source: URL, to destination: URL) throws {
        let staging = destination.deletingLastPathComponent().appending(path: "\(destination.lastPathComponent).importing")
        try? removeItem(at: staging)
        try copyItem(at: source, to: staging)
        try? removeItem(at: destination)
        try moveItem(at: staging, to: destination)
    }
}

enum RuntimeError: LocalizedError {
    case failed(String)
    var errorDescription: String? {
        if case .failed(let message) = self { return message }
        return nil
    }
}
