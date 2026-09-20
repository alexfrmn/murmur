import Foundation

public enum ContractError: Error, LocalizedError, Sendable {
    case schema, timestamp, missingOrInvalidFields, duplicateStage, stageOrder, stageState, unparsable
    case missingKeys([String]), wrongTypes([String]), invalidValue(String)
    case doctorChain(stage: String, blocker: String)

    public var code: String {
        switch self {
        case .schema: "schema.unknown"
        case .timestamp: "snapshot.unparsable"
        case .missingKeys: "schema.missing-key"
        case .wrongTypes: "schema.wrong-type"
        case .invalidValue: "schema.invalid-value"
        case .doctorChain: "doctor.invalid-chain"
        default: "schema.unparsable"
        }
    }

    public var errorDescription: String? {
        switch self {
        case .schema: L10n.text("Unknown response schema")
        case .timestamp: L10n.text("Snapshot time unknown")
        case .missingOrInvalidFields: L10n.text("Required data is missing from the response")
        case .duplicateStage: L10n.text("A diagnostic step appears more than once")
        case .stageOrder: L10n.text("Diagnostic steps are out of order")
        case .stageState: L10n.text("A diagnostic step has an unknown state")
        case .unparsable: L10n.text("Could not parse the response")
        case .missingKeys(let paths): L10n.text("Required response fields are missing: ") + paths.joined(separator: ", ")
        case .wrongTypes(let paths): L10n.text("Response fields have the wrong type: ") + paths.joined(separator: ", ")
        case .invalidValue(let path): L10n.text("A counter cannot be negative: ") + path
        case .doctorChain(let stage, let blocker): L10n.text("Invalid diagnostics: step %@ must be skipped after %@ failed", String(describing: (stage)), String(describing: (blocker)))
        }
    }
}

public func timestamp(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: value) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: value)
}

public func schemaKnown(_ value: String, name: String) -> Bool {
    let parts = value.split(separator: "/", omittingEmptySubsequences: false)
    guard parts.count == 2, parts[0] == name else { return false }
    let version = parts[1].split(separator: ".", omittingEmptySubsequences: false)
    guard version.first == "1", version.count <= 2 else { return false }
    return version.count == 1 || (!version[1].isEmpty && version[1].utf8.allSatisfy { $0 >= 48 && $0 <= 57 })
}

public struct Verdict: Sendable {
    public let indicator: Indicator
    public let unread: Bool
    public let code: String
    public let missing: [String]
    public let missingWhy: [String: String]
    public let reason: String
    public init(_ indicator: Indicator, unread: Bool = false, code: String = "status.unavailable",
                missing: [String] = [], missingWhy: [String: String] = [:], reason: String) {
        self.indicator = indicator; self.unread = unread; self.code = code
        self.missing = missing; self.missingWhy = missingWhy; self.reason = reason
    }
    public static func unavailable(_ error: any Error) -> Self {
        // Invalid responses cannot supply even an unread indicator.
        let code = (error as? ContractError)?.code ?? "status.unavailable"
        return Verdict(.unknown, code: code,
                       reason: StatusReason.displayed(code: code, missing: [], fallback: L10n.text("Status is unavailable — copy diagnostics for details")))
    }
    public var color: String {
        switch indicator {
        case .ready, .unread: "green"
        case .failed: "red"
        case .offline: "yellow"
        default: "grey"
        }
    }
}

/// Shared status-presentation selection. Protocol diagnostics stay in `missing`,
/// `missingWhy`, and `diagnosticNotes`; the menu reason never interpolates them.
private enum StatusReason {
    private static let messages = [
        "status.pairingUnknown": "Pairing has not been checked yet — run a check",
        "status.schema": "The status response format is not supported — copy diagnostics for details",
        "status.unavailable": "Status is unavailable — copy diagnostics for details",
        "status.unmeasured": "Some status details were not measured — run a check",
        "status.unpaired": "Pairing is not confirmed — run a check",
        "status.wakeFault": "Wake failed — copy diagnostics for details",
    ]

