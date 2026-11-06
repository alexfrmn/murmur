import Foundation
import MurmurTrayCore

func runConversationContextChecks() throws -> Int {
    var count = 0
    func need(_ condition: Bool, _ label: String) throws { try check(condition, label); count += 1 }
    let stamp = "2026-10-26T12:00:00Z"
    var object: [String: Any] = ["schema":"aim.murmur.companion/1", "privacy":"owner-metadata", "fresh":true,
        "people":[["id":"person:sample", "name":"Sample", "agents":["agent-sample", "agent-other"]]],
        "questions":[], "incoming":[], "pending_count":0, "decision_count":0, "budget":[:],
        "owner_mode":"native_server", "transport":"active", "responder":"active", "server_version":"2.12.0", "responder_model":"Codex"]
    func decode() throws -> AIMCompanionSnapshot { try AIMCompanionSnapshot.decode(JSONSerialization.data(withJSONObject: object)) }
    try need(try decode().reviewedTopics(for: "agent-sample") == nil, "old server leaves reviewed conversation context unavailable")
    let decision: [String: Any] = ["id":"decision-1", "label":"Use the reviewed setting", "decided_by":"Sample human",
        "source_id":"source-1", "decided_at":stamp, "evidence_kind":"direct_human_choice_relayed", "scope":"sample setting",
        "source_date":stamp, "reviewed_at":stamp, "source_available":true]
    var topic: [String: Any] = ["id":"topic-1", "title":"Sample topic", "peer":"agent-sample", "status":"awaiting_user",
        "responsibility":"owner", "source_id":"source-1", "source_date":stamp, "reviewed_at":stamp,
        "source_available":true, "next_action":"Choose the setting", "summary":"Reviewed summary", "evidence":"A human choice was relayed",
        "references":[["id":"source-1", "label":"Choice source"]], "confirmed_decisions":[decision]]
    object["reviewed_topics"] = [topic]; object["review_at"] = stamp
    let value = try decode()
    let selected = value.reviewedTopics(for: "agent-sample")!
    try need(selected.count == 1 && selected[0].summary == "Reviewed summary" && selected[0].references?.first?.id == "source-1", "review projection retains topic summary and references")
    try need(value.reviewedTopics(for: "agent-other")?.isEmpty == true, "same person's other agent never receives exact-peer topics")
    try need(value.reviewedTopics(for: "unlisted") == nil, "unlisted peer has no reviewed context")
    let source = selected[0].confirmed_decisions![0].sourceMatch(peer: "agent-sample")!
    try need(source.store == "murmur-sasha" && source.id == "source-1" && source.date == stamp && source.peer_identity == "agent-sample", "decision opens exact retained source through existing owner reader")
    try need(selected[0].sourceMatch?.id == "source-1" && selected[0].nextStepGroup() == .owner, "topic source and owner next step retain provenance")
    var unavailableTopic = topic; unavailableTopic["source_available"] = false
    object["reviewed_topics"] = [unavailableTopic]
    try need(try decode().reviewed_topics![0].sourceMatch == nil, "topic source outside retained snapshot is disabled")
    object["reviewed_topics"] = [topic]
    var config = AIMEditionConfig(info: [:]); config.ownerResponsibility = "configured-owner"
    for (owner, expected) in [("configured-owner", AIMCompanionSnapshot.NextStepGroup.owner), ("owner", .verify), ("peer", .peer), ("agent", .agent), ("verify", .verify), ("unexpected", .verify)] {
        topic["responsibility"] = owner; object["reviewed_topics"] = [topic]
        try need(try decode().reviewed_topics![0].nextStepGroup(config: config) == expected, "next step follows current configured responsibility: " + owner)
    }
    for status in ["answered", "no_reply_needed", "reported_complete", "cancelled"] {
        topic["status"] = status; object["reviewed_topics"] = [topic]
        let closed = try decode().reviewed_topics![0]
        try need(closed.nextStepGroup() == nil && closed.confirmed_decisions?.count == 1, "closed topic excluded from next steps but decision retained: " + status)
    }
    var unavailable = decision; unavailable["source_available"] = false
    topic["confirmed_decisions"] = [unavailable]; object["reviewed_topics"] = [topic]
    let historical = try decode().reviewed_topics![0].confirmed_decisions![0]
    try need(historical.sourceMatch(peer: "agent-sample") == nil && historical.decided_at == stamp, "missing retained source disables opening and preserves recorded date")
    func rejected(_ label: String) throws {
        do { _ = try decode(); throw CheckFailure(message: label + " accepted") }
        catch is CocoaError { count += 1 }
        catch is DecodingError { count += 1 }
    }
    for kind in ["agent_recommendation", "peer_review_and_github_merge_verified_20260230", "peer_review_and_github_merge_verified_20261026extra", "unknown"] {
        var invalid = decision; invalid["evidence_kind"] = kind; topic["confirmed_decisions"] = [invalid]; object["reviewed_topics"] = [topic]
        try rejected("unsafe decision evidence " + kind)
    }
    for kind in ["human_decision_reported_by_peer", "operator_verified_receipt", "peer_review_and_github_merge_verified_20261026"] {
        var valid = decision; valid["evidence_kind"] = kind; topic["confirmed_decisions"] = [valid]; object["reviewed_topics"] = [topic]
        try need(try decode().reviewed_topics![0].confirmed_decisions![0].evidenceLabelKey != "unknown", "verified decision evidence accepted: " + kind)
    }
    for field in ["id", "label", "decided_by", "source_id", "decided_at", "evidence_kind", "scope", "source_available"] {
        var invalid = decision; invalid.removeValue(forKey: field); topic["confirmed_decisions"] = [invalid]; object["reviewed_topics"] = [topic]
        try rejected("missing decision field " + field)
    }
    topic["confirmed_decisions"] = [decision]
    for peer in ["shaper-viola", "agent-viola-alex", "not-in-roster"] {
        topic["peer"] = peer; object["reviewed_topics"] = [topic]; try rejected("private or unlisted reviewed topic " + peer)
    }
    object["people"] = [["id":"person:private", "name":"Private", "agents":["agent-sample"], "contact_state":"status_only"]]
    topic["peer"] = "agent-sample"; object["reviewed_topics"] = [topic]; try rejected("status-only reviewed topic")
    return count + (try runAttentionOrderChecks()) + (try runReplyDraftChecks())
}


