import Foundation

/// Compare shipped code while tolerating npm's formatting and root build-metadata rewrites.
/// Dependency resolutions, package versions and every executable source file still participate.
enum RuntimePayload {
    static func matches(bundled: URL, installed: URL, fileManager: FileManager = .default) -> Bool {
        let sourceRoot = bundled.resolvingSymlinksInPath().standardizedFileURL
        let destinationRoot = installed.resolvingSymlinksInPath().standardizedFileURL
        var files = ["config.example.json", "package.json", "package-lock.json"]
        for root in ["src", "scripts", "plugins"] {
            let directory = sourceRoot.appending(path: root)
            guard let enumerator = fileManager.enumerator(atPath: directory.path) else { return false }
            // Relative enumeration avoids /var vs /private/var aliases in URL enumerators.
            for case let relative as String in enumerator {
                if relative.split(separator: "/").contains(where: { $0.hasPrefix(".") }) { continue }
                let file = directory.appending(path: relative)
                guard (try? file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
                files.append("\(root)/\(relative)")
            }
        }
        return files.allSatisfy { relative in
            let source = sourceRoot.appending(path: relative), target = destinationRoot.appending(path: relative)
            if relative == "package-lock.json" {
                guard let left = normalizedLockfile(source), let right = normalizedLockfile(target) else { return false }
                return left.isEqual(right)
            }
            return fileManager.fileExists(atPath: target.path) && fileManager.contentsEqual(atPath: source.path, andPath: target.path)
        }
    }

    private static func normalizedLockfile(_ url: URL) -> NSDictionary? {
        guard let data = try? Data(contentsOf: url),
              var lock = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        lock.removeValue(forKey: "build")
        if var packages = lock["packages"] as? [String: Any], var root = packages[""] as? [String: Any] {
            root.removeValue(forKey: "build")
            packages[""] = root; lock["packages"] = packages
        }
        return lock as NSDictionary
    }
}
