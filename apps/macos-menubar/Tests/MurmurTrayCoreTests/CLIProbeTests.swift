import Foundation
import MurmurTrayCore

struct CheckFailure: Error { let message: String }

func check(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    guard try condition() else { throw CheckFailure(message: message) }
}

func withCLI(_ body: String, test: (URL) throws -> Void) throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("murmur test \(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    let executable = directory.appendingPathComponent("fake cli")
    try ("#!/bin/sh\n" + body + "\n").write(to: executable, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
    try test(executable)
}

func expect(_ description: String, probe: () throws -> Void, matching: (ProbeError) -> Bool) throws {
    do {
        try probe()
        throw CheckFailure(message: "\(description): expected an error")
    } catch let error as ProbeError {
        try check(matching(error), "\(description): unexpected error \(error)")
    }
}

func materialized(_ object: [String: Any], now: Date) throws -> [String: Any] {
    var value = object
    let formatter = ISO8601DateFormatter()
    switch value["$stamp"] as? String {
    case "now": value["generatedAt"] = formatter.string(from: now)
    case "now-5m": value["generatedAt"] = formatter.string(from: now.addingTimeInterval(-300))
    case "now+1h": value["generatedAt"] = formatter.string(from: now.addingTimeInterval(3600))
    case "as-is": break
    default: throw CheckFailure(message: "Unknown or missing fixture clock policy")
    }
    return value
}

func readStatus(_ object: [String: Any], now: Date) throws -> (StatusSnapshot?, Verdict) {
    let data = try JSONSerialization.data(withJSONObject: object)
    do {
        let snapshot = try StatusSnapshot.decode(data)
        return (snapshot, snapshot.verdict(now: now))
    } catch {
        return (nil, .unavailable(error))
    }
}

@discardableResult
func compareStatus(_ object: [String: Any], name: String, now: Date) throws -> (StatusSnapshot?, Verdict) {
    guard let expected = object["$expect"] as? [String: Any],
          let color = expected["level"] as? String, let unread = expected["unread"] as? Bool,
          let code = expected["code"] as? String else {
        throw CheckFailure(message: "Missing canonical expectations: \(name)")
    }
    let (snapshot, actual) = try readStatus(materialized(object, now: now), now: now)
    try check(actual.color == color, "\(name): color \(actual.color) != \(color)")
    try check(actual.unread == unread, "\(name): unread")
    try check(actual.code == code, "\(name): code \(actual.code) != \(code)")
    let missing = expected["missing"] as? [String] ?? []
    let reasons = expected["missingWhy"] as? [String: String] ?? [:]
    try check(Set(actual.missing) == Set(missing), "\(name): missing \(actual.missing) != \(missing)")
    try check(actual.missingWhy == reasons, "\(name): missingWhy \(actual.missingWhy) != \(reasons)")
    return (snapshot, actual)
}

@discardableResult
func compareDoctor(_ object: [String: Any], name: String, now: Date) throws -> DoctorSnapshot? {
    guard let expected = object["$expect"] as? [String: Any], let valid = expected["valid"] as? Bool else {
        throw CheckFailure(message: "Missing canonical doctor expectation: \(name)")
    }
    let data = try JSONSerialization.data(withJSONObject: materialized(object, now: now))
    let snapshot: DoctorSnapshot?
    do { snapshot = try DoctorSnapshot.decode(data) }
    catch is ContractError { snapshot = nil }
    try check((snapshot != nil) == valid, "\(name): doctor validity must be \(valid)")
    return snapshot
}

func expectGateFailure(_ name: String, _ body: () throws -> Void) throws {
    var failed = false
    do { try body() } catch is CheckFailure { failed = true }
    try check(failed, "Conformance gate must reject \(name)")
    print("PASS negative control: \(name)")
}

@main
struct ProbeChecks {
    static func main() throws {
        try withCLI("[ \"$#\" = 2 ] && [ \"$1\" = status ] && [ \"$2\" = --json ] || exit 71\nprintf '{\"unexpected\":true}'") { url in
            let result = try CLIProbe(executable: url).run("status")
            try check(result.command == "status" && result.exitCode == 0 && result.byteCount > 0,
                      "Exact arguments / executable with spaces")
        }
        print("PASS exact argv and executable with spaces")

        try withCLI("printf '{\"ok\":false}'; exit 1") { url in
            try expect("Nonzero exit", probe: { _ = try CLIProbe(executable: url).run("doctor") }) {
                if case .failed(1) = $0 { true } else { false }
            }
        }
        print("PASS nonzero exit rejects JSON per shared contract")

        try withCLI("printf 'agent is probably ready'") { url in
            try expect("Invalid JSON", probe: { _ = try CLIProbe(executable: url).run("status") }) {
                if case .invalidJSON = $0 { true } else { false }
            }
        }
        print("PASS invalid JSON is rejected")

        try withCLI("printf 'SECRET_TOKEN=must-not-be-displayed' >&2; exit 7") { url in
            try expect("Failure output", probe: { _ = try CLIProbe(executable: url).run("status") }) {
                $0.localizedDescription == "CLI exited with code 7"
            }
        }
        print("PASS unstructured failure is not success; stderr is not disclosed")

        try withCLI("printf 'Permission denied while reading the selected profile\\nextra trace' >&2; exit 2") { url in
            try expect("Human error reason", probe: { _ = try CLIProbe(executable: url).run("status") }) {
                $0.localizedDescription == "CLI exited with code 2: Permission denied while reading the selected profile"
            }
        }
        print("PASS bounded actionable stderr reason is retained")

        try withCLI("exec /bin/sleep 30") { url in
            let start = Date()
            try expect("Timeout", probe: { _ = try CLIProbe(executable: url, timeout: 0.1).run("status") }) {
                if case .timedOut = $0 { true } else { false }
            }
            try check(Date().timeIntervalSince(start) < 2, "Timeout must terminate CLI promptly")
        }
        print("PASS timeout terminates the CLI")

        try withCLI("exec /usr/bin/yes x") { url in
            try expect("Output limit", probe: { _ = try CLIProbe(executable: url).run("status") }) {
                if case .outputLimit = $0 { true } else { false }
            }
        }
        print("PASS oversized output is rejected")
        let directory = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "../../contracts/setup/v1/fixtures")
        let clock = timestamp("2026-09-19T13:00:00Z")!
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasPrefix("status-") && $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        try check(!files.isEmpty, "Canonical status fixtures are required; no fallback copies")
        var base: [String: Any]?
        for file in files {
            let object = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
            let (value, actual) = try compareStatus(object, name: file.lastPathComponent, now: clock)
            if actual.code == "wake.mode-mismatch", let value {
                try check(value.diagnosticNotes.first == value.modeMismatch, "Mode mismatch must be first diagnostic independently of color")
            }
            if actual.code == "service.stopped", let value {
                try check(value.diagnosticNotes.contains(where: { $0.contains("send error") }), "Stopped service must retain historical send failure")
            }
            if file.lastPathComponent == "status-green.json" { base = try materialized(object, now: clock) }
            print("PASS canonical \(file.lastPathComponent): \(actual.color), \(actual.code), missing set + reasons")
        }
        guard let base else { throw CheckFailure(message: "Canonical green fixture missing") }
        func edited(_ path: [String], value: Any?, object: [String: Any]) -> [String: Any] {
            var result = object
            if path.count == 1 { result[path[0]] = value }
            else {
                result[path[0]] = edited(Array(path.dropFirst()), value: value, object: result[path[0]] as! [String: Any])
            }
            return result
        }
        var extraChecks = 0
        for (name, path, value): (String, [String], Any?) in [
            ("missing timestamp", ["generatedAt"], nil),
            ("missing wake", ["wake"], nil),
            ("unknown schema", ["schema"], "murmur.status/99"),
            ("empty schema version", ["schema"], "murmur.status/"),
            ("noncanonical schema major", ["schema"], "murmur.status/01"),
            ("signed schema major", ["schema"], "murmur.status/+1"),
            ("empty schema minor", ["schema"], "murmur.status/1."),
            ("nonnumeric schema minor", ["schema"], "murmur.status/1.beta"),
            ("extra schema version component", ["schema"], "murmur.status/1.2.3"),
            ("unknown service state", ["service", "state"], "surprise"),
            ("missing required nullable key", ["wake", "faults", "lastFault"], nil),
            ("negative count", ["outbox", "queue", "failed"], -1),
        ] {
            var rejected = false
            let data = try JSONSerialization.data(withJSONObject: edited(path, value: value, object: base))
            do { _ = try StatusSnapshot.decode(data) } catch { rejected = true }
            try check(rejected, "Fail closed: \(name)")
            print("PASS fail closed: \(name)"); extraChecks += 1
        }
        for path in [["outbox", "queue", "failed"], ["wake", "config", "enabled"], ["wake", "effective", "enabled"]] {
            let data = try JSONSerialization.data(withJSONObject: edited(path, value: NSNull(), object: base))
            let verdict = try StatusSnapshot.decode(data).verdict(now: clock)
            try check(verdict.color == "grey" && verdict.missing.contains(path.joined(separator: ".")), "Null must name \(path)")
            print("PASS unknown measurement: \(path.joined(separator: "."))"); extraChecks += 1
        }
        let minorData = try JSONSerialization.data(withJSONObject: edited(["schema"], value: "murmur.status/1.3", object: base))
        let minor = try StatusSnapshot.decode(minorData).verdict(now: clock)
        try check(minor.code == "ok", "Compatible schema minor must be accepted")
        print("PASS additive schema minor"); extraChecks += 1
        var partial = edited(["outbox", "queue", "dlq"], value: NSNull(), object: base)
        partial = edited(["outbox", "queue", "failed"], value: 3, object: partial)
        let failure = try StatusSnapshot.decode(JSONSerialization.data(withJSONObject: partial)).verdict(now: clock)
        try check(failure.code == "outbox.undelivered" && failure.missing == ["outbox.queue.dlq"], "Known failure beats partial read failure")
        print("PASS known failure retains missing measurement"); extraChecks += 1
        let doctorFiles = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasPrefix("doctor-") && $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        try check(!doctorFiles.isEmpty, "Canonical doctor fixtures are required")
        var validDoctor: [String: Any]?
        for file in doctorFiles {
            let object = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
            let snapshot = try compareDoctor(object, name: file.lastPathComponent, now: clock)
            if file.lastPathComponent == "doctor-broker-fail.json", let snapshot {
                let rows = snapshot.rows()
                try check(rows[2].state == "fail" && rows.dropFirst(3).allSatisfy { $0.state == "skip" }, "Doctor stopped chain")
                validDoctor = object
            }
            print("PASS canonical \(file.lastPathComponent): valid=\(snapshot != nil)")
        }
        guard let validDoctor else { throw CheckFailure(message: "Valid canonical stopped doctor chain is required") }
        for (name, path, value): (String, [String], Any) in [
            ("changed color", ["$expect", "level"], "red"),
            ("changed unread", ["$expect", "unread"], false),
            ("changed missing set", ["$expect", "missing"], ["invented.field"]),
            ("unknown clock policy", ["$stamp"], "tomorrow"),
        ] {
            try expectGateFailure(name) { try compareStatus(edited(path, value: value, object: base), name: name, now: clock) }
            extraChecks += 1
        }
        let faultLog = try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("status-faultlog-unread.json"))) as! [String: Any]
        try expectGateFailure("changed missing reason") {
            try compareStatus(edited(["$expect", "missingWhy", "outbox.faults"], value: "invented-reason", object: faultLog), name: "wrong reason", now: clock)
        }
        extraChecks += 1
        var wrongDoctor = validDoctor
        var stages = wrongDoctor["stages"] as! [[String: Any]]
        stages[stages.count - 1]["reason"] = "blocked-by:config"
        wrongDoctor["stages"] = stages
        try expectGateFailure("changed doctor blocker") { try compareDoctor(wrongDoctor, name: "wrong blocker", now: clock) }
        extraChecks += 1

        for (name, path, value, code): (String, [String], Any?, String) in [
            ("boolean is not a counter", ["inbox", "unread"], true, "schema.wrong-type"),
            ("number is not a boolean", ["wake", "config", "enabled"], 1, "schema.wrong-type"),
            ("wrong schema type", ["schema"], 1, "schema.wrong-type"),
            ("negative optional counter", ["inbox", "total"], -1, "schema.invalid-value"),
            ("fractional optional counter", ["outbox", "queue", "pending"], 0.5, "schema.unparsable"),
            ("nonnumeric optional counter", ["inbox", "total"], "many", "schema.unparsable"),
            ("counter outside shared safe range", ["inbox", "unread"], 9_007_199_254_740_992 as Int, "schema.unparsable"),
            ("null schema is present but unknown", ["schema"], NSNull(), "schema.unknown"),
        ] {
            let (_, verdict) = try readStatus(edited(path, value: value, object: base), now: clock)
            try check(verdict.code == code && verdict.color == "grey" && !verdict.unread,
                      "\(name): \(verdict.code), unread=\(verdict.unread)")
            print("PASS typed failure: \(name)"); extraChecks += 1
        }
        var both = edited(["inbox", "unread"], value: "invalid", object: base)
        both = edited(["wake", "faults", "lastFault"], value: nil, object: both)
        let missingBeforeType = try readStatus(both, now: clock).1
        try check(missingBeforeType.code == "schema.missing-key", "Missing required leaves precede wrong types")
        print("PASS missing required leaf precedes wrong type"); extraChecks += 1

        let nullDate = try readStatus(edited(["generatedAt"], value: NSNull(), object: base), now: clock).1
        try check(nullDate.code == "snapshot.unparsable" && nullDate.unread, "Null timestamp remains a measurement failure")
        print("PASS explicit null timestamp is present"); extraChecks += 1

        for (name, path, value, code): (String, [String], Any?, String) in [
            ("additive root extension", ["futureExtension"], ["arbitrary": true], "ok"),
            ("additive nested extension", ["outbox", "queue", "futureCount"], "opaque", "ok"),
            ("optional reason omitted", ["outbox", "queue", "unknownReason"], nil, "ok"),
            ("optional faults omitted", ["outbox", "faults"], nil, "ok"),
            ("effective state omitted is unmeasured", ["wake", "effective"], nil, "unmeasured"),
        ] {
            let verdict = try readStatus(edited(path, value: value, object: base), now: clock).1
            try check(verdict.code == code, "\(name): \(verdict.code)")
            print("PASS additive/optional input: \(name)"); extraChecks += 1
        }
        let canonicalCount = files.count + doctorFiles.count
        let controlCount = try runControlChecks(fixtures: directory)
        let updateCount = try runUpdateChecks()
        let runtimeCount = try runBundledRuntimeChecks()
        let localizationCount = try runLocalizationChecks()
        let presentationCount = try runStatusPresentationChecks(fixtures: directory, base: base, now: clock)
        let markCount = try runMarkChecks(fixtures: directory)
        let onboardingCount = try runOnboardingChecks(fixtures: directory)
        let guidanceCount = try runConnectionGuidanceChecks(fixtures: directory)
        let clientSetupCount = try runClientSetupChecks(fixtures: directory)
        let outboxCount = try runOutboxAttentionChecks(fixtures: directory)
        print("\(guidanceCount) connection guidance checks passed")
        print("\(7 + canonicalCount + extraChecks + controlCount + updateCount + runtimeCount + localizationCount + presentationCount + markCount + onboardingCount + guidanceCount + clientSetupCount + outboxCount) checks passed; canonical \(canonicalCount), transport 7, boundary \(extraChecks), profile controls \(controlCount), updates \(updateCount), bundled runtime \(runtimeCount), localization \(localizationCount), presentation \(presentationCount), mark \(markCount), onboarding \(onboardingCount), guidance \(guidanceCount), client setup \(clientSetupCount), outbox \(outboxCount)")
    }
}