    private static func isPeerPairingField(_ path: String) -> Bool {
        let fields = path.split(separator: ".", omittingEmptySubsequences: false)
        return fields.count == 4 && fields[0] == "peers" && fields[1] == "list"
            && !fields[2].isEmpty && fields[3] == "paired"
    }

    private static func messageID(code: String, missing: [String]) -> String? {
        switch code {
        case "status.unavailable", "schema.unparsable", "schema.missing-key", "schema.wrong-type", "schema.invalid-value":
            return "status.unavailable"
        case "schema.unknown": return "status.schema"
        case "wake.fault": return "status.wakeFault"
        case "peers.unpaired": return "status.unpaired"
        case "unmeasured":
            return !missing.isEmpty && missing.allSatisfy(isPeerPairingField)
                ? "status.pairingUnknown" : "status.unmeasured"
        default: return nil
        }
    }

    static func displayed(code: String, missing: [String], fallback: String) -> String {
        guard let id = messageID(code: code, missing: missing), let key = messages[id] else { return fallback }
        return L10n.text(key)
    }
}

/// Frozen consumer contract 44b882d, packet one. Unknown measurements never imply success.
public struct StatusSnapshot: Decodable, Sendable {
    public struct Service: Decodable, Sendable {
        public enum State: String, Decodable, Sendable { case running, stopped, failed, unknown }
        public let state: State?
        public let restartCount: Int?, restartWindowMs: Int?, restartsLastHour: Int?
        public let lastFailureAt: String?, lastExitCode: Int?
    }
    public struct Broker: Decodable, Sendable {
        public enum State: String, Decodable, Sendable { case connected, disconnected, unauthorized, unknown }
        public let state: State?
        public let lastError: String?, lastErrorAt: String?
    }
    public struct Peer: Decodable, Sendable { public let agentId: String; public let paired: Bool? }
    public struct Peers: Decodable, Sendable { public let list: [Peer]?; public let unknownReason: String? }
    public struct Inbox: Decodable, Sendable { public let unread: Int?; public let unknownReason: String? }
    public struct Outbox: Decodable, Sendable {
        public struct Queue: Decodable, Sendable { public let failed: Int?, dlq: Int?; public let unknownReason: String? }
        public struct Faults: Decodable, Sendable { public let lastError: String?, lastErrorAt: String?, unknownReason: String? }
        public let queue: Queue
        public let faults: Faults
        private enum CodingKeys: String, CodingKey { case queue, faults }
        public init(from decoder: Decoder) throws {
            let fields = try decoder.container(keyedBy: CodingKeys.self)
            queue = try fields.decode(Queue.self, forKey: .queue)
            faults = try fields.decodeIfPresent(Faults.self, forKey: .faults)
                ?? Faults(lastError: nil, lastErrorAt: nil, unknownReason: nil)
        }
    }
    public struct Wake: Decodable, Sendable {
        public struct Config: Decodable, Sendable {
            public let enabled: Bool?
            public let mode: String?, responder: String?, unknownReason: String?
        }
        public struct Effective: Decodable, Sendable {
            public let enabled: Bool?, needsRestart: Bool?
            public let observedAt: String?, unknownReason: String?
        }
        public struct Delivery: Decodable, Sendable {
            public let pendingUndelivered: Int?, storedOnly: Int?
            public let lastDeliveredAt: String?, unknownReason: String?
        }
        public struct Faults: Decodable, Sendable { public let lastFault: String?, lastFaultAt: String?, unknownReason: String? }
        public let config: Config, effective: Effective, delivery: Delivery, faults: Faults
        private enum CodingKeys: String, CodingKey { case config, effective, delivery, faults }
        public init(from decoder: Decoder) throws {
            let fields = try decoder.container(keyedBy: CodingKeys.self)
            config = try fields.decode(Config.self, forKey: .config)
            delivery = try fields.decode(Delivery.self, forKey: .delivery)
            faults = try fields.decode(Faults.self, forKey: .faults)
            effective = try fields.decodeIfPresent(Effective.self, forKey: .effective)
                ?? Effective(enabled: nil, needsRestart: nil, observedAt: nil, unknownReason: nil)
        }
    }
    public let schema: String, generatedAt: String
    public let agentId: String?
    public let service: Service, broker: Broker, peers: Peers, inbox: Inbox, outbox: Outbox, wake: Wake

