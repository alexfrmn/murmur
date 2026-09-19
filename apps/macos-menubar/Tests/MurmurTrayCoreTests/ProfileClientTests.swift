import Foundation
import Darwin
import MurmurTrayCore

private func shellLiteral(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

private struct ProfileFixture {
    let directory: URL, executable: URL, binding: ProfileBinding
    let status: [String: Any], doctor: [String: Any]
    let agent = "agent-misha"

    init(directory: URL, fixtures: URL) throws {
        self.directory = directory
        executable = directory.appendingPathComponent("fake cli")
        let data = directory.appendingPathComponent("profile ' ; $(literal)")
        try FileManager.default.createDirectory(at: data, withIntermediateDirectories: false)
        binding = try ProfileBinding(dataDirectory: data.path, serviceName: "org.murmur.test")
        let original = try JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent("status-green.json"))) as! [String: Any]
        status = try materialized(original, now: Date())
        doctor = try JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent("doctor-broker-fail.json"))) as! [String: Any]
        try write("status", object: status)
        try write("doctor", object: doctor)
        for action in ControlAction.allCases { try write(key(action), object: receipt(action)) }
        let script = """
        #!/bin/sh
        key="$1"; shift
        case "$key" in
          status|doctor) ;;
          wake|service|logs) key="$key-$1"; shift ;;
          *) exit 71 ;;
        esac
        [ "$#" = 5 ] && [ "$1" = --json ] && [ "$2" = --data-dir ] &&
          [ "$3" = \(shellLiteral(binding.dataDirectory)) ] && [ "$4" = --service-name ] &&
          [ "$5" = \(shellLiteral(binding.serviceName!)) ] || exit 72
        [ "$PWD" = / ] || exit 73
        [ -z "${DATA_DIR+x}${MURMUR_DATA_DIR+x}${MURMUR_STORE_PATH+x}${NODE_OPTIONS+x}" ] || exit 74
        printf '%s\\n' "$key" >> \(shellLiteral(directory.appendingPathComponent("calls").path))
        exec /bin/sh \(shellLiteral(directory.path))/"$key.sh"
        """
        try script.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
    }

    func client(statusTimeout: TimeInterval = 1, actionTimeout: TimeInterval = 1) -> ProfileClient {
        ProfileClient(executable: executable, profile: binding,
                      environment: ["HOME": directory.path, "DATA_DIR": "/wrong", "MURMUR_DATA_DIR": "/wrong",
                                    "MURMUR_STORE_PATH": "/wrong/db", "NODE_OPTIONS": "--bad-option"],
                      statusTimeout: statusTimeout, actionTimeout: actionTimeout, doctorTimeout: 1)
    }
    func key(_ action: ControlAction) -> String {
        (action == .pause || action == .resume ? "wake-" : "service-") + action.rawValue
    }
    func receipt(_ action: ControlAction) -> [String: Any] {
        if action == .pause || action == .resume {
            return ["schema": "murmur.wake/1", "configuredEnabled": action == .resume,
                    "effectiveEnabled": true, "restartRequired": action == .pause, "applyError": NSNull()]
        }
        var service = status["service"] as! [String: Any]
        service["state"] = action == .start ? "running" : "stopped"
        return ["schema": "murmur.service/1", "action": action.rawValue, "service": service]
    }
    func write(_ key: String, object: [String: Any]) throws {
        let file = directory.appendingPathComponent(key + ".json")
        try JSONSerialization.data(withJSONObject: object).write(to: file)
        try body(key, "exec /bin/cat " + shellLiteral(file.path))
    }
    func body(_ key: String, _ content: String) throws {
        try content.write(to: directory.appendingPathComponent(key + ".sh"), atomically: true, encoding: .utf8)
    }
    func calls() throws -> [String] {
        let file = directory.appendingPathComponent("calls")
        guard FileManager.default.fileExists(atPath: file.path) else { return [] }
        return try String(contentsOf: file, encoding: .utf8).split(separator: "\n").map(String.init)
    }
}

private func changing(_ object: [String: Any], _ path: [String], _ value: Any?) -> [String: Any] {
    var next = object
    if path.count == 1 { next[path[0]] = value }
    else { next[path[0]] = changing(object[path[0]] as! [String: Any], Array(path.dropFirst()), value) }
    return next
}

private func rejects(_ label: String, _ body: () throws -> Void) throws {
    do { try body() }
    catch is CheckFailure { throw CheckFailure(message: label + ": test assertion failed") }
    catch { return }
    throw CheckFailure(message: label + ": expected rejection")
}

