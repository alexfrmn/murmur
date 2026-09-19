import Foundation
import MurmurTrayCore

private func updateFixture(now: Date) -> [String: Any] {
    let stamp = ISO8601DateFormatter().string(from: now)
    return ["schema": "murmur.updates/1", "channel": "stable", "currentVersion": "2.9.0",
            "versionSource": "root-package-json", "comparison": "declared-release-version", "enabled": true,
            "state": "available", "reason": "updates.newer-release", "latestVersion": "2.10.0",
            "releaseUrl": "https://github.com/alexfrmn/murmur/releases/tag/v2.10.0", "action": "open-release-page",
            "checkedAt": stamp, "lastSuccessAt": stamp, "nextCheckAt": ISO8601DateFormatter().string(from: now.addingTimeInterval(21_600)),
            "cached": false, "stale": false, "checkIntervalMs": 21_600_000, "timeoutMs": 4_000]
}
private func updateData(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: value) }
private func updateReply(_ value: [String: Any]) throws -> String {
    "cat <<'MURMUR_UPDATE_RESPONSE'\n" + String(data: try updateData(value), encoding: .utf8)! + "\nMURMUR_UPDATE_RESPONSE\n"
}
private func rejectUpdate(_ value: [String: Any], _ label: String) throws {
    do { _ = try UpdateSnapshot.decode(updateData(value)) }
    catch is UpdateError { return }
    throw CheckFailure(message: "Update contract must reject " + label)
}

