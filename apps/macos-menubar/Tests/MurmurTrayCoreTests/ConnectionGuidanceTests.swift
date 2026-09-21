import Foundation
import MurmurTrayCore

func runConnectionGuidanceChecks(fixtures: URL) throws -> Int {
    let preferences = UserDefaults.standard
    let previous = preferences.object(forKey: "interfaceLanguage")
    defer {
        if let previous { preferences.set(previous, forKey: "interfaceLanguage") }
        else { preferences.removeObject(forKey: "interfaceLanguage") }
    }
    var count = 0
    for language in AppLanguage.allCases {
        L10n.select(language)
        let checking = ConnectionGuidance.profileLabel(agentID: nil, hasStatus: false, checking: true)
        let failed = ConnectionGuidance.profileLabel(agentID: nil, hasStatus: false, checking: false)
        try check(checking != failed, "Completed failure must not remain a checking label: \(language)")
        try check(ConnectionGuidance.profileLabel(agentID: "previous-id", hasStatus: false, checking: false) == failed,
                  "A retained pinned ID must not masquerade as a fresh verified connection")
        try check(ConnectionGuidance.profileLabel(agentID: "current-id", hasStatus: true, checking: true) == "current-id",
                  "A background refresh must not replace an available identity with a first-run spinner")
        count += 3

        let raw = try Data(contentsOf: fixtures.appendingPathComponent("doctor-broker-fail.json"))
        var object = try JSONSerialization.jsonObject(with: raw) as! [String: Any]
        object["generatedAt"] = ISO8601DateFormatter().string(from: Date())
        let doctor = try DoctorSnapshot.decode(JSONSerialization.data(withJSONObject: object))
        let summary = ConnectionGuidance.diagnosticSummary(doctor)
        try check(summary.title == L10n.text("The server refused access"),
                  "An authorization refusal must not be presented as an internet outage")
        try check(!summary.message.contains("blocked-by:") && !summary.message.contains("broker."),
                  "Protocol details should stay out of the primary explanation")
        try check(doctor.rows().contains(where: { $0.state == "skip" && $0.detail.contains("blocked-by:broker") }),
                  "Technical details must remain available after adding a friendly summary")
        count += 3

        var stages = DoctorSnapshot.stageIDs.map { id in
            ["id": id, "state": "skip", "detail": "blocked", "reason": "blocked-by:config"]
        }
        stages[0] = ["id": "config", "state": "fail", "detail": "config.missing"]
        object["stages"] = stages
        let missing = try DoctorSnapshot.decode(JSONSerialization.data(withJSONObject: object))
        try check(ConnectionGuidance.diagnosticSummary(missing).title == L10n.text("This folder has no Murmur settings"),
                  "The missing-folder case needs a recovery explanation")
        stages[0]["detail"] = "synthetic-secret-do-not-display"
        object["stages"] = stages
        let unsafe = ConnectionGuidance.diagnosticSummary(try DoctorSnapshot.decode(JSONSerialization.data(withJSONObject: object)))
        try check(!unsafe.title.contains("synthetic-secret") && !unsafe.message.contains("synthetic-secret"),
                  "Unknown diagnostic payload must not leak into the friendly summary")
        count += 2

        object["stages"] = DoctorSnapshot.stageIDs.map { ["id": $0, "state": "ok", "detail": "ok"] }
        let complete = ConnectionGuidance.diagnosticSummary(try DoctorSnapshot.decode(JSONSerialization.data(withJSONObject: object)))
        try check(complete.message == L10n.text("These checks do not prove that an AI assistant has replied. Ask your assistant to send a test message and wait for the answer."),
                  "All doctor steps passing must not be presented as a real AI reply")
        object["stages"] = [["id": "config", "state": "ok", "detail": "ok"]]
        let partial = ConnectionGuidance.diagnosticSummary(try DoctorSnapshot.decode(JSONSerialization.data(withJSONObject: object)))
        try check(partial.title == L10n.text("Some checks are still unconfirmed"), "A partial response is not complete")
        count += 2
        print("PASS connection guidance: \(language.rawValue), 10 checks")
    }
    return count
}
