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
    try check(people.first?.flows == nil, "an older roster leaves traffic unknown")
    var flowPerson = (object["people"] as! [[String: Any]])[0]
    flowPerson["flows"] = ["agent-sample": ["inbound_count": 0, "outbound_count": 7, "scope": "retained snapshot", "source_at": "2026-09-29T17:00:00Z"]]
    object["people"] = [flowPerson]
    let flow = try AIMCompanionSnapshot.decode(JSONSerialization.data(withJSONObject: object)).people[0].flows!["agent-sample"]!
    try check(flow.inbound_count == 0 && flow.outbound_count == 7 && flow.last_at == nil, "directional counts preserve measured zero and unknown date")
    flowPerson["flows"] = ["agent-sample": ["inbound_count": -1]]
    object["people"] = [flowPerson]
    do { _ = try AIMCompanionSnapshot.decode(JSONSerialization.data(withJSONObject: object)); throw CheckFailure(message: "negative traffic accepted") }
    catch is CocoaError {}
    flowPerson.removeValue(forKey: "flows"); object["people"] = [flowPerson]
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
    var crowded = AIMCompanionCursor(seen: Set((0..<9000).map { "z-\($0)" }))
    _ = crowded.observe(["a-current"])
    try check(crowded.seen?.count == 8192 && crowded.seen?.contains("a-current") == true, "bounded notification history retains current attention before old hashes")
    var boundedRestore = AIMCompanionCursor(seen: crowded.seen)
    try check(boundedRestore.observe(["a-current"]).isEmpty, "current attention remains quiet after restoring a full history")
    let historySuite = "org.murmur.tests.attention-history." + UUID().uuidString
    let historyDefaults = UserDefaults(suiteName: historySuite)!
    defer { historyDefaults.removePersistentDomain(forName: historySuite) }
    // A draft build could have written legacy hashes to the mixed-format key.
    historyDefaults.set(["legacy-existing"], forKey: "aimCompanionAttentionSeen")
    var history = AIMCompanionNotificationHistory(defaults: historyDefaults)
    try check(history.observe(["legacy-existing"], sharedAttention: false).isEmpty,
              "a legacy server establishes a quiet baseline before its upgrade")
    var afterLegacyRestart = AIMCompanionNotificationHistory(defaults: historyDefaults)
    try check(afterLegacyRestart.observe(["shared-existing"], sharedAttention: true).isEmpty,
              "first shared queue stays quiet after a persisted legacy baseline and restart")
    try check(afterLegacyRestart.observe(["shared-existing", "shared-new"], sharedAttention: true) == ["shared-new"],
              "new shared attention notifies after its own quiet baseline")
    try check(afterLegacyRestart.observe(["legacy-existing"], sharedAttention: false).isEmpty,
              "temporary legacy fallback preserves the legacy baseline")
    try check(afterLegacyRestart.observe(["legacy-existing", "legacy-new"], sharedAttention: false) == ["legacy-new"],
              "new fallback attention still notifies independently")
    var afterSharedRestart = AIMCompanionNotificationHistory(defaults: historyDefaults)
    try check(afterSharedRestart.observe(["shared-existing", "shared-new"], sharedAttention: true).isEmpty,
              "shared dedupe survives fallback and restart")
    try check(afterSharedRestart.observe(["legacy-existing", "legacy-new"], sharedAttention: false).isEmpty,
              "legacy dedupe survives a shared queue and restart")
    var navigation = AIMPanelNavigation(page: "People")
    navigation.openSettings(); navigation.openSettings()
    try check(navigation.page == "Settings" && !navigation.escape() && navigation.page == "People", "Settings Escape preserves the prior view even after repeated open")
    try check(navigation.escape(), "main Escape requests hiding without mutating navigation")
    navigation.select("Help"); navigation.openSettings(); _ = navigation.escape()
    try check(navigation.page == "Help", "each Settings visit returns to the latest selected view")
    // Edition configuration: a stock build has none, and nothing unsafe survives validation.
    let searchEdition = AIMEditionConfig(info: ["AIMShellEdition": 1, "AIMBoardURL": "https://example.com/desk/?command=old&view=old&lab=test#stale"])
    try check(searchEdition.sharedSearchURL?.absoluteString == "https://example.com/desk/?lab=test&view=mesh&command=search", "owner search preserves mount and replaces routing")
    try check(searchEdition.teamDirectoryURL?.absoluteString == "https://example.com/desk/team", "team directory keeps the HTTPS board mount and removes query and fragment")
    var changedBoard = searchEdition
    changedBoard.boardURL = URL(string: "http://example.com/desk/")
    try check(changedBoard.teamDirectoryURL == nil && changedBoard.sharedSearchURL == nil,
              "directory and search refuse an HTTP URL even after public config mutation")
    changedBoard.boardURL = URL(string: "https://user:password@example.com/desk/?token=secret#old")
    try check(changedBoard.teamDirectoryURL == nil, "team directory never opens a credential-bearing URL")
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
    var attentionObject = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    let attentionItem: [String: Any] = ["id":"topic:q", "peer":"agent-demo", "kind":"owner", "title":"Synthetic decision", "date":"2026-09-29T15:00:00Z", "next_action":"Review source", "source_ids":["source-demo"], "conversation":"dm:agent-demo:agent-self", "actionable":true, "alert":true]
    attentionObject["attention"] = ["schema":1, "receipts_ok":true, "items":[attentionItem]]
    let attentionValue = try AIMCompanionSnapshot.decode(JSONSerialization.data(withJSONObject: attentionObject))
    try check(attentionValue.attentionCount == 1 && attentionValue.attentionKeys.count == 1, "shared attention replaces raw incoming counts")
    var classifiedAttentionItems: [[String: Any]] = []
    for (kind, label) in [("owner", "Your reply or decision"), ("agent", "Assistant action needed"),
                          ("peer", "Waiting for people"), ("verify", "Needs verification"), ("delivery", "Delivery failed")] {
        var item = attentionItem; item["kind"] = kind; item["id"] = "synthetic-" + kind
        item["actionable"] = !["peer", "verify"].contains(kind)
        classifiedAttentionItems.append(item)
        attentionObject["attention"] = ["schema":1, "receipts_ok":true, "items":[item]]
        let decoded = try AIMCompanionSnapshot.decode(JSONSerialization.data(withJSONObject: attentionObject))
        try check(decoded.attention?.items.first?.kindLabelKey == label, "attention label preserves responsibility: " + kind)
    }
    attentionObject["attention"] = ["schema":1, "receipts_ok":true, "items":classifiedAttentionItems]
    let groupedAttention = try AIMCompanionSnapshot.decode(JSONSerialization.data(withJSONObject: attentionObject)).attention!
    try check(groupedAttention.peerWaits.map(\.kind) == ["peer"] && groupedAttention.verificationItems.map(\.kind) == ["verify"],
              "waiting for a peer stays separate from verification and actionable work")
    try check(groupedAttention.yourTurn.map(\.kind) == ["owner"] && Set(groupedAttention.otherUpdates.map(\.kind)) == ["agent", "delivery"],
              "technical failures and agent work never masquerade as owner decisions")
    let groupedSnapshot = try AIMCompanionSnapshot.decode(JSONSerialization.data(withJSONObject: attentionObject))
    try check(groupedSnapshot.ownerAttentionCount == 1 && groupedSnapshot.technicalAttentionCount == 2,
              "menu separates owner decisions from technical work")
    try check(groupedSnapshot.notificationKeys(owner: true, technical: false) == Set(classifiedAttentionItems.filter { $0["kind"] as? String == "owner" }.map { "attention:\($0["id"]!):owner:source-demo" }),
              "owner-only notifications exclude assistant and delivery issues")
    try check(groupedSnapshot.notificationKeys(owner: false, technical: true).isDisjoint(with: groupedSnapshot.notificationKeys(owner: true, technical: false)),
              "technical notification scope does not include owner decisions")
    try check(groupedSnapshot.notificationKeys(owner: false, technical: false).isEmpty,
              "turning both categories off emits no notification keys")
    var recentVerification = attentionItem
    recentVerification["kind"] = "verify"; recentVerification["id"] = "unreviewed_inbound:synthetic"
    let verificationObject = attentionObject.merging(["attention": ["schema": 1, "receipts_ok": true, "items": [recentVerification]]]) { _, new in new }
    let verificationSnapshot = try AIMCompanionSnapshot.decode(JSONSerialization.data(withJSONObject: verificationObject))
    try check(verificationSnapshot.ownerAttentionCount == 0 && verificationSnapshot.technicalAttentionCount == 1
              && verificationSnapshot.notificationKeys(owner: false, technical: true).count == 1,
              "recent unclassified incoming can alert for verification without becoming an owner obligation")
    var contactObject = attentionObject
    contactObject["people"] = [["id":"person:demo", "name":"Synthetic contact", "agents":["agent-other", "agent-demo"],
                               "writable_agents":["agent-other", "agent-demo"]]]
    let contacts = try AIMCompanionSnapshot.decode(JSONSerialization.data(withJSONObject: contactObject))
    let contact = contacts.people[0]
    try check(contacts.contactAttention(for: contact).map(\.kind) == ["owner", "delivery", "agent"],
              "a compact contact prioritizes actionable work without counting waiting or historical review")
    try check(contacts.communicationPeer(for: contact) == "agent-demo", "Read follows the displayed work even when another agent is listed first")
    let privateEdition = AIMEditionConfig(info: ["AIMShellEdition":1, "AIMPrivatePeers":["agent-demo"]])
    try check(contacts.communicationPeer(for: contact, config: privateEdition) == nil
              && contacts.contactAttention(for: contact, config: privateEdition).isEmpty,
              "private bindings suppress contact conversation summaries and actions")
    contactObject["attention"] = ["schema":1, "receipts_ok":true, "items":[]]
    let quietContacts = try AIMCompanionSnapshot.decode(JSONSerialization.data(withJSONObject: contactObject))
    try check(quietContacts.communicationPeer(for: quietContacts.people[0]) == "agent-other",
              "a contact without attention keeps an explicit history route")
    contactObject["people"] = [["id":"person:demo", "name":"Synthetic contact", "agents":["agent-demo"], "contact_state":"status_only"]]
    let statusContacts = try AIMCompanionSnapshot.decode(JSONSerialization.data(withJSONObject: contactObject))
    try check(statusContacts.communicationPeer(for: statusContacts.people[0]) == nil,
              "status-only contacts never open a conversation reader")
    var unknownItem = attentionItem; unknownItem["kind"] = "unknown"
    attentionObject["attention"] = ["schema":1, "receipts_ok":true, "items":[unknownItem]]
    do { _ = try AIMCompanionSnapshot.decode(JSONSerialization.data(withJSONObject: attentionObject)); throw CheckFailure(message: "unknown attention kind accepted") }
    catch is CocoaError {}
    var changedTitle = attentionItem; changedTitle["title"] = "Renamed synthetic decision"
    attentionObject["attention"] = ["schema":1, "receipts_ok":true, "items":[changedTitle]]
    let renamedAttention = try AIMCompanionSnapshot.decode(JSONSerialization.data(withJSONObject: attentionObject))
    try check(renamedAttention.attentionKeys == attentionValue.attentionKeys, "editorial title changes do not notify again")
    var quietItem = attentionItem; quietItem["actionable"] = false; quietItem["alert"] = false
    attentionObject["attention"] = ["schema":1, "receipts_ok":true, "items":[quietItem]]
    let quietAttention = try AIMCompanionSnapshot.decode(JSONSerialization.data(withJSONObject: attentionObject))
    try check(quietAttention.attentionCount == 0 && quietAttention.attentionKeys.isEmpty, "historical review never becomes an actionable badge")
    attentionObject["attention"] = ["schema":1, "receipts_ok":true, "items":[attentionItem, attentionItem]]
    do { _ = try AIMCompanionSnapshot.decode(JSONSerialization.data(withJSONObject: attentionObject)); throw CheckFailure(message: "duplicate attention accepted") }
    catch is CocoaError {}
    var privateItem = attentionItem; privateItem["peer"] = "agent-viola-alex"
    attentionObject["attention"] = ["schema":1, "receipts_ok":true, "items":[privateItem]]
    do { _ = try AIMCompanionSnapshot.decode(JSONSerialization.data(withJSONObject: attentionObject)); throw CheckFailure(message: "private attention accepted") }
    catch is CocoaError {}
    privateItem["peer"] = "status-only-peer"
    attentionObject["people"] = [["id":"person:private", "name":"Synthetic private person",
                                   "agents":["status-only-peer"], "contact_state":"status_only"]]
    attentionObject["attention"] = ["schema":1, "receipts_ok":true, "items":[privateItem]]
    do { _ = try AIMCompanionSnapshot.decode(JSONSerialization.data(withJSONObject: attentionObject)); throw CheckFailure(message: "status-only attention accepted") }
    catch is CocoaError {}
    attentionObject["people"] = []
    attentionObject["attention"] = ["schema":1, "receipts_ok":true, "items":(0..<201).map { index in
        var item = attentionItem; item["id"] = "topic:synthetic-\(index)"; return item
    }]
    do { _ = try AIMCompanionSnapshot.decode(JSONSerialization.data(withJSONObject: attentionObject)); throw CheckFailure(message: "oversized attention accepted") }
    catch is CocoaError {}
    let oldPolicy: [String: Any] = ["revision":0,"send_allowed":true,"trust":"review_required","context":"message_only","tone":"concise","responder":"codex_app_server","wake_status":"unknown"]
    var policyEnvelope: [String: Any] = ["observed_at":"2026-10-20T05:00:00Z","peers":["agent-sample":oldPolicy]]
    let legacyPolicy = try JSONDecoder().decode(AIMPeerPolicySnapshot.self, from: JSONSerialization.data(withJSONObject: policyEnvelope))
    try check(legacyPolicy.peers["agent-sample"]?.reply_mode == nil, "older server policy remains readable")
    try check(legacyPolicy.peers["agent-sample"]?.incomingLabelKey == "Incoming mode not observed" && legacyPolicy.peers["agent-sample"]?.canEditIncoming == false,
              "a missing mode never promises auto replies or enables an unsafe save")
    var restricted = oldPolicy; restricted["reply_mode"] = "manual"
    policyEnvelope["peers"] = ["agent-sample":restricted]
    let manualPolicy = try JSONDecoder().decode(AIMPeerPolicySnapshot.self, from: JSONSerialization.data(withJSONObject: policyEnvelope))
    try check(manualPolicy.peers["agent-sample"]?.reply_mode == "manual", "manual admission restriction survives the native contract")
    try check(manualPolicy.peers["agent-sample"]?.incomingLabelKey == "Manual review only" && manualPolicy.peers["agent-sample"]?.canEditIncoming == true,
              "known manual mode remains explicit and editable")
    var capabilityObject = object
    capabilityObject["people"] = [["id":"person:sample", "name":"Synthetic contact", "agents":["agent-sample"], "writable_agents":["agent-sample"]]]
    capabilityObject["owner_threads"] = [String: Any]()
    capabilityObject["peer_policy"] = ["observed_at":"2026-09-29T17:00:00Z", "peers":["agent-sample":restricted]]
    func capabilitySnapshot() throws -> AIMCompanionSnapshot { try AIMCompanionSnapshot.decode(JSONSerialization.data(withJSONObject: capabilityObject)) }
    var access = try capabilitySnapshot()
    try check(access.connectionSending(for: access.people[0], current: true, now: now) == .allowed,
              "sending requires both an observed writable route and explicit fresh permission")
    try check(access.connectionSending(for: access.people[0], current: false, now: now) == .unknown,
              "a retained or failed snapshot never promises permission")
    var sendBlocked = restricted; sendBlocked["send_allowed"] = false
    capabilityObject["peer_policy"] = ["observed_at":"2026-09-29T17:00:00Z", "peers":["agent-sample":sendBlocked]]
    access = try capabilitySnapshot()
    try check(access.connectionSending(for: access.people[0], current: true, now: now) == .blocked, "an explicit sending restriction stays visible")
    capabilityObject["peer_policy"] = ["observed_at":"2026-09-29T16:00:00Z", "peers":["agent-sample":restricted]]
    access = try capabilitySnapshot()
    try check(access.connectionSending(for: access.people[0], current: true, now: now) == .unknown, "a fresh envelope cannot upgrade a stale policy")
    capabilityObject["peer_policy"] = ["observed_at":"2026-09-29T17:00:00Z", "peers":[String: Any]()]
    access = try capabilitySnapshot()
    try check(access.connectionSending(for: access.people[0], current: true, now: now) == .unknown, "a listed route alone grants no sending permission")
    var noResponder = restricted; noResponder["responder"] = "none"; noResponder["trust"] = "trusted_contact"
    capabilityObject["peer_policy"] = ["observed_at":"2026-09-29T17:00:00Z", "peers":["agent-sample":noResponder]]
    access = try capabilitySnapshot()
    try check(access.connectionSending(for: access.people[0], current: true, now: now) == .allowed && access.peer_policy?.peers["agent-sample"]?.incomingLabelKey == "Manual review only",
              "sending permission is independent of responder assignment, incoming mode and trust")
    capabilityObject["people"] = [["id":"person:sample", "name":"Synthetic contact", "agents":["agent-sample"], "writable_agents":[String]()]]
    access = try capabilitySnapshot()
    try check(access.connectionSending(for: access.people[0], current: true, now: now) == .blocked, "explicitly absent writable route blocks sending")
    capabilityObject["people"] = [["id":"person:sample", "name":"Synthetic contact", "agents":["agent-sample"]]]
    access = try capabilitySnapshot()
    try check(access.connectionSending(for: access.people[0], current: true, now: now) == .unknown, "missing route observation remains unknown")
    capabilityObject["people"] = [["id":"person:sample", "name":"Synthetic private", "agents":["agent-sample"], "contact_state":"status_only", "writable_agents":["agent-sample"]]]
    access = try capabilitySnapshot()
    try check(access.connectionSending(for: access.people[0], current: true, now: now) == .statusOnly && access.firstAllowedConnection(for: access.people[0], current: true) == nil,
              "status-only overrides a contradictory route and permission")
    capabilityObject["people"] = [["id":"person:sample", "name":"Synthetic private", "agents":["shaper-viola"], "writable_agents":["shaper-viola"]]]
    access = try capabilitySnapshot()
    try check(access.connectionSending(for: access.people[0], current: true, now: now) == .statusOnly && access.communicationPeer(for: access.people[0]) == nil,
              "canonical private identities stay status-only when an old edition omits private settings")
    func observedFlow(_ scope: String?, count: Int, source: String? = "2026-09-29T17:00:00Z") throws -> AIMCompanionSnapshot.Person.Flow {
        var row: [String: Any] = ["inbound_count":count,"outbound_count":count]
        row["scope"] = scope; row["source_at"] = source
        return try JSONDecoder().decode(AIMCompanionSnapshot.Person.Flow.self, from: JSONSerialization.data(withJSONObject: row))
    }
    try check(try observedFlow("retained_snapshot", count: 0).observedCount(inbound: true) == 0,
              "a complete source receipt preserves observed zero")
    try check(try observedFlow("partial_retained_snapshot", count: 0).observedCount(inbound: true) == nil,
              "partial or failed sources cannot establish a zero")
    try check(try observedFlow("partial_retained_snapshot", count: 4).observedCount(inbound: false) == 4,
              "partial retained sources preserve their positive observations")
    try check(try observedFlow(nil, count: 0).observedCount(inbound: true) == nil,
              "an unobserved scope cannot establish a zero")
    try check(try observedFlow("retained_snapshot", count: 4, source: nil).observedCount(inbound: true) == nil,
              "a missing source timestamp leaves the count unobserved")
    try check(legacyPolicy.peers["agent-sample"]?.sharingLabelKey == "Written message only", "message-only policy has an explicit sharing label")
    var briefPolicy = restricted; briefPolicy["context"] = "approved_brief"
    let briefValue = try JSONDecoder().decode(AIMPeerPolicySnapshot.Policy.self, from: JSONSerialization.data(withJSONObject: briefPolicy))
    try check(briefValue.sharingLabelKey == "Approved brief · choose per send", "brief approval never implies automatic attachment")
    let unboundPortrait = try JSONDecoder().decode(AIMCompanionSnapshot.Person.self, from: JSONSerialization.data(withJSONObject: [
        "id":"person:demo", "name":"Synthetic unbound", "agents":[String](), "contact_state":"unlinked",
        "photo":"/mesh-comms-avatar-demo.jpg", "photo_privacy":"owner-approved-avatar"]))
    try check(unboundPortrait.approvedPhoto(in: edition) != nil && unboundPortrait.writable_agents == nil,
              "an approved current unbound portrait grants no message route")
    let privatePortrait = try JSONDecoder().decode(AIMCompanionSnapshot.Person.self, from: JSONSerialization.data(withJSONObject: [
        "id":"person:demo", "name":"Synthetic private", "agents":[String](), "contact_state":"status_only",
        "photo":"/mesh-comms-avatar-demo.jpg", "photo_privacy":"owner-approved-avatar"]))
    try check(privatePortrait.approvedPhoto(in: edition) == nil, "explicit status-only denies even an approved unbound portrait")
    capabilityObject["people"] = [["id":"person:sample", "name":"Synthetic multi-agent", "agents":["agent-one","agent-two"],
        "writable_agents":["agent-one","agent-two"], "flows":[
            "agent-one":["inbound_count":3,"outbound_count":0,"scope":"retained_snapshot","source_at":"2026-09-29T17:00:00Z"],
            "agent-two":["inbound_count":5,"outbound_count":0,"scope":"retained_snapshot","source_at":"2026-09-29T17:00:00Z"]]]]
    capabilityObject["peer_policy"] = ["observed_at":"2026-09-29T17:00:30Z", "peers":["agent-one":sendBlocked,"agent-two":restricted]]
    access = try capabilitySnapshot()
    try check(access.connectionSending(for: access.people[0], current: true, now: now) == .allowed,
              "a fresher policy than the retained envelope is evaluated against the current clock")
    try check(access.connectionSending(for: access.people[0], agent: "agent-one", current: true, now: now) == .blocked,
              "one allowed assistant does not upgrade a blocked sibling")
    try check(access.connectionCount(for: access.people[0], inbound: true).count == 8 && !access.connectionCount(for: access.people[0], inbound: true).partial,
              "a person keeps aggregate observed counts across multiple assistant routes")
    try check(access.connectionCount(for: access.people[0], inbound: false).count == 0,
              "complete observed zero aggregates across every assistant route")
    var partialPeople = capabilityObject["people"] as! [[String: Any]]
    partialPeople[0]["flows"] = ["agent-one":["inbound_count":3,"scope":"retained_snapshot","source_at":"2026-09-29T17:00:00Z"]]
    capabilityObject["people"] = partialPeople; access = try capabilitySnapshot()
    try check(access.connectionCount(for: access.people[0], inbound: true).count == 3 && access.connectionCount(for: access.people[0], inbound: true).partial,
              "a missing route makes an aggregate positive count a lower bound")
    try check(access.connectionCount(for: access.people[0], inbound: false).count == nil,
              "a missing direction never fabricates aggregate zero")
    capabilityObject["peer_policy"] = ["observed_at":"2026-09-29T17:01:01Z", "peers":["agent-one":restricted,"agent-two":restricted]]
    access = try capabilitySnapshot()
    try check(access.connectionSending(for: access.people[0], current: true, now: now) == .unknown,
              "a future policy reading remains unknown")
    return 95 + (try runPrivateMetadataChecks())
}


