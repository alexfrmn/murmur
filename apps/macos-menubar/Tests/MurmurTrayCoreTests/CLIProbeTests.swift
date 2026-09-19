import Foundation
import MurmurTrayCore

struct CheckFailure: Error { let message: String }

func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    guard condition() else { throw CheckFailure(message: message) }
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
                $0.localizedDescription == "CLI завершился с кодом 7"
            }
        }
        print("PASS unstructured failure is not success; stderr is not disclosed")

        try withCLI("printf 'Permission denied while reading the selected profile\\nextra trace' >&2; exit 2") { url in
            try expect("Human error reason", probe: { _ = try CLIProbe(executable: url).run("status") }) {
                $0.localizedDescription == "CLI завершился с кодом 2: Permission denied while reading the selected profile"
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
        let formatter = ISO8601DateFormatter()
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasPrefix("status-") && $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        try check(!files.isEmpty, "Canonical status fixtures are required; no fallback copies")
        var base: [String: Any]?
        for file in files {
            var object = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
            guard let expected = object["$expect"] as? [String: Any], let policy = object["$stamp"] as? String else {
                throw CheckFailure(message: "Missing canonical expectations: \(file.lastPathComponent)")
            }
            switch policy {
            case "now": object["generatedAt"] = formatter.string(from: clock)
            case "now-5m": object["generatedAt"] = formatter.string(from: clock.addingTimeInterval(-300))
            case "now+1h": object["generatedAt"] = formatter.string(from: clock.addingTimeInterval(3600))
            case "as-is": break
            default: throw CheckFailure(message: "Unknown fixture clock policy: \(policy)")
            }
            let value = try StatusSnapshot.decode(JSONSerialization.data(withJSONObject: object))
            let actual = value.verdict(now: clock)
            try check(actual.color == expected["level"] as? String, "\(file.lastPathComponent): color \(actual.color)")
            try check(actual.unread == expected["unread"] as? Bool, "\(file.lastPathComponent): unread")
            try check(actual.code == expected["code"] as? String, "\(file.lastPathComponent): code \(actual.code)")
            let missing = expected["missing"] as? [String] ?? []
            try check(Set(actual.missing) == Set(missing), "\(file.lastPathComponent): missing \(actual.missing) != \(missing)")
            if actual.code == "wake.mode-mismatch" {
                try check(value.diagnosticNotes.first == value.modeMismatch, "Mode mismatch must be first diagnostic independently of color")
            }
            if actual.code == "service.stopped" {
                try check(value.diagnosticNotes.contains(where: { $0.contains("ошибка отправки") }), "Stopped service must retain historical send failure")
            }
            if file.lastPathComponent == "status-green.json" { base = object }
            print("PASS canonical \(file.lastPathComponent): \(actual.color), \(actual.code), missing set")
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
        let doctorData = try Data(contentsOf: directory.appendingPathComponent("doctor-broker-fail.json"))
        let rows = try DoctorSnapshot.decode(doctorData).rows()
        try check(rows[2].state == "fail" && rows[3].state == "skip" && rows[4].state == "skip", "Doctor failed chain")
        try check(rows[5].state == "unknown", "Frozen doctor fixture has inconsistent wake.warn; must not present as valid")
        print("PASS doctor inconsistent fixture is marked unknown"); extraChecks += 1
        print("\(7 + files.count + extraChecks) checks passed; canonical \(files.count), transport 7, boundary \(extraChecks)")
    }
}
