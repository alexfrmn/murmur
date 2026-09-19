import Foundation

public enum ContractError: Error, LocalizedError, Sendable {
    case schema, timestamp, missingOrInvalidFields, duplicateStage, stageOrder
    public var errorDescription: String? {
        switch self {
        case .schema: "Схема ответа незнакома"
        case .timestamp: "Время снимка неизвестно"
        case .missingOrInvalidFields: "В ответе отсутствуют обязательные данные"
        case .duplicateStage: "В проверке повторяется один этап"
        case .stageOrder: "Нарушен порядок этапов проверки"
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
    public let reason: String
    public init(_ indicator: Indicator, unread: Bool = false, code: String = "status.unavailable",
                missing: [String] = [], reason: String) {
        self.indicator = indicator; self.unread = unread; self.code = code
        self.missing = missing; self.reason = reason
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

/// Frozen consumer contract 78b40c. Unknown values are never zero/default success.
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
    }
    public let schema: String, generatedAt: String
    public let service: Service, broker: Broker, peers: Peers, inbox: Inbox, outbox: Outbox, wake: Wake

    public static func decode(_ data: Data) throws -> Self {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let schema = object["schema"] as? String, schemaKnown(schema, name: "murmur.status") else {
            throw ContractError.schema
        }
        // Optional Swift properties alone conflate missing and explicit null.
        // Verify required keys before decoding their nullable values.
        for key in ["generatedAt", "service.state", "broker.state", "peers.list", "inbox.unread",
                    "outbox.queue.failed", "outbox.queue.dlq", "outbox.queue.unknownReason", "outbox.faults.unknownReason",
                    "wake.config.enabled", "wake.config.unknownReason", "wake.effective.enabled", "wake.effective.unknownReason",
                    "wake.delivery.pendingUndelivered", "wake.delivery.unknownReason", "wake.faults.lastFault", "wake.faults.unknownReason"] {
            var current: Any = object
            for part in key.split(separator: ".").map(String.init) {
                guard let dictionary = current as? [String: Any], let value = dictionary[part] else {
                    throw ContractError.missingOrInvalidFields
                }
                current = value
            }
        }
        if let peers = (object["peers"] as? [String: Any])?["list"] as? [[String: Any]],
           peers.contains(where: { !$0.keys.contains("paired") }) { throw ContractError.missingOrInvalidFields }
        guard let value = try? JSONDecoder().decode(Self.self, from: data) else { throw ContractError.missingOrInvalidFields }
        let counts = [value.inbox.unread, value.outbox.queue.failed, value.outbox.queue.dlq,
                      value.wake.delivery.pendingUndelivered, value.wake.delivery.storedOnly,
                      value.service.restartCount, value.service.restartWindowMs, value.service.restartsLastHour]
        guard counts.compactMap({ $0 }).allSatisfy({ $0 >= 0 }) else { throw ContractError.missingOrInvalidFields }
        return value
    }

    public var modeMismatch: String? {
        guard let configured = wake.config.enabled, let effective = wake.effective.enabled, configured != effective else { return nil }
        let reason = configured ? "Пробуждение включено в настройках и не действует" : "Пауза задана в настройках и не применена"
        return reason + (wake.effective.needsRestart == true ? ", нужен перезапуск службы" : "")
    }

    public func verdict(now: Date = Date()) -> Verdict {
        let unread = (inbox.unread ?? 0) > 0
        var missing: [String] = []
        func result(_ indicator: Indicator, _ code: String, _ reason: String) -> Verdict {
            Verdict(indicator, unread: unread, code: code, missing: missing, reason: reason)
        }
        guard let generated = timestamp(generatedAt) else { return result(.unknown, "snapshot.unparsable", "Время снимка неизвестно") }
        if now.timeIntervalSince(generated) > 120 { return result(.unknown, "snapshot.stale", "Данные старше двух минут") }
        if generated.timeIntervalSince(now) > 5 { return result(.unknown, "snapshot.future", "Часы разошлись: снимок из будущего") }
        switch service.state {
        case .stopped: return result(.stopped, "service.stopped", "Служба остановлена")
        case .unknown, nil: return result(.unknown, "service.unknown", "Состояние службы неизвестно")
        case .failed: return result(.failed, "service.failed", "Служба завершилась с ошибкой")
        case .running: break
        }
        if outbox.queue.failed == nil { missing.append("outbox.queue.failed") }
        if outbox.queue.dlq == nil { missing.append("outbox.queue.dlq") }
        if (outbox.queue.failed ?? 0) > 0 || (outbox.queue.dlq ?? 0) > 0 {
            return result(.failed, "outbox.undelivered", "Не доставлено: \(outbox.queue.failed.map(String.init) ?? "не измерено"); DLQ: \(outbox.queue.dlq.map(String.init) ?? "не измерено")")
        }
        if wake.faults.lastFault?.isEmpty == false { return result(.failed, "wake.fault", "Ошибка передачи сообщения агенту") }
        if wake.delivery.pendingUndelivered == nil { missing.append("wake.delivery.pendingUndelivered") }
        if (wake.delivery.pendingUndelivered ?? 0) > 0 { return result(.failed, "wake.pending", "Есть сообщения, не переданные агенту") }
        for (name, reason) in [("журнал отказов отправки", outbox.faults.unknownReason),
                               ("журнал отказов пробуждения", wake.faults.unknownReason),
                               ("очередь", outbox.queue.unknownReason), ("доставка wake", wake.delivery.unknownReason),
                               ("настройки wake", wake.config.unknownReason), ("действующее состояние wake", wake.effective.unknownReason)] {
            if let reason, !reason.isEmpty { missing.append("\(name) (\(reason))") }
        }
        switch broker.state {
        case .unauthorized: return result(.offline, "broker.unauthorized", "Брокер отклонил доступ")
        case .disconnected: return result(.offline, "broker.unreachable", "Нет связи с брокером")
        case .unknown, nil: missing.append("broker.state")
        case .connected: break
        }
        func explained(_ name: String, _ reason: String?) -> String {
            name + (reason?.isEmpty == false ? " (\(reason!))" : "")
        }
        if let list = peers.list {
            if list.isEmpty { return result(.offline, "peers.none", "Подключите первого агента") }
            if list.contains(where: { $0.paired == false }) { return result(.offline, "peers.unpaired", "Не все агенты подключены друг к другу") }
            let unknown = list.filter { $0.paired == nil }.map(\.agentId)
            if !unknown.isEmpty { missing.append("парность неизвестна: " + unknown.joined(separator: ", ")) }
        } else { missing.append(explained("peers.list", peers.unknownReason)) }
        if inbox.unread == nil { missing.append(explained("inbox.unread", inbox.unknownReason)) }
        if let mismatch = modeMismatch { return result(.offline, "wake.mode-mismatch", mismatch) }
        // Required nullable flags must not silently imply effective/paired state.
        // A source reason already names the same missing measurement when present.
        if wake.config.enabled == nil && wake.config.unknownReason?.isEmpty != false { missing.append("wake.config.enabled") }
        if wake.effective.enabled == nil && wake.effective.unknownReason?.isEmpty != false { missing.append("wake.effective.enabled") }
        if !missing.isEmpty { return result(.unknown, "unmeasured", "Не измерено: " + missing.joined(separator: ", ")) }
        let detail = wake.config.responder == "none" ? "Связь работает; автоматический ответ не настроен"
            : (wake.effective.enabled == false ? "Связь работает; приём агентом на паузе" : "Служба, брокер и подключения работают")
        return result(.ready, "ok", detail)
    }

    public var diagnosticNotes: [String] {
        var notes: [String] = modeMismatch.map { [$0] } ?? []
        func bounded(_ value: String) -> String {
            String(String(value.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }).prefix(180))
        }
        for (title, error, at) in [("Последняя ошибка отправки", outbox.faults.lastError, outbox.faults.lastErrorAt),
                                    ("Последний сбой пробуждения", wake.faults.lastFault, wake.faults.lastFaultAt),
                                    ("Последняя ошибка брокера", broker.lastError, broker.lastErrorAt)] {
            if error?.isEmpty == false || at?.isEmpty == false {
                notes.append("\(title): \(error.map(bounded) ?? "был") · \(at.map(bounded) ?? "время неизвестно")")
            }
        }
        if let at = service.lastFailureAt { notes.append("Последний сбой службы: \(bounded(at))") }
        if let code = service.lastExitCode, code != 0 { notes.append("Последний код завершения: \(code)") }
        if let failed = outbox.queue.failed, failed > 0 { notes.append("Сохранённые ошибки доставки: \(failed)") }
        if let dlq = outbox.queue.dlq, dlq > 0 { notes.append("В очереди недоставленных: \(dlq)") }
        if let count = service.restartsLastHour { notes.append("Перезапусков за час: \(count)") }
        else if let count = service.restartCount, let window = service.restartWindowMs { notes.append("Перезапусков за \(window / 1000) с: \(count)") }
        else { notes.append("Число перезапусков за период не измерено") }
        if let pending = wake.delivery.pendingUndelivered, pending > 0 { notes.append("Ожидают передачи агенту: \(pending)") }
        if let stored = wake.delivery.storedOnly, stored > 0 { notes.append("Сохранено без автоматического ответа: \(stored)") }
        if wake.config.responder == "none" { notes.append("Автоматический ответ не настроен") }
        else if wake.effective.enabled == false { notes.append("Приём агентом на паузе") }
        return notes
    }
}
