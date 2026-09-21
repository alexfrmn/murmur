import Foundation

public enum AIClientKind: String, Decodable, Sendable, CaseIterable {
    case claudeCode = "claude-code", claudeDesktop = "claude-desktop"
    case codexCLI = "codex-cli", codexDesktop = "codex-desktop"
    public var title: String {
        switch self {
        case .claudeCode: "Claude Code"
        case .claudeDesktop: "Claude Desktop"
        case .codexCLI: "Codex CLI"
        case .codexDesktop: "Codex"
        }
    }
}
public struct DetectedAIClient: Decodable, Sendable, Identifiable {
    public let id: AIClientKind
    public let installed: Bool
    public let configPath: String?
    public var canConfigure: Bool { installed && configPath != nil }
}
public struct ClientConfigurationPlan: Decodable, Sendable, Identifiable {
    public enum Action: String, Decodable, Sendable { case add, replace, unchanged }
    public let schema: String, planId: String, agentId: String, dataDir: String, configPath: String
    public let client: AIClientKind
    public let action: Action
    public let restartRequired: Bool, configExisted: Bool
    public var id: String { planId }
    public static func decode(_ data: Data, profile: ProfileBinding, agentID: String, client: AIClientKind) throws -> Self {
        let plan = try JSONDecoder().decode(Self.self, from: data)
        guard schemaKnown(plan.schema, name: "murmur.client-plan"), plan.client == client,
              plan.agentId == agentID, plan.dataDir == profile.dataDirectory,
              explicitAbsolutePath(plan.configPath), plan.restartRequired,
              plan.planId.range(of: "\\A[a-f0-9]{64}\\z", options: .regularExpression) != nil else { throw ProfileError.invalidResponse }
        return plan
    }
}
public struct ClientConfigurationReceipt: Decodable, Sendable {
    public let schema: String, planId: String, agentId: String, dataDir: String, configPath: String
    public let client: AIClientKind
    public let changed: Bool, restartRequired: Bool
    public let backup: String?
    public static func decode(_ data: Data, plan: ClientConfigurationPlan) throws -> Self {
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard schemaKnown(value.schema, name: "murmur.client"), value.planId == plan.planId,
              value.client == plan.client, value.agentId == plan.agentId, value.dataDir == plan.dataDir,
              value.configPath == plan.configPath, value.restartRequired,
              value.changed == (plan.action != .unchanged) else { throw ProfileError.invalidResponse }
        if let backup = value.backup {
            guard value.changed, explicitAbsolutePath(backup), backup.hasPrefix(plan.configPath + ".murmur-backup-"),
                  UUID(uuidString: String(backup.dropFirst((plan.configPath + ".murmur-backup-").count))) != nil else { throw ProfileError.invalidResponse }
        }
        if plan.configExisted && value.changed && value.backup == nil { throw ProfileError.invalidResponse }
        return value
    }
}

