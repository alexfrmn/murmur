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
        try write("join", ["schema": "murmur.join/1", "agentId": "agent-misha", "peerId": "agent-jarvis",
                           "reply": "MURMUR:reply-only", "paired": NSNull(), "replyFile": NSNull()])
        let script = """
        #!/bin/sh
        key="$1"; shift
        [ -z "${MURMUR_STORE_PATH+x}${DATA_DIR+x}${NODE_OPTIONS+x}" ] || exit 71
        printf '%s\\n' "$key" >> \(pairingQuote(root.path))/calls
        printf '%s\\0' "$@" > \(pairingQuote(root.path))/"$key.argv"
        if [ -f \(pairingQuote(root.path))/"$key.error" ]; then
          /bin/cat \(pairingQuote(root.path))/"$key.error" >&2; exit 1
        fi
        if [ "$key" = add-peer ] || [ "$key" = join ]; then
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
    let token = "MURMUR:eyJ2IjoxLCJ0eXBlIjoiaW52aXRlIn0"
    let legacy = "MURMUR:eyJ2Ijox+/eyJ0eXBlIjoi=="
    // Exact input/output cases from Windows #261 at 1bcba16, with extra Unicode
    // coverage. A message and its identical quote count as one line.
    for (name, pasted, expected) in [
        ("signature", token + "\n\n↑ Copy only the MURMUR: line above.\n\n▓▒░ signature", token),
        ("quotes", "Here is the invitation: «" + token + "»", token),
        ("code fence", "```\n" + token + "\n```", token),
        ("whitespace", "\t" + token + "\r\n", token),
        ("identical quoted tokens", "> " + token + "\n\n" + token + "\nthe same line quoted", token),
        ("zero-width space", "MURMUR:eyJ2Ijox\u{200b}LCJ0eXBlIjoiaW52aXRlIn0", token),
        ("legacy base64", "file written by v2.11: " + legacy + "\n", legacy),
        ("soft hyphen", "MURMUR:eyJ2Ijox\u{ad}LCJ0eXBlIjoiaW52aXRlIn0", token),
        ("bidi marks in prefix and body", "MUR\u{2066}MUR:\u{200e}eyJ2IjoxLCJ0eXBlIjoiaW52aXRlIn0\u{2069}", token),
        ("non-BMP format character", "MURMUR:eyJ2Ijox\u{e0001}LCJ0eXBlIjoiaW52aXRlIn0", token),
        ("duplicates after Cf removal", "> MURMUR:eyJ2Ijox\u{200b}LCJ0eXBlIjoiaW52aXRlIn0\n" + token, token),
        ("emoji prefix", "💌 Приглашение: \"" + token + "\"", token),
        ("combining accent suffix", token + "\u{0301}", token),
        ("variation selector suffix", token + "\u{fe0f}", token),
        ("skin tone suffix", token + "\u{1f3fd}", token),
        ("padding", "Reply: \"MURMUR:abcd_ef-==\" — signature", "MURMUR:abcd_ef-=="),
        ("wrapped token is left to engine", "MURMUR:eyJ2Ijox\nLCJ0eXBlIjoiaW52aXRlIn0", "MURMUR:eyJ2Ijox"),
    ] {
        try check(try PairingLine.validated(pasted) == expected, "Extract one messenger token: \(name)")
        count += 1; print("PASS pairing: messenger \(name)")
    }
    for (name, pasted) in [
        ("missing", "only the prefix MURMUR: is mentioned"),
        ("empty", "MURMUR:»"),
        ("different tokens", token + "\nMURMUR:another"),
        ("current and legacy tokens", token + "\n" + legacy),
        ("Cf removal still leaves different tokens", "MURMUR:fir\u{200b}st\nMURMUR:sec\u{ad}ond"),
    ] {
        try scenario("invalid messenger paste \(name) never reaches CLI") { f in
            do {
                _ = try f.client.joinInvitation(pasted, expectedAgent: "agent-misha")
                throw CheckFailure(message: "Expected damaged line")
            } catch let error as PairingError { try check(error == .damaged, "Damaged paste") }
            try reject { _ = try f.client.addReply(pasted, expectedAgent: "agent-misha") }
            try check(!FileManager.default.fileExists(atPath: f.root.appendingPathComponent("calls").path), "No mutation or process")
        }
    }
    try scenario("legacy recovery copy preserves every base64 character") { f in
        let file = f.root.appendingPathComponent("reply.txt")
        try (legacy + "\n").write(to: file, atomically: true, encoding: .utf8)
        try check(try PairingLine.recovered(from: file) == legacy, "Old Reply is not truncated")
    }
    try scenario("size limit applies before stripping format characters") { f in
        let pasted = token + String(repeating: "\u{200b}", count: PairingLine.maximumBytes / 3)
        do {
            _ = try f.client.joinInvitation(pasted, expectedAgent: "agent-misha")
            throw CheckFailure(message: "Expected size limit")
        } catch let error as PairingError { try check(error == .tooLarge, "Bound raw pasted bytes") }
        try check(!FileManager.default.fileExists(atPath: f.root.appendingPathComponent("calls").path), "No CLI invocation")
    }
    try scenario("normalized legacy duplicate reaches stdin once for join and Reply") { f in
        let pasted = "> " + legacy + "\nMUR\u{200e}MUR:eyJ2Ijox+\u{200b}/eyJ0eXBlIjoi=="
        _ = try f.client.joinInvitation(pasted, expectedAgent: "agent-misha")
        try check(try f.text("stdin") == legacy, "Join received full legacy token once")
        _ = try f.client.addReply(pasted, expectedAgent: "agent-misha")
        try check(try f.text("stdin") == legacy, "Reply received full legacy token once")
        try check(try f.text("calls") == "status\njoin\nstatus\nstatus\nadd-peer\nstatus\n", "One import per explicit action")
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
        let contact = try f.client.addReply("Your Reply: «MURMUR:reply-only»\n— colleague", expectedAgent: "agent-misha")
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
    try scenario("Invitation uses current Identity and profile; only extracted token reaches stdin") { f in
        let joined = try f.client.joinInvitation("```\nMURMUR:invite-only\n```\n— colleague", expectedAgent: "agent-misha")
        try check(joined.peerID == "agent-jarvis" && joined.reply == "MURMUR:reply-only", "Verified Reply and Contact")
        try check(try f.text("calls") == "status\njoin\nstatus\n", "No init, retry or Service action")
        try check(try f.text("stdin") == "MURMUR:invite-only", "Only token in stdin")
        try check(try f.text("join.argv").components(separatedBy: "\0") ==
            ["--agent-id", "agent-misha", "--invite-stdin", "--json", "--data-dir", f.profile.dataDirectory, ""], "Pinned Identity/profile, no token in argv")
    }
    try scenario("different selected Identity prevents join") { f in
        try reject { _ = try f.client.joinInvitation("MURMUR:test", expectedAgent: "someone-else") }
        try check(try f.text("calls") == "status\n", "No join of unverified Identity")
    }
    for kind in ["missing-contact", "changed-identity", "receipt-identity", "self-contact", "wrong-schema", "missing-reply", "damaged-reply", "paired-claim"] {
        try scenario("existing Identity join is not declared successful: \(kind)") { f in
            var after = f.status
            var receipt: [String: Any] = ["schema": "murmur.join/1", "agentId": "agent-misha", "peerId": "agent-jarvis", "reply": "MURMUR:reply"]
            if kind == "missing-contact" { after["peers"] = ["list": [], "unknownReason": NSNull()] }
            if kind == "changed-identity" { after["agentId"] = "someone-else" }
            if kind == "receipt-identity" { receipt["agentId"] = "someone-else" }
            if kind == "self-contact" { receipt["peerId"] = "agent-misha" }
            if kind == "wrong-schema" { receipt["schema"] = "unknown/1" }
            if kind == "missing-reply" { receipt.removeValue(forKey: "reply") }
            if kind == "damaged-reply" { receipt["reply"] = "MURMUR:" }
            if kind == "paired-claim" { receipt["paired"] = true }
            try f.write("join", receipt); try f.write("after", after)
            try reject { _ = try f.client.joinInvitation("MURMUR:test", expectedAgent: "agent-misha") }
            try check(try f.text("calls").components(separatedBy: "join").count == 2, "No mutation retry")
        }
    }
    for (code, expected) in [("onboarding.existing-profile-conflict", PairingError.differentServer), ("onboarding.invalid-blob", .damaged),
                             ("onboarding.self-peer", .failed), ("onboarding.peer-key-conflict", .failed)] {
        try scenario("join error is actionable without exposing input: \(code)") { f in
            try (code + "\n").write(to: f.root.appendingPathComponent("join.error"), atomically: true, encoding: .utf8)
            do {
                _ = try f.client.joinInvitation("MURMUR:truncated\nrest-of-line", expectedAgent: "agent-misha")
                throw CheckFailure(message: "Expected join refusal")
            } catch let error as PairingError { try check(error == expected, "Stable human error mapping") }
            try check(try f.text("calls") == "status\njoin\n", "No automatic retry")
        }
    }
    for code in ["onboarding.self-peer", "onboarding.peer-key-conflict"] {
        try scenario("Reply conflict still asks for a Reply: \(code)") { f in
            try (code + "\n").write(to: f.root.appendingPathComponent("add-peer.error"), atomically: true, encoding: .utf8)
            do {
                _ = try f.client.addReply("MURMUR:reply-only", expectedAgent: "agent-misha")
                throw CheckFailure(message: "Expected Reply refusal")
            } catch let error as PairingError { try check(error == .wrongReply, "Reply-specific action") }
        }
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
