import Foundation
import MurmurTrayCore

func runAIMCoworkChecks() throws -> Int {
    var count = 0
    func need(_ value: Bool, _ message: String) throws { count += 1; try check(value, message) }
    let base: [String: Any] = ["schema": "aim.cowork.desk/1", "scope": "team-task-metadata", "ok": true,
        "observed_at": "2026-10-27T15:00:00Z", "collector_seconds": 120,
        "members": [["identity": "agent-test", "name": "Test Person", "role": "Test role"]],
        "tasks": [["id": "task-1", "title": "Test task", "owner": "agent-test", "status": "reported_done", "next_step": "Verify independently"]]]
    func decode(_ object: [String: Any]) throws -> AIMCoworkSnapshot {
        try AIMCoworkSnapshot.decode(JSONSerialization.data(withJSONObject: object))
    }
    let value = try decode(base), now = AIMCompanionSnapshot.date("2026-10-27T15:01:00Z")!
    try need(value.isCurrent(now: now), "cowork snapshot carries an independently current source")
    try need(!value.isCurrent(now: now.addingTimeInterval(300)) && !value.isCurrent(now: now.addingTimeInterval(-120)), "stale and future cowork sources are not current")
    try need(value.tasks[0].statusLabel != "Verified", "reported completion is distinct from verified completion")
    try need(value.ownerName("agent-test") == "Test Person", "cowork ownership binds by exact identity")
    var empty = base; empty["tasks"] = [[String: Any]]()
    try need(try decode(empty).tasks.isEmpty, "successful empty cowork projection preserves measured zero")
    var cases = [[String: Any]]()
    var x = base; x["scope"] = "owner-messages"; cases.append(x)
    x = base; x["message_body"] = "must not enter this projection"; cases.append(x)
    x = base; x["members"] = [["identity": "agent-test", "name": "One", "role": "Role"], ["identity": "agent-test", "name": "Two", "role": "Role"]]; cases.append(x)
    x = base; x["tasks"] = [["id": "task-1", "title": "T", "owner": "agent-other", "status": "verified", "next_step": "N"]]; cases.append(x)
    x = base; x["tasks"] = [["id": "task-1", "title": "T", "owner": "agent-test", "status": "arbitrary", "next_step": "N"]]; cases.append(x)
    x = base; x["ok"] = false; cases.append(x)
    for object in cases {
        do { _ = try decode(object); throw CheckFailure(message: "invalid cowork projection accepted") }
        catch is CocoaError { count += 1 }
    }
    return count
}
