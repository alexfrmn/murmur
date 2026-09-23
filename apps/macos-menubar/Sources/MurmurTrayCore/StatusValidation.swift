import Foundation
import CoreFoundation

private enum JSONKind {
    case string, number, boolean, array, object, null
}

private func kind(_ value: Any) -> JSONKind {
    if value is NSNull { return .null }
    if value is String { return .string }
    if let number = value as? NSNumber {
        // Foundation bridges JSON booleans to NSNumber too. Never treat true as 1.
        return CFGetTypeID(number) == CFBooleanGetTypeID() ? .boolean : .number
    }
    if value is [Any] { return .array }
    return .object
}

private func lookup(_ object: [String: Any], _ path: String) -> Any? {
    var current: Any = object
    for key in path.split(separator: ".") {
        guard let fields = current as? [String: Any], let value = fields[String(key)] else { return nil }
        current = value
    }
    return current
}

// This is validation of the frozen required leaves, not an exhaustive JSON schema.
// Extension fields remain additive. Explicit null is different from a missing key.
func validateStatusObject(_ data: Data) throws -> [String: Any] {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw ContractError.unparsable
    }
    let required: [(String, JSONKind)] = [
        ("schema", .string), ("generatedAt", .string), ("service.state", .string),
        ("broker.state", .string), ("peers.list", .array), ("inbox.unread", .number),
        ("outbox.queue.failed", .number), ("outbox.queue.dlq", .number),
        ("wake.config.enabled", .boolean), ("wake.faults.lastFault", .string),
        ("wake.delivery.pendingUndelivered", .number),
    ]
    var absent: [String] = [], wrong: [String] = []
    for (path, expected) in required {
        guard let value = lookup(object, path) else { absent.append(path); continue }
        if kind(value) != .null && kind(value) != expected { wrong.append(path) }
    }
    if !absent.isEmpty { throw ContractError.missingKeys(absent) }
    if !wrong.isEmpty { throw ContractError.wrongTypes(wrong) }

    let counters = ["inbox.unread", "inbox.total", "outbox.queue.pending", "outbox.queue.inflight",
                    "outbox.queue.delivered", "outbox.queue.failed", "outbox.queue.dlq",
                    "outbox.attention.total", "outbox.attention.pending", "outbox.attention.dismissed",
                    "wake.delivery.pendingUndelivered", "service.restartsLastHour",
                    // Additional measurements already decoded by this native consumer.
                    "wake.delivery.storedOnly", "service.restartCount", "service.restartWindowMs"]
    for path in counters {
        if let value = lookup(object, path), kind(value) == .number,
           let number = value as? NSNumber, number.doubleValue < 0 { throw ContractError.invalidValue(path) }
    }
    for path in counters {
        guard let value = lookup(object, path), !(value is NSNull) else { continue }
        guard kind(value) == .number, let number = value as? NSNumber else { throw ContractError.unparsable }
        let count = number.doubleValue
        guard count.isFinite, count.rounded(.towardZero) == count, count <= 9_007_199_254_740_991 else {
            throw ContractError.unparsable
        }
    }
    return object
}
