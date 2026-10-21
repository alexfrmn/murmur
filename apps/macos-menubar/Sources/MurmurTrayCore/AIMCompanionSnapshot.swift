import Foundation

/// Owner-only projection of existing server observations. Never carries message bodies or keys.
public struct AIMCompanionSnapshot: Decodable, Sendable {
    public struct Person: Decodable, Identifiable, Sendable {
        public struct Contour: Decodable, Sendable {
            public let id: String
        }
        public let contour: Contour?
        public struct Flow: Decodable, Sendable {
            public let inbound_count: Int?
            public let outbound_count: Int?
            public let last_at: String?
            public let source_at: String?
            public let scope: String?
        }
        public let id: String
        public let name: String
        public let agents: [String]
        public let last_at: String?
        public let nickname: String?
        public let role: String?
        public let contact_state: String?
        public let agent_labels: [String: String]?
        public let writable_agents: [String]?
        public let photo: String?
        public let photo_note: String?
        public let photo_privacy: String?
        public let flows: [String: Flow]?
        public let flow_window: String?
        /// A portrait is shown only for a person the edition lists, never for a private-contour binding.
        public var approvedPhoto: String? { approvedPhoto(in: .current) }
        public func approvedPhoto(in config: AIMEditionConfig) -> String? {
            let privatePeers = config.privatePeers.union(["shaper-viola", "agent-viola-alex"])
            guard id.hasPrefix("person:"), config.avatarPeople.contains(String(id.dropFirst(7))),
                  photo_privacy == "owner-approved-avatar", contact_state != "status_only",
                  agents.allSatisfy({ !privatePeers.contains($0) }),
                  let photo, photo == "/mesh-comms-avatar-" + id.dropFirst(7) + ".jpg"
            else { return nil }
            return photo
        }
    }
    public struct Question: Decodable, Identifiable, Sendable {
        public let id: String
        public let title: String?
        public let peer: String?
        public let status: String?
        public let source_date: String?
        public let reviewed_at: String?
        public let next_action: String?
        public let conversation: String?
        public let responsibility: String?
        public let source_id: String?
        public var needsOwner: Bool {
            if let responsibility {
                return responsibility == AIMEditionConfig.defaultOwnerResponsibility
                    || responsibility == AIMEditionConfig.current.ownerResponsibility
            }
            return ["awaiting_user", "needs_owner_decision"].contains(status ?? "")
        }
        public var waitingForAgent: Bool { responsibility == "agent" }
        public var waitingForPeer: Bool { responsibility == "peer" }
        public var needsVerification: Bool { responsibility == "verify" }
    }
    public struct Incoming: Decodable, Sendable {
        public let peer: String
        public let conversation: String
        public let ids: [String]
        public let date: String?
    }
    public struct Attention: Decodable, Sendable {
        public struct Item: Decodable, Identifiable, Sendable {
            public let id: String
            public let peer: String
            public let kind: String
            public let title: String
            public let date: String?
            public let next_action: String
            public let source_ids: [String]
            public let conversation: String
            public let actionable: Bool
            public let alert: Bool
            public var notificationKey: String { "attention:\(id):\(kind):\(source_ids.last ?? "")" }
            public var kindLabelKey: String {
                switch kind {
                case "owner": return "Your reply or decision"
                case "agent": return "Assistant action needed"
                case "peer": return "Waiting for people"
                case "delivery": return "Delivery failed"
                default: return "Needs verification"
                }
            }
        }
        public let schema: Int
        public let receipts_ok: Bool
        public let items: [Item]
        public var peerWaits: [Item] { items.filter { !$0.actionable && $0.kind == "peer" } }
        public var verificationItems: [Item] { items.filter { !$0.actionable && $0.kind != "peer" } }
        public var yourTurn: [Item] { items.filter { $0.actionable && $0.kind == "owner" } }
        public var otherUpdates: [Item] { items.filter { $0.actionable && $0.kind != "owner" } }
    }
    public struct Budget: Decodable, Sendable {
        public let allowed: Bool?
        public let reason: String?
        public let observed_at: String?
        public let fresh: Bool?
    }
    public struct FlowSource: Decodable, Sendable {
        public let store: String
        public let ok: Bool?
        public let observed_at: String?
    }
    public struct PrivateContour: Decodable, Identifiable, Sendable {
        public let id: String
        public let name: String
        public let privacy: String
        public let service_active: Bool?
        public let last_at: String?
        public let updated_at: String?
        public let inbound_count: Int?
        public let outbound_count: Int?
        public let failed_count: Int?
        public let waiting_count: Int?
        public let handler_configured: Bool?
        public let handler_service_active: Bool?
        public let last_wake_status: String?
        public let model_reply_verified: Bool?
        public let reply_delivery: String?
        public let last_model_reply_at: String?
        public let source_at: String?
        public let source_age_seconds: Int?
        public let source_fresh: Bool?
        public let work_status: String?
        public let work_code: String?
        public let work_at: String?
        public let processor_location: String?
        public let owner_thread: OwnerThread?

