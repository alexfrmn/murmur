import Foundation

public enum PairingError: Error, LocalizedError, Sendable, Equatable {
    case damaged, tooLarge, publicServerRequired, invalidServer, differentServer, wrongReply, confirmationRequired, unconfirmed, failed

    static func from(code: String?) -> Self {
        switch code {
        case "onboarding.input-too-large": .tooLarge
        case "onboarding.invite-public-server-required": .publicServerRequired
        case "onboarding.invite-server-address-invalid": .invalidServer
        case "onboarding.existing-profile-conflict": .differentServer
        case "onboarding.invalid-blob", "onboarding.invalid-peer", "onboarding.invalid-peer-key", "onboarding.invalid-broker": .damaged
        case "onboarding.self-peer", "onboarding.peer-key-conflict": .wrongReply
        default: .failed
        }
    }
    public var errorDescription: String? {
        switch self {
        case .damaged: L10n.text("This line is damaged. Paste one complete Invitation or Reply sent by your colleague.")
        case .tooLarge: L10n.text("This line is too long. Ask your colleague for a new Invitation or Reply.")
        case .publicServerRequired: L10n.text("Your colleague needs a public Server address. Ask the person who manages your Server for it.")
        case .invalidServer: L10n.text("Enter a public Server address without an access key, then try again.")
        case .differentServer: L10n.text("This Invitation uses a different Server. Ask your colleague for an Invitation for the Server you already use.")
        case .wrongReply: L10n.text("This Reply does not match the Contact. Ask your colleague for a new Reply.")
        case .confirmationRequired: L10n.text("Confirm that you will send this Invitation personally before copying it.")
        case .unconfirmed: L10n.text("The Contact could not be confirmed. Refresh the status before trying again.")
        case .failed: L10n.text("Murmur could not finish pairing. Check the saved Identity and ask your colleague for a new line.")
        }
    }
    public static func message(for error: Error) -> String {
        if let known = error as? Self { return known.localizedDescription }
        if let known = error as? OnboardingError { return known.localizedDescription }
        return Self.failed.localizedDescription
    }
}

public enum PairingLine {
    public static let maximumBytes = 16 * 1024
    public static func validated(_ input: String) throws -> String {
        guard input.utf8.count <= maximumBytes else { throw PairingError.tooLarge }
        let pattern = try NSRegularExpression(pattern: "MURMUR:[A-Za-z0-9_-]+=*")
        let matches = pattern.matches(in: input, range: NSRange(input.startIndex..., in: input))
        guard matches.count == 1, let range = Range(matches[0].range, in: input) else {
            throw PairingError.damaged
        }
        return String(input[range])
    }
    // Private recovery copy, never a file exchange step in the interface.
    public static func recovered(from file: URL) throws -> String {
        let info = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard info.isRegularFile == true, info.isSymbolicLink != true,
              let size = info.fileSize, size <= maximumBytes else { throw PairingError.damaged }
        return try validated(String(contentsOf: file, encoding: .utf8))
    }
}

public struct PairingJoin: Sendable {
    public let peerID: String
    public let reply: String
}

public struct PairingInvitation: Sendable {
    private let line: String
    public let containsBrokerCredential: Bool
    init(data: Data) throws {
        struct Receipt: Decodable { let schema: String, invitation: String, containsBrokerCredential: Bool }
        guard let value = try? JSONDecoder().decode(Receipt.self, from: data),
              schemaKnown(value.schema, name: "murmur.invite") else { throw PairingError.unconfirmed }
        line = try PairingLine.validated(value.invitation)
        containsBrokerCredential = value.containsBrokerCredential
    }
    public func lineForCopy(confirmedPersonalSharing: Bool) throws -> String {
        guard !containsBrokerCredential || confirmedPersonalSharing else { throw PairingError.confirmationRequired }
        return line
    }
}

/// The same pinned Identity must survive every pairing operation. A Contact in
/// status is pairing evidence, not proof of a successful exchange or Wake-up.
public struct ProfilePairingClient: Sendable {
    private let client: ProfileClient
    private let probe: CLIProbe
    public init(executable: URL, profile: ProfileBinding,
                environment: [String: String] = ProcessInfo.processInfo.environment, timeout: TimeInterval = 20) {
        client = ProfileClient(executable: executable, profile: profile, environment: environment)
        probe = CLIProbe(executable: executable, timeout: timeout, profile: profile, environment: environment)
    }
    private func verified(_ identity: String) throws -> StatusSnapshot {
        let status = try client.readStatus()
        guard try client.verifiedAgent(in: status) == identity else { throw PairingError.unconfirmed }
        return status
    }
    public func invite(expectedAgent: String, publicServer: String? = nil) throws -> PairingInvitation {
        _ = try verified(expectedAgent)
        var args = ["invite"]
        if let publicServer {
            var address = publicServer.trimmingCharacters(in: .whitespacesAndNewlines)
            if !address.contains("://") { address = "nats://" + address }
            guard !address.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) }),
                  let parts = URLComponents(string: address), ["nats", "tls"].contains(parts.scheme ?? ""),
                  parts.host?.isEmpty == false, parts.user == nil, parts.password == nil,
                  parts.query == nil, parts.fragment == nil, parts.path.isEmpty || parts.path == "/" else {
                throw PairingError.invalidServer
            }
            args += ["--broker", address]
        }
        let invitation = try PairingInvitation(data: probe.invoke(args, pairingErrors: true).data)
        _ = try verified(expectedAgent)
        return invitation
    }
    public func addReply(_ input: String, expectedAgent: String) throws -> String {
        let line = try PairingLine.validated(input)
        _ = try verified(expectedAgent)
        let data = try probe.invoke(["add-peer", "--reply-stdin"], input: Data(line.utf8), pairingErrors: true).data
        struct Receipt: Decodable { let schema: String, peerId: String }
        guard let value = try? JSONDecoder().decode(Receipt.self, from: data),
              schemaKnown(value.schema, name: "murmur.peer"), value.peerId != expectedAgent,
              !value.peerId.isEmpty else { throw PairingError.unconfirmed }
        guard try verified(expectedAgent).peers.list?.contains(where: { $0.agentId == value.peerId }) == true else {
            throw PairingError.unconfirmed
        }
        return value.peerId
    }
    public func joinInvitation(_ input: String, expectedAgent: String) throws -> PairingJoin {
        let line = try PairingLine.validated(input)
        _ = try verified(expectedAgent)
        // Reuse the selected profile and Identity; never initialize a new one here.
        let data = try probe.invoke(["join", "--agent-id", expectedAgent, "--invite-stdin"],
                                    input: Data(line.utf8), pairingErrors: true).data
        struct Receipt: Decodable {
            let schema: String, agentId: String, peerId: String, reply: String
            let paired: Bool?
        }
        guard let value = try? JSONDecoder().decode(Receipt.self, from: data),
              schemaKnown(value.schema, name: "murmur.join"), value.agentId == expectedAgent,
              validNewAgentID(value.peerId), value.peerId != expectedAgent, value.paired == nil else {
            throw PairingError.unconfirmed
        }
        let reply = try PairingLine.validated(value.reply)
        guard try verified(expectedAgent).peers.list?.contains(where: { $0.agentId == value.peerId }) == true else {
            throw PairingError.unconfirmed
        }
        return PairingJoin(peerID: value.peerId, reply: reply)
    }
}
