// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "YumeLifeAfterMacAgent",
    defaultLocalization: "en",
    platforms: [.macOS(.v14)],
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