        /// Display only the bounded public vocabulary, never free-form private work text.
        public var workStatusLabelKey: String {
            switch work_status {
            case "in_progress": return "Work in progress"
            case "blocked": return "Work blocked"
            case "needs_verification": return "Work needs verification"
            case "complete": return "Work complete"
            case "awaiting_fresh_inbound": return "Awaiting fresh incoming after restart"
            default: return "Work status unknown"
            }
        }
        public var workDetailLabelKey: String? {
            work_code == "materials_verified_continuity_in_progress"
                ? "Materials verified; processing resilience and post-restart verification" : nil
        }
        public var processorLocationLabelKey: String? {
            processor_location == "local_mac" ? "Private handler · this Mac" : nil
        }
        public func sourceFreshnessLabelKey(snapshotCurrent: Bool) -> String {
            guard let fresh = source_fresh, Self.validSource(self) else { return "Source freshness unknown" }
            return fresh && snapshotCurrent ? "Source fresh" : "Source stale"
        }
        private static func validSource(_ contour: Self) -> Bool {
            AIMCompanionSnapshot.date(contour.source_at) != nil && (contour.source_age_seconds.map { $0 >= 0 } ?? false)
        }
    }
    public struct OwnerThread: Decodable, Sendable {
        public let title: String
        public let url: String
        public var verifiedURL: URL? {
            guard let components = URLComponents(string: url), components.scheme == "codex",
                  components.host == "threads", components.user == nil, components.password == nil,
                  components.port == nil, components.query == nil, components.fragment == nil,
                  components.path.first == "/", components.path.count == 37,
                  UUID(uuidString: String(components.path.dropFirst())) != nil,
                  components.percentEncodedPath == components.path else { return nil }
            return components.url
        }
    }
    public let peer_policy: AIMPeerPolicySnapshot?
    public let schema: String
    public let privacy: String
    public let snapshot_at: String?
    public let fresh: Bool
    public let people: [Person]
    public let flow_sources: [FlowSource]?
    public let pending_count: Int
    public let decision_count: Int
    public let questions: [Question]
    public let incoming: [Incoming]
    public let attention: Attention?
    public let private_contours: [PrivateContour]?
    public let owner_threads: [String: OwnerThread]?
    public let budget: Budget
    public let owner_mode: String
    public let transport: String
    public let responder: String
    public let server_version: String
    public let responder_model: String