    public static func decode(_ data: Data) throws -> Self {
        var object = try validateStatusObject(data)
        guard let schema = object["schema"] as? String, schemaKnown(schema, name: "murmur.status") else {
            throw ContractError.schema
        }
        // Null is a present, unknown timestamp; the verdict handles it as such.
        let decodeData: Data
        if object["generatedAt"] is NSNull {
            object["generatedAt"] = ""
            decodeData = try JSONSerialization.data(withJSONObject: object)
        } else {
            decodeData = data
        }
        guard let value = try? JSONDecoder().decode(Self.self, from: decodeData) else { throw ContractError.unparsable }
        return value
    }

    public var modeMismatch: String? {
        guard let configured = wake.config.enabled, let effective = wake.effective.enabled, configured != effective else { return nil }
        let reason = configured ? L10n.text("Agent delivery is enabled in settings but is not active") : L10n.text("Agent delivery is paused in settings but the pause is not active")
        return reason + (wake.effective.needsRestart == true ? L10n.text("; restart the service to apply") : "")
    }

    public func verdict(now: Date = Date()) -> Verdict {
        let unread = (inbox.unread ?? 0) > 0
        var missing: [String] = []
        var missingWhy: [String: String] = [:]
        func note(_ path: String, _ reason: String? = nil) {
            missing.append(path)
            missingWhy[path] = reason?.isEmpty == false ? "source-unreadable" : "unmeasured"
        }
        func result(_ indicator: Indicator, _ code: String, _ reason: String) -> Verdict {
            let exactMissing = Array(Set(missing)).sorted()
            return Verdict(indicator, unread: unread, code: code, missing: exactMissing, missingWhy: missingWhy,
                           reason: StatusReason.displayed(code: code, missing: exactMissing, fallback: reason))
        }
        guard let generated = timestamp(generatedAt) else { return result(.unknown, "snapshot.unparsable", L10n.text("Snapshot time unknown")) }
        if now.timeIntervalSince(generated) > 120 { return result(.unknown, "snapshot.stale", L10n.text("Data is more than two minutes old")) }
        if generated.timeIntervalSince(now) > 5 { return result(.unknown, "snapshot.future", L10n.text("Clocks disagree: the snapshot is in the future")) }
        switch service.state {
        case .stopped: return result(.stopped, "service.stopped", L10n.text("Service stopped"))
        case .unknown, nil: return result(.unknown, "service.unknown", L10n.text("Service status unknown"))
        case .failed: return result(.failed, "service.failed", L10n.text("Service failed"))
        case .running: break
        }
        if outbox.queue.failed == nil { note("outbox.queue.failed") }
        if outbox.queue.dlq == nil { note("outbox.queue.dlq") }
        if (outbox.queue.failed ?? 0) > 0 || (outbox.queue.dlq ?? 0) > 0 {
            return result(.failed, "outbox.undelivered", L10n.text("Undelivered: %@; dead-letter queue: %@", String(describing: (outbox.queue.failed.map(String.init) ?? L10n.text("not measured"))), String(describing: (outbox.queue.dlq.map(String.init) ?? L10n.text("not measured")))))
        }
        if wake.faults.lastFault?.isEmpty == false { return result(.failed, "wake.fault", "") }
        if wake.delivery.pendingUndelivered == nil { note("wake.delivery.pendingUndelivered") }
        if (wake.delivery.pendingUndelivered ?? 0) > 0 { return result(.failed, "wake.pending", L10n.text("Some messages have not reached the agent")) }
        for (path, reason) in [("outbox.faults", outbox.faults.unknownReason), ("wake.faults", wake.faults.unknownReason),
                               ("outbox.queue", outbox.queue.unknownReason), ("wake.delivery", wake.delivery.unknownReason),
                               ("wake.config", wake.config.unknownReason), ("wake.effective", wake.effective.unknownReason)] {
            if let reason, !reason.isEmpty { note(path, reason) }
        }
        switch broker.state {
        case .unauthorized: return result(.offline, "broker.unauthorized", L10n.text("Broker access denied"))
        case .disconnected: return result(.offline, "broker.unreachable", L10n.text("Broker disconnected"))
        case .unknown, nil: missing.append("broker.state")
        case .connected: break
        }
        if let list = peers.list {
            if list.isEmpty { return result(.offline, "peers.none", L10n.text("Connect your first agent")) }
            if list.contains(where: { $0.paired == false }) { return result(.offline, "peers.unpaired", "") }
            for peer in list where peer.paired == nil { note("peers.list.\(peer.agentId).paired") }
        } else { note("peers.list", peers.unknownReason) }
        if inbox.unread == nil { note("inbox.unread", inbox.unknownReason) }
        if let mismatch = modeMismatch { return result(.offline, "wake.mode-mismatch", mismatch) }
        // Required nullable flags must not silently imply effective/paired state.
        // A source reason already names the same missing measurement when present.
        if wake.config.enabled == nil && wake.config.unknownReason?.isEmpty != false { note("wake.config.enabled") }
        if wake.effective.enabled == nil && wake.effective.unknownReason?.isEmpty != false { note("wake.effective.enabled") }
        if !missing.isEmpty {
            return result(.unknown, "unmeasured", "")
        }
        let detail = wake.config.responder == "none" ? L10n.text("Connected; automatic replies are not configured")
            : (wake.effective.enabled == false ? L10n.text("Connected; agent delivery is paused") : L10n.text("Service, broker and connections are working"))
        return result(.ready, "ok", detail)
    }

