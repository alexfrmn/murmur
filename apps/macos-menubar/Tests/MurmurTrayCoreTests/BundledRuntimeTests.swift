import Foundation
import MurmurTrayCore

func runBundledRuntimeChecks() throws -> Int {
    let policyDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("murmur-policy-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: policyDirectory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: policyDirectory) }
    let package = policyDirectory.appendingPathComponent("package.json")
    try "{\"engines\":{\"node\":\">=22.13.0\"}}".write(to: package, atomically: true, encoding: .utf8)
    let policy = try NodeRequirement(runtimeDirectory: policyDirectory)
    var count = 0
    func pass(_ title: String) { count += 1; print("PASS bundled runtime: \(title)") }
    for version in ["22.13.0", "22.22.3", "24.0.0", "25.9.0"] {
        try check(policy.supports(version: version), "Supported Node \(version)")
        pass("supported Node \(version)")
    }
    for version in ["20.19.0", "22.12.9", "22.13", "22.13.0-rc1", "garbage"] {
        try check(!policy.supports(version: version), "Unsupported Node \(version)")
        pass("reject unsupported Node \(version)")
    }
    let clean = BundledRuntime.cleanEnvironment(["HOME": "/test user's home", "NODE_OPTIONS": "--require /bad",
        "NODE_PATH": "/bad", "DYLD_INSERT_LIBRARIES": "/bad", "DATA_DIR": "/production", "MURMUR_UPDATE_CHECK": "0"])
    try check(clean["HOME"] == "/test user's home" && clean["MURMUR_UPDATE_CHECK"] == "0" && clean.count == 3,
              "Only home, fixed PATH and update opt-out should remain")
    pass("no Node injection or inherited production profile")
    try check(BundledRuntime.cleanEnvironment(["MURMUR_UPDATE_CHECK": "1"])["MURMUR_UPDATE_CHECK"] == nil,
              "No inherited update opt-in")
    pass("update opt-in not inherited")
    do { _ = try BundledRuntime.findNode(runtime: policyDirectory, candidates: []); throw CheckFailure(message: "Missing Node accepted") }
    catch RuntimeError.missingNode {}
    pass("missing Node is actionable")
    try withCLI("printf 'not node'") { fake in
        do { _ = try BundledRuntime.findNode(runtime: policyDirectory, candidates: [fake]); throw CheckFailure(message: "Non-Node accepted") }
        catch RuntimeError.missingNode {}
    }
    pass("unrelated executable rejected")
    try withCLI("exec /bin/sleep 30") { fake in
        let start = Date()
        do { _ = try BundledRuntime.findNode(runtime: policyDirectory, candidates: [fake], timeout: 0.1); throw CheckFailure(message: "Hung Node accepted") }
        catch RuntimeError.missingNode {}
        try check(Date().timeIntervalSince(start) < 1.5, "Hung probe must be terminated")
    }
    pass("hung Node probe has a deadline")
    try withCLI("exec /usr/bin/yes x") { fake in
        do { _ = try BundledRuntime.findNode(runtime: policyDirectory, candidates: [fake]); throw CheckFailure(message: "Unbounded output accepted") }
        catch RuntimeError.missingNode {}
    }
    pass("unbounded Node output rejected")
    try withCLI("printf '{\"executable\":\"/bin/sh\",\"version\":\"22.12.0\"}'") { fake in
        do { _ = try BundledRuntime.findNode(runtime: policyDirectory, candidates: [fake]); throw CheckFailure(message: "Old Node accepted") }
        catch RuntimeError.missingNode {}
    }
    pass("old Node executable rejected")
    try withCLI("[ -z \"${NODE_OPTIONS-}\" ] && [ -z \"${DATA_DIR-}\" ] && [ -z \"${CODEX_HOME-}\" ] && [ -z \"${CLAUDE_CONFIG_DIR-}\" ] || exit 80\nprintf '{\"executable\":\"/bin/sh\",\"version\":\"22.13.0\"}'") { fake in
        let actual = try BundledRuntime.findNode(runtime: policyDirectory, candidates: [fake],
            environment: ["NODE_OPTIONS": "bad", "DATA_DIR": "/production", "CODEX_HOME": "/custom codex", "CLAUDE_CONFIG_DIR": "/custom claude"])
        try check(actual.path == "/bin/sh", "Validated executable identity should be used")
    }
    pass("spaces in executable path; sanitized actual probe")
    do { _ = try BundledRuntime.runtime(for: URL(fileURLWithPath: "/no-app/Contents/MacOS/murmur"));
        throw CheckFailure(message: "Incomplete bundle accepted") }
    catch RuntimeError.incompleteBundle {}
    pass("missing bundled engine rejected")
    let damaged = FileManager.default.temporaryDirectory.appendingPathComponent("damaged-\(UUID().uuidString).app")
    try FileManager.default.createDirectory(at: damaged.appendingPathComponent("Contents"), withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: damaged) }
    let plist: [String: String] = ["CFBundleIdentifier": "org.murmur.mac", "CFBundlePackageType": "APPL", "CFBundleExecutable": "MurmurMenuBar"]
    try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        .write(to: damaged.appendingPathComponent("Contents/Info.plist"))
    guard let bundle = Bundle(url: damaged) else { throw CheckFailure(message: "Test bundle unavailable") }
    try check(BundledRuntime.cli(in: bundle)?.path == damaged.appendingPathComponent("Contents/MacOS/murmur").path,
              "Damaged distributed app must never choose a global Murmur CLI")
    pass("damaged app cannot silently switch engines")
    try "{\"engines\":{\"node\":\">=30.1.2\"}}".write(to: package, atomically: true, encoding: .utf8)
    let futurePolicy = try NodeRequirement(runtimeDirectory: policyDirectory)
    try check(!futurePolicy.supports(version: "30.1.1") && futurePolicy.supports(version: "30.1.2")
              && futurePolicy.supports(version: "31.0.0") && !futurePolicy.supports(version: "25.9.0"),
              "The engine's changed minimum must change the companion verdict")
    pass("future engine minimum applies without companion source edits")
    do { _ = try BundledRuntime.findNode(runtime: policyDirectory, candidates: []);
        throw CheckFailure(message: "Missing Node accepted") }
    catch let error as RuntimeError {
        try check(error.localizedDescription.contains("30.1.2"), "Guidance must name the engine's minimum")
    }
    pass("missing Node guidance follows the shipped engine")
    for invalid in ["{}", "{\"engines\":{\"node\":\"^22.0.0\"}}", "{\"engines\":{\"node\":\">=22.13.0 || >=24.0.0\"}}", "not json"] {
        try invalid.write(to: package, atomically: true, encoding: .utf8)
        do { _ = try NodeRequirement(runtimeDirectory: policyDirectory); throw CheckFailure(message: "Invalid policy accepted") }
        catch RuntimeError.invalidPolicy {}
        pass("malformed or unsupported engine policy fails closed")
    }
    return count
}