    public static func decode(_ data: Data) throws -> Self {
        guard data.count <= 524_288 else { throw CocoaError(.fileReadTooLarge) }
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard value.schema == "aim.murmur.companion/1", value.privacy == "owner-metadata",
              value.pending_count >= 0, value.decision_count >= 0,
              value.decision_count <= value.pending_count,
              (value.private_contours ?? []).allSatisfy({
                  $0.privacy == "status-only" && ($0.owner_thread == nil || $0.owner_thread?.verifiedURL != nil)
                      && ($0.source_age_seconds.map { $0 >= 0 } ?? true)
              }),
              value.people.allSatisfy({ person in
                  (person.flows ?? [:]).allSatisfy { agent, flow in
                      person.agents.contains(agent)
                          && (flow.inbound_count.map { $0 >= 0 } ?? true)
                          && (flow.outbound_count.map { $0 >= 0 } ?? true)
                  }
              }),
              (value.owner_threads ?? [:]).values.allSatisfy({ $0.verifiedURL != nil })
        else { throw CocoaError(.fileReadCorruptFile) }
        if let attention = value.attention {
            let privatePeers = AIMEditionConfig.current.privatePeers
                .union(["shaper-viola", "agent-viola-alex"])
                .union(value.people.filter { $0.contact_state == "status_only" }.flatMap(\.agents))
            guard attention.schema == 1, attention.items.count <= 200,
                  Set(attention.items.map(\.id)).count == attention.items.count,
                  attention.items.allSatisfy({ item in
                      ["owner", "agent", "peer", "verify", "delivery"].contains(item.kind)
                      && !privatePeers.contains(item.peer)
                      && item.source_ids.count <= 30
                  }) else { throw CocoaError(.fileReadCorruptFile) }
        }
        return value
    }
    public func isCurrent(now: Date = Date()) -> Bool {
        guard fresh, let date = Self.date(snapshot_at) else { return false }
        return (0..<300).contains(now.timeIntervalSince(date))
    }
    public static func date(_ raw: String?) -> Date? {
        guard let raw else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
    }
    public var attentionKeys: Set<String> {
        if let attention { return Set(attention.items.filter(\.alert).map(\.notificationKey)) }
        return Set(incoming.flatMap { item in item.ids.map { "message:\(item.peer):\($0)" } }
            + questions.filter(\.needsOwner).map { "decision:\($0.id):\($0.source_date ?? "")" })
    }
    public var attentionCount: Int {
        attention.map { $0.items.filter(\.actionable).count }
            ?? (decision_count + incoming.reduce(0) { $0 + $1.ids.count })
    }
    /// The owner's decisions and transport/assistant work have separate entrances.
    public var ownerAttentionCount: Int { attention?.yourTurn.count ?? decision_count }
    public var technicalAttentionCount: Int { attention?.otherUpdates.count ?? agentQuestions.count }
    public func notificationKeys(owner: Bool, technical: Bool) -> Set<String> {
        guard let attention else { return owner ? attentionKeys : [] }
        return Set(attention.items.filter { $0.alert && $0.actionable && ($0.kind == "owner" ? owner : technical) }.map(\.notificationKey))
    }
    public func attentionItems(for person: Person) -> [Attention.Item] {
        (attention?.items ?? []).filter { person.agents.contains($0.peer) && $0.actionable }
    }
    /// One contact's actionable work. Historical review never inflates this summary.
    /// Private/status-only contacts never acquire conversation actions from this projection.
    public func contactAttention(for person: Person, config: AIMEditionConfig = .current) -> [Attention.Item] {
        guard communicationPeer(for: person, config: config) != nil else { return [] }
        return (attention?.items ?? []).filter { person.agents.contains($0.peer) && $0.actionable }.sorted {
            let lhs = Self.contactPriority($0), rhs = Self.contactPriority($1)
            if lhs != rhs { return lhs < rhs }
            if $0.date != $1.date { return ($0.date ?? "") > ($1.date ?? "") }
            return $0.id < $1.id
        }
    }
    /// The Read button follows the displayed conversation for a multi-agent contact.
    public func communicationPeer(for person: Person, config: AIMEditionConfig = .current) -> String? {
        guard !isStatusOnly(person, config: config) else { return nil }
        return (attention?.items ?? []).filter { person.agents.contains($0.peer) }.min {
            let lhs = Self.contactPriority($0), rhs = Self.contactPriority($1)
            if lhs != rhs { return lhs < rhs }
            if $0.date != $1.date { return ($0.date ?? "") > ($1.date ?? "") }
            return $0.id < $1.id
        }?.peer ?? person.agents.first
    }
    private static func contactPriority(_ item: Attention.Item) -> Int {
        if item.actionable { return ["owner": 0, "delivery": 1, "agent": 2][item.kind] ?? 3 }
        return item.kind == "peer" ? 4 : 5
    }
    public var ownerQuestions: [Question] { questions.filter(\.needsOwner) }
    public var agentQuestions: [Question] { questions.filter(\.waitingForAgent) }
    public var peerQuestions: [Question] { questions.filter(\.waitingForPeer) }
    public var verificationQuestions: [Question] { questions.filter(\.needsVerification) }
    /// Explicit roster binding only; names and agent ordering never infer a private owner.
    public func privateContour(for person: Person) -> PrivateContour? {
        guard isStatusOnly(person), let id = person.contour?.id else { return nil }
        return private_contours?.first { $0.id == id }
    }
    public func ownerThread(for peer: String?) -> OwnerThread? {
        guard let peer else { return nil }
        return owner_threads?[peer]
    }
}

