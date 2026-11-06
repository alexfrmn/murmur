import Foundation

extension AIMCompanionSnapshot {
    public struct Reference: Decodable, Sendable, Equatable {
        public let id: String
        public let label: String
    }
    public struct Decision: Decodable, Identifiable, Sendable, Equatable {
        public let id: String
        public let label: String
        public let decided_by: String
        public let source_id: String
        public let decided_at: String
        public let evidence_kind: String
        public let scope: String
        public let source_date: String?
        public let reviewed_at: String?
        public let source_available: Bool

        public var evidenceLabelKey: String {
            switch evidence_kind {
            case "direct_human_choice_recorded": return "Human choice recorded in owner chat"
            case "direct_human_choice_relayed": return "Human choice relayed"
            case "human_decision_reported_by_peer": return "Human decision reported by counterpart"
            case "operator_verified_receipt": return "Operator verified receipt"
            default: return "Peer review and GitHub merge verified"
            }
        }
        public var originLabelKey: String {
            evidence_kind == "direct_human_choice_recorded" ? "Owner chat decision" : "Murmur source"
        }
        public func sourceMatch(peer: String) -> AIMMessageSearchResult.Match? {
            guard source_available, evidence_kind != "direct_human_choice_recorded" else { return nil }
            return .init(id: source_id, store: "murmur-sasha", date: source_date,
                         peer_identity: peer, local_identity: nil, direction: nil,
                         conversation_id: nil, excerpt: label)
        }
    }
    public struct ReplyOption: Decodable, Identifiable, Sendable, Equatable {
        public let id: String
        public let text: String
    }
    public enum NextStepGroup: String, CaseIterable, Sendable {
        case owner = "Your decision", peer = "Waiting for counterpart", agent = "Our implementation", verify = "Needs verification"
    }

    /// Nil means the server has not projected reviewed context. An empty array is a confirmed empty result.
    public func reviewedTopics(for peer: String, config: AIMEditionConfig = .current) -> [Question]? {
        guard let person = people.first(where: { $0.agents.contains(peer) }), !isStatusOnly(person, config: config),
              let reviewed_topics else { return nil }
        return reviewed_topics.filter { $0.peer == peer }
    }
    func validateConversationContext() throws {
        guard let reviewed_topics else { return }
        let privatePeers = AIMEditionConfig.current.privatePeers.union(["shaper-viola", "agent-viola-alex"])
            .union(people.filter { $0.contact_state == "status_only" }.flatMap(\.agents))
        guard reviewed_topics.count <= 200, Set(reviewed_topics.map(\.id)).count == reviewed_topics.count,
              review_at.map({ Self.date($0) != nil }) ?? true,
              reviewed_topics.allSatisfy({ topic in
                  guard let peer = topic.peer, !privatePeers.contains(peer),
                        people.contains(where: { $0.agents.contains(peer) }),
                        Self.contextText(topic.id, limit: 160),
                        (topic.proposed_reply == nil && (topic.reply_options ?? []).isEmpty) || topic.proposal_status == "draft_not_approved",
                        Self.validReplyOptions(topic.reply_options ?? []),
                        topic.reply_context.map({ Self.validReplyContext($0, topic: topic, privatePeers: privatePeers) }) ?? true,
                        [topic.title, topic.summary, topic.evidence, topic.next_action, topic.proposed_reply].allSatisfy({ $0.map { Self.contextText($0, limit: 4096) } ?? true }),
                        [topic.source_date, topic.reviewed_at].allSatisfy({ $0.map { Self.date($0) != nil } ?? true }),
                        topic.source_id.map({ Self.contextText($0, limit: 160) }) ?? true,
                        (topic.references ?? []).count <= 30,
                        (topic.references ?? []).allSatisfy({ Self.contextText($0.id, limit: 160) && Self.contextText($0.label, limit: 300) }),
                        (topic.confirmed_decisions ?? []).count <= 30,
                        Set((topic.confirmed_decisions ?? []).map(\.id)).count == (topic.confirmed_decisions ?? []).count
                  else { return false }
                  return (topic.confirmed_decisions ?? []).allSatisfy { decision in
                      Self.contextText(decision.id, limit: 160) && Self.contextText(decision.label, limit: 4096)
                      && Self.contextText(decision.decided_by, limit: 160) && Self.contextText(decision.scope, limit: 300)
                      && Self.contextText(decision.source_id, limit: 160) && Self.date(decision.decided_at) != nil
                      && [decision.source_date, decision.reviewed_at].allSatisfy({ $0.map { Self.date($0) != nil } ?? true })
                      && Self.validDecisionEvidence(decision.evidence_kind)
                      && (decision.evidence_kind != "direct_human_choice_recorded"
                          || (UUID(uuidString: decision.source_id) != nil && !decision.source_available))
                  }
              }) else { throw CocoaError(.fileReadCorruptFile) }
    }
    fileprivate static func contextText(_ text: String, limit: Int) -> Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && text.count <= limit
            && !text.unicodeScalars.contains { CharacterSet.controlCharacters.subtracting(.newlines).contains($0) }
    }
    private static func validDecisionEvidence(_ kind: String) -> Bool {
        if ["direct_human_choice_relayed", "direct_human_choice_recorded", "human_decision_reported_by_peer", "operator_verified_receipt"].contains(kind) { return true }
        let prefix = "peer_review_and_github_merge_verified_"
        guard kind.hasPrefix(prefix) else { return false }
        let suffix = String(kind.dropFirst(prefix.count))
        guard suffix.count == 8, suffix.allSatisfy({ $0.isASCII && $0.isNumber }) else { return false }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyyMMdd"; formatter.isLenient = false
        guard let date = formatter.date(from: suffix) else { return false }
        return formatter.string(from: date) == suffix
    }
}

