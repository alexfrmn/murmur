import Foundation

public enum OnboardingError: Error, LocalizedError, Sendable {
    case invalidAgent, invalidServer, invalidFile, unsafeLocation, replyExists, invalidReceipt
    public var errorDescription: String? {
        switch self {
        case .invalidAgent: L10n.text("Use an agent name with letters, numbers, hyphens or underscores")
        case .invalidServer: L10n.text("Enter the nats:// or tls:// server address supplied by your team")
        case .invalidFile: L10n.text("Choose a readable Murmur invitation or access file")
        case .unsafeLocation: L10n.text("Murmur could not use its private profile folder")
        case .replyExists: L10n.text("A reply file already exists. Choose the created profile to continue")
        case .invalidReceipt: L10n.text("Profile creation was not confirmed. Your files were kept")
        }
    }
}

/// A new, explicit profile selection. Config, keys and service paths remain CLI-owned.
public struct NewProfilePlan: Equatable, Sendable {
    public let agentID: String
    public let profile: ProfileBinding
    public let replyFile: URL
    let applicationDirectory: URL
    let identifier: UUID
    public var applicationRoot: URL { applicationDirectory }

    public static func suggestedAgentID() -> String { "mac-" + UUID().uuidString.lowercased().prefix(12) }

    public init(applicationDirectory: URL, agentID: String = Self.suggestedAgentID()) throws {
        try self.init(applicationDirectory: applicationDirectory, agentID: agentID, identifier: UUID())
    }
    init(applicationDirectory: URL, agentID: String, identifier: UUID) throws {
        guard validNewAgentID(agentID) else { throw OnboardingError.invalidAgent }
        guard applicationDirectory.isFileURL, explicitAbsolutePath(applicationDirectory.path) else {
            throw OnboardingError.unsafeLocation
        }
        self.agentID = agentID; self.applicationDirectory = applicationDirectory; self.identifier = identifier
        let key = identifier.uuidString.lowercased()
        profile = try ProfileBinding(dataDirectory: applicationDirectory.appendingPathComponent("profiles").appendingPathComponent(key).path)
        replyFile = applicationDirectory.appendingPathComponent("replies").appendingPathComponent("Murmur reply - \(agentID) - \(key.prefix(8)).txt")
    }
}

func validNewAgentID(_ value: String) -> Bool {
    value.range(of: "\\A[A-Za-z0-9][A-Za-z0-9_-]{0,127}\\z", options: .regularExpression) != nil
}

/// Creation and an observed identity do not prove connection, pairing or live wake.
public struct CreatedProfile: Sendable {
    public let profile: ProfileBinding
    public let agentID: String
    public let replyFile: URL?
    public let peerID: String?
    public var reply: String? = nil
}