private func runPrivateMetadataChecks() throws -> Int {
    var checks = 0
    func need(_ condition: Bool, _ label: String) throws {
        try check(condition, label); checks += 1
    }
    let link = "codex://threads/00000000-0000-4000-8000-000000000001"
    var contour: [String: Any] = ["id":"private-test", "name":"Synthetic private", "privacy":"status-only",
        "source_at":"2026-10-21T09:00:00Z", "source_age_seconds":30, "source_fresh":true,
        "work_status":"in_progress", "work_code":"materials_verified_continuity_in_progress",
        "work_at":"2026-10-21T08:00:00Z", "owner_thread":["title":"Synthetic owner", "url":link]]
    var object: [String: Any] = [
        "schema":"aim.murmur.companion/1", "privacy":"owner-metadata", "fresh":true,
        "people":[["id":"person:private", "name":"Synthetic", "agents":["agent-synthetic"],
                   "contact_state":"status_only", "contour":["id":"private-test"]]],
        "questions":[], "incoming":[], "pending_count":0, "decision_count":0, "budget":[:],
        "owner_mode":"native_server", "transport":"active", "responder":"active",
        "server_version":"2.12.0", "responder_model":"Codex"]
    func decode() throws -> AIMCompanionSnapshot {
        object["private_contours"] = [contour]
        return try AIMCompanionSnapshot.decode(JSONSerialization.data(withJSONObject: object))
    }
    var snapshot = try decode(), item = snapshot.private_contours![0]
    try need(item.source_at == "2026-10-21T09:00:00Z" && item.source_age_seconds == 30
             && item.work_at == "2026-10-21T08:00:00Z", "private health and work preserve separate observation dates")
    try need(item.owner_thread?.verifiedURL?.absoluteString == link, "private owner uses the exact verified URL")
    try need(item.processor_location == nil && item.processorLocationLabelKey == nil,
             "older private projection makes no processor location claim")
    contour["processor_location"] = "local_mac"; item = try decode().private_contours![0]
    try need(item.processor_location == "local_mac" && item.processorLocationLabelKey == "Private handler · this Mac",
             "verified local Mac processor has a fixed location label")
    contour["processor_location"] = "untrusted private location"; item = try decode().private_contours![0]
    try need(item.processorLocationLabelKey == nil, "unknown private processor location is never displayed")
    contour.removeValue(forKey:"processor_location")
    try need(snapshot.privateContour(for: snapshot.people[0])?.id == "private-test", "private person maps by exact contour ID")
    try need(snapshot.communicationPeer(for: snapshot.people[0]) == nil
             && snapshot.connectionSending(for: snapshot.people[0], current:true) == .statusOnly
             && snapshot.contactAttention(for: snapshot.people[0]).isEmpty,
             "private owner route grants no ordinary Read, Write or attention")
    try need(item.workStatusLabelKey == "Work in progress" && item.workDetailLabelKey ==
             "Materials verified; processing resilience and post-restart verification", "known private work has safe presentation")
    for (status, label) in [("blocked","Work blocked"),("needs_verification","Work needs verification"),("complete","Work complete"),("awaiting_fresh_inbound","Awaiting fresh incoming after restart"),("arbitrary private text","Work status unknown")] {
        contour["work_status"] = status; item = try decode().private_contours![0]
        try need(item.workStatusLabelKey == label, "private status vocabulary is bounded: " + status)
    }
    contour["work_code"] = "arbitrary private text"; item = try decode().private_contours![0]
    try need(item.workDetailLabelKey == nil, "unknown private work code never becomes displayed text")
    try need(item.sourceFreshnessLabelKey(snapshotCurrent:true) == "Source fresh"
             && item.sourceFreshnessLabelKey(snapshotCurrent:false) == "Source stale", "stale envelope cannot promote source freshness")
    contour["source_fresh"] = false; item = try decode().private_contours![0]
    try need(item.sourceFreshnessLabelKey(snapshotCurrent:true) == "Source stale", "server stale flag survives a current envelope")
    contour.removeValue(forKey:"source_age_seconds"); item = try decode().private_contours![0]
    try need(item.sourceFreshnessLabelKey(snapshotCurrent:true) == "Source freshness unknown", "missing private age remains unknown")
    contour["source_age_seconds"] = 30; contour["source_at"] = "bad"; item = try decode().private_contours![0]
    try need(item.sourceFreshnessLabelKey(snapshotCurrent:true) == "Source freshness unknown", "bad source date remains unknown")
    contour.removeValue(forKey:"owner_thread"); item = try decode().private_contours![0]
    try need(item.owner_thread == nil, "older private projection does not invent an owner route")
    for url in ["https://example.com", "codex://threads/not-a-uuid", link + "/extra", link + "?x=1", link + "#fragment",
                "codex://user@threads/00000000-0000-4000-8000-000000000001", "codex://threads:99/00000000-0000-4000-8000-000000000001",
                "codex://threads/%300000000-0000-4000-8000-000000000001"] {
        contour["owner_thread"] = ["title":"Synthetic", "url":url]
        do { _ = try decode(); throw CheckFailure(message:"unsafe private owner URL accepted: " + url) }
        catch is CocoaError { checks += 1 }
    }
    contour.removeValue(forKey:"owner_thread"); contour["source_age_seconds"] = -1
    do { _ = try decode(); throw CheckFailure(message:"negative private source age accepted") }
    catch is CocoaError { checks += 1 }
    contour.removeValue(forKey:"source_age_seconds")
    object["people"] = [["id":"person:other", "name":"Same name", "agents":[], "contact_state":"status_only", "contour":["id":"different"]]]
    snapshot = try decode()
    try need(snapshot.privateContour(for:snapshot.people[0]) == nil, "unmapped private contact does not borrow another contour owner")
    return checks
}
