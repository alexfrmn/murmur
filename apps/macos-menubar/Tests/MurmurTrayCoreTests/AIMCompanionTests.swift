import Foundation
import MurmurTrayCore

func runAIMCompanionChecks() throws -> Int {
    var object: [String: Any] = [
        "schema": "aim.murmur.companion/1", "privacy": "owner-metadata",
        "snapshot_at": "2026-09-29T17:00:00Z", "fresh": true,
        "people": [], "questions": [], "incoming": [],
        "pending_count": 2, "decision_count": 1, "budget": [:],
        "owner_mode": "native_server", "transport": "active", "responder": "active",
        "server_version": "2.12.0", "responder_model": "Codex"
    ]
    let data = try JSONSerialization.data(withJSONObject: object)
    let value = try AIMCompanionSnapshot.decode(data)
    let now = AIMCompanionSnapshot.date("2026-09-29T17:01:00Z")!
    try check(value.isCurrent(now: now), "recent source remains current")
    try check(!value.isCurrent(now: now.addingTimeInterval(300)), "retained snapshots expire without refresh")
    try check(!value.isCurrent(now: now.addingTimeInterval(-120)), "future timestamps fail closed")
    object["people"] = [["id":"person:sample", "name":"Sample", "agents":["agent-sample"], "nickname":"@sample_handle", "agent_labels":["agent-sample":"sample label"], "writable_agents":["agent-sample"]]]
    let people = try AIMCompanionSnapshot.decode(JSONSerialization.data(withJSONObject: object)).people
    try check(people.first?.nickname == "@sample_handle" && people.first?.writable_agents == ["agent-sample"], "exact recipient and nickname survive decoding")
    object["privacy"] = "public"
    do { _ = try AIMCompanionSnapshot.decode(JSONSerialization.data(withJSONObject: object)); throw CheckFailure(message: "unsafe projection accepted") }
    catch is CocoaError {} 
    object["privacy"] = "owner-metadata"
    object["questions"] = [
        ["id":"q-owner", "peer":"agent-demo", "responsibility":"owner", "status":"awaiting_user"],
        ["id":"q-agent", "peer":"agent-sample", "responsibility":"agent", "status":"awaiting_agent"],
        ["id":"q-peer", "responsibility":"peer", "status":"awaiting_peer"],
        ["id":"q-check", "responsibility":"verify", "status":"unclassified"]]
    object["private_contours"] = [["id":"private-1", "name":"Private line", "privacy":"status-only", "service_active":true]]
    object["owner_threads"] = ["agent-demo": ["title":"Owner", "url":"codex://threads/00000000-0000-4000-8000-000000000001"]]
    let classified = try AIMCompanionSnapshot.decode(JSONSerialization.data(withJSONObject: object))
    try check(classified.ownerQuestions.map(\.id) == ["q-owner"] && classified.agentQuestions.map(\.id) == ["q-agent"]
              && classified.peerQuestions.map(\.id) == ["q-peer"] && classified.verificationQuestions.map(\.id) == ["q-check"],
              "responsibility is displayed as separate work queues")
    try check(classified.ownerThread(for: "agent-demo")?.verifiedURL != nil && classified.ownerThread(for: "agent-sample") == nil,
              "only the exact linked agent receives an owner chat")
    try check(classified.private_contours?.first?.privacy == "status-only", "private contour contains status only")
    object["owner_threads"] = ["agent-demo": ["title":"Wrong", "url":"https://example.com"]]
    do { _ = try AIMCompanionSnapshot.decode(JSONSerialization.data(withJSONObject: object)); throw CheckFailure(message: "unsafe owner URL accepted") }
    catch is CocoaError {}
    let match: [String: Any] = ["privacy":"owner-only-search", "matches":[["id":"m-1", "store":"ordinary", "excerpt":"synthetic phrase"]],
                                "total":1, "truncated":false, "searched":20, "unavailable":[], "scope":"ordinary messages", "source_at":"2026-10-05T10:00:00Z"]
    let search = try AIMMessageSearchResult.decode(JSONSerialization.data(withJSONObject: match))
    try check(search.matches.first?.stableID == "ordinary:m-1", "search keeps a stable exact message reference")
    let read = try AIMMessageReadResult.decode(JSONSerialization.data(withJSONObject: ["privacy":"owner-only-on-demand", "id":"m-1", "text":"synthetic text", "truncated":false]), expectedID: "m-1")
    try check(read.text == "synthetic text", "explicit read returns selected message")
    do { _ = try AIMMessageReadResult.decode(JSONSerialization.data(withJSONObject: ["privacy":"owner-only-on-demand", "id":"m-2", "text":"wrong", "truncated":false]), expectedID: "m-1"); throw CheckFailure(message: "mismatched message accepted") }
    catch is CocoaError {}
    var cursor = AIMCompanionCursor()
    try check(cursor.observe(["old"]).isEmpty, "first observation is quiet")
    try check(cursor.observe(["old", "new"]) == ["new"], "only unseen items notify")
    _ = cursor.observe([])
    try check(cursor.observe(["new"]).isEmpty, "queue reappearance does not notify again")
    var restored = AIMCompanionCursor(seen: cursor.seen)
    try check(restored.observe(["old", "new"]).isEmpty, "restart preserves notification dedupe")
    var navigation = AIMPanelNavigation(page: "People")
    navigation.openSettings(); navigation.openSettings()
    try check(navigation.page == "Settings" && !navigation.escape() && navigation.page == "People", "Settings Escape preserves the prior view even after repeated open")
    try check(navigation.escape(), "main Escape requests hiding without mutating navigation")
    navigation.select("Help"); navigation.openSettings(); _ = navigation.escape()
    try check(navigation.page == "Help", "each Settings visit returns to the latest selected view")
    // Edition configuration: a stock build has none, and nothing unsafe survives validation.
    let searchEdition = AIMEditionConfig(info: ["AIMShellEdition": 1, "AIMBoardURL": "https://example.com/desk/?command=old&view=old&lab=test#stale"])
    try check(searchEdition.sharedSearchURL?.absoluteString == "https://example.com/desk/?lab=test&view=mesh&command=search", "owner search preserves mount and replaces routing")
    try check(AIMEditionConfig().sharedSearchURL == nil, "stock has no owner search destination")
    try check(AIMEditionConfig(info: ["AIMShellEdition": 1, "AIMBoardURL": "http://example.com"]).sharedSearchURL == nil, "owner search requires HTTPS")
    try check(AIMEditionConfig(info: ["AIMShellEdition": 1, "AIMBoardURL": "https://user:password@example.com"]).sharedSearchURL == nil, "owner search does not expose credentials in URL")
    let stock = AIMEditionConfig()
    try check(!stock.isEnabled && !stock.canReachServer && stock.boardURL == nil && stock.avatarPeople.isEmpty,
              "a stock build carries no edition, host, board or roster")
    let hostile = AIMEditionConfig(info: ["AIMShellEdition": 1, "AIMOwnerSSHHost": "host; rm -rf /",
                                          "AIMServerRoot": "../etc", "AIMServerDatabase": "/etc/passwd",
                                          "AIMBoardURL": "http://board.example.org/", "AIMAvatarPeople": ["demo", "../x", "Name"]])
    try check(hostile.isEnabled && !hostile.canReachServer && hostile.serverRoot == AIMEditionConfig.defaultServerRoot
              && hostile.serverDatabase == nil && hostile.boardURL == nil && hostile.avatarPeople == ["demo"],
              "invalid host, paths, plain-HTTP board and roster entries are dropped")
    let edition = AIMEditionConfig(info: ["AIMShellEdition": 9, "AIMOwnerSSHHost": "owner-alias", "AIMServerRoot": "companion",
                                          "AIMServerDatabase": ".local/var/murmur/murmur.db", "AIMOwnerResponsibility": "lead",
                                          "AIMAvatarPeople": ["demo"], "AIMPrivatePeers": ["agent-private"]])
    try check(edition.canReachServer && edition.helperEnvironment == ["MURMUR_COMPANION_ROOT=companion", "MURMUR_COMPANION_OWNER=lead",
              "MURMUR_COMPANION_DB=.local/var/murmur/murmur.db", "MURMUR_COMPANION_AVATARS=demo", "MURMUR_COMPANION_PRIVATE=agent-private"],
              "the helper environment carries only validated edition values")
    // The previous case left an unsafe owner thread in `object`; the portrait fixture starts without threads.
    let portrait = try AIMCompanionSnapshot.decode(JSONSerialization.data(withJSONObject: object.merging(["owner_threads": [String: Any](), "people": [
        ["id":"person:demo", "name":"Demo", "agents":["agent-demo"], "photo":"/mesh-comms-avatar-demo.jpg", "photo_privacy":"owner-approved-avatar"],
        ["id":"person:demo", "name":"Private", "agents":["agent-private"], "photo":"/mesh-comms-avatar-demo.jpg", "photo_privacy":"owner-approved-avatar"]]]) { _, new in new })).people
    try check(portrait[0].approvedPhoto(in: edition) != nil && portrait[0].approvedPhoto(in: stock) == nil
              && portrait[1].approvedPhoto(in: edition) == nil,
              "portraits follow the edition roster and never show for a private identity")
    return 27
}