func runControlChecks(fixtures: URL) throws -> Int {
    var count = 0
    func scenario(_ name: String, _ test: (ProfileFixture) throws -> Void) throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("murmur-controls-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        guard let resolved = realpath(directory.path, nil) else { throw CheckFailure(message: "Test directory realpath unavailable") }
        defer { free(resolved) }
        try test(ProfileFixture(directory: URL(fileURLWithPath: String(cString: resolved)), fixtures: fixtures))
        count += 1; print("PASS profile control: \(name)")
    }
    for path in ["relative", "/", "/tmp/../other", "/tmp/line\nbreak", "/tmp//profile", "/tmp/./profile", "/tmp/profile/"] {
        try rejects("invalid profile path") { _ = try ProfileBinding(dataDirectory: path) }
        count += 1
    }
    for service in ["", "bad/name", "valid\n", String(repeating: "a", count: 102)] {
        try rejects("invalid service name") { _ = try ProfileBinding(dataDirectory: "/tmp/profile", serviceName: service) }
        count += 1
    }
    print("PASS profile control: 11 invalid explicit selections rejected")

    try scenario("shared status/doctor argv, literal path, isolated environment and cwd") { f in
        let client = f.client()
        let status = try client.readStatus()
        let id = try client.verifiedAgent(in: status)
        try check(id == f.agent, "Identity from selected CLI status")
        _ = try client.readDoctor()
        try check(try f.calls() == ["status", "doctor"], "Only selected reads")
    }
    for (name, identity): (String, Any?) in [
        ("changed", "agent-other"), ("missing", nil), ("null", NSNull()), ("invalid", "agent-misha\n"),
    ] {
        try scenario("\(name) identity never becomes displayed status") { f in
            let first = f.client().readProfileStatus(expectedAgent: nil)
            try check(first.agentID == f.agent && first.status != nil && first.error == nil, "Initial verified binding")
            // The foreign snapshot otherwise has the canonical green verdict.
            try f.write("status", object: changing(f.status, ["agentId"], identity))
            let rejected = f.client().readProfileStatus(expectedAgent: first.agentID)
            try check(rejected.status == nil, "Rejected status/counters must not be published")
            try check(rejected.agentID == first.agentID, "Pinned identity survives rejection")
            try check(rejected.error?.color == "grey" && rejected.error?.reason.isEmpty == false,
                      "Grey unavailable observation with actionable reason")
        }
    }
    try scenario("unbound invalid identity remains unavailable") { f in
        try f.write("status", object: changing(f.status, ["agentId"], NSNull()))
        let read = f.client().readProfileStatus(expectedAgent: nil)
        try check(read.status == nil && read.agentID == nil && read.error?.color == "grey", "No initial binding from invalid identity")
    }
    try scenario("same identity refresh and explicit reselect") { f in
        let initial = f.client().readProfileStatus(expectedAgent: nil)
        let same = f.client().readProfileStatus(expectedAgent: initial.agentID)
        try check(same.status != nil && same.agentID == f.agent && same.error == nil, "Same identity refresh accepted")
        try f.write("status", object: changing(f.status, ["agentId"], "agent-other"))
        let reselected = f.client().readProfileStatus(expectedAgent: nil)
        try check(reselected.agentID == "agent-other" && reselected.status != nil && reselected.error == nil,
                  "Explicit reselect can establish the new binding")
    }
    for action in ControlAction.allCases {
        try scenario("\(action.rawValue) uses fresh status, exact argv and no --apply") { f in
            let receipt = try f.client().perform(action, expectedAgent: f.agent)
            try check(try f.calls() == ["status", f.key(action)], "One preflight and one mutation")
            if action == .pause { try check(receipt.restartRequired == true, "Configured pause retains effective mismatch") }
        }
    }
    for (name, path, value): (String, [String], Any?) in [
        ("missing identity", ["agentId"], nil),
        ("null identity", ["agentId"], NSNull()),
        ("changed identity", ["agentId"], "agent-other"),
        ("invalid identity", ["agentId"], "agent-misha\n"),
        ("stale status", ["generatedAt"], "2000-01-01T00:00:00Z"),
        ("future status", ["generatedAt"], "2100-01-01T00:00:00Z"),
        ("unknown schema", ["schema"], "murmur.status/2"),
        ("unknown configured state", ["wake", "config", "enabled"], NSNull()),
    ] {
        try scenario("\(name) blocks mutation") { f in
            try f.write("status", object: changing(f.status, path, value))
            try rejects(name) { _ = try f.client().perform(.pause, expectedAgent: f.agent) }
            try check(try f.calls() == ["status"], "No action after failed preflight")
        }
    }
    for (name, body, timeout) in [
        ("nonzero action", "printf 'service.profile-mismatch' >&2; exit 3", 1.0),
        ("action timeout", "exec /bin/sleep 30", 0.5),
        ("action output limit", "exec /usr/bin/yes x", 1.0),
        ("malformed action JSON", "printf 'not json'", 1.0),
    ] {
        try scenario("\(name) fails without retry") { f in
            try f.body("wake-pause", body)
            let started = Date()
            try rejects(name) { _ = try f.client(actionTimeout: timeout).perform(.pause, expectedAgent: f.agent) }
            try check(Date().timeIntervalSince(started) < 3, "Bounded failure")
            try check(try f.calls() == ["status", "wake-pause"], "Never repeat timed-out mutation")
        }
    }
    for (name, field, value): (String, String, Any?) in [
        ("wrong receipt schema", "schema", "murmur.wake/2"),
        ("opposite configured state", "configuredEnabled", true),
        ("missing restart flag", "restartRequired", nil),
        ("reported apply failure", "applyError", "unexpected apply"),
    ] {
        try scenario("\(name) is not success") { f in
            var response = f.receipt(.pause); response[field] = value
            try f.write("wake-pause", object: response)
            try rejects(name) { _ = try f.client().perform(.pause, expectedAgent: f.agent) }
        }
    }
    try scenario("wrong service action is not success") { f in
        try f.write("service-start", object: f.receipt(.stop))
        try rejects("wrong service action") { _ = try f.client().perform(.start, expectedAgent: f.agent) }
    }
    try scenario("preflight timeout blocks action") { f in
        try f.body("status", "exec /bin/sleep 30")
        try expect("preflight timeout", probe: { _ = try f.client(statusTimeout: 0.5).perform(.stop, expectedAgent: f.agent) }) {
            if case .timedOut = $0 { true } else { false }
        }
        let calls = try f.calls()
        try check(calls.count <= 1 && calls.allSatisfy { $0 == "status" }, "No mutation on timed-out preflight")
    }
    for timeout in [0.0, -1, .infinity, .nan, 61] {
        try scenario("invalid timeout rejected before execution") { f in
            try rejects("timeout") { _ = try f.client(statusTimeout: timeout).readStatus() }
            try check(try f.calls().isEmpty, "No execution with invalid timeout")
        }
    }
    try scenario("public read transport rejects arbitrary commands") { f in
        try rejects("arbitrary command") { _ = try CLIProbe(executable: f.executable).run("service stop") }
        try check(try f.calls().isEmpty, "No arbitrary command execution")
    }

    for name in ["valid", "wrong agent", "wrong profile", "outside directory", "wrong schema", "wrong source", "wrong service", "missing directory", "symlink escape"] {
        try scenario("logs path: \(name)") { f in
            let logs = URL(fileURLWithPath: f.binding.dataDirectory).appendingPathComponent("logs")
            try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: false)
            var response = ["schema": "murmur.logs/1", "agentId": f.agent, "dataDir": f.binding.dataDirectory,
                            "serviceName": f.binding.serviceName!, "logDir": logs.path, "source": "configured"]
            switch name {
            case "wrong agent": response["agentId"] = "other"
            case "wrong profile": response["dataDir"] = f.directory.path
            case "outside directory": response["logDir"] = f.directory.path
            case "wrong schema": response["schema"] = "murmur.logs/2"
            case "wrong source": response["source"] = "observed"
            case "wrong service": response["serviceName"] = "other.service"
            case "missing directory": response["logDir"] = logs.appendingPathComponent("missing").path
            case "symlink escape":
                let link = URL(fileURLWithPath: f.binding.dataDirectory).appendingPathComponent("link")
                try FileManager.default.createSymbolicLink(at: link, withDestinationURL: f.directory)
                response["logDir"] = link.path
            default: break
            }
            try f.write("logs-path", object: response)
            if name == "valid" {
                let actual = try f.client().logDirectory(expectedAgent: f.agent)
                try check(actual.path == logs.path, "Only CLI-returned validated directory")
            } else { try rejects(name) { _ = try f.client().logDirectory(expectedAgent: f.agent) } }
            try check(try f.calls() == ["status", "logs-path"], "Fresh identity and lookup, never fallback")
        }
    }
    return count
}