func runAttentionOrderChecks() throws -> Int {
    var count = 0
    func need(_ condition: Bool, _ label: String) throws { try check(condition, label); count += 1 }
    func row(_ id: String, _ peer: String, _ date: String?, _ kind: String = "owner") -> [String: Any] {
        var value: [String: Any] = ["id":id, "peer":peer, "kind":kind, "title":"Synthetic topic", "next_action":"Review source",
            "source_ids":[], "conversation":"synthetic", "actionable":true, "alert":true]
        if let date { value["date"] = date }
        return value
    }
    let rows = [row("old-danik", "zima", "2026-10-11T12:00:00Z"), row("b-unknown", "zima", nil),
        row("fresh-jarvis", "agent-jarvis", "2026-10-26T19:00:00Z"), row("a-invalid", "zima", "invalid"),
        row("older-jarvis", "agent-jarvis", "2026-10-25T23:00:00Z"), row("timezone", "agent-jarvis", "2026-10-26T20:00:00+02:00"),
        row("delivery", "zima", "2026-10-26T21:00:00Z", "delivery"), row("implementation", "agent-jarvis", "2026-10-26T22:00:00Z", "agent")]
    let attention = try JSONDecoder().decode(AIMCompanionSnapshot.Attention.self, from: JSONSerialization.data(withJSONObject: ["schema":1, "receipts_ok":true, "items":rows]))
    try need(attention.yourTurn.map(\.id) == ["fresh-jarvis", "timezone", "older-jarvis", "old-danik", "a-invalid", "b-unknown"], "owner topics sort parsed source dates descending; malformed/nil last with stable ID ties")
    let groups = AIMCompanionSnapshot.Attention.peerGroups(attention.yourTurn)
    try need(groups.map(\.peer) == ["agent-jarvis", "zima"], "new 26 October counterpart appears before 11 October counterpart")
    try need(groups[0].items.map(\.id) == ["fresh-jarvis", "timezone", "older-jarvis"], "each person's topics retain source-date order")
    try need(groups.flatMap(\.items).count == attention.yourTurn.count && Set(groups.flatMap(\.items).map(\.id)) == Set(attention.yourTurn.map(\.id)), "grouping keeps all owner topics")
    try need(attention.otherUpdates.map(\.id) == ["delivery", "implementation"], "delivery and implementation alerts retain existing priority and membership")
    var object: [String: Any] = ["schema":"aim.murmur.companion/1", "privacy":"owner-metadata", "fresh":true,
        "people":[["id":"person:vasiliev", "name":"Александр Васильев", "agents":["agent-jarvis"], "agent_labels":["agent-jarvis":"JARVIS"]],
                  ["id":"person:danik", "name":"Александр Даник", "agents":["zima"], "agent_labels":["zima":"zima"]]],
        "questions":[], "incoming":[], "pending_count":0, "decision_count":0, "budget":[:],
        "owner_mode":"native_server", "transport":"active", "responder":"active", "server_version":"2.12.0", "responder_model":"Codex"]
    func decode() throws -> AIMCompanionSnapshot { try AIMCompanionSnapshot.decode(JSONSerialization.data(withJSONObject: object)) }
    let snapshot = try decode()
    try need(snapshot.participantLabel(for: "agent-jarvis") == "Александр Васильев · JARVIS" && snapshot.participantLabel(for: "zima") == "Александр Даник · zima", "full person and exact agent labels keep same-first-name counterparts distinct")
    try need(snapshot.participantLabel(for: "unknown-agent") == "unknown-agent", "unlisted counterpart identity remains explicit")
    var topic: [String: Any] = ["id":"suggestion", "peer":"agent-jarvis", "responsibility":"owner", "status":"awaiting_user",
        "proposal_status":"draft_not_approved", "proposed_reply":"Synthetic operator draft only", "confirmed_decisions":[]]
    object["reviewed_topics"] = [topic]
    let suggested = try decode().reviewed_topics![0]
    try need(suggested.draftProposedReply == "Synthetic operator draft only" && suggested.confirmed_decisions?.isEmpty == true,
             "an explicit proposed answer remains a draft and creates no decision")
    let draftSnapshot = try decode()
    func item(_ id: String, _ peer: String, _ kind: String = "owner") throws -> AIMCompanionSnapshot.Attention.Item {
        try JSONDecoder().decode(AIMCompanionSnapshot.Attention.Item.self, from: JSONSerialization.data(withJSONObject: row(id, peer, nil, kind)))
    }
    try need(try draftSnapshot.proposedReply(for: item("topic:suggestion", "agent-jarvis")) == "Synthetic operator draft only", "Overview accepts the exact owner topic and peer draft")
    try need(try draftSnapshot.proposedReply(for: item("topic:suggestion", "zima")) == nil, "Overview never transfers a proposal across peers")
    try need(try draftSnapshot.proposedReply(for: item("topic:other-topic", "agent-jarvis")) == nil, "Overview never matches proposals by title or person alone")
    try need(try draftSnapshot.proposedReply(for: item("topic:suggestion", "agent-jarvis", "agent")) == nil, "implementation card cannot inherit an owner proposal")
    for status in ["", "approved", "sent", "agent_recommendation"] {
        topic["proposal_status"] = status; object["reviewed_topics"] = [topic]
        do { _ = try decode(); throw CheckFailure(message: "untrusted proposal status accepted") }
        catch is CocoaError { count += 1 }
    }
    topic.removeValue(forKey: "proposal_status"); object["reviewed_topics"] = [topic]
    do { _ = try decode(); throw CheckFailure(message: "proposal missing draft status accepted") }
    catch is CocoaError { count += 1 }
    topic["proposal_status"] = "draft_not_approved"
    topic.removeValue(forKey: "proposed_reply"); object["reviewed_topics"] = [topic]
    try need(try decode().reviewed_topics![0].proposed_reply == nil, "missing proposed answer remains absent")
    topic["proposed_reply"] = String(repeating: "x", count: 4097); object["reviewed_topics"] = [topic]
    do { _ = try decode(); throw CheckFailure(message: "oversized proposed answer accepted") }
    catch is CocoaError { count += 1 }
    try need(L10n.localized("Proposed reply · draft, not approved or sent", language: .russian) == "Вариант ответа · драфт, не одобрен и не отправлен", "operator draft label is explicit in Russian")
    return count
}
