import Foundation
import MurmurTrayCore

private func pairingQuote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }

private struct PairingFixture {
    let root: URL, executable: URL, profile: ProfileBinding
    let status: [String: Any]
    init(root: URL, fixtures: URL) throws {
        self.root = root
        executable = root.appendingPathComponent("fake-cli")
        profile = try ProfileBinding(dataDirectory: root.appendingPathComponent("profile").path)
        status = try materialized(JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent("status-green.json"))) as! [String: Any], now: Date())
        try write("status", status)
        try write("after", status)
        try write("invite", ["schema": "murmur.invite/1", "invitation": "MURMUR:test-only", "containsBrokerCredential": true])
        try write("add-peer", ["schema": "murmur.peer/1", "peerId": "agent-jarvis"])
        let script = """
        #!/bin/sh
        key="$1"; shift
        [ -z "${MURMUR_STORE_PATH+x}${DATA_DIR+x}${NODE_OPTIONS+x}" ] || exit 71
        printf '%s\\n' "$key" >> \(pairingQuote(root.path))/calls
        printf '%s\\0' "$@" > \(pairingQuote(root.path))/"$key.argv"
        if [ -f \(pairingQuote(root.path))/"$key.error" ]; then
          /bin/cat \(pairingQuote(root.path))/"$key.error" >&2; exit 1
        fi
        if [ "$key" = add-peer ]; then
          /bin/cat > \(pairingQuote(root.path))/stdin
          /usr/bin/touch \(pairingQuote(root.path))/imported
        fi
        if [ "$key" = status ] && [ -f \(pairingQuote(root.path))/imported ]; then key=after; fi
        exec /bin/cat \(pairingQuote(root.path))/"$key.json"
        """
        try script.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
    }
    var client: ProfilePairingClient {
        ProfilePairingClient(executable: executable, profile: profile, environment: ["HOME": root.path,
            "MURMUR_STORE_PATH": "/wrong", "DATA_DIR": "/wrong", "NODE_OPTIONS": "--bad-option"])
    }
    func write(_ name: String, _ value: [String: Any]) throws {
        try JSONSerialization.data(withJSONObject: value).write(to: root.appendingPathComponent(name + ".json"))
    }
    func text(_ name: String) throws -> String { try String(contentsOf: root.appendingPathComponent(name), encoding: .utf8) }
}

func runPairingChecks(fixtures: URL) throws -> Int {
    var count = 0
    func reject(_ body: () throws -> Void) throws {
        do { try body() } catch is CheckFailure { throw CheckFailure(message: "Assertion failed") } catch { return }
        throw CheckFailure(message: "Expected refusal")
    }
    func scenario(_ name: String, _ body: (PairingFixture) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("murmur-pairing-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        try body(PairingFixture(root: root, fixtures: fixtures))
        count += 1; print("PASS pairing: \(name)")
    }
    try scenario("Server key requires acknowledgement before exposing the line") { f in
        let receipt = try f.client.invite(expectedAgent: "agent-misha")
        try check(receipt.containsBrokerCredential, "Credential flag preserved")
        try reject { _ = try receipt.lineForCopy(confirmedPersonalSharing: false) }
        try check(try receipt.lineForCopy(confirmedPersonalSharing: true) == "MURMUR:test-only", "Explicit consent unlocks clipboard")
        try check(try f.text("calls") == "status\ninvite\nstatus\n", "Identity checked around invitation")
    }
    try scenario("Invitation without a Server key can be copied immediately") { f in
        try f.write("invite", ["schema": "murmur.invite/1", "invitation": "MURMUR:test-only", "containsBrokerCredential": false])
        let receipt = try f.client.invite(expectedAgent: "agent-misha")
        try check(try receipt.lineForCopy(confirmedPersonalSharing: false) == "MURMUR:test-only", "No needless confirmation")
    }
    try scenario("older invitation receipt without credential flag fails closed") { f in
        try f.write("invite", ["schema": "murmur.invite/1", "invitation": "MURMUR:test-only"])
        try reject { _ = try f.client.invite(expectedAgent: "agent-misha") }
    }
    try scenario("private Server code asks for public address; no automatic retry") { f in
        let error = f.root.appendingPathComponent("invite.error")
        try "onboarding.invite-public-server-required\n".write(to: error, atomically: true, encoding: .utf8)
        do { _ = try f.client.invite(expectedAgent: "agent-misha"); throw CheckFailure(message: "Expected address step") }
        catch let error as PairingError { try check(error == .publicServerRequired, "Stable code selects address form") }
        try check(try f.text("calls") == "status\ninvite\n", "One attempt only")
        try FileManager.default.removeItem(at: error)
        _ = try f.client.invite(expectedAgent: "agent-misha", publicServer: " server.example.org:4222 ")
        try check(try f.text("invite.argv").components(separatedBy: "\0").prefix(3) == ["--broker", "nats://server.example.org:4222", "--json"], "Public override is literal argv")
    }
    try scenario("Server credentials in a pasted address never reach argv") { f in
        try reject { _ = try f.client.invite(expectedAgent: "agent-misha", publicServer: "nats://test-secret@example.org:4222") }
        try check(try f.text("calls") == "status\n", "No invitation with credential URL")
    }
    try scenario("Reply goes only to stdin and Contact is verified after import") { f in
        let contact = try f.client.addReply("\nMURMUR:reply-only\n", expectedAgent: "agent-misha")
        try check(contact == "agent-jarvis", "Confirmed Contact")
        try check(try f.text("stdin") == "MURMUR:reply-only" && !f.text("add-peer.argv").contains("MURMUR:"), "No line in argv")
        try check(try f.text("calls") == "status\nadd-peer\nstatus\n", "Status sandwich")
    }
    for kind in ["missing-contact", "changed-identity", "self-reply", "wrong-schema"] {
        try scenario("import is not declared successful: \(kind)") { f in
            var after = f.status
            if kind == "missing-contact" { after["peers"] = ["list": [], "unknownReason": NSNull()] }
            if kind == "changed-identity" { after["agentId"] = "someone-else" }
            if kind == "self-reply" { try f.write("add-peer", ["schema": "murmur.peer/1", "peerId": "agent-misha"]) }
            if kind == "wrong-schema" { try f.write("add-peer", ["schema": "unknown/1", "peerId": "agent-jarvis"]) }
            try f.write("after", after)
            try reject { _ = try f.client.addReply("MURMUR:test", expectedAgent: "agent-misha") }
            try check(try f.text("calls").components(separatedBy: "add-peer").count == 2, "No mutation retry")
        }
    }
    try scenario("different selected Identity prevents any import") { f in
        try reject { _ = try f.client.addReply("MURMUR:test", expectedAgent: "someone-else") }
        try check(try f.text("calls") == "status\n", "Precondition before mutation")
    }
    try scenario("raw stderr cannot appear in the window") { f in
        try "MURMUR:credential-do-not-display\n".write(to: f.root.appendingPathComponent("invite.error"), atomically: true, encoding: .utf8)
        do { _ = try f.client.invite(expectedAgent: "agent-misha"); throw CheckFailure(message: "Expected failure") }
        catch let error as PairingError {
            try check(error == .failed && !error.localizedDescription.contains("credential-do-not-display"), "Only human action, no raw input")
        }
    }
    return count
}
