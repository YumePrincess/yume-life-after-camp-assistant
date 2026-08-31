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

    var debugDirectory: URL {
        applicationSupport.appending(path: "debug", directoryHint: .isDirectory)
    }

    var modelsDirectory: URL {
        applicationSupport.appending(path: "Models", directoryHint: .isDirectory)
    }

    var modelDirectory: URL {
        modelsDirectory.appending(path: "Qwen3-VL-2B-Instruct-4bit", directoryHint: .isDirectory)
    }

    var modelRuntimeDirectory: URL {
        applicationSupport.appending(path: "ModelRuntime", directoryHint: .isDirectory)
    }

    var modelPythonPath: URL {
        modelRuntimeDirectory.appending(path: "venv/bin/python", directoryHint: .notDirectory)
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
                try migrateLegacyModel(from: destination)
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
        try migrateLegacyModel(from: destination)
        // Node.js is no longer copied from the App bundle. Preserve a local
        // Node downloaded by the runtime updater across bundled-code swaps.
        let existingNode = destination.appending(path: "Toolchain/node", directoryHint: .isDirectory)
        let stagingNode = staging.appending(path: "Toolchain/node", directoryHint: .isDirectory)
        if fileManager.fileExists(atPath: existingNode.path) {
            try fileManager.createDirectory(at: stagingNode.deletingLastPathComponent(), withIntermediateDirectories: true)
            try fileManager.copyItem(at: existingNode, to: stagingNode)
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

    private func migrateLegacyModel(from runtime: URL) throws {
        let legacyModel = runtime.appending(
            path: ".local-model/models/Qwen3-VL-2B-Instruct-4bit",
            directoryHint: .isDirectory
        )
        guard !fileManager.fileExists(atPath: modelDirectory.path),
              fileManager.fileExists(atPath: legacyModel.path) else { return }
        try fileManager.createDirectory(at: modelsDirectory, withIntermediateDirectories: true)
        try fileManager.copyItem(at: legacyModel, to: modelDirectory)
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
        // Older App builds copied Swift's compiler module cache and bundled
        // platform-tools into Runtime/current. Both are build/install
        // artifacts, not runtime data; remove them during every bootstrap so
        // an App update repairs existing installations as well as fresh ones.
        try? fileManager.removeItem(at: runtime.appending(path: "bin/module-cache", directoryHint: .isDirectory))
        try? fileManager.removeItem(at: runtime.appending(path: "module-cache", directoryHint: .isDirectory))
        try? fileManager.removeItem(at: runtime.appending(path: "Toolchain/platform-tools", directoryHint: .isDirectory))
        let config = runtime.appending(path: "config.json")
        if fileManager.fileExists(atPath: config.path) {
            // 27.0 renamed only the historical built-in identity. A custom
            // administrator-defined Agent ID is never overwritten.
            var object = try JSONSerialization.jsonObject(with: Data(contentsOf: config)) as! [String: Any]
            var server = object["server"] as? [String: Any] ?? [:]
            var changed = false
            if migrateMissingFlowDefinitions(
                &object,
                from: runtime.appending(path: "config.example.json")
            ) {
                changed = true
            }
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
            if let storedTimezone = server["timezone"] as? String,
               TimeZone(identifier: storedTimezone) != nil {
                // Keep a valid user-selected timezone. Setup registration can
                // replace the initial default with the Workers timezone.
            } else {
                // Legacy runtimes did not persist a local display timezone.
                // Asia/Shanghai is the Workers default and is replaced during
                // first registration when the deployment uses another zone.
                server["timezone"] = "Asia/Shanghai"
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
                changed = true
            }
            if debug["captureScreenshots"] == nil {
                debug["captureScreenshots"] = false
                changed = true
            }
            object["debug"] = debug
            if debug["captureScreenshots"] as? Bool != true {
                try? fileManager.removeItem(at: debugDirectory)
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
            if adb["binary"] as? String != "adb" {
                adb["binary"] = "adb"
                changed = true
            }
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
                    pagination["maxIncompletePageRetries"] = 6
                    pagination["maxExtraPagesAfterExpected"] = 2
                    pagination["fullPageRegion"] = [
                        "left": 115,
                        "top": 363,
                        "right": 1800,
                        "bottom": 810
                    ]
                    pagination["fullPageRows"] = 5
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
            if migrateExternalModelSettings(&object) {
                changed = true
            }
            if migrateDeathRecoverySettings(&object) {
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
        debug["captureScreenshots"] = debug["captureScreenshots"] as? Bool ?? false
        object["debug"] = debug
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: config, options: .atomic)
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: config.path)
    }

    private func migrateMissingFlowDefinitions(
        _ object: inout [String: Any],
        from template: URL
    ) -> Bool {
        guard let data = try? Data(contentsOf: template),
              let decoded = try? JSONSerialization.jsonObject(with: data),
              let templateObject = decoded as? [String: Any],
              let templateFlows = templateObject["flows"] as? [String: Any],
              !templateFlows.isEmpty else {
            return false
        }

        var flows = object["flows"] as? [String: Any] ?? [:]
        var changed = false
        for (name, definition) in templateFlows {
            guard flows[name] == nil,
                  let actions = definition as? [[String: Any]],
                  !actions.isEmpty else {
                continue
            }
            flows[name] = actions
            changed = true
        }
        if changed {
            object["flows"] = flows
        }
        return changed
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

        if patrol["campAffairsTexts"] == nil {
            patrol["campAffairsTexts"] = ["营地事务", "营地事物"]
            changed = true
        }
        if patrol["campAffairsTextRegion"] == nil {
            patrol["campAffairsTextRegion"] = [
                "left": 330, "top": 220, "right": 640, "bottom": 1000
            ]
            changed = true
        }
        if patrol["existingTeamRouteProgressTexts"] == nil {
            patrol["existingTeamRouteProgressTexts"] = ["巡逻路线进度", "巡逻路线", "巡逻路線進度", "巡逻路線"]
            changed = true
        }
        if patrol["existingTeamTaskProgressTexts"] == nil {
            patrol["existingTeamTaskProgressTexts"] = ["我的任务进度", "任务进度", "我的任務進度", "任務進度"]
            changed = true
        }
        if patrol["existingTeamRouteRegion"] == nil {
            patrol["existingTeamRouteRegion"] = [
                "left": 0, "top": 0, "right": 760, "bottom": 460
            ]
            changed = true
        }
        if patrol["existingTeamObjectiveRegion"] == nil {
            patrol["existingTeamObjectiveRegion"] = [
                "left": 0, "top": 0, "right": 900, "bottom": 120
            ]
            changed = true
        }
        if patrol["existingTeamPatrolObjectiveTexts"] == nil {
            patrol["existingTeamPatrolObjectiveTexts"] = [
                "营地事务>营地巡逻任务", "营地巡逻任务", "营地巡逻"
            ]
            changed = true
        }
        if patrol["existingTeamBookDefenseObjectiveTexts"] == nil {
            patrol["existingTeamBookDefenseObjectiveTexts"] = [
                "营地事务>保卫古籍", "保卫古籍"
            ]
            changed = true
        }
        if patrol["existingTeamCardRegion"] == nil {
            patrol["existingTeamCardRegion"] = [
                "left": 0, "top": 0, "right": 1920, "bottom": 1180
            ]
            changed = true
        }
        if patrol["teamCardColor"] == nil {
            patrol["teamCardColor"] = [
                "enabled": true,
                "taskIconPoints": [["x": 48, "y": 150]],
                "taskIconBackgroundPoints": [
                    ["x": 16, "y": 150], ["x": 80, "y": 150]
                ],
                "teamFlagIconPoints": [["x": 48, "y": 327]],
                "teamFlagBackgroundPoints": [
                    ["x": 16, "y": 327], ["x": 80, "y": 327]
                ],
                "probeRadius": 8,
                "minimumWarmPoints": 1,
                "redBlueDelta": 0.2,
                "greenBlueDelta": 0.12,
                "minimumSaturation": 0.45,
                "minimumLuminance": 0.42,
                "minimumForegroundBackgroundLuminanceDelta": 0.12,
                "minimumForegroundBackgroundChannelDelta": 0.08
            ]
            changed = true
        }
        if patrol["flagClickSettleMs"] == nil {
            patrol["flagClickSettleMs"] = 2000
            changed = true
        }
        if patrol["flagClickColorReadRetries"] == nil {
            patrol["flagClickColorReadRetries"] = 6
            changed = true
        }
        if patrol["existingTeamCardTexts"] == nil {
            patrol["existingTeamCardTexts"] = [
                "营地巡逻任务", "保卫古籍", "自动匹配", "暂无队员加入", "调整", "离开队伍"
            ]
            changed = true
        }
        if patrol["existingTeamStatusTexts"] == nil {
            patrol["existingTeamStatusTexts"] = ["自动匹配", "暂无队员加入", "等待队员加入"]
            changed = true
        }
        if let statuses = patrol["existingTeamStatusTexts"] as? [String],
           statuses.contains("调整") || statuses.contains("离开队伍") {
            patrol["existingTeamStatusTexts"] = statuses.filter {
                $0 != "调整" && $0 != "离开队伍"
            }
            changed = true
        }
        if patrol["existingTeamMemberStatusTexts"] == nil {
            patrol["existingTeamMemberStatusTexts"] = ["自动匹配", "暂无队员加入", "等待队员加入"]
            changed = true
        }
        if patrol["teamMemberSlotRegions"] == nil {
            patrol["teamMemberSlotRegions"] = [
                ["left": 560, "top": 290, "right": 955, "bottom": 960],
                ["left": 960, "top": 290, "right": 1355, "bottom": 960],
                ["left": 1360, "top": 290, "right": 1750, "bottom": 960]
            ]
            changed = true
        }
        if patrol["teamMemberLocationRegions"] == nil {
            patrol["teamMemberLocationRegions"] = [
                ["left": 560, "top": 840, "right": 955, "bottom": 925],
                ["left": 960, "top": 840, "right": 1355, "bottom": 925],
                ["left": 1360, "top": 840, "right": 1750, "bottom": 925]
            ]
            changed = true
        }
        if patrol["existingTeamPanelSettleMs"] == nil {
            patrol["existingTeamPanelSettleMs"] = 1200
            changed = true
        }
        if patrol["leaveTeamAttempts"] == nil {
            patrol["leaveTeamAttempts"] = 3
            changed = true
        }
        if patrol["leaveTeamSettleMs"] == nil {
            patrol["leaveTeamSettleMs"] = 1500
            changed = true
        }
        if patrol["leaveTeamTextRegion"] == nil {
            patrol["leaveTeamTextRegion"] = [
                "left": 0, "top": 0, "right": 1920, "bottom": 1200
            ]
            changed = true
        }
        if patrol["leaveTeamConfirmTexts"] == nil {
            patrol["leaveTeamConfirmTexts"] = ["确认(F)", "确定(F)", "确认"]
            changed = true
        }
        if patrol["leaveTeamConfirmRegion"] == nil {
            patrol["leaveTeamConfirmRegion"] = [
                "left": 760, "top": 420, "right": 1380, "bottom": 850
            ]
            changed = true
        }
        if patrol["leaveTeamCancelTexts"] == nil {
            patrol["leaveTeamCancelTexts"] = ["取消(Esc)", "取消", "Cancel", "Esc"]
            changed = true
        }
        if patrol["leaveTeamCancelKeyCode"] == nil {
            patrol["leaveTeamCancelKeyCode"] = 111
            changed = true
        }
        if patrol["leaveTeamCancelAttempts"] == nil {
            patrol["leaveTeamCancelAttempts"] = 3
            changed = true
        }
        if patrol["leaveTeamValidRouteTexts"] == nil {
            patrol["leaveTeamValidRouteTexts"] = ["巡逻任务尚未完成", "视为放弃任务", "放弃任务"]
            changed = true
        }
        if patrol["leaveTeamDialogTexts"] == nil {
            patrol["leaveTeamDialogTexts"] = [
                "退出队伍", "离开队伍", "是否退出", "是否离开", "确认离开",
                "巡逻任务尚未完成", "视为放弃任务", "放弃任务", "是否退出队伍"
            ]
            changed = true
        }
        if patrol["leaveTeamConfirmKeyCode"] == nil {
            patrol["leaveTeamConfirmKeyCode"] = 34
            changed = true
        }

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
        if share["recruitRecoveryRegion"] == nil {
            share["recruitRecoveryRegion"] = [
                "left": 0, "top": 900, "right": 850, "bottom": 1200
            ]
            changed = true
        }
        if share["recruitAiAttempts"] == nil {
            share["recruitAiAttempts"] = 2
            changed = true
        }
        if share["recruitOverlayControlPoints"] == nil {
            share["recruitOverlayControlPoints"] = [
                "close_x": ["x": 1800, "y": 900],
                "back": ["x": 75, "y": 1120],
                "collapse": ["x": 1740, "y": 1110]
            ]
            changed = true
        }
        if share["sceneChannelTexts"] == nil {
            share["sceneChannelTexts"] = ["场景频道", "场景"]
            changed = true
        }
        if share["sceneSuccessTexts"] == nil {
            share["sceneSuccessTexts"] = ["成功分享至场景频道", "分享成功"]
            changed = true
        }
        if share["successTexts"] == nil {
            share["successTexts"] = ["成功分享至营地频道", "分享成功"]
            changed = true
        }
        if share["successRegion"] == nil {
            share["successRegion"] = ["left": 650, "top": 150, "right": 1300, "bottom": 330]
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
        if flows["closeTaskGuideOverlay"] == nil {
            flows["closeTaskGuideOverlay"] = [[
                "op": "closeTaskGuideOverlay",
                "texts": ["任务", "当前", "导航", "追踪"],
                "region": ["left": 0, "top": 0, "right": 960, "bottom": 1200],
                "minimumTexts": 3,
                "dismissPoint": ["x": 1600, "y": 600],
                "maxAttempts": 4,
                "intervalMs": 500,
                "regionOcrMinimumConfidence": 0.2,
                "regionOcrScale": 2
            ]]
            changed = true
        }
        if var openFlow = flows["openTeamPanel"] as? [[String: Any]] {
            let overlayMetadata: [String: Any] = [
                "texts": ["任务", "当前", "导航", "追踪"],
                "region": ["left": 0, "top": 0, "right": 960, "bottom": 1200],
                "minimumTexts": 3,
                "dismissPoint": ["x": 1600, "y": 600],
                "maxAttempts": 4,
                "intervalMs": 500,
                "regionOcrMinimumConfidence": 0.2,
                "regionOcrScale": 2
            ]
            var guardedPanelAction: [String: Any] = [
                "op": "openTeamPanelGuarded",
                "cardPoint": ["x": 350, "y": 150],
                "requiredCardTexts": ["自动匹配"],
                "memberStateTexts": ["暂无队员加入", "等待队员加入"],
                "panelTexts": ["调整", "离开队伍"],
                "minimumPanelTexts": 2,
                "panelRegion": ["left": 0, "top": 0, "right": 1920, "bottom": 1180],
                "cardRegion": ["left": 0, "top": 0, "right": 1920, "bottom": 1180],
                "memberNameRegion": ["left": 0, "top": 120, "right": 620, "bottom": 520],
                "settleMs": 500,
                "hud": true
            ]
            guardedPanelAction["taskGuideOverlay"] = overlayMetadata
            var flowChanged = false
            if !openFlow.contains(where: { $0["op"] as? String == "closeTaskGuideOverlay" }) {
                var closeAction = overlayMetadata
                closeAction["op"] = "closeTaskGuideOverlay"
                openFlow.insert(closeAction, at: 0)
                flowChanged = true
            }
            let hasGuardedPanelAction = openFlow.contains {
                $0["op"] as? String == "openTeamPanelGuarded"
            }
            let guardedPanelActionNeedsMemberRegion = openFlow.contains { action in
                action["op"] as? String == "openTeamPanelGuarded" &&
                    action["memberNameRegion"] == nil
            }
            let guardedPanelActionNeedsRequiredCardText = openFlow.contains { action in
                guard action["op"] as? String == "openTeamPanelGuarded" else { return false }
                guard let requiredCardTexts = action["requiredCardTexts"] as? [String] else {
                    return true
                }
                return requiredCardTexts != ["自动匹配"]
            }
            let hasLegacyFlagRetry = openFlow.contains { action in
                guard action["op"] as? String == "tapUntilAnyTexts" else { return false }
                let controlLabel = action["controlLabel"] as? String
                let x = (action["x"] as? NSNumber)?.intValue
                let y = (action["y"] as? NSNumber)?.intValue
                return controlLabel == "队伍卡片旗帜展开" || (x == 50 && y == 325)
            }
            let hasLegacyCardTap = openFlow.contains { action in
                guard action["op"] as? String == "tapUnlessAnyText" else { return false }
                let x = (action["x"] as? NSNumber)?.intValue
                let y = (action["y"] as? NSNumber)?.intValue
                return x == 350 && y == 150
            }
            if !hasGuardedPanelAction || guardedPanelActionNeedsMemberRegion || guardedPanelActionNeedsRequiredCardText || hasLegacyFlagRetry || hasLegacyCardTap {
                var rebuilt: [[String: Any]] = []
                var insertedGuard = false
                for action in openFlow {
                    let op = action["op"] as? String
                    let x = (action["x"] as? NSNumber)?.intValue
                    let y = (action["y"] as? NSNumber)?.intValue
                    let isLegacyFlag = op == "tapUntilAnyTexts" && (
                        action["controlLabel"] as? String == "队伍卡片旗帜展开" ||
                        (x == 50 && y == 325)
                    )
                    let isLegacyCardTap = op == "tapUnlessAnyText" && x == 350 && y == 150
                    if op == "openTeamPanelGuarded" || isLegacyFlag || isLegacyCardTap {
                        if !insertedGuard {
                            rebuilt.append(guardedPanelAction)
                            insertedGuard = true
                        }
                        continue
                    }
                    rebuilt.append(action)
                }
                if !insertedGuard {
                    let insertionIndex = rebuilt.firstIndex {
                        $0["op"] as? String == "closeTaskGuideOverlay"
                    }.map { $0 + 1 } ?? 0
                    rebuilt.insert(guardedPanelAction, at: insertionIndex)
                }
                openFlow = rebuilt
                flowChanged = true
            }
            if flowChanged {
                flows["openTeamPanel"] = openFlow
                changed = true
            }
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

    private func migrateExternalModelSettings(_ object: inout [String: Any]) -> Bool {
        var model = object["localVisionModel"] as? [String: Any] ?? [:]
        var changed = object["localVisionModel"] != nil &&
            (object["localVisionModel"] as? [String: Any]) == nil
        let defaults: [String: Any] = [
            "enabled": true,
            "mode": "guarded",
            "transport": "http",
            "baseUrl": "http://127.0.0.1:8092",
            "timeoutSeconds": 180,
            "minimumConfidence": 0.9,
            "waitTextVerificationEnabled": false,
            "minimumActionConfidence": 0.95,
            "minimumLoginActionConfidence": 0.45,
            "consecutiveMatches": 1,
            "maxAdviceAgeSeconds": 8,
            "intervalSeconds": 3,
            "unknownRecoveryDelaySeconds": 8,
            "unknownRecoveryMatches": 2,
            "autoStartForTasks": true,
            "stopAfterTask": true
        ]
        for (key, value) in defaults where model[key] == nil {
            model[key] = value
            changed = true
        }
        if model["model"] as? String != modelDirectory.path {
            model["model"] = modelDirectory.path
            changed = true
        }
        if model["pythonBinary"] as? String != modelPythonPath.path {
            model["pythonBinary"] = modelPythonPath.path
            changed = true
        }
        object["localVisionModel"] = model
        return changed
    }

    private func migrateDeathRecoverySettings(_ object: inout [String: Any]) -> Bool {
        var recovery = object["deathRecovery"] as? [String: Any] ?? [:]
        let defaults: [String: Any] = [
            "enabled": true,
            "pollSeconds": 3,
            "dialogRegion": ["left": 0, "top": 0, "right": 1_920, "bottom": 1_200],
            "buttonRegion": ["left": 1_320, "top": 820, "right": 1_900, "bottom": 1_170],
            "deathTexts": ["昏迷通知单", "昏迷于"],
            "returnToCampTexts": ["回到营地"],
            "accurateProbeIntervalMs": 1_500,
            "accurateMinimumConfidence": 0.2,
            "accurateScale": 2,
            "reviveSettleMs": 2_000,
            "reviveConfirmationTimeoutSeconds": 12,
            "reviveConfirmationPollMs": 800,
            "reviveReadyTexts": ["背包", "营地", "综合", "世界", "场景"],
            "reviveReadyMinimumTexts": 2,
            "cooldownSeconds": 8,
            "restartDelaySeconds": 3,
            "maxTaskRestarts": 2
        ]
        var changed = false
        for (key, value) in defaults where recovery[key] == nil {
            recovery[key] = value
            changed = true
        }
        object["deathRecovery"] = recovery
        return changed
    }

    func run(_ arguments: [String], timeout: TimeInterval = 120) async throws -> String {
        let root = runtimeRoot
        let script = root.appending(path: "scripts/manage-local-agent.sh").path
        guard nodePath() != nil else {
            throw RuntimeError.failed(String(localized: "Node.js is required. Install Node.js 22 arm64, then retry."))
        }
        guard adbPath() != nil else {
            throw RuntimeError.failed(String(localized: "ADB is required. Install Android platform-tools, then retry."))
        }
        return try await process("/bin/zsh", [script] + arguments, workingDirectory: root, timeout: timeout)
    }

    func plugin(_ arguments: [String], timeout: TimeInterval = 120) async throws -> String {
        let root = runtimeRoot
        guard let node = nodePath() else {
            throw RuntimeError.failed(String(localized: "Node.js is required. Install Node.js 22 arm64, then retry."))
        }
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

    func abort(debugToken: String) async throws {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8091/abort")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 5
        request.setValue("Bearer \(debugToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw RuntimeError.failed(payload?["error"] as? String ?? "HTTP \(status)")
        }
    }

    func registerAgent(
        baseURL: String,
        agentID: String,
        agentName: String,
        agentToken: String
    ) async throws -> String? {
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
        let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        return payload?["timezone"] as? String
    }

    func logs(maxBytesPerFile: Int = 2_000_000, maxLinesPerFile: Int = 8_000) async -> String {
        // The log screen is polled by the App. Never read an unbounded file or
        // spawn the management shell command here: both operations used to
        // copy/parse the entire history on the main actor and made a large
        // log appear frozen. The explicit Refresh action still uses this same
        // bounded tail, while the Workers console owns its own event window.
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
        func append(_ data: Data) {
            let text = String(decoding: data, as: UTF8.self)
            let fileLines = text
                .split(separator: "\n", omittingEmptySubsequences: false)
                .suffix(maxLinesPerFile)
            for line in fileLines {
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
                      let handle = try? FileHandle(forReadingFrom: file) else { continue }
                defer { try? handle.close() }
                let size = (try? handle.seekToEnd()) ?? 0
                let start = size > UInt64(maxBytesPerFile)
                    ? size - UInt64(maxBytesPerFile)
                    : 0
                try? handle.seek(toOffset: start)
                if let data = try? handle.readToEnd() {
                    append(data)
                }
            }
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
        // A Debug image is evidence for a log entry. Clearing the complete
        // local log history must not leave unreferenced task evidence behind.
        try? fileManager.removeItem(at: debugDirectory)
    }

    func debugCaptureEnabled() -> Bool {
        let config = runtimeRoot.appending(path: "config.json")
        guard let data = try? Data(contentsOf: config),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let debug = object["debug"] as? [String: Any]
        else { return false }
        return debug["captureScreenshots"] as? Bool ?? false
    }

    func setDebugCaptureEnabled(_ enabled: Bool) throws {
        let config = runtimeRoot.appending(path: "config.json")
        guard fileManager.fileExists(atPath: config.path) else {
            throw RuntimeError.failed(String(localized: "Runtime configuration is missing. Run the setup assistant first."))
        }
        var object = try JSONSerialization.jsonObject(with: Data(contentsOf: config)) as! [String: Any]
        var debug = object["debug"] as? [String: Any] ?? [:]
        debug["captureScreenshots"] = enabled
        object["debug"] = debug
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: config, options: .atomic)
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: config.path)
        if !enabled {
            try? fileManager.removeItem(at: debugDirectory)
        }
    }

    func clearDebugCapture() throws {
        try? fileManager.removeItem(at: debugDirectory)
    }

    func debugImages(runID: String) -> [TaskDebugImage] {
        let safeID = runID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !safeID.isEmpty,
              safeID.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil
        else { return [] }
        let base = debugDirectory.standardizedFileURL
        let directory = base.appending(path: safeID, directoryHint: .isDirectory).standardizedFileURL
        guard directory.path.hasPrefix(base.path + "/"),
              let files = try? fileManager.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: [.isRegularFileKey],
                options: [.skipsHiddenFiles]
              )
        else { return [] }
        return files
            .filter { ["png", "jpg", "jpeg", "webp"].contains($0.pathExtension.lowercased()) }
            .filter { (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true }
            .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
            .enumerated()
            .map { index, url in
                let name = url.deletingPathExtension().lastPathComponent
                let components = name.split(separator: "-", maxSplits: 1).map(String.init)
                let sequence = Int(components.first ?? "") ?? index + 1
                let label = components.count > 1 ? components[1] : name
                return TaskDebugImage(id: "\(safeID)-\(sequence)-\(url.lastPathComponent)", sequence: sequence, label: label, url: url)
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
        allowUnsignedLocalPlugins: Bool,
        locale: String,
        timezone: String,
        captureDebugArtifacts: Bool
    ) throws {
        try saveCredentials(agentToken: agentToken, debugToken: debugToken, adminKey: adminKey)
        let root = runtimeRoot
        let path = root.appending(path: "config.json")
        let template = root.appending(path: "config.example.json")
        let source = fileManager.fileExists(atPath: path.path) ? path : template
        var object = try JSONSerialization.jsonObject(with: Data(contentsOf: source)) as! [String: Any]
        object.removeValue(forKey: "memberKick")
        _ = migrateExternalModelSettings(&object)
        var server = object["server"] as? [String: Any] ?? [:]
        server["baseUrl"] = baseURL
        server["agentId"] = agentID
        server["agentName"] = agentName
        server["locale"] = locale
        server["timezone"] = timezone
        server["agentToken"] = "CREDENTIALS_FILE"
        object["server"] = server
        var mumu = object["mumu"] as? [String: Any] ?? [:]
        mumu["instanceName"] = mumuInstanceName
        object["mumu"] = mumu
        var adb = object["adb"] as? [String: Any] ?? [:]
        // The matching MuMu instance reports its current loopback ADB port.
        // It is intentionally not persisted as a fragile, hard-coded port.
        adb["binary"] = "adb"
        adb["serial"] = "auto"
        object["adb"] = adb
        var debug = object["debug"] as? [String: Any] ?? [:]
        debug["token"] = "CREDENTIALS_FILE"
        debug["captureScreenshots"] = captureDebugArtifacts
        object["debug"] = debug
        var plugins = object["plugins"] as? [String: Any] ?? [:]
        plugins.removeValue(forKey: "catalogUrl")
        plugins.removeValue(forKey: "uninstalled")
        plugins["allowUnsignedLocal"] = allowUnsignedLocalPlugins
        object["plugins"] = plugins
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: path, options: [.atomic])
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
        if !captureDebugArtifacts {
            try? fileManager.removeItem(at: debugDirectory)
        }
    }

    func setRuntimeLocale(_ locale: String, debugToken: String) async {
        guard !debugToken.isEmpty,
              let url = URL(string: "http://127.0.0.1:8091/locale") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 3
        request.setValue("Bearer \(debugToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["locale": locale])
        _ = try? await URLSession.shared.data(for: request)
    }

    func setRuntimeDebugCapture(_ enabled: Bool, debugToken: String) async {
        guard !debugToken.isEmpty,
              let url = URL(string: "http://127.0.0.1:8091/debug-capture") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 3
        request.setValue("Bearer \(debugToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["enabled": enabled])
        _ = try? await URLSession.shared.data(for: request)
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

    func exportMigrationArchive(
        to archive: URL,
        includeModel: Bool = false,
        includeCredentials: Bool = false
    ) async throws {
        let stagingRoot = fileManager.temporaryDirectory
            .appending(path: "yla-backup-\(UUID().uuidString)", directoryHint: .isDirectory)
        let payload = stagingRoot.appending(path: "YumeLifeAfterBackup", directoryHint: .isDirectory)
        defer { try? fileManager.removeItem(at: stagingRoot) }
        try fileManager.createDirectory(at: payload, withIntermediateDirectories: true)
        let manifest: [String: Any] = [
            "schemaVersion": 2,
            "createdAt": ISO8601DateFormatter().string(from: Date()),
            "containsSecrets": includeCredentials,
            "containsModel": includeModel,
            "containsCredentials": includeCredentials
        ]
        try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
            .write(to: payload.appending(path: "manifest.json"), options: .atomic)
        // Normalize a copy through the same migration path used on App
        // startup/import. This keeps an archive made from an older runtime
        // aligned with the newest bundled defaults and flow definitions,
        // while never mutating the live config during export.
        let exportRuntime = stagingRoot.appending(path: "Runtime", directoryHint: .isDirectory)
        try fileManager.createDirectory(at: exportRuntime, withIntermediateDirectories: true)
        let template = runtimeRoot.appending(path: "config.example.json")
        guard fileManager.fileExists(atPath: template.path) else {
            throw RuntimeError.failed(String(localized: "The bundled runtime configuration template is missing."))
        }
        try fileManager.copyItem(at: template, to: exportRuntime.appending(path: "config.example.json"))
        let currentConfig = runtimeRoot.appending(path: "config.json")
        if fileManager.fileExists(atPath: currentConfig.path) {
            try fileManager.copyItem(at: currentConfig, to: exportRuntime.appending(path: "config.json"))
        }
        try ensureRuntimeConfig(at: exportRuntime)
        let normalizedConfig = exportRuntime.appending(path: "config.json")
        guard fileManager.fileExists(atPath: normalizedConfig.path) else {
            throw RuntimeError.failed(String(localized: "Runtime configuration is missing. Run the setup assistant first."))
        }
        var object = try JSONSerialization.jsonObject(with: Data(contentsOf: normalizedConfig)) as! [String: Any]
        object.removeValue(forKey: "memberKick")
        var server = object["server"] as? [String: Any] ?? [:]
        server["agentToken"] = "CREDENTIALS_FILE"
        object["server"] = server
        var debug = object["debug"] as? [String: Any] ?? [:]
        debug["token"] = "CREDENTIALS_FILE"
        object["debug"] = debug
        try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
            .write(to: payload.appending(path: "config.json"), options: .atomic)
        let plugins = applicationSupport.appending(path: "Plugins", directoryHint: .isDirectory)
        if fileManager.fileExists(atPath: plugins.path) {
            try fileManager.copyItem(at: plugins, to: payload.appending(path: "Plugins", directoryHint: .isDirectory))
        }
        if includeModel {
            guard modelStatus().isInstalled else {
                throw RuntimeError.failed(String(localized: "The local Qwen model is not installed."))
            }
            let models = payload.appending(path: "Models", directoryHint: .isDirectory)
            try fileManager.createDirectory(at: models, withIntermediateDirectories: true)
            try fileManager.copyItem(
                at: modelDirectory,
                to: models.appending(path: modelDirectory.lastPathComponent, directoryHint: .isDirectory)
            )
        }
        if includeCredentials {
            guard fileManager.fileExists(atPath: credentialsFile.path) else {
                throw RuntimeError.failed(String(localized: "No saved credentials were found."))
            }
            try fileManager.copyItem(at: credentialsFile, to: payload.appending(path: "credentials.json"))
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
        let schemaVersion = (manifest?["schemaVersion"] as? NSNumber)?.intValue ?? 0
        guard schemaVersion == 1 || schemaVersion == 2 else {
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
        let importedModels = payload.appending(
            path: "Models/Qwen3-VL-2B-Instruct-4bit",
            directoryHint: .isDirectory
        )
        if fileManager.fileExists(atPath: importedModels.appending(path: "config.json").path),
           (try? fileManager.contentsOfDirectory(at: importedModels, includingPropertiesForKeys: nil)
               .contains(where: { $0.pathExtension == "safetensors" })) == true {
            try fileManager.createDirectory(at: modelsDirectory, withIntermediateDirectories: true)
            try fileManager.copyItemReplacing(at: importedModels, to: modelDirectory)
        }
        let importedCredentials = payload.appending(path: "credentials.json")
        if fileManager.fileExists(atPath: importedCredentials.path) {
            try fileManager.createDirectory(at: applicationSupport, withIntermediateDirectories: true)
            try fileManager.copyItemReplacing(at: importedCredentials, to: credentialsFile)
            try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: credentialsFile.path)
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

    func nodeStatus() async -> NodeRuntimeInfo {
        if let local = localNodePath() {
            return NodeRuntimeInfo(
                source: .local,
                path: local,
                version: nodeVersion(at: local)
            )
        }
        if let system = systemNodePath() {
            return NodeRuntimeInfo(
                source: .system,
                path: system,
                version: nodeVersion(at: system)
            )
        }
        return .missing
    }

    func modelStatus() -> ModelRuntimeInfo {
        let installed = fileManager.fileExists(atPath: modelDirectory.appending(path: "config.json").path) &&
            ((try? fileManager.contentsOfDirectory(at: modelDirectory, includingPropertiesForKeys: nil)
                .contains(where: { $0.pathExtension == "safetensors" })) == true)
        let pythonAvailable = fileManager.isExecutableFile(atPath: modelPythonPath.path)
        return ModelRuntimeInfo(
            path: modelDirectory.path,
            isInstalled: installed,
            isRuntimeAvailable: pythonAvailable
        )
    }

    func localVisionEnabled() -> Bool {
        let config = runtimeRoot.appending(path: "config.json")
        guard let data = try? Data(contentsOf: config),
              let decoded = try? JSONSerialization.jsonObject(with: data),
              let object = decoded as? [String: Any],
              let model = object["localVisionModel"] as? [String: Any]
        else {
            return true
        }
        return model["enabled"] as? Bool ?? true
    }

    func setLocalVisionEnabled(_ enabled: Bool) throws {
        let config = runtimeRoot.appending(path: "config.json")
        guard fileManager.fileExists(atPath: config.path) else {
            throw RuntimeError.failed(String(localized: "Runtime configuration is missing. Run the setup assistant first."))
        }
        var object = try JSONSerialization.jsonObject(with: Data(contentsOf: config)) as! [String: Any]
        _ = migrateExternalModelSettings(&object)
        var model = object["localVisionModel"] as? [String: Any] ?? [:]
        model["enabled"] = enabled
        object["localVisionModel"] = model
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: config, options: .atomic)
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: config.path)
    }

    func prepareModelRuntime() async throws -> ModelRuntimeInfo {
        try await runModelControl("deps", timeout: 1_800)
        return modelStatus()
    }

    func installExternalModel() async throws -> ModelRuntimeInfo {
        try await runModelControl("install", timeout: 3_600)
        return modelStatus()
    }

    private func runModelControl(_ action: String, timeout: TimeInterval) async throws {
        let script = runtimeRoot.appending(path: "scripts/local-model.sh").path
        guard fileManager.fileExists(atPath: script) else {
            throw RuntimeError.failed(String(localized: "The local model installer is missing."))
        }
        _ = try await process(
            "/bin/zsh",
            [script, action],
            workingDirectory: runtimeRoot,
            timeout: timeout
        )
    }

    func adbStatus() async -> AdbRuntimeInfo {
        guard let adb = adbPath() else { return .missing }
        return AdbRuntimeInfo(source: .system, path: adb, version: toolVersion(at: adb))
    }

    /// Downloads the pinned arm64 Node.js runtime outside the App bundle.
    /// The Overview update action calls this before updating the JS runtime,
    /// so a Mac without a discoverable shell Node can still be repaired.
    func ensureLocalNodeForUpdate() async throws -> NodeRuntimeInfo {
        let root = runtimeRoot
        let script = root.appending(path: "scripts/ensure-local-node.sh").path
        guard fileManager.fileExists(atPath: script) else {
            throw RuntimeError.failed(String(localized: "The local Node.js installer is missing."))
        }
        _ = try await process(
            "/bin/zsh",
            [script, "--update"],
            workingDirectory: root,
            timeout: 1_800
        )
        let status = await nodeStatus()
        guard status.source == .local else {
            throw RuntimeError.failed(String(localized: "Local Node.js could not be installed."))
        }
        return status
    }

    private func nodePath() -> String? {
        localNodePath() ?? systemNodePath()
    }

    private func localNodePath() -> String? {
        let candidates = [
            applicationSupport.appending(path: "Runtime/current/Toolchain/node/bin/node"),
            runtimeRoot.appending(path: "Toolchain/node/bin/node")
        ]
        return candidates.map(\.path).first(where: fileManager.isExecutableFile(atPath:))
    }

    private func systemNodePath() -> String? {
        var candidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/opt/local/bin/node",
            "/usr/bin/node"
        ]
        let home = fileManager.homeDirectoryForCurrentUser.path
        candidates.append(contentsOf: [
            "\(home)/.volta/bin/node",
            "\(home)/.asdf/shims/node",
            "\(home)/.local/bin/node"
        ])
        if let path = ProcessInfo.processInfo.environment["PATH"] {
            candidates.append(contentsOf: path.split(separator: ":").map {
                URL(fileURLWithPath: String($0)).appending(path: "node").path
            })
        }
        return candidates.first(where: fileManager.isExecutableFile(atPath:))
    }

    private func adbPath() -> String? {
        var candidates = [
            "/opt/homebrew/bin/adb",
            "/usr/local/bin/adb",
            "/opt/local/bin/adb",
            "/usr/bin/adb"
        ]
        let home = fileManager.homeDirectoryForCurrentUser.path
        candidates.append(contentsOf: [
            "\(home)/Library/Android/sdk/platform-tools/adb",
            "\(home)/.android/sdk/platform-tools/adb"
        ])
        if let path = ProcessInfo.processInfo.environment["PATH"] {
            candidates.append(contentsOf: path.split(separator: ":").map {
                URL(fileURLWithPath: String($0)).appending(path: "adb").path
            })
        }
        return candidates.first(where: fileManager.isExecutableFile(atPath:))
    }

    private func nodeVersion(at path: String) -> String? {
        toolVersion(at: path)
    }

    private func toolVersion(at path: String) -> String? {
        let task = Process()
        let pipe = Pipe()
        task.executableURL = URL(fileURLWithPath: path)
        task.arguments = ["--version"]
        task.standardOutput = pipe
        task.standardError = pipe
        do {
            try task.run()
            task.waitUntilExit()
        } catch {
            return nil
        }
        guard task.terminationStatus == 0 else { return nil }
        let output = String(
            decoding: pipe.fileHandleForReading.readDataToEndOfFile(),
            as: UTF8.self
        ).trimmingCharacters(in: .whitespacesAndNewlines)
        return output.split(whereSeparator: \.isNewline).first.map(String.init)
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
            // App launches do not inherit an interactive shell PATH. Add the
            // external/local Node and system ADB directories explicitly so
            // management scripts behave the same from the GUI and Terminal.
            var environment = ProcessInfo.processInfo.environment
            var runtimePaths: [String] = []
            if let node = nodePath() {
                runtimePaths.insert(URL(fileURLWithPath: node).deletingLastPathComponent().path, at: 0)
            }
            if let adb = adbPath() {
                runtimePaths.insert(URL(fileURLWithPath: adb).deletingLastPathComponent().path, at: 0)
            }
            let inheritedPath = environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
            environment["PATH"] = (runtimePaths + [inheritedPath]).joined(separator: ":")
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

enum NodeRuntimeSource: String, Sendable {
    case system
    case local
    case missing
}

struct NodeRuntimeInfo: Sendable {
    let source: NodeRuntimeSource
    let path: String?
    let version: String?

    static let missing = NodeRuntimeInfo(source: .missing, path: nil, version: nil)

    var isAvailable: Bool { source != .missing }
    var isLocal: Bool { source == .local }
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
