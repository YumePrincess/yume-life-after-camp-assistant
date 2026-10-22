import Foundation

@main
struct RuntimePayloadTests {
    static func main() throws {
        let suite = RuntimePayloadTests()
        try suite.npmMetadataRewriteDoesNotTriggerUpdateAgain()
        try suite.changedDependencyAndChangedSourceStillRequireUpdate()
        print("Runtime payload regression checks passed (npm rewrites, repeat launch, dependency and source changes).")
    }

    private func fixture() throws -> (URL, URL, URL) {
        let root = FileManager.default.temporaryDirectory.appending(path: "yla-payload-test-\(UUID().uuidString)")
        let bundled = root.appending(path: "bundled"), installed = root.appending(path: "installed")
        for directory in ["src", "scripts", "plugins"] {
            try FileManager.default.createDirectory(at: bundled.appending(path: directory), withIntermediateDirectories: true)
        }
        for (path, text) in [
            "src/main.mjs": "export const version = 1;",
            "scripts/start.sh": "#!/bin/sh\nexit 0\n",
            "plugins/config.json": "{}",
            "config.example.json": "{}",
            "package.json": "{\"name\":\"agent\",\"version\":\"27.2.0\",\"build\":27171}",
            "package-lock.json": "{\"lockfileVersion\":3,\"packages\":{\"\":{\"name\":\"agent\",\"build\":27171},\"node_modules/example\":{\"version\":\"1.0.0\"}}}"
        ] { try Data(text.utf8).write(to: bundled.appending(path: path)) }
        try FileManager.default.copyItem(at: bundled, to: installed)
        return (root, bundled, installed)
    }

    func npmMetadataRewriteDoesNotTriggerUpdateAgain() throws {
        let (root, bundled, installed) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        precondition(RuntimePayload.matches(bundled: bundled, installed: installed))
        try Data("""
        {"packages":{"node_modules/example":{"version":"1.0.0"},"":{"name":"agent"}},"lockfileVersion":3}
        """.utf8).write(to: installed.appending(path: "package-lock.json"))
        precondition(RuntimePayload.matches(bundled: bundled, installed: installed))
        precondition(RuntimePayload.matches(bundled: bundled, installed: installed))
    }

    func changedDependencyAndChangedSourceStillRequireUpdate() throws {
        let (root, bundled, installed) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let lock = installed.appending(path: "package-lock.json")
        let original = try Data(contentsOf: lock)
        try Data(String(decoding: original, as: UTF8.self).replacingOccurrences(of: "1.0.0", with: "2.0.0").utf8).write(to: lock)
        precondition(!RuntimePayload.matches(bundled: bundled, installed: installed))
        try original.write(to: lock)
        try Data("changed".utf8).write(to: installed.appending(path: "src/main.mjs"))
        precondition(!RuntimePayload.matches(bundled: bundled, installed: installed))
    }
}