/// First observation establishes a quiet baseline. Old items remain seen after leaving the queue.
public struct AIMCompanionCursor: Sendable {
    public private(set) var seen: Set<String>?
    public init(seen: Set<String>? = nil) { self.seen = seen }
    public mutating func observe(_ keys: Set<String>) -> Set<String> {
        let added = seen.map { keys.subtracting($0) } ?? []
        // Retain the whole current queue before older hashes. Persisting a sorted
        // suffix could evict current items and alert again after every restart.
        let older = (seen ?? []).subtracting(keys).sorted().suffix(max(0,8192-keys.count))
        seen = keys.union(older)
        return added
    }
}

/// Persist only notification hashes, with independent baselines for legacy and shared queues.
public struct AIMCompanionNotificationHistory {
    private let defaults: UserDefaults
    private var cursors: [String: AIMCompanionCursor] = [:]
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    public mutating func observe(_ hashes: Set<String>, sharedAttention: Bool) -> Set<String> {
        // The draft's aimCompanionAttentionSeen mixed both formats, so it cannot
        // establish a trustworthy shared baseline. Keep the original legacy key.
        let key = sharedAttention ? "aimCompanionSharedAttentionV1Seen" : "aimCompanionSeen"
        var cursor = cursors[key] ?? AIMCompanionCursor(seen: defaults.stringArray(forKey: key).map(Set.init))
        let added = cursor.observe(hashes)
        cursors[key] = cursor
        defaults.set(Array(cursor.seen ?? []).sorted(), forKey: key)
        return added
    }
}

public struct AIMPeerPolicySnapshot: Decodable, Sendable {
    public struct Policy: Decodable, Sendable {
        public let revision: Int
        public let send_allowed: Bool
        public let trust: String
        public let context: String
        public let brief: String?
        public let tone: String
        public let reply_mode: String?
        public let responder: String
        public let wake_status: String
        public let wake_reason: String?
        public var incomingLabelKey: String {
            switch reply_mode {
            case "manual": return "Manual review only"
            case "technical_only": return "Automatic technical replies"
            default: return "Incoming mode not observed"
            }
        }
        public var canEditIncoming: Bool { ["manual", "technical_only"].contains(reply_mode ?? "") }
    }
    public let observed_at: String
    public let peers: [String: Policy]
}

/// Read-only owner search. Bodies are fetched only after an explicit selection.
public struct AIMMessageSearchResult: Decodable, Sendable {
    public struct Match: Decodable, Identifiable, Sendable {
        public let id: String
        public let store: String
        public let date: String?
        public let peer_identity: String?
        public let local_identity: String?
        public let direction: String?
        public let conversation_id: String?
        public let excerpt: String
        public var stableID: String { store + ":" + id }
    }
    public let privacy: String
    public let matches: [Match]
    public let total: Int
    public let truncated: Bool
    public let searched: Int
    public let unavailable: [String]
    public let source_at: String?
    public let scope: String

    public static func decode(_ data: Data) throws -> Self {
        guard data.count <= 1_048_576 else { throw CocoaError(.fileReadTooLarge) }
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard value.privacy == "owner-only-search", value.total >= 0, value.searched >= 0,
              value.matches.count <= 100, value.matches.allSatisfy({ !$0.store.isEmpty && !$0.id.isEmpty })
        else { throw CocoaError(.fileReadCorruptFile) }
        return value
    }
}

public struct AIMMessageReadResult: Decodable, Sendable {
    public let privacy: String
    public let id: String
    public let text: String
    public let truncated: Bool
    public static func decode(_ data: Data, expectedID: String) throws -> Self {
        guard data.count <= 1_048_576 else { throw CocoaError(.fileReadTooLarge) }
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard value.privacy == "owner-only-on-demand", value.id == expectedID else { throw CocoaError(.fileReadCorruptFile) }
        return value
    }
}
