import Foundation

public struct OutboxAttentionItem: Decodable, Sendable, Identifiable {
    public let msgId: String, createdAt: String, failedAt: String, reason: String, token: String
    public let peer: String?
    public let attempts: Int
    public let dismissed: Bool
    public var id: String { msgId }
    public var canSelect: Bool {
        msgId.range(of: "\\A[A-Za-z0-9][A-Za-z0-9_.:-]{0,150}\\z", options: .regularExpression) != nil
        && token.range(of: "\\A[a-f0-9]{64}\\z", options: .regularExpression) != nil
    }
    public var reasonText: String {
        switch reason {
        case "CONNECTION_CLOSED": L10n.text("The connection closed while sending")
        case "ack-timeout": L10n.text("No delivery receipt was received")
        default: L10n.text("Delivery could not be completed")
        }
    }
}

public struct OutboxAttentionSnapshot: Decodable, Sendable {
    public let schema: String?
    public let total: Int?, pending: Int?, dismissed: Int?
    public let items: [OutboxAttentionItem]?
    public let truncated: Bool?
    public let unknownReason: String?

    public func verifiedPending(total queueTotal: Int?) -> Int? {
        guard schema == "murmur.outbox-attention/1", unknownReason == nil,
              let total, total == queueTotal, let pending, let dismissed,
              total >= 0, pending >= 0, dismissed >= 0, pending <= total, dismissed == total - pending else { return nil }
        return pending
    }
}

struct OutboxActionReceipt: Decodable {
    let schema: String, agentId: String, msgId: String, token: String, transportState: String
    let dismissed: Bool, historyPreserved: Bool, resent: Bool
}
