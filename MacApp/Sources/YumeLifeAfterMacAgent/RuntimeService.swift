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
#if DEBUG
        let development = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "Mac", directoryHint: .isDirectory)
        return development
#else
        // A released App must never fall back to the source checkout. That
        // path can live on an external development volume and would trigger a
        // macOS permission prompt on every launch if the bundled/runtime copy
        // were missing. The installer/bootstrap path reports the real missing
        // runtime instead; it does not silently read project files.
        return installed
#endif
    }

    var credentialsFile: URL {
        applicationSupport.appending(path: "credentials.json")
    }

    func installBundledRuntimeIfNeeded() throws -> Bool {
        guard let bundled = Bundle.main.resourceURL?.appending(path: "Runtime", directoryHint: .isDirectory),
              fileManager.fileExists(atPath: bundled.appending(path: "src/main.mjs").path)
        else { return false }
        let destination = applicationSupport.appending(path: "Runtime/current", directoryHint: .isDirectory)
        let replacedExistingRuntime = fileManager.fileExists(
            atPath: destination.appending(path: "src/main.mjs").path
        )
        let marketingVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "development"
        let buildVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        let bundleVersion = "\(marketingVersion)-\(buildVersion)"
        let marker = destination.appending(path: ".bundle-version")
        if fileManager.fileExists(atPath: destination.appending(path: "src/main.mjs").path),
           (try? String(contentsOf: marker, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)) == bundleVersion {
            // A local Beta can keep the same App build number while the
            // bundled runtime code changes. Do not let an old Runtime/current
            // survive solely because its version marker still matches.
            if runtimeCodeMatches(bundled: bundled, installed: destination) {
                try ensureRuntimeConfig(at: destination)
                return false
            }
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
        return replacedExistingRuntime
    }

    private func runtimeCodeMatches(bundled: URL, installed: URL) -> Bool {
        let roots = ["src", "scripts", "plugins"]
        var relativeFiles = ["config.example.json", "package.json", "package-lock.json"]
        for root in roots {
            let rootURL = bundled.appending(path: root, directoryHint: .isDirectory)
            guard let enumerator = fileManager.enumerator(
                at: rootURL,
                includingPropertiesForKeys: [.isRegularFileKey],
                options: [.skipsHiddenFiles]
            ) else { return false }
            for case let file as URL in enumerator {
                let values = try? file.resourceValues(forKeys: [.isRegularFileKey])
                guard values?.isRegularFile == true else { continue }
                let relative = file.path.replacingOccurrences(of: bundled.path + "/", with: "")
                relativeFiles.append(relative)
            }
        }
        return relativeFiles.allSatisfy { relative in
            let source = bundled.appending(path: relative)
            let target = installed.appending(path: relative)
            return fileManager.fileExists(atPath: target.path) &&
                fileManager.contentsEqual(atPath: source.path, andPath: target.path)
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
            let storedAgentName = server["agentName"] as? String
            if storedAgentName?
                .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false {
                server["agentName"] = Host.current().localizedName ?? "Mac Agent"
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
            var vision = object["vision"] as? [String: Any] ?? [:]
            if vision["prewarmEnabled"] == nil {
                vision["prewarmEnabled"] = true
                changed = true
            }
            if vision["prewarmTimeoutSeconds"] == nil {
                vision["prewarmTimeoutSeconds"] = 45
                changed = true
            }
            for key in ["fastTimeoutSeconds", "accurateTimeoutSeconds", "memberTableTimeoutSeconds"] {
                if let timeout = vision[key] as? NSNumber, timeout.doubleValue <= 2 {
                    vision[key] = 3
                    changed = true
                }
            }
            object["vision"] = vision
            var mumu = object["mumu"] as? [String: Any] ?? [:]
            if mumu.removeValue(forKey: "hostMouseUnlock") != nil {
                changed = true
                object["mumu"] = mumu
            }
            var adb = object["adb"] as? [String: Any] ?? [:]
            let toggleKeyIs70 = (adb["gameMouseToggleKey"] as? NSNumber)?.intValue == 70 ||
                (adb["gameMouseToggleKey"] as? String) == "70"
            if !toggleKeyIs70 {
                adb["gameMouseToggleKey"] = 70
                changed = true
            }
            if (adb["gameMouseToggleSettleMs"] as? NSNumber)?.intValue != 350 {
                adb["gameMouseToggleSettleMs"] = 350
                changed = true
            }
            let hudTapPoint = adb["gameMouseHudTapPoint"] as? [String: Any]
            let hudTapX = (hudTapPoint?["x"] as? NSNumber)?.intValue
            let hudTapY = (hudTapPoint?["y"] as? NSNumber)?.intValue
            if hudTapX != 1_865 || hudTapY != 1_130 {
                adb["gameMouseHudTapPoint"] = ["x": 1_865, "y": 1_130]
                changed = true
            }
            let initialHudTapPoint = adb["gameMouseHudInitialTapPoint"] as? [String: Any]
            let initialHudTapX = (initialHudTapPoint?["x"] as? NSNumber)?.intValue
            let initialHudTapY = (initialHudTapPoint?["y"] as? NSNumber)?.intValue
            if initialHudTapX != 1_782 || initialHudTapY != 1_110 {
                adb["gameMouseHudInitialTapPoint"] = ["x": 1_782, "y": 1_110]
                changed = true
            }
            if (adb["gameMouseCClickDelayMs"] as? NSNumber)?.intValue != 2_000 {
                adb["gameMouseCClickDelayMs"] = 2_000
                changed = true
            }
            if (adb["gameMouseCKeyEventDelayMs"] as? NSNumber)?.intValue != 3_000 {
                adb["gameMouseCKeyEventDelayMs"] = 3_000
                changed = true
            }
            var gameMouseCIcon = adb["gameMouseCIcon"] as? [String: Any] ?? [:]
            if gameMouseCIcon["probePoints"] == nil {
                gameMouseCIcon["probePoints"] = [
                    ["x": 1_865, "y": 1_130],
                    ["x": 1_848, "y": 1_130],
                    ["x": 1_882, "y": 1_130],
                    ["x": 1_865, "y": 1_114],
                    ["x": 1_865, "y": 1_146]
                ]
                changed = true
            }
            if gameMouseCIcon["probeRadius"] == nil {
                gameMouseCIcon["probeRadius"] = 12
                changed = true
            }
            if gameMouseCIcon["minimumLitPoints"] == nil {
                gameMouseCIcon["minimumLitPoints"] = 3
                changed = true
            }
            if gameMouseCIcon["redBlueDelta"] == nil {
                gameMouseCIcon["redBlueDelta"] = 0.08
                changed = true
            }
            if gameMouseCIcon["greenBlueDelta"] == nil {
                gameMouseCIcon["greenBlueDelta"] = 0.07
                changed = true
            }
            if gameMouseCIcon["minimumSaturation"] == nil {
                gameMouseCIcon["minimumSaturation"] = 0.20
                changed = true
            }
            adb["gameMouseCIcon"] = gameMouseCIcon
            if (adb["gameMouseIconVerifyTimeoutMs"] as? NSNumber)?.intValue != 2_000 {
                adb["gameMouseIconVerifyTimeoutMs"] = 2_000
                changed = true
            }
            if (adb["gameMouseIconVerifyPollMs"] as? NSNumber)?.intValue != 250 {
                adb["gameMouseIconVerifyPollMs"] = 250
                changed = true
            }
            var gameMouseIcon = adb["gameMouseIcon"] as? [String: Any] ?? [:]
            if gameMouseIcon["probePoints"] == nil {
                gameMouseIcon["probePoints"] = [
                    ["x": 1_728, "y": 1_000],
                    ["x": 1_728, "y": 1_055]
                ]
                changed = true
            }
            if gameMouseIcon["probeRadius"] == nil {
                gameMouseIcon["probeRadius"] = 18
                changed = true
            }
            if gameMouseIcon["luminanceDeviationThreshold"] == nil {
                gameMouseIcon["luminanceDeviationThreshold"] = 0.12
                changed = true
            }
            if gameMouseIcon["ocrFallback"] == nil {
                gameMouseIcon["ocrFallback"] = [
                    "texts": ["Space"],
                    "region": ["left": 1_450, "top": 850, "right": 1_910, "bottom": 1_150],
                    "minimumConfidence": 0.35,
                    "luminanceDeviationThreshold": 0.08
                ]
                changed = true
            }
            adb["gameMouseIcon"] = gameMouseIcon
            object["adb"] = adb
            var tables = object["tables"] as? [String: Any] ?? [:]
            for tableName in ["contribution", "activity", "members"] {
                var table = tables[tableName] as? [String: Any] ?? [:]
                let defaultOcrMinimum = 0.30
                let existingOcrMinimum = (table["ocrMinimumConfidence"] as? NSNumber)?.doubleValue
                if existingOcrMinimum == nil ||
                    (existingOcrMinimum.map { abs($0 - 0.25) < 0.001 || abs($0 - 0.50) < 0.001 } == true) {
                    table["ocrMinimumConfidence"] = defaultOcrMinimum
                    changed = true
                }
                var pagination = table["pagination"] as? [String: Any] ?? [:]
                if let settle = pagination["initialSettleMs"] as? NSNumber,
                   settle.doubleValue < 3_000 {
                    pagination["initialSettleMs"] = 3_000
                    changed = true
                } else if pagination["initialSettleMs"] == nil {
                    pagination["initialSettleMs"] = 3_000
                    changed = true
                }
                table["pagination"] = pagination
                if tableName == "members" {
                    // Member pagination is a calibrated device layout, not a
                    // user preference. Older persistent configs used 700 ->
                    // 350 (about four rows), while the current member parser
                    // requires the existing calibrated 700 -> 225 movement.
                    // Keep the persistent runtime in sync with the bundled
                    // member definition on every App update.
                    table["region"] = [
                        "left": 115,
                        "top": 285,
                        "right": 1800,
                        "bottom": 780
                    ]
                    pagination["from"] = ["x": 1700, "y": 700]
                    pagination["to"] = ["x": 1700, "y": 225]
                    pagination["firstPageFrom"] = ["x": 1700, "y": 700]
                    pagination["firstPageTo"] = ["x": 1700, "y": 225]
                    pagination["durationMs"] = 1000
                    pagination["settleAfterSwipeMs"] = 2000
                    pagination["rowsPerPage"] = 5
                    pagination["minimumRowsPerPage"] = 5
                    pagination["maxIncompletePageRetries"] = 3
                    pagination["maxExtraPagesAfterExpected"] = 2
                    pagination["fullPageRegion"] = [
                        "left": 115,
                        "top": 285,
                        "right": 1800,
                        "bottom": 810
                    ]
                    pagination["fullPageRows"] = 7
                    pagination["maxRowAlignments"] = 1
                    pagination["rowHeightPx"] = 95
                    pagination["rowColorThreshold"] = 0.3
                    pagination["rowColorSampleStepPx"] = 5
                    pagination["rowAlignmentDurationMs"] = 1000
                    pagination["rowAlignmentSettleMs"] = 2000
                    table["pagination"] = pagination
                    changed = true
                }
                tables[tableName] = table
            }
            object["tables"] = tables
            if migratePatrolSettings(&object) {
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

    private func migratePatrolSettings(_ object: inout [String: Any]) -> Bool {
        var changed = false
        var patrol = object["patrolTeamUi"] as? [String: Any] ?? [:]
        for key in [
            "hostMouseUnlockBeforeCreate",
            "hostMouseUnlockAttempts",
            "mouseReleaseSettleMs"
        ] {
            if patrol.removeValue(forKey: key) != nil { changed = true }
        }
        var hardPatrol = patrol["hardPatrol"] as? [String: Any] ?? [:]
        if hardPatrol["acceptAttempts"] == nil {
            hardPatrol["acceptAttempts"] = 8
            changed = true
        }
        if hardPatrol["retryTexts"] == nil {
            hardPatrol["retryTexts"] = [
                "简单巡逻任务", "困难巡逻任务", "简单巡逻路线", "困难巡逻路线"
            ]
            changed = true
        }
        if hardPatrol["retryRegion"] == nil {
            hardPatrol["retryRegion"] = [
                "left": 850, "top": 150, "right": 1920, "bottom": 950
            ]
            changed = true
        }
        patrol["hardPatrol"] = hardPatrol

        var share = patrol["share"] as? [String: Any] ?? [:]
        if let attempts = share["recruitAttempts"] as? NSNumber,
           attempts.intValue < 15 {
            share["recruitAttempts"] = 15
            changed = true
        } else if share["recruitAttempts"] == nil {
            share["recruitAttempts"] = 15
            changed = true
        }
        if share["recruitOverlayTexts"] == nil {
            share["recruitOverlayTexts"] = [
                "邀请", "推荐组队", "最近组队", "巡猎车队", "萌芽师徒"
            ]
            changed = true
        }
        if share["recruitOverlayRegion"] == nil {
            share["recruitOverlayRegion"] = [
                "left": 250, "top": 150, "right": 1350, "bottom": 820
            ]
            changed = true
        }
        if share["recruitOverlayDismissPoint"] == nil {
            share["recruitOverlayDismissPoint"] = ["x": 1800, "y": 900]
            changed = true
        }
        patrol["share"] = share
        object["patrolTeamUi"] = patrol

        var flows = object["flows"] as? [String: Any] ?? [:]
        if var hardFlow = flows["startHardPatrol"] as? [[String: Any]],
           let last = hardFlow.indices.last,
           hardFlow[last]["op"] as? String == "waitAnyText" {
            if hardFlow[last]["strictTimeout"] as? Bool != true {
                hardFlow[last]["strictTimeout"] = true
                flows["startHardPatrol"] = hardFlow
                changed = true
            }
        }
        if var openFlow = flows["openTeamPanel"] as? [[String: Any]],
           openFlow.count > 2,
           openFlow[2]["op"] as? String == "tapUnlessAnyText" {
            openFlow[2] = [
                "op": "tapUntilAnyTexts",
                "texts": ["调整", "离开队伍"],
                "minimumTexts": 1,
                "x": 50,
                "y": 325,
                "maxAttempts": 6,
                "intervalMs": 500,
                "hud": true,
                "gameMouse": true,
                "controlLabel": "队伍卡片旗帜展开"
            ]
            flows["openTeamPanel"] = openFlow
            changed = true
        }
        // Beta 86 added a post-creation 3D -> 2D check. Existing installed
        // Runtime/current configs are deliberately preserved across upgrades,
        // so older configs do not contain this newly introduced flow. Add it
        // during migration without replacing a user's non-empty calibration.
        if let existingTwoDFlow = flows["ensurePatrolTeamTwoD"] as? [[String: Any]],
           !existingTwoDFlow.isEmpty {
            // Keep an existing calibrated flow unchanged.
        } else {
            flows["ensurePatrolTeamTwoD"] = [
                [
                    "op": "tapIfAnyText",
                    "texts": ["3D模式"],
                    "x": 1655,
                    "y": 55,
                    "hud": true,
                    "region": ["left": 1500, "top": 0, "right": 1850, "bottom": 120]
                ],
                ["op": "sleep", "ms": 500],
                [
                    "op": "waitAnyText",
                    "texts": ["2D模式"],
                    "region": ["left": 1500, "top": 0, "right": 1850, "bottom": 120],
                    "timeoutSeconds": 8
                ]
            ]
            changed = true
        }
        if var campFlow = flows["openCampPanel"] as? [[String: Any]],
           !campFlow.isEmpty,
           campFlow[0]["op"] as? String == "openCampPanelViaChat" {
            for key in [
                "hostMouseUnlockBeforeCampChannel",
                "hostMouseUnlockBeforeEveryCampChannelAttempt",
                "hostMouseUnlockOnCampChannelRetry",
                "hostMouseUnlockDelayMs",
                "campControlTapMode",
                "androidTouchFallbackAfterAttempts"
            ] {
                if campFlow[0].removeValue(forKey: key) != nil { changed = true }
            }
            flows["openCampPanel"] = campFlow
        }
        if flows["closePatrolTeamPanelBeforeAccept"] == nil {
            flows["closePatrolTeamPanelBeforeAccept"] = [[
                "op": "closePatrolTeamPanelBeforeAccept",
                "x": 74,
                "y": 1110,
                "hud": true,
                "panelTexts": ["调整", "离开队伍"],
                "hudTexts": ["综合", "世界", "场景", "营地", "队伍"],
                "hudRegion": ["left": 0, "top": 930, "right": 760, "bottom": 1200],
                "minimumHudTexts": 2,
                "collapseText": "收起",
                "collapseRegion": ["left": 1450, "top": 850, "right": 1900, "bottom": 1150],
                "collapsePoint": ["x": 1740, "y": 1110],
                "chatTexts": ["营地频道", "成员", "私聊", "萌芽邀约", "聊天室"],
                "chatRegion": ["left": 1200, "top": 100, "right": 1900, "bottom": 1150],
                "settleAfterClickMs": 5000,
                "collapseSettleMs": 1500,
                "maxAttempts": 6
            ]]
            changed = true
        }
        if var campFlow = flows["openCampPanel"] as? [[String: Any]],
           !campFlow.isEmpty,
           campFlow[0]["op"] as? String == "openCampPanelViaChat",
           campFlow[0]["chatReadyTexts"] == nil {
            campFlow[0]["chatReadyTexts"] = ["营地频道", "成员", "私聊"]
            campFlow[0]["chatReadyRegion"] = ["left": 1200, "top": 100, "right": 1900, "bottom": 1150]
            campFlow[0]["chatReadyMinimumTexts"] = 1
            flows["openCampPanel"] = campFlow
            changed = true
        }
        object["flows"] = flows
        return changed
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

    func registerAgent(
        baseURL: String,
        agentID: String,
        agentName: String,
        agentToken: String
    ) async throws {
        guard let endpoint = URL(string: baseURL)?.appending(path: "api/agent/register") else {
            throw RuntimeError.failed(String(localized: "The Workers URL is invalid."))
        }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(agentToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "agentId": agentID,
            "displayName": agentName
        ])
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
        // LaunchAgent and the App can briefly disagree about the active
        // runtime during an update. Read the managed runtime first, then the
        // bundle/development fallbacks, so the App never presents an empty
        // log view merely because one runtime path was replaced.
        var roots: [URL] = [runtimeRoot]
        roots.append(applicationSupport.appending(path: "Runtime/current", directoryHint: .isDirectory))
        if let bundled = Bundle.main.resourceURL?.appending(path: "Runtime", directoryHint: .isDirectory) {
            roots.append(bundled)
        }
#if DEBUG
        // Development-only fallback. Never include the source checkout in a
        // Release App: it may be on a removable volume and reading it during
        // the three-second log refresh would trigger a permission prompt.
        let development = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "Mac", directoryHint: .isDirectory)
        roots.append(development)
#endif

        var lines: [(index: Int, value: String)] = []
        var seenFiles = Set<String>()
        var seenLines = Set<String>()
        var index = 0
        func append(_ text: String) {
            for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
                let value = String(line)
                guard !value.isEmpty, seenLines.insert(value).inserted else { continue }
                lines.append((index, value))
                index += 1
            }
        }
        for root in roots {
            for name in ["agent.log", "agent-error.log"] {
                let file = root.appending(path: "logs/\(name)")
                guard seenFiles.insert(file.path).inserted,
                      let data = try? Data(contentsOf: file) else { continue }
                append(String(decoding: data, as: UTF8.self))
            }
        }

        // The control script resolves the same managed Runtime/current path
        // used by launchd. Include its live tail as a fallback for upgrades or
        // external-volume mounts where direct file reads can briefly lag.
        if let commandOutput = try? await run(["logs"], timeout: 10) {
            append(commandOutput)
        }

        // Both streams begin with an ISO-8601 timestamp. Merge them instead
        // of returning all stderr after stdout; this keeps task events and
        // diagnostics together in the same order users see in Workers.
        let ordered = lines.sorted { left, right in
            let leftTimestamp = String(left.value.prefix(24))
            let rightTimestamp = String(right.value.prefix(24))
            let leftLooksTimed = leftTimestamp.count == 24 && leftTimestamp.contains("T")
            let rightLooksTimed = rightTimestamp.count == 24 && rightTimestamp.contains("T")
            if leftLooksTimed && rightLooksTimed, leftTimestamp != rightTimestamp {
                return leftTimestamp < rightTimestamp
            }
            return left.index < right.index
        }
        // The App's “全部日志” view must not silently discard older task
        // events. The source files are already bounded by the runtime's log
        // retention policy, so return the complete merged set here.
        return ordered.map(\.value).joined(separator: "\n")
    }

    /// Truncate both streams in place so a running Agent can continue writing
    /// to the same paths without needing a restart or leaving stale handles.
    func clearLogs() throws {
        let logDirectory = runtimeRoot.appending(path: "logs", directoryHint: .isDirectory)
        try fileManager.createDirectory(at: logDirectory, withIntermediateDirectories: true)
        for name in ["agent.log", "agent-error.log"] {
            let file = logDirectory.appending(path: name)
            try Data().write(to: file, options: .atomic)
        }
    }

    func saveConnection(
        baseURL: String,
        agentID: String,
        agentName: String,
        agentToken: String,
        debugToken: String,
        adminKey: String,
        mumuInstanceName: String,
        allowUnsignedLocalPlugins: Bool
    ) throws {
        try saveCredentials(agentToken: agentToken, debugToken: debugToken, adminKey: adminKey)
        let root = runtimeRoot
        let path = root.appending(path: "config.json")
        let template = root.appending(path: "config.example.json")
        let source = fileManager.fileExists(atPath: path.path) ? path : template
        var object = try JSONSerialization.jsonObject(with: Data(contentsOf: source)) as! [String: Any]
        object.removeValue(forKey: "memberKick")
        var server = object["server"] as? [String: Any] ?? [:]
        server["baseUrl"] = baseURL
        server["agentId"] = agentID
        server["agentName"] = agentName
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
        var plugins = object["plugins"] as? [String: Any] ?? [:]
        plugins.removeValue(forKey: "catalogUrl")
        plugins.removeValue(forKey: "uninstalled")
        plugins["allowUnsignedLocal"] = allowUnsignedLocalPlugins
        object["plugins"] = plugins
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

    private func saveCredentials(agentToken: String, debugToken: String, adminKey: String) throws {
        try fileManager.createDirectory(at: applicationSupport, withIntermediateDirectories: true)
        try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: applicationSupport.path)
        let credentials = StoredCredentials(
            agentToken: agentToken,
            debugToken: debugToken,
            adminKey: adminKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? nil
                : adminKey.trimmingCharacters(in: .whitespacesAndNewlines)
        )
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
            let targetConfig = runtimeRoot.appending(path: "config.json")
            let currentObject = (try? JSONSerialization.jsonObject(
                with: Data(contentsOf: targetConfig)
            )) as? [String: Any]
            let currentServer = currentObject?["server"] as? [String: Any]
            try fileManager.copyItemReplacing(at: importedConfig, to: targetConfig)
            if let currentAgentID = currentServer?["agentId"] as? String,
               !currentAgentID.isEmpty {
                var importedObject = try JSONSerialization.jsonObject(
                    with: Data(contentsOf: targetConfig)
                ) as! [String: Any]
                var importedServer = importedObject["server"] as? [String: Any] ?? [:]
                importedServer["agentId"] = currentAgentID
                if let currentAgentName = currentServer?["agentName"] as? String,
                   !currentAgentName.isEmpty {
                    importedServer["agentName"] = currentAgentName
                }
                importedObject["server"] = importedServer
                try JSONSerialization.data(
                    withJSONObject: importedObject,
                    options: [.prettyPrinted, .sortedKeys]
                ).write(to: targetConfig, options: .atomic)
            }
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
    let adminKey: String?
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