extension AIMCompanionSnapshot.Question {
    public var isClosed: Bool {
        ["answered", "no_reply_needed", "reported_complete", "cancelled", "superseded"].contains(status ?? "")
    }
    public var draftProposedReply: String? {
        guard !isClosed, proposal_status == "draft_not_approved", let proposed_reply,
              AIMCompanionSnapshot.contextText(proposed_reply, limit: 4096) else { return nil }
        return proposed_reply
    }
    public var draftReplyOptions: [AIMCompanionSnapshot.ReplyOption] {
        guard !isClosed, proposal_status == "draft_not_approved",
              let reply_options, AIMCompanionSnapshot.validReplyOptions(reply_options) else { return [] }
        return reply_options
    }
    public var statusLabelKey: String {
        switch status {
        case "answered": return "Answered"
        case "no_reply_needed": return "No reply needed"
        case "reported_complete": return "Reported complete"
        case "reported_complete_with_gap": return "Reported complete · verification pending"
        case "cancelled": return "Cancelled"
        case "superseded": return "Superseded"
        case "awaiting_user", "needs_owner_decision": return "Your decision"
        case "awaiting_peer", "awaiting_peer_human", "awaiting_external_owner": return "Waiting for counterpart"
        case "awaiting_agent", "awaiting_implementation_owner": return "Our implementation"
        default: return "Needs verification"
        }
    }
    public func nextStepGroup(config: AIMEditionConfig = .current) -> AIMCompanionSnapshot.NextStepGroup? {
        guard !isClosed else { return nil }
        switch responsibility {
        case config.ownerResponsibility: return .owner
        case "peer": return .peer
        case "agent": return .agent
        default: return .verify
        }
    }
    public var sourceMatch: AIMMessageSearchResult.Match? {
        guard source_available == true, let source_id, let peer else { return nil }
        return .init(id: source_id, store: "murmur-sasha", date: source_date,
                     peer_identity: peer, local_identity: nil, direction: nil,
                     conversation_id: conversation, excerpt: title ?? "")
    }
}


extension AIMCompanionSnapshot.Attention.Item {
    /// Parse dates before ordering: malformed/unknown observations follow every dated item.
    public static func newestFirst(_ lhs: Self, _ rhs: Self) -> Bool {
        let left = AIMCompanionSnapshot.date(lhs.date), right = AIMCompanionSnapshot.date(rhs.date)
        if left != right {
            if let left, let right { return left > right }
            return left != nil
        }
        return lhs.id < rhs.id
    }
}
extension AIMCompanionSnapshot.Attention {
    public struct PeerGroup: Identifiable, Sendable {
        public var id: String { peer }
        public let peer: String
        public let items: [Item]
    }
    /// Group by exact counterpart, order groups by newest retained source, keep every item.
    public static func peerGroups(_ items: [Item]) -> [PeerGroup] {
        Dictionary(grouping: items, by: \.peer).map { peer, rows in
            PeerGroup(peer: peer, items: rows.sorted(by: Item.newestFirst))
        }.sorted { left, right in
            let lhs = AIMCompanionSnapshot.date(left.items.first?.date), rhs = AIMCompanionSnapshot.date(right.items.first?.date)
            if lhs != rhs {
                if let lhs, let rhs { return lhs > rhs }
                return lhs != nil
            }
            return left.peer < right.peer
        }
    }
}
extension AIMCompanionSnapshot {
    public func participantLabel(for peer: String) -> String {
        guard let person = people.first(where: { $0.agents.contains(peer) }) else { return peer }
        return person.name + " · " + (person.agent_labels?[peer] ?? peer)
    }
}