public struct ProfileOnboardingClient: Sendable {
    public let executable: URL
    private let environment: [String: String]
    private let timeout: TimeInterval
    public init(executable: URL, environment: [String: String] = ProcessInfo.processInfo.environment, timeout: TimeInterval = 20) {
        self.executable = executable; self.environment = environment; self.timeout = timeout
    }
    private func probe(_ plan: NewProfilePlan) -> CLIProbe {
        CLIProbe(executable: executable, timeout: timeout, profile: plan.profile, environment: environment)
    }
    private func checkLocation(_ plan: NewProfilePlan) throws {
        for url in [plan.applicationDirectory, URL(fileURLWithPath: plan.profile.dataDirectory).deletingLastPathComponent(),
                    URL(fileURLWithPath: plan.profile.dataDirectory), plan.replyFile.deletingLastPathComponent()] {
            if let values = try? url.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey]),
               values.isSymbolicLink == true || values.isDirectory == false { throw OnboardingError.unsafeLocation }
        }
    }
    private func inputFile(_ file: URL) throws {
        guard file.isFileURL, explicitAbsolutePath(file.path),
              let values = try? file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
              values.isRegularFile == true, values.isSymbolicLink != true,
              let bytes = values.fileSize, bytes > 0, bytes <= 16384,
              FileManager.default.isReadableFile(atPath: file.path) else { throw OnboardingError.invalidFile }
    }
    private func verify(_ plan: NewProfilePlan) throws {
        let client = ProfileClient(executable: executable, profile: plan.profile, environment: environment)
        let snapshot = try client.readStatus()
        guard try client.verifiedAgent(in: snapshot) == plan.agentID else { throw ProfileError.identityChanged }
    }
    public func initialize(_ plan: NewProfilePlan, brokerURL: String, tokenFile: URL? = nil,
                           journal: OnboardingJournal? = nil) throws -> CreatedProfile {
        guard !brokerURL.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              let parts = URLComponents(string: brokerURL), ["nats", "tls"].contains(parts.scheme ?? ""),
              parts.host?.isEmpty == false, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil, parts.path.isEmpty || parts.path == "/" else {
            throw OnboardingError.invalidServer
        }
        try checkLocation(plan)
        var args = ["init", "--agent-id", plan.agentID, "--broker-url", brokerURL]
        if let tokenFile { try inputFile(tokenFile); args += ["--token-file", tokenFile.path] }
        let pending = PendingOnboarding(plan: plan, kind: .ownServer)
        try journal?.save(pending)
        defer { try? journal?.markCommandFinished(pending) }
        let data = try probe(plan).invoke(args).data
        struct Receipt: Decodable { let schema: String, agentId: String, dataDir: String, existing: Bool }
        guard let receipt = try? JSONDecoder().decode(Receipt.self, from: data),
              schemaKnown(receipt.schema, name: "murmur.init"), receipt.agentId == plan.agentID,
              explicitAbsolutePath(receipt.dataDir), let requested = existingRealPath(plan.profile.dataDirectory),
              existingRealPath(receipt.dataDir) == requested else { throw OnboardingError.invalidReceipt }
        try journal?.markCreated(pending)
        try verify(plan)
        return CreatedProfile(profile: plan.profile, agentID: plan.agentID, replyFile: nil, peerID: nil)
    }
    public func join(_ plan: NewProfilePlan, invitation: URL, journal: OnboardingJournal? = nil) throws -> CreatedProfile {
        try join(plan, invitationFile: invitation, invitationLine: nil, journal: journal)
    }
    public func join(_ plan: NewProfilePlan, invitationLine: String, journal: OnboardingJournal? = nil) throws -> CreatedProfile {
        let line = try PairingLine.validated(invitationLine)
        return try join(plan, invitationFile: nil, invitationLine: line, journal: journal)
    }
    private func join(_ plan: NewProfilePlan, invitationFile: URL?, invitationLine: String?,
                      journal: OnboardingJournal?) throws -> CreatedProfile {
        try checkLocation(plan)
        // Refuse an existing output before any profile mutation; CLI also reserves it with O_EXCL.
        guard (try? plan.replyFile.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])) == nil else {
            throw OnboardingError.replyExists
        }
        if let invitationFile { try inputFile(invitationFile) }
        let pending = PendingOnboarding(plan: plan, kind: .invitation)
        try journal?.save(pending)
        defer { try? journal?.markCommandFinished(pending) }
        try FileManager.default.createDirectory(at: plan.replyFile.deletingLastPathComponent(), withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        let inputArgs = invitationFile.map { ["--invite-file", $0.path] } ?? ["--invite-stdin"]
        let data = try probe(plan).invoke(["join", "--agent-id", plan.agentID] + inputArgs +
            ["--reply-out", plan.replyFile.path], input: invitationLine.map { Data($0.utf8) },
            pairingErrors: invitationLine != nil).data
        struct Receipt: Decodable {
            let schema: String, agentId: String, peerId: String, replyFile: String, restartRequired: Bool
            let paired: Bool?
            let reply: String?
        }
        guard let receipt = try? JSONDecoder().decode(Receipt.self, from: data),
              schemaKnown(receipt.schema, name: "murmur.join"), receipt.agentId == plan.agentID,
              validNewAgentID(receipt.peerId), receipt.peerId != plan.agentID, receipt.paired == nil,
              receipt.replyFile == plan.replyFile.path,
              let values = try? plan.replyFile.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
              values.isRegularFile == true, values.isSymbolicLink != true else { throw OnboardingError.invalidReceipt }
        let reply: String?
        if invitationLine != nil {
            guard let returned = receipt.reply else { throw OnboardingError.invalidReceipt }
            reply = try PairingLine.validated(returned)
        } else { reply = nil }
        try journal?.markCreated(pending)
        try verify(plan)
        return CreatedProfile(profile: plan.profile, agentID: plan.agentID, replyFile: plan.replyFile, peerID: receipt.peerId, reply: reply)
    }

    /// Recovery never repeats init/join, even after a malformed receipt or a timeout.
    public func resume(_ pending: PendingOnboarding) throws -> CreatedProfile {
        let plan = pending.plan
        try checkLocation(plan)
        try verify(plan)
        if pending.kind == .invitation {
            guard let values = try? plan.replyFile.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
                  values.isRegularFile == true, values.isSymbolicLink != true,
                  let size = values.fileSize, size > 0 else { throw OnboardingJournalError.missingReply }
        }
        return CreatedProfile(profile: plan.profile, agentID: plan.agentID,
                              replyFile: pending.kind == .invitation ? plan.replyFile : nil, peerID: nil,
                              reply: pending.kind == .invitation ? try? PairingLine.recovered(from: plan.replyFile) : nil)
    }

    /// Both recovery picker and list use a read-only verification before the UI
    /// can persist a selection. Resolve a picker alias before classifying an
    /// app-owned folder, so it still restores the original reply and setup steps.
    public func recoverSelectedProfile(_ selected: ProfileBinding, applicationDirectory: URL) throws -> CreatedProfile {
        guard let canonical = existingRealPath(selected.dataDirectory),
              let values = try? URL(fileURLWithPath: canonical).resourceValues(forKeys: [.isDirectoryKey]),
              values.isDirectory == true else { throw ProfileError.unverified }
        let chosen = try ProfileBinding(dataDirectory: canonical, serviceName: selected.serviceName)
        let root = URL(fileURLWithPath: existingRealPath(applicationDirectory.path) ?? applicationDirectory.path)
        if URL(fileURLWithPath: canonical).deletingLastPathComponent().path == root.appendingPathComponent("profiles").path {
            return try adoptExistingProfile(chosen, applicationDirectory: root)
        }
        // External service names are derived by CLI from the lexical data-dir.
        // Canonicalization may classify the folder, but must not rebind its service.
        let client = ProfileClient(executable: executable, profile: selected, environment: environment)
        let id = try client.verifiedAgent(in: client.readStatus())
        return CreatedProfile(profile: selected, agentID: id, replyFile: nil, peerID: nil)
    }

    /// An explicit selection from the app's old private folders. Recover setup
    /// controls for an orphan without generating a new identity or replaying join.
    public func adoptExistingProfile(_ selected: ProfileBinding, applicationDirectory: URL) throws -> CreatedProfile {
        let folder = URL(fileURLWithPath: selected.dataDirectory)
        guard folder.deletingLastPathComponent().path == applicationDirectory.appendingPathComponent("profiles").path,
              let identifier = UUID(uuidString: folder.lastPathComponent), selected.serviceName == nil,
              existingRealPath(selected.dataDirectory) != nil else { throw OnboardingError.unsafeLocation }
        let client = ProfileClient(executable: executable, profile: selected, environment: environment)
        let id = try client.verifiedAgent(in: client.readStatus())
        let plan = try NewProfilePlan(applicationDirectory: applicationDirectory, agentID: id, identifier: identifier)
        guard plan.profile == selected else { throw OnboardingError.unsafeLocation }
        try checkLocation(plan)
        let values = try? plan.replyFile.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        let hasReply = values?.isRegularFile == true && values?.isSymbolicLink != true && (values?.fileSize ?? 0) > 0
        return CreatedProfile(profile: selected, agentID: id, replyFile: hasReply ? plan.replyFile : nil, peerID: nil)
    }
}
