// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MurmurMenuBarSpike",
    defaultLocalization: "en",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "MurmurMenuBar", targets: ["MurmurMenuBar"])],
    targets: [
        .target(name: "MurmurTrayCore", resources: [.process("Resources")]),
        .executableTarget(name: "MurmurMenuBar", dependencies: ["MurmurTrayCore"]),
        .executableTarget(name: "MurmurRuntimeLauncher", dependencies: ["MurmurTrayCore"]),
        // CommandLineTools builds the app but does not ship XCTest.
        .executableTarget(name: "MurmurProbeChecks", dependencies: ["MurmurTrayCore"],
                          path: "Tests/MurmurTrayCoreTests"),
    ]
)
