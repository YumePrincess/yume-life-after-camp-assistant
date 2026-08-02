// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "YumeLifeAfterMacAgent",
    defaultLocalization: "en",
    platforms: [.macOS(.v26)],
    products: [
        .executable(
            name: "YumeLifeAfterMacAgent",
            targets: ["YumeLifeAfterMacAgent"]
        )
    ],
    targets: [
        .executableTarget(
            name: "YumeLifeAfterMacAgent",
            resources: [.process("Resources")],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency")
            ]
        )
    ]
)
