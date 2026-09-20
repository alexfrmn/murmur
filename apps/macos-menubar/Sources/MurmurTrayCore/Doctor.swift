import Foundation

public struct DoctorRow: Identifiable, Sendable {
    public let id: String
    public let title: String
    public let state: String
    public let detail: String
    public var symbol: String {
        switch state {
        case "ok": "checkmark.circle"
        case "fail": "xmark.circle"
        case "warn": "exclamationmark.triangle"
        case "skip": "minus.circle"
        default: "questionmark.circle"
        }
    }
}

public struct DoctorSnapshot: Decodable, Sendable {
    public struct Stage: Decodable, Sendable {
        public let id: String
        public let state: String
        public let detail: String
        public let reason: String?
        public let elapsedMs: Int?
    }
    public static let stageIDs = ["config", "daemon", "broker", "peers", "roundtrip", "wake"]
    public static var titles: [String] { [L10n.text("Settings"), L10n.text("Service"), L10n.text("Broker"), L10n.text("Connections"), L10n.text("Reply"), L10n.text("Agent delivery")] }
    public let schema: String
    public let generatedAt: String
    public let stages: [Stage]

    public static func decode(_ data: Data) throws -> Self {
        guard let value = try? JSONDecoder().decode(Self.self, from: data) else { throw ContractError.missingOrInvalidFields }
        guard schemaKnown(value.schema, name: "murmur.doctor") else { throw ContractError.schema }
        guard timestamp(value.generatedAt) != nil else { throw ContractError.timestamp }
        guard Set(value.stages.map(\.id)).count == value.stages.count else { throw ContractError.duplicateStage }
        let indices = value.stages.compactMap { stageIDs.firstIndex(of: $0.id) }
        guard indices.count == value.stages.count, indices == indices.sorted() else { throw ContractError.stageOrder }
        var blocker: String?
        for stage in value.stages {
            guard ["ok", "warn", "fail", "skip"].contains(stage.state) else { throw ContractError.stageState }
            if let blocker {
                guard stage.state == "skip", stage.reason == "blocked-by:\(blocker)" else {
                    throw ContractError.doctorChain(stage: stage.id, blocker: blocker)
                }
            } else if stage.state == "fail" { blocker = stage.id }
        }
        return value
    }

    public func rows() -> [DoctorRow] {
        var blocker: String?
        return Self.stageIDs.enumerated().map { index, id in
            guard let stage = stages.first(where: { $0.id == id }) else {
                return DoctorRow(id: id, title: Self.titles[index], state: "unknown", detail: L10n.text("Missing from response"))
            }
            if let blocker, stage.state != "skip" || stage.reason != "blocked-by:\(blocker)" {
                return DoctorRow(id: id, title: Self.titles[index], state: "unknown",
                                 detail: L10n.text("Invalid response: expected a skipped step after %@ failed", String(describing: (blocker))))
            }
            if stage.state == "fail" { blocker = id }
            let names = ["ok": L10n.text("Done"), "warn": L10n.text("Warning"), "fail": L10n.text("Error"), "skip": L10n.text("Skipped")]
            let state = names[stage.state] == nil ? "unknown" : stage.state
            var detail = names[stage.state] ?? L10n.text("Unknown state")
            if let ms = stage.elapsedMs { detail += L10n.text(" · %@ ms", String(describing: (ms))) }
            if state != "ok", !stage.detail.isEmpty { detail += ": " + stage.detail }
            if state == "skip", let reason = stage.reason { detail += " (\(reason))" }
            return DoctorRow(id: id, title: Self.titles[index], state: state, detail: detail)
        }
    }
}
