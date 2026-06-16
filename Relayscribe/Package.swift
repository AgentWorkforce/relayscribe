// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Relayscribe",
    platforms: [.macOS(.v14)],
    targets: [
        // Library target — holds all testable logic
        .target(
            name: "RelayscribeCore",
            path: "Sources"
        ),
        // Thin executable wrapper
        .executableTarget(
            name: "Relayscribe",
            dependencies: ["RelayscribeCore"],
            path: "Main"
        ),
        .testTarget(
            name: "RelayscribeTests",
            dependencies: ["RelayscribeCore"],
            path: "Tests/RelayscribeTests"
        ),
    ]
)