    public var diagnosticNotes: [String] {
        var notes: [String] = modeMismatch.map { [$0] } ?? []
        func bounded(_ value: String) -> String {
            String(String(value.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }).prefix(180))
        }
        for (title, error, at) in [(L10n.text("Last send error"), outbox.faults.lastError, outbox.faults.lastErrorAt),
                                    (L10n.text("Last agent wake failure"), wake.faults.lastFault, wake.faults.lastFaultAt),
                                    (L10n.text("Last broker error"), broker.lastError, broker.lastErrorAt)] {
            if error?.isEmpty == false || at?.isEmpty == false {
                notes.append("\(title): \(error.map(bounded) ?? L10n.text("recorded")) · \(at.map(bounded) ?? L10n.text("time unknown"))")
            }
        }
        if let at = service.lastFailureAt { notes.append(L10n.text("Last service failure: %@", String(describing: (bounded(at))))) }
        if let code = service.lastExitCode, code != 0 { notes.append(L10n.text("Last exit code: %@", String(describing: (code)))) }
        if let failed = outbox.queue.failed, failed > 0 { notes.append(L10n.text("Recorded delivery failures: %@", String(describing: (failed)))) }
        if let dlq = outbox.queue.dlq, dlq > 0 { notes.append(L10n.text("In the dead-letter queue: %@", String(describing: (dlq)))) }
        if let count = service.restartsLastHour { notes.append(L10n.text("Restarts in the last hour: %@", String(describing: (count)))) }
        else if let count = service.restartCount, let window = service.restartWindowMs { notes.append(L10n.text("Restarts in %@ seconds: %@", String(describing: (window / 1000)), String(describing: (count)))) }
        else { notes.append(L10n.text("Restart count for this period is not measured")) }
        if let pending = wake.delivery.pendingUndelivered, pending > 0 { notes.append(L10n.text("Waiting for agent delivery: %@", String(describing: (pending)))) }
        if let stored = wake.delivery.storedOnly, stored > 0 { notes.append(L10n.text("Stored without an automatic reply: %@", String(describing: (stored)))) }
        if wake.config.responder == "none" { notes.append(L10n.text("Automatic replies are not configured")) }
        else if wake.effective.enabled == false { notes.append(L10n.text("Agent delivery is paused")) }
        return notes
    }
}
