import Foundation
import MurmurTrayCore

func runClientSetupChecks(fixtures: URL) throws -> Int {
    let fm = FileManager.default
    let directory = fm.temporaryDirectory.appendingPathComponent("murmur client checks \(UUID().uuidString)")
    try fm.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? fm.removeItem(at: directory) }
    let profile = try ProfileBinding(dataDirectory: directory.appendingPathComponent("profile with spaces").path)
    let target = directory.appendingPathComponent("custom codex/config.toml").path
    let planID = String(repeating: "a", count: 64)
    var planObject: [String: Any] = ["schema": "murmur.client-plan/1", "client": "codex-cli", "configPath": target,
        "agentId": "agent-misha", "dataDir": profile.dataDirectory, "action": "replace", "planId": planID, "configExisted": true, "restartRequired": true]
    func data(_ object: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: object) }
    func write(_ name: String, _ object: [String: Any]) throws { try data(object).write(to: directory.appendingPathComponent(name + ".json")) }
    var count = 0
    func refuse(_ label: String, _ action: () throws -> Void) throws {
        do { try action() } catch is CheckFailure { throw CheckFailure(message: label) } catch { count += 1; return }
        throw CheckFailure(message: label + ": expected refusal")
    }
    let plan = try ClientConfigurationPlan.decode(data(planObject), profile: profile, agentID: "agent-misha", client: .codexCLI)
    for (key, value): (String, Any) in [("schema", "murmur.client-plan/2"), ("client", "claude-code"), ("configPath", "relative"),
                                       ("agentId", "other"), ("dataDir", "/other"), ("action", "surprise"), ("planId", "bad"), ("restartRequired", false)] {
        var bad = planObject; bad[key] = value
        try refuse("Invalid client plan: \(key)") { _ = try ClientConfigurationPlan.decode(data(bad), profile: profile, agentID: "agent-misha", client: .codexCLI) }
    }
    let receipt: [String: Any] = ["schema": "murmur.client/1", "client": "codex-cli", "configPath": target,
        "agentId": "agent-misha", "dataDir": profile.dataDirectory, "planId": planID, "changed": true, "restartRequired": true,
        "backup": target + ".murmur-backup-" + UUID().uuidString]
    _ = try ClientConfigurationReceipt.decode(data(receipt), plan: plan); count += 1
    for (key, value): (String, Any) in [("configPath", "/different"), ("planId", String(repeating: "b", count: 64)), ("backup", "/unrelated/file"), ("backup", NSNull()), ("changed", false)] {
        var bad = receipt; bad[key] = value
        try refuse("Invalid client receipt: \(key)") { _ = try ClientConfigurationReceipt.decode(data(bad), plan: plan) }
    }
    let now = Date(), date = ISO8601DateFormatter(), nonce = String(repeating: "c", count: 48)
    let testObject: [String: Any] = ["schema": "murmur.reply-test-plan/1", "agentId": "agent-misha", "peerId": "peer-one",
        "conversationId": "murmur:setup:" + nonce, "token": "dGVzdA", "createdAt": date.string(from: now),
        "expiresAt": date.string(from: now.addingTimeInterval(900)), "requestText": "synthetic test request",
        "expectedReply": "MURMUR-SETUP-REPLY " + nonce]
    let testPlan = try ReplyTestPlan.decode(data(testObject), agentID: "agent-misha", peerID: "peer-one", now: now)
    try check(testPlan.prompt.contains("murmur_send") && testPlan.prompt.contains("conversationId"), "Prompt must ask the selected AI client to send the real correlated request"); count += 1
    let observation: [String: Any] = ["schema": "murmur.reply-test/1", "agentId": "agent-misha", "peerId": "peer-one",
        "conversationId": testPlan.conversationId, "generatedAt": date.string(from: now), "state": "replied",
        "requestMsgId": "outbound-test", "replyMsgId": "inbound-test", "receivedAt": date.string(from: now)]
    _ = try ReplyTestObservation.decode(data(observation), plan: testPlan, now: now); count += 1
    for (key, value): (String, Any) in [("peerId", "other"), ("conversationId", "other"), ("requestMsgId", NSNull()),
                                       ("replyMsgId", ""), ("receivedAt", date.string(from: now.addingTimeInterval(-60))),
                                       ("state", "waiting"), ("generatedAt", date.string(from: now.addingTimeInterval(-60)))] {
        var bad = observation; bad[key] = value
        try refuse("Invalid reply observation: \(key)") { _ = try ReplyTestObservation.decode(data(bad), plan: testPlan, now: now) }
    }
    var status = try JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent("status-green.json"))) as! [String: Any]
    status["agentId"] = "agent-misha"
    try write("status", status)
    try write("clients-detect", ["schema": "murmur.clients/1", "clients": [["id": "codex-cli", "installed": true, "configPath": target, "format": "toml"]]])
    try write("clients-preview", planObject); try write("clients-configure", receipt)
    try write("reply-test-prepare", testObject); try write("reply-test-check", observation)
    let executable = directory.appendingPathComponent("fixture cli")
    let script = """
    #!/usr/bin/python3
    import json,sys,os,datetime
    from pathlib import Path
    root=Path(__file__).parent
    args=sys.argv[1:]
    with (root/'calls.jsonl').open('a') as out:
     out.write(json.dumps({'args':args,'env':{k:os.environ.get(k) for k in ['CODEX_HOME','CLAUDE_CONFIG_DIR','NODE_OPTIONS','OPENAI_API_KEY','DATA_DIR']}})+'\\n')
    key=args[0] if args[0]=='status' else args[0]+'-'+args[1]
    result=json.loads((root/(key+'.json')).read_text())
    if key=='status': result['generatedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    print(json.dumps(result))
    """
    try script.write(to: executable, atomically: true, encoding: .utf8)
    try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
    let helper = ClientSetupClient(executable: executable, profile: profile,
        environment: ["HOME": directory.path, "CODEX_HOME": directory.appendingPathComponent("custom codex").path,
                      "CLAUDE_CONFIG_DIR": "/custom-claude", "NODE_OPTIONS": "bad", "OPENAI_API_KEY": "fixture-never-inherit", "DATA_DIR": "/wrong"])
    try check(try helper.detect(expectedAgent: "agent-misha").count == 1, "Detection from canonical CLI"); count += 1
    let preview = try helper.preview(.codexCLI, expectedAgent: "agent-misha")
    _ = try helper.configure(preview, expectedAgent: "agent-misha")
    let prepared = try helper.prepareTest(peerID: "peer-one", expectedAgent: "agent-misha")
    _ = try helper.checkTest(prepared, expectedAgent: "agent-misha")
    let callsFile = directory.appendingPathComponent("calls.jsonl")
    let calls = try String(contentsOf: callsFile, encoding: .utf8).split(separator: "\n").map {
        try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any]
    }
    let actions = calls.map { $0["args"] as! [String] }
    try check(actions.allSatisfy { $0.suffix(3) == ["--json", "--data-dir", profile.dataDirectory] }, "All actions use the selected lexical profile path as one argv element"); count += 1
    try check(actions.contains { $0.prefix(7) == ["clients", "configure", "--client", "codex-cli", "--plan-id", planID, "--replace"] }, "Explicit replacement is tied to the confirmed plan"); count += 1
    for record in calls {
        let args = record["args"] as! [String], env = record["env"] as! [String: Any]
        try check(env["NODE_OPTIONS"] is NSNull && env["OPENAI_API_KEY"] is NSNull && env["DATA_DIR"] is NSNull, "Never inherit auth/runtime overrides")
        if args.first == "clients" {
            try check(env["CLAUDE_CONFIG_DIR"] as? String == "/custom-claude" && env["CODEX_HOME"] as? String == directory.appendingPathComponent("custom codex").path, "Client detector must see custom configuration routing")
        } else { try check(env["CODEX_HOME"] is NSNull && env["CLAUDE_CONFIG_DIR"] is NSNull, "Client overrides stay scoped to client commands") }
    }
    count += 2
    let before = try Data(contentsOf: callsFile)
    status["agentId"] = "other"; try write("status", status)
    try refuse("Changed profile identity before configure") { _ = try helper.configure(preview, expectedAgent: "agent-misha") }
    let appended = try String(contentsOf: callsFile, encoding: .utf8).dropFirst(before.count)
    try check(!appended.contains("configure"), "Identity refusal must not invoke the writer"); count += 1
    print("PASS client setup and returned reply: \(count) checks")
    return count
}
