// swift-tools-version:5.10
import PackageDescription

// The Sidequest Mac app. Built with SwiftPM rather than an Xcode project so
// the repo has no .xcodeproj to churn; scripts/build-app.sh turns the
// executable into Sidequest.app.
let package = Package(
    name: "Sidequest",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Sidequest", targets: ["Sidequest"]),
    ],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.6.4"),
    ],
    targets: [
        .executableTarget(
            name: "Sidequest",
            dependencies: [.product(name: "Sparkle", package: "Sparkle")],
            path: "Sources/Sidequest",
            linkerSettings: [
                // Sparkle.framework is copied into Contents/Frameworks by build-app.sh.
                .unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"]),
            ]
        ),
        .testTarget(
            name: "SidequestTests",
            dependencies: ["Sidequest"],
            path: "Tests/SidequestTests",
            resources: [.copy("Fixtures")]
        ),
    ]
)
