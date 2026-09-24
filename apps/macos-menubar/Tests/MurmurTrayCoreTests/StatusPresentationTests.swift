import Foundation
import MurmurTrayCore

private func presentationEdited(_ path: [String], value: Any, object: [String: Any]) -> [String: Any] {
    var result = object
    if path.count == 1 { result[path[0]] = value }
    else {
        result[path[0]] = presentationEdited(Array(path.dropFirst()), value: value,
                                              object: result[path[0]] as! [String: Any])
    }
    return result
}

private func inLanguage<T>(_ language: AppLanguage, _ body: () throws -> T) rethrows -> T {
    let preferences = UserDefaults.standard
    let previous = preferences.object(forKey: "interfaceLanguage")
    L10n.select(language, in: preferences)
    defer {
        if let previous { preferences.set(previous, forKey: "interfaceLanguage") }
        else { preferences.removeObject(forKey: "interfaceLanguage") }
    }
    return try body()
}

func runStatusPresentationChecks(fixtures: URL, base: [String: Any], now: Date) throws -> Int {
    let presentation = fixtures.deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("presentation")
    let contractURL = presentation.appendingPathComponent("status-reasons.json")
    let fixturesURL = presentation.appendingPathComponent("status-reasons-fixtures.json")
    let contract = try JSONSerialization.jsonObject(with: Data(contentsOf: contractURL)) as! [String: Any]
    let fixtureContract = try JSONSerialization.jsonObject(with: Data(contentsOf: fixturesURL)) as! [String: Any]
    try check(contract["schema"] as? String == "murmur.status-presentation/1", "Shared status-presentation schema")
    try check(fixtureContract["schema"] as? String == "murmur.status-presentation-fixtures/1", "Shared presentation-fixture schema")
    let messages = contract["messages"] as! [String: [String: String]]
    let exposure = contract["exposure"] as! [String: Any]
    try check((exposure["displayedReasonAllows"] as? [String])?.isEmpty == true,
              "Displayed status reasons must not expose diagnostic values")
    try check(Set(exposure["diagnosticsRetain"] as? [String] ?? []).isSuperset(of: ["rawError", "missing", "missingWhy"]),
              "Diagnostics must retain raw errors and Missing metadata")
    try check(exposure["onlyPeerPairingFieldPattern"] as? String == "^peers\\.list\\.[^.]+\\.paired$",
              "Pairing-only selector must match the shared exposure contract")
    var count = 5

    // Status.swift looks reasons up by these source keys; the shared contract carries
    // the displayed text, which follows contracts/vocabulary.md and may differ from the key.
    let sourceKeys = [
        "status.ready": "Service connected and ready",
        "status.pairingUnknown": "Pairing has not been checked yet — run a check",
        "status.schema": "The status response format is not supported — copy diagnostics for details",
        "status.unavailable": "Status is unavailable — copy diagnostics for details",
        "status.unmeasured": "Some status details were not measured — run a check",
        "status.unpaired": "Pairing is not confirmed — run a check",
        "status.wakeFault": "Wake failed — copy diagnostics for details",
    ]
    for (id, message) in messages.sorted(by: { $0.key < $1.key }) {
        guard let english = message["en"], let russian = message["ru"] else {
            throw CheckFailure(message: "Missing shared presentation translation: \(id)")
        }
        guard let key = sourceKeys[id] else {
            throw CheckFailure(message: "Shared presentation message has no source key: \(id)")
        }
        try check(L10n.localized(key, language: .english) == english,
                  "English catalog differs from shared presentation text: \(id)")
        try check(L10n.localized(key, language: .russian) == russian,
                  "Russian catalog differs from shared presentation text: \(id)")
        print("PASS status presentation catalogs: \(id)"); count += 1
    }

    let cases = fixtureContract["cases"] as! [[String: Any]]
    for item in cases {
        let name = item["name"] as! String
        let relative = item["statusFixture"] as! String
        let statusURL = presentation.appendingPathComponent(relative).standardizedFileURL
        let source = try JSONSerialization.jsonObject(with: Data(contentsOf: statusURL)) as! [String: Any]
        let material = try materialized(source, now: now)
        let snapshot = try StatusSnapshot.decode(JSONSerialization.data(withJSONObject: material))
        let englishVerdict = try inLanguage(.english) { snapshot.verdict(now: now) }
        let russianVerdict = try inLanguage(.russian) { snapshot.verdict(now: now) }
        let expectedCode = item["expectedCode"] as! String
        let expectedID = item["expectedMessageId"] as! String
        let expected = messages[expectedID]!
        try check(englishVerdict.code == expectedCode && russianVerdict.code == expectedCode,
                  "\(name): status code differs from shared presentation fixture")
        try check(englishVerdict.reason == expected["en"] && russianVerdict.reason == expected["ru"],
                  "\(name): displayed reason differs from shared presentation message \(expectedID)")
        for forbidden in item["forbiddenDisplayedSubstrings"] as? [String] ?? [] {
            try check(!englishVerdict.reason.contains(forbidden) && !russianVerdict.reason.contains(forbidden),
                      "\(name): displayed reason exposes \(forbidden)")
        }
        let expectedMissing = (source["$expect"] as? [String: Any])?["missing"] as? [String] ?? []
        try check(englishVerdict.missing == expectedMissing.sorted(),
                  "\(name): diagnostic Missing changed: \(englishVerdict.missing)")
        let expectedWhy = (source["$expect"] as? [String: Any])?["missingWhy"] as? [String: String] ?? [:]
        try check(englishVerdict.missingWhy == expectedWhy, "\(name): diagnostic missingWhy changed")
        for required in item["requiredDiagnosticMissing"] as? [String] ?? [] {
            try check(englishVerdict.missing.contains(required), "\(name): diagnostics lost \(required)")
        }
        print("PASS status presentation fixture: \(name)"); count += 1
    }

    let schema = try inLanguage(.english) { Verdict.unavailable(ContractError.schema) }
    try check(schema.reason == messages["status.schema"]?["en"], "Unknown schema needs canonical safe reason")
    count += 1
    let hostileError = NSError(domain: "raw peer-agent / profile.token", code: 7,
                                userInfo: [NSLocalizedDescriptionKey: "raw peer-agent / profile.token"])
    let unavailable = try inLanguage(.english) { Verdict.unavailable(hostileError) }
    try check(unavailable.reason == messages["status.unavailable"]?["en"]
              && !unavailable.reason.contains("peer-agent") && !unavailable.reason.contains("profile.token"),
              "Unavailable status must not display raw errors")
    count += 1

    let hostileChain = try inLanguage(.english) {
        Verdict.unavailable(ContractError.doctorChain(stage: "peers.list.private-agent.paired", blocker: "private-agent"))
    }
    try check(!hostileChain.reason.contains("private-agent") && !hostileChain.reason.contains("peers.list"),
              "Unknown contract-error codes must not fall back to raw descriptions")
    count += 1

    var wakeObject = presentationEdited(["wake", "faults", "lastFault"],
                                        value: "raw peer-agent / wake.secret", object: base)
    wakeObject = presentationEdited(["wake", "faults", "lastFaultAt"],
                                    value: "2026-09-19T12:59:00Z", object: wakeObject)
    let wakeSnapshot = try StatusSnapshot.decode(JSONSerialization.data(withJSONObject: wakeObject))
    let wakeVerdict = try inLanguage(.english) { wakeSnapshot.verdict(now: now) }
    try check(wakeVerdict.reason == messages["status.wakeFault"]?["en"]
              && !wakeVerdict.reason.contains("peer-agent") && !wakeVerdict.reason.contains("wake.secret"),
              "Wake failure must display only the canonical safe reason")
    try check(wakeSnapshot.diagnosticNotes.contains(where: { $0.contains("raw peer-agent / wake.secret") }),
              "Raw wake error must remain available to diagnostics")
    count += 1

    var unpairedObject = base
    var peers = unpairedObject["peers"] as! [String: Any]
    var peerList = peers["list"] as! [[String: Any]]
    peerList[0]["paired"] = false
    peers["list"] = peerList
    unpairedObject["peers"] = peers
    let unpairedSnapshot = try StatusSnapshot.decode(JSONSerialization.data(withJSONObject: unpairedObject))
    let unpaired = try inLanguage(.english) { unpairedSnapshot.verdict(now: now) }
    try check(unpaired.code == "peers.unpaired" && unpaired.reason == messages["status.unpaired"]?["en"],
              "Unpaired status needs the canonical safe reason")
    try check(!unpaired.reason.contains(peerList[0]["agentId"] as! String),
              "Unpaired status must not display a peer ID")
    count += 1
    for (value, english, russian) in [
        (NSNull() as Any, "Exchange not checked yet", "Обмен ещё не проверен"),
        (true as Any, "Exchange verified", "Обмен проверен"),
        (false as Any, "Exchange verification failed", "Проверка обмена не пройдена")
    ] {
        let data = try JSONSerialization.data(withJSONObject: ["agentId": "agent-fixture", "paired": value])
        let peer = try JSONDecoder().decode(StatusSnapshot.Peer.self, from: data)
        try check(inLanguage(.english) { peer.exchangeDescription } == english
                  && inLanguage(.russian) { peer.exchangeDescription } == russian,
                  "Peer detail must preserve each proof state in EN/RU")
        count += 1
    }
    return count
}