extension AIMCompanionSnapshot {
    /// A suggestion belongs to one owner topic and exact counterpart, never a same-title card.
    public func proposedReply(for item: Attention.Item) -> String? {
        guard item.actionable, item.kind == "owner", item.id.hasPrefix("topic:") else { return nil }
        let topicID = String(item.id.dropFirst("topic:".count))
        return reviewedTopics(for: item.peer)?.first { $0.id == topicID }?.draftProposedReply
    }
}


/// A read-only binding to one retained ordinary Murmur source. No path or recipient is encoded.
public struct AIMReplyContext: Codable, Equatable, Sendable {
    public let store: String
    public let local_identity: String
    public let source_id: String
    public let conversation_id: String

    public init(store: String, local_identity: String, source_id: String, conversation_id: String) {
        self.store = store; self.local_identity = local_identity
        self.source_id = source_id; self.conversation_id = conversation_id
    }
}

/// The id identifies a presented sheet only. The composer owns any send request UUID.
public struct AIMReplyDraft: Identifiable, Sendable {
    public let id: String
    public let peer: String
    public let text: String
    public let context: AIMReplyContext
    public let title: String?
}

extension AIMCompanionSnapshot {
    fileprivate static func validReplyOptions(_ options: [ReplyOption]) -> Bool {
        options.isEmpty || (options.count == 2 && Set(options.map(\.id)) == Set(["yes", "no"])
            && options.allSatisfy { contextText($0.text, limit: 4096) })
    }
    private static func boundIdentifier(_ id: String, limit: Int) -> Bool {
        id.count <= limit && id.range(of: "^[A-Za-z0-9][A-Za-z0-9._:-]*$", options: .regularExpression) != nil
    }
    private static func validReplyContext(_ context: AIMReplyContext, topic: Question, privatePeers: Set<String>) -> Bool {
        guard let peer = topic.peer, context.store == "murmur-sasha",
              peer.range(of: AIMEditionConfig.peerPattern, options: .regularExpression) != nil,
              context.local_identity.range(of: AIMEditionConfig.peerPattern, options: .regularExpression) != nil,
              !privatePeers.contains(peer), !privatePeers.contains(context.local_identity),
              context.local_identity != peer,
              boundIdentifier(context.source_id, limit: 160), boundIdentifier(context.conversation_id, limit: 160),
              context.source_id == topic.source_id, context.conversation_id == topic.conversation
        else { return false }
        return true
    }
    /// Returns the current retained question only when an ordinary writable reply route exists.
    /// Fresh sending policy is still checked by the existing composer and server on submit.
    private func replyReadyQuestion(_ question: Question, config: AIMEditionConfig, now: Date) -> Question? {
        guard isCurrent(now: now), let peer = question.peer,
              let current = reviewedTopics(for: peer, config: config)?.first(where: { $0.id == question.id }),
              current == question, !current.isClosed, current.source_available == true,
              question.source_id == current.source_id, question.conversation == current.conversation,
              question.reply_context == current.reply_context,
              let person = people.first(where: { $0.agents.contains(peer) }), !isStatusOnly(person, config: config),
              (person.writable_agents ?? []).contains(peer),
              let context = current.reply_context
        else { return nil }
        let privatePeers = config.privatePeers.union(["shaper-viola", "agent-viola-alex"])
            .union(people.filter { $0.contact_state == "status_only" }.flatMap(\.agents))
        guard Self.validReplyContext(context, topic: current, privatePeers: privatePeers) else { return nil }
        return current
    }
    public func replyQuestion(for item: Attention.Item, config: AIMEditionConfig = .current, now: Date = Date()) -> Question? {
        guard item.id.hasPrefix("topic:"),
              let topic = reviewedTopics(for: item.peer, config: config)?.first(where: { "topic:" + $0.id == item.id })
        else { return nil }
        return replyReadyQuestion(topic, config: config, now: now)
    }
    public func replyDraft(for question: Question, choice: String, config: AIMEditionConfig = .current, now: Date = Date()) -> AIMReplyDraft? {
        guard let current = replyReadyQuestion(question, config: config, now: now),
              let peer = current.peer, let context = current.reply_context else { return nil }
        let text: String
        switch choice {
        case "custom": text = ""
        case "proposal":
            guard let proposed = current.draftProposedReply else { return nil }
            text = proposed
        case "yes", "no":
            guard let option = current.draftReplyOptions.first(where: { $0.id == choice }) else { return nil }
            text = option.text
        default: return nil
        }
        return AIMReplyDraft(id: UUID().uuidString, peer: peer, text: text, context: context, title: current.title)
    }
}