func runUpdateChecks() throws -> Int {
    let now = Date(), base = updateFixture(now: Date())
    var count = 0
    func pass(_ name: String) { count += 1; print("PASS updates: \(name)") }
    let available = try UpdateSnapshot.decode(updateData(base))
    try check(available.releasePage(now: now) != nil && available.title(now: now).contains("2.10.0"), "Available badge and explicit page action")
    pass("available stable result")
    var current = base; current["state"] = "up-to-date"; current["reason"] = "updates.no-newer-release"
    current["action"] = NSNull(); current["releaseUrl"] = NSNull()
    let currentSnapshot = try UpdateSnapshot.decode(updateData(current))
    try check(currentSnapshot.releasePage(now: now) == nil && currentSnapshot.title(now: now).contains("не найдено"), "Current never opens a page")
    pass("up-to-date consumes CLI decision without version comparison")
    for reason in ["updates.disabled", "updates.timeout", "updates.network-error", "updates.cache-invalid",
                   "updates.rate-limited", "updates.check-in-progress", "updates.current-version-invalid"] {
        var unknown = current; unknown["state"] = "unknown"; unknown["reason"] = reason
        unknown["latestVersion"] = NSNull(); unknown["stale"] = true; unknown["cached"] = true
        if reason == "updates.disabled" { unknown["enabled"] = false }
        let snapshot = try UpdateSnapshot.decode(updateData(unknown))
        try check(snapshot.state == .unknown && snapshot.releasePage(now: now) == nil && !snapshot.title(now: now).contains("не найдено"), "Unknown is not current")
        try check(snapshot.lastSuccessAt == base["lastSuccessAt"] as? String, "Previous success timestamp preserved")
        pass("unknown remains visible: \(reason)")
    }
    for key in base.keys.sorted() {
        var invalid = base; invalid.removeValue(forKey: key)
        try rejectUpdate(invalid, "missing " + key); pass("required field \(key)")
    }
    for (key, value): (String, Any) in [
        ("schema", "murmur.updates/2"), ("channel", "beta"), ("versionSource", "setup-package"),
        ("comparison", "git-revision"), ("state", "ready"), ("enabled", 1), ("cached", 1), ("stale", 0),
        ("currentVersion", 29), ("latestVersion", ""), ("reason", "raw server error with token"),
        ("checkedAt", "yesterday"), ("lastSuccessAt", true), ("nextCheckAt", "tomorrow"),
        ("checkIntervalMs", 1000), ("timeoutMs", true), ("action", "install"),
        ("enabled", false), ("stale", true), ("currentVersion", NSNull()), ("checkedAt", NSNull()),
    ] {
        var invalid = base; invalid[key] = value
        try rejectUpdate(invalid, "invalid " + key); pass("typed/semantic boundary \(key)")
    }
    for page in [
        "http://github.com/alexfrmn/murmur/releases/tag/v2.10.0",
        "https://github.com.evil.test/alexfrmn/murmur/releases/tag/v2.10.0",
        "https://github.com@evil.test/alexfrmn/murmur/releases/tag/v2.10.0",
        "https://user@github.com/alexfrmn/murmur/releases/tag/v2.10.0",
        "https://github.com:443/alexfrmn/murmur/releases/tag/v2.10.0",
        "https://github.com/other/murmur/releases/tag/v2.10.0",
        "https://github.com/alexfrmn/murmur/releases/download/v2.10.0/app.zip",
        "https://github.com/alexfrmn/murmur/releases/tag/v2.10.0?redirect=evil",
        "https://github.com/alexfrmn/murmur/releases/tag/v2.10.0#fragment",
        "https://github.com/alexfrmn/murmur/releases/tag/../latest",
        "https://github.com/alexfrmn/murmur/releases/tag/%2e%2e",
        "https://github.com/alexfrmn/murmur/releases/tag/v2.10.0%2f..%2f..",
        "https://github.com/alexfrmn/murmur/releases/tag/",
        "file:///tmp/installer", "javascript:alert(1)",
    ] {
        var invalid = base; invalid["releaseUrl"] = page
        try rejectUpdate(invalid, "untrusted release page"); pass("release URL allowlist")
    }
    var buildMetadata = base
    buildMetadata["releaseUrl"] = "https://github.com/alexfrmn/murmur/releases/tag/v2.10.0%2Bbuild.1"
    try check(try UpdateSnapshot.decode(updateData(buildMetadata)).releasePage(now: now) != nil, "Canonical encoded build metadata")
    pass("canonical encoded build metadata URL")
    try check(available.releasePage(now: now.addingTimeInterval(21_601)) == nil, "Expired metadata loses actionable badge")
    try check(available.title(now: now.addingTimeInterval(21_601)).contains("устарел"), "Expiry remains visible")
    pass("expiry prevents stale available/current presentation")
    try check(available.releasePage(now: now.addingTimeInterval(-60)) == nil, "Future observation cannot drive a badge")
    pass("future observation is not actionable")
    var cached = base; cached["cached"] = true
    let cachedSnapshot = try UpdateSnapshot.decode(updateData(cached))
    try check(cachedSnapshot.ageText(now: now.addingTimeInterval(120)).contains("2 мин.") && cachedSnapshot.checkedAt == available.checkedAt, "Cache retains original timestamp")
    pass("cache age and original timestamp")
    var extensionValue = base; extensionValue["futureExtension"] = ["x": true]
    _ = try UpdateSnapshot.decode(updateData(extensionValue)); pass("unknown additive fields")

    for flag: String? in [nil, "0", "1", "unexpected"] {
        let expected = flag == "0" ? "[ \"$MURMUR_UPDATE_CHECK\" = 0 ]" : "[ -z \"${MURMUR_UPDATE_CHECK+x}\" ]"
        let script = """
        [ "$#" = 3 ] && [ "$1" = updates ] && [ "$2" = check ] && [ "$3" = --json ] || exit 71
        [ -z "${GH_TOKEN+x}${GITHUB_TOKEN+x}${DATA_DIR+x}${MURMUR_STORE_PATH+x}${NODE_OPTIONS+x}" ] || exit 72
        \(expected) || exit 73
        """
        try withCLI(script + "\n" + updateReply(base)) { url in
            var env = ["GH_TOKEN": "fixture-not-a-credential", "GITHUB_TOKEN": "fixture-not-a-credential", "DATA_DIR": "/wrong", "NODE_OPTIONS": "bad"]
            env["MURMUR_UPDATE_CHECK"] = flag
            let client = UpdatesClient(executable: url, environment: env)
            try check(client.forcedOff == (flag == "0"), "Only exact opt-out is recognized")
            _ = try client.check()
        }
        pass("profile-free CLI argv; only exact opt-out forwarded")
    }
    for enabled in [false, true] {
        let command = enabled ? "enable" : "disable"
        let reply: [String: Any] = ["schema": "murmur.update-preferences/1", "enabled": enabled]
        try withCLI("[ \"$#\" = 3 ] && [ \"$1\" = updates ] && [ \"$2\" = \(command) ] && [ \"$3\" = --json ] || exit 74\n" + updateReply(reply)) { url in
            try UpdatesClient(executable: url).setEnabled(enabled)
        }
        pass("persistent \(command) uses only CLI")
    }
    try withCLI("printf '{\"schema\":\"murmur.update-preferences/1\",\"enabled\":true}'") { url in
        var rejected = false
        do { try UpdatesClient(executable: url).setEnabled(false) } catch is UpdateError { rejected = true }
        try check(rejected, "Wrong preference receipt is not success")
    }
    pass("preference receipt must match request")
    try withCLI("printf 'updates.preferences-unavailable' >&2; exit 1") { url in
        try expect("Update failure", probe: { _ = try UpdatesClient(executable: url).check() }) {
            if case .failedWithReason(1, "updates.preferences-unavailable") = $0 { true } else { false }
        }
    }
    pass("CLI error remains an error")
    try withCLI("exec /bin/sleep 30") { url in
        try expect("Update timeout", probe: { _ = try UpdatesClient(executable: url, timeout: 0.2).check() }) {
            if case .timedOut = $0 { true } else { false }
        }
    }
    pass("update subprocess is bounded")
    try withCLI("exec /usr/bin/yes x") { url in
        try expect("Update output limit", probe: { _ = try UpdatesClient(executable: url).check() }) {
            if case .outputLimit = $0 { true } else { false }
        }
    }
    pass("update output is bounded")
    return count
}
