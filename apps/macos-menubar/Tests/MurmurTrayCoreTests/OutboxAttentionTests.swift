import Foundation
import MurmurTrayCore

func runOutboxAttentionChecks(fixtures: URL) throws -> Int {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appendingPathComponent("murmur outbox checks \(UUID().uuidString)")
    try fm.createDirectory(at: root, withIntermediateDirectories: false)
    defer { try? fm.removeItem(at: root) }
    let profile = try ProfileBinding(dataDirectory: root.appendingPathComponent("profile ' literal").path, serviceName: "test-outbox")
    let cli = root.appendingPathComponent("fixture cli")
    let script = """
    #!/usr/bin/python3
    import sys,json,datetime
    from pathlib import Path
    root=Path(__file__).parent
    args=sys.argv[1:]
    with (root/'calls.jsonl').open('a') as f: f.write(json.dumps(args)+'\\n')
    key='status' if args[0]=='status' else 'receipt'
    result=json.loads((root/(key+'.json')).read_text())
    if key=='status': result['generatedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    print(json.dumps(result))
    """
    try script.write(to: cli, atomically: true, encoding: .utf8)
    try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: cli.path)
    let client = ProfileClient(executable: cli, profile: profile, environment: ["HOME": root.path])
    var base = try JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent("status-dead-letter.json"))) as! [String: Any]
    base["agentId"] = "agent-misha"
    let itemObject: [String: Any] = ["msgId": "old-failure", "peer": "peer-one", "createdAt": "2026-05-09T02:05:48Z",
        "failedAt": "2026-05-12T13:00:21Z", "reason": "CONNECTION_CLOSED", "attempts": 5751,
        "token": String(repeating: "a", count: 64), "dismissed": false]
    func data(_ object: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: object) }
    func write(_ name: String, _ object: [String: Any]) throws { try data(object).write(to: root.appendingPathComponent(name + ".json")) }
    let item = try JSONDecoder().decode(OutboxAttentionItem.self, from: data(itemObject))
    var outbox = base["outbox"] as! [String: Any]
    outbox["attention"] = ["schema": "murmur.outbox-attention/1", "total": 1, "pending": 1, "dismissed": 0,
        "items": [itemObject], "truncated": false]
    base["outbox"] = outbox
    let receipt: [String: Any] = ["schema": "murmur.outbox-action/1", "agentId": "agent-misha", "msgId": item.msgId,
        "token": item.token, "dismissed": true, "transportState": "dlq", "historyPreserved": true, "resent": false]
    func calls() throws -> [[String]] {
        try String(contentsOf: root.appendingPathComponent("calls.jsonl"), encoding: .utf8).split(separator: "\n").map {
            try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String]
        }
    }
    var count = 0
    func reject(_ action: () throws -> Void) throws {
        do { try action() } catch is CheckFailure { throw CheckFailure(message: "Test assertion failed") }
        catch { count += 1; return }
        throw CheckFailure(message: "Outbox action must be rejected")
    }
    for dismissed in [true, false] {
        try write("status", base)
        var response = receipt; response["dismissed"] = dismissed; try write("receipt", response)
        try client.setOutboxDismissed(item, dismissed: dismissed, expectedAgent: "agent-misha")
        let action = try calls().suffix(2)
        try check(action.first?.first == "status", "Outbox action requires fresh status")
        try check(action.last == ["outbox", dismissed ? "dismiss" : "restore", "--msg-id", item.msgId,
            "--expected-state", item.token, "--expected-agent", "agent-misha", "--json", "--data-dir", profile.dataDirectory,
            "--service-name", "test-outbox"], "Exact record, state, identity and literal profile argv")
        count += 1
    }
    for foreign in [true, false] {
        var changed = base
        if foreign { changed["agentId"] = "other-agent" }
        else {
            var changedBox = outbox, attention = outbox["attention"] as! [String: Any], changedItem = itemObject
            changedItem["token"] = String(repeating: "b", count: 64); attention["items"] = [changedItem]
            changedBox["attention"] = attention; changed["outbox"] = changedBox
        }
        try write("status", changed)
        let before = try calls().count
        try reject { try client.setOutboxDismissed(item, dismissed: true, expectedAgent: "agent-misha") }
        try check(try calls().dropFirst(before).map { $0.first! } == ["status"], "Changed profile/state never reaches writer")
    }
    try write("status", base)
    for (key, value): (String, Any) in [("schema", "murmur.outbox-action/2"), ("agentId", "other-agent"),
        ("msgId", "other-failure"), ("token", String(repeating: "b", count: 64)), ("dismissed", false),
        ("transportState", "acked"), ("historyPreserved", false), ("resent", true)] {
        var bad = receipt; bad[key] = value; try write("receipt", bad)
        try reject { try client.setOutboxDismissed(item, dismissed: true, expectedAgent: "agent-misha") }
    }
    print("PASS outbox attention: \(count) native checks")
    return count
}