public struct ReplyTestPlan: Decodable, Sendable {
    public let schema: String, agentId: String, peerId: String, conversationId: String
    public let token: String, createdAt: String, expiresAt: String, requestText: String, expectedReply: String
    public static func decode(_ data: Data, agentID: String, peerID: String, now: Date = Date()) throws -> Self {
        let plan = try JSONDecoder().decode(Self.self, from: data)
        guard schemaKnown(plan.schema, name: "murmur.reply-test-plan"), plan.agentId == agentID, plan.peerId == peerID,
              plan.conversationId.range(of: "\\Amurmur:setup:[a-f0-9]{48}\\z", options: .regularExpression) != nil,
              !plan.token.isEmpty, plan.token.count <= 2048,
              plan.token.range(of: "\\A[A-Za-z0-9_-]+\\z", options: .regularExpression) != nil,
              !plan.requestText.isEmpty, plan.requestText.count < 2048,
              plan.expectedReply == "MURMUR-SETUP-REPLY " + plan.conversationId.dropFirst("murmur:setup:".count),
              let start = timestamp(plan.createdAt), let end = timestamp(plan.expiresAt),
              abs(start.timeIntervalSince(now)) <= 30, end.timeIntervalSince(start) == 900 else { throw ProfileError.invalidResponse }
        return plan
    }
    public var prompt: String {
        let arguments = ["to": peerId, "conversationId": conversationId, "text": requestText]
        let json = (try? JSONSerialization.data(withJSONObject: arguments, options: [.prettyPrinted, .sortedKeys])).flatMap { String(data: $0, encoding: .utf8) } ?? ""
        return L10n.text("Use the Murmur tool murmur_send with exactly these arguments. Send a real message; do not simulate the tool or its result.") + "\n\n" + json
    }
}
public struct ReplyTestObservation: Decodable, Sendable {
    public enum State: String, Decodable, Sendable { case notSent = "not-sent", waiting, replied, expired }
    public let schema: String, generatedAt: String, agentId: String, peerId: String, conversationId: String
    public let state: State
    public let requestMsgId: String?, replyMsgId: String?, receivedAt: String?
    public static func decode(_ data: Data, plan: ReplyTestPlan, now: Date = Date()) throws -> Self {
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard schemaKnown(value.schema, name: "murmur.reply-test"), value.agentId == plan.agentId,
              value.peerId == plan.peerId, value.conversationId == plan.conversationId,
              let generated = timestamp(value.generatedAt), abs(generated.timeIntervalSince(now)) <= 30 else { throw ProfileError.invalidResponse }
        if value.state == .replied {
            guard let requestID = value.requestMsgId, !requestID.isEmpty,
                  let replyID = value.replyMsgId, !replyID.isEmpty,
                  let received = value.receivedAt.flatMap(timestamp), let start = timestamp(plan.createdAt), let end = timestamp(plan.expiresAt),
                  received >= start.addingTimeInterval(-5), received <= min(end, now.addingTimeInterval(5)) else { throw ProfileError.invalidResponse }
        } else if value.replyMsgId != nil || value.receivedAt != nil { throw ProfileError.invalidResponse }
        if value.state == .waiting && (value.requestMsgId?.isEmpty ?? true) { throw ProfileError.invalidResponse }
        return value
    }
}

/// Presentation calls the shared setup engine; it never opens client files or SQLite.
public struct ClientSetupClient: Sendable {
    private let bound: ProfileClient, probe: CLIProbe
    public let profile: ProfileBinding
    public init(executable: URL, profile: ProfileBinding, environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.profile = profile
        bound = ProfileClient(executable: executable, profile: profile, environment: environment)
        probe = CLIProbe(executable: executable, timeout: 8, profile: profile, environment: environment)
    }
    private func verify(_ agentID: String) throws {
        guard try bound.verifiedAgent(in: bound.readStatus()) == agentID else { throw ProfileError.identityChanged }
    }
    public func detect(expectedAgent: String) throws -> [DetectedAIClient] {
        try verify(expectedAgent)
        struct List: Decodable { let schema: String; let clients: [DetectedAIClient] }
        let list = try JSONDecoder().decode(List.self, from: probe.invoke(["clients", "detect"]).data)
        guard schemaKnown(list.schema, name: "murmur.clients"), Set(list.clients.map(\.id)).count == list.clients.count,
              list.clients.allSatisfy({ $0.configPath.map(explicitAbsolutePath) ?? true }) else { throw ProfileError.invalidResponse }
        return list.clients
    }
    public func preview(_ client: AIClientKind, expectedAgent: String) throws -> ClientConfigurationPlan {
        try verify(expectedAgent)
        return try ClientConfigurationPlan.decode(probe.invoke(["clients", "preview", "--client", client.rawValue]).data,
                                                 profile: profile, agentID: expectedAgent, client: client)
    }
    public func configure(_ plan: ClientConfigurationPlan, expectedAgent: String) throws -> ClientConfigurationReceipt {
        guard plan.agentId == expectedAgent, plan.dataDir == profile.dataDirectory else { throw ProfileError.identityChanged }
        try verify(expectedAgent)
        let argv = ["clients", "configure", "--client", plan.client.rawValue, "--plan-id", plan.planId]
            + (plan.action == .replace ? ["--replace"] : [])
        return try ClientConfigurationReceipt.decode(probe.invoke(argv).data, plan: plan)
    }
    public func prepareTest(peerID: String, expectedAgent: String) throws -> ReplyTestPlan {
        try verify(expectedAgent)
        return try ReplyTestPlan.decode(probe.invoke(["reply-test", "prepare", "--peer", peerID]).data, agentID: expectedAgent, peerID: peerID)
    }
    public func checkTest(_ plan: ReplyTestPlan, expectedAgent: String) throws -> ReplyTestObservation {
        guard plan.agentId == expectedAgent else { throw ProfileError.identityChanged }
        try verify(expectedAgent)
        return try ReplyTestObservation.decode(probe.invoke(["reply-test", "check", "--test-token", plan.token]).data, plan: plan)
    }
}
