import Foundation
import MurmurTrayCore

func runReplyDraftChecks() throws -> Int {
    var count = 0
    func need(_ condition: Bool, _ label: String) throws { try check(condition, label); count += 1 }
    let stamp = "2026-10-27T12:00:00Z", sourceID = "00000000-0000-4000-8000-000000000101"
    let conversationID = "00000000-0000-4000-8000-000000000102"
    let now = AIMCompanionSnapshot.date("2026-10-27T12:01:00Z")!
    let context: [String: Any] = ["store":"murmur-sasha", "local_identity":"agent-synthetic-owner", "source_id":sourceID, "conversation_id":conversationID]
    let topic: [String: Any] = ["id":"reply-topic", "title":"Synthetic reply topic", "peer":"agent-sample", "status":"awaiting_user", "responsibility":"owner",
        "source_id":sourceID, "conversation":conversationID, "source_date":stamp, "source_available":true,
        "reply_context":context, "proposal_status":"draft_not_approved", "proposed_reply":"Synthetic reviewed full reply.",
        "reply_options":[["id":"yes", "text":"Synthetic full affirmative reply."], ["id":"no", "text":"Synthetic full negative reply."]]]
    let base: [String: Any] = ["schema":"aim.murmur.companion/1", "privacy":"owner-metadata", "snapshot_at":stamp, "fresh":true,
        "people":[["id":"person:sample", "name":"Sample", "agents":["agent-sample"], "writable_agents":["agent-sample"]]],
        "questions":[], "reviewed_topics":[topic], "incoming":[], "pending_count":0, "decision_count":0, "budget":[:],
        "owner_mode":"native_server", "transport":"active", "responder":"active", "server_version":"2.12.0", "responder_model":"Codex"]
    func decode(_ object: [String: Any]) throws -> AIMCompanionSnapshot { try AIMCompanionSnapshot.decode(JSONSerialization.data(withJSONObject: object)) }
    func altered(_ key: String, _ value: Any?) throws -> AIMCompanionSnapshot {
        var changed = topic; changed[key] = value
        var object = base; object["reviewed_topics"] = [changed]
        return try decode(object)
    }
    func draft(_ snapshot: AIMCompanionSnapshot, _ choice: String = "custom") -> AIMReplyDraft? {
        snapshot.replyDraft(for: snapshot.reviewed_topics![0], choice: choice, now: now)
    }
    func item(_ id: String = "topic:reply-topic", _ peer: String = "agent-sample", _ kind: String = "owner") throws -> AIMCompanionSnapshot.Attention.Item {
        try JSONDecoder().decode(AIMCompanionSnapshot.Attention.Item.self, from: JSONSerialization.data(withJSONObject: [
            "id":id, "peer":peer, "kind":kind, "title":"Synthetic", "next_action":"Review", "source_ids":[sourceID],
            "conversation":conversationID, "actionable":true, "alert":true]))
    }
    let snapshot = try decode(base), question = try decode(base).reviewed_topics![0]
    let custom = draft(snapshot)!
    try need(custom.text.isEmpty && custom.peer == "agent-sample" && custom.title == "Synthetic reply topic" && UUID(uuidString: custom.id) != nil,
             "custom opens an empty reviewable sheet with a UI-only UUID")
    try need(custom.context.source_id == sourceID && custom.context.conversation_id == conversationID && custom.context.local_identity == "agent-synthetic-owner", "draft carries the exact retained source binding")
    try need(draft(snapshot, "proposal")?.text == "Synthetic reviewed full reply.", "proposal uses the curated full text")
    try need(draft(snapshot, "yes")?.text == "Synthetic full affirmative reply." && draft(snapshot, "no")?.text == "Synthetic full negative reply.", "binary choices use explicit full draft texts")
    try need(draft(snapshot, "infer-yes") == nil, "unknown choices never infer binary semantics")
    let encoded = try JSONEncoder().encode(custom.context)
    try need(Set((try JSONSerialization.jsonObject(with: encoded) as! [String: Any]).keys) == Set(["store", "local_identity", "source_id", "conversation_id"])
             && (try JSONDecoder().decode(AIMReplyContext.self, from: encoded)) == custom.context, "reply context Codable contains exactly the four source fields and no request UUID")
    try need(try snapshot.replyQuestion(for: item(), now: now)?.id == "reply-topic", "attention lookup binds exact topic and peer")
    try need(try snapshot.replyQuestion(for: item("topic:reply-topic", "agent-sample", "agent"), now: now)?.id == "reply-topic", "manual reply supports ordinary open implementation topics")
    try need(try snapshot.proposedReply(for: item("topic:reply-topic", "agent-sample", "agent")) == nil, "legacy proposal display stays owner-only")
    try need(try snapshot.replyQuestion(for: item("topic:other"), now: now) == nil && snapshot.replyQuestion(for: item("topic:reply-topic", "wrong-peer"), now: now) == nil, "attention lookup never crosses topics or peers")
    var modified = topic; modified["proposed_reply"] = "Untrusted replacement"
    let modifiedQuestion = try JSONDecoder().decode(AIMCompanionSnapshot.Question.self, from: JSONSerialization.data(withJSONObject: modified))
    try need(snapshot.replyDraft(for: modifiedQuestion, choice: "proposal", now: now) == nil, "modified question copy cannot seed a composer")
    try need(snapshot.replyDraft(for: question, choice: "custom", now: now.addingTimeInterval(300)) == nil, "expired snapshot blocks draft preparation")
    for (key, value) in [("fresh", false as Any), ("snapshot_at", "invalid" as Any), ("snapshot_at", "2026-10-27T13:00:00Z" as Any)] {
        var object = base; object[key] = value
        try need(draft(try decode(object)) == nil, "unconfirmed snapshot blocks draft: " + key)
    }
    var noRoute = base; noRoute["people"] = [["id":"person:sample", "name":"Sample", "agents":["agent-sample"]]]
    try need(draft(try decode(noRoute)) == nil, "missing listed writable route blocks draft")
    var config = AIMEditionConfig(); config.privatePeers = ["agent-sample"]
    try need(snapshot.replyDraft(for: question, choice: "custom", config: config, now: now) == nil, "configured private counterpart blocks a draft")
    config.privatePeers = ["agent-synthetic-owner"]
    try need(snapshot.replyDraft(for: question, choice: "custom", config: config, now: now) == nil, "configured private local identity blocks a draft")
    try need(draft(try altered("source_available", false)) == nil && draft(try altered("reply_context", nil)) == nil, "unavailable source or absent source context blocks draft")
    for status in ["answered", "no_reply_needed", "reported_complete", "cancelled", "superseded"] {
        let closed = try altered("status", status)
        try need(draft(closed, "custom") == nil && closed.reviewed_topics![0].draftProposedReply == nil && closed.reviewed_topics![0].draftReplyOptions.isEmpty,
                 "closed topic suppresses every reply choice: " + status)
    }
    let noProposal = try altered("proposed_reply", nil)
    try need(draft(noProposal, "proposal") == nil && draft(noProposal, "custom") != nil, "custom remains available without inventing a proposal")
    let noOptions = try altered("reply_options", [])
    try need(draft(noOptions, "yes") == nil && draft(noOptions, "no") == nil && draft(noOptions, "custom") != nil, "absent binary options never produce inferred yes/no replies")
    func rejected(_ object: [String: Any], _ label: String) throws {
        do { _ = try decode(object); throw CheckFailure(message: label + " accepted") }
        catch is CocoaError { count += 1 }
        catch is DecodingError { count += 1 }
    }
    for options: [[String: String]] in [
        [["id":"yes", "text":"Only one"]], [["id":"yes", "text":"One"], ["id":"yes", "text":"Two"]],
        [["id":"yes", "text":"One"], ["id":"maybe", "text":"Two"]], [["id":"yes", "text":" "], ["id":"no", "text":"Two"]],
        [["id":"yes", "text":String(repeating:"x", count:4097)], ["id":"no", "text":"Two"]]] {
        var changed = topic; changed["reply_options"] = options
        var object = base; object["reviewed_topics"] = [changed]
        try rejected(object, "malformed explicit reply options")
    }
    for status in ["approved", "sent", "unknown"] {
        var changed = topic; changed["proposal_status"] = status
        var object = base; object["reviewed_topics"] = [changed]
        try rejected(object, "non-draft reply option status")
    }
    for (key, value) in [("source_id", "other-source"), ("conversation_id", "other-conversation"), ("store", "private-store"),
                         ("local_identity", "shaper-viola"), ("local_identity", "agent-sample"), ("local_identity", "unsafe identity") ] {
        var invalidContext = context; invalidContext[key] = value
        var changed = topic; changed["reply_context"] = invalidContext
        var object = base; object["reviewed_topics"] = [changed]
        try rejected(object, "unbound reply context " + key)
    }
    var privateRoster = base; privateRoster["people"] = [["id":"person:sample", "name":"Private", "agents":["agent-sample"], "contact_state":"status_only"]]
    try rejected(privateRoster, "status-only source topic")
    let recorded: [String: Any] = ["id":"owner-choice", "label":"Synthetic human choice", "decided_by":"Synthetic owner",
        "source_id":"00000000-0000-4000-8000-000000000103", "decided_at":stamp, "evidence_kind":"direct_human_choice_recorded",
        "scope":"Synthetic scope", "source_available":false]
    let recordedSnapshot = try altered("confirmed_decisions", [recorded])
    let decision = recordedSnapshot.reviewed_topics![0].confirmed_decisions![0]
    try need(decision.evidenceLabelKey == "Human choice recorded in owner chat" && decision.originLabelKey == "Owner chat decision"
             && decision.sourceMatch(peer:"agent-sample") == nil, "recorded owner-chat choice stays distinct from Murmur delivery and has no Murmur source action")
    for (key, value) in [("source_id", "not-a-uuid" as Any), ("source_available", true as Any)] {
        var invalid = recorded; invalid[key] = value
        var changed = topic; changed["confirmed_decisions"] = [invalid]
        var object = base; object["reviewed_topics"] = [changed]
        try rejected(object, "invalid owner-chat decision provenance " + key)
    }
    return count
}
