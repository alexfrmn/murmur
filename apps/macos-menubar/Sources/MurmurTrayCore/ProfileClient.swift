import Foundation
import Darwin

func explicitAbsolutePath(_ value: String) -> Bool {
    value.hasPrefix("/") && value != "/" &&
        !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) &&
        value.split(separator: "/", omittingEmptySubsequences: false).dropFirst()
            .allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
}

// Validate a CLI result using POSIX realpath. Foundation's URL standardization
// strips /private on macOS, so it is not equivalent to the CLI's realpath.
func existingRealPath(_ value: String) -> String? {
    guard let pointer = realpath(value, nil) else { return nil }
    defer { free(pointer) }
    return String(cString: pointer)
}

public enum ProfileError: Error, LocalizedError, Sendable {
    case absoluteDirectoryRequired, invalidServiceName, invalidCLI, invalidTimeout, unsupportedCommand
    case unverified, identityChanged, stale, invalidResponse

    public var errorDescription: String? {
        switch self {
        case .absoluteDirectoryRequired: L10n.text("Choose a profile folder using its full path")
        case .invalidServiceName: L10n.text("The selected profile has an invalid service name")
        case .invalidCLI: L10n.text("No Murmur CLI executable was selected")
        case .invalidTimeout: L10n.text("Invalid command timeout")
        case .unsupportedCommand: L10n.text("This command is not supported by the menu app")
        case .unverified: L10n.text("The profile is not verified. Check its settings with Murmur CLI")
        case .identityChanged: L10n.text("The agent in this folder has changed. Select the profile again")
        case .stale: L10n.text("No recent status is available for the selected profile")
        case .invalidResponse: L10n.text("The command result was not confirmed. Refresh status before trying again")
        }
    }
}

/// An explicit selection, not a second implementation of the CLI path resolver.
public struct ProfileBinding: Equatable, Sendable {
    public let dataDirectory: String
    public let serviceName: String?

    public init(dataDirectory: String, serviceName: String? = nil) throws {
        guard explicitAbsolutePath(dataDirectory) else {
            throw ProfileError.absoluteDirectoryRequired
        }
        if let serviceName {
            guard serviceName.range(of: "\\A[A-Za-z0-9][A-Za-z0-9._-]{0,100}\\z", options: .regularExpression) != nil else {
                throw ProfileError.invalidServiceName
            }
        }
        self.dataDirectory = dataDirectory
        self.serviceName = serviceName
    }

    var arguments: [String] {
        ["--data-dir", dataDirectory] + (serviceName.map { ["--service-name", $0] } ?? [])
    }
}

public enum ControlAction: String, CaseIterable, Sendable {
    case pause, resume, start, stop
    var arguments: [String] {
        switch self {
        case .pause: ["wake", "pause"]
        case .resume: ["wake", "resume"]
        case .start: ["service", "start"]
        case .stop: ["service", "stop"]
        }
    }
    public var title: String {
        switch self {
        case .pause: L10n.text("Pause agent delivery")
        case .resume: L10n.text("Resume agent delivery")
        case .start: L10n.text("Start service")
        case .stop: L10n.text("Stop service")
        }
    }
}

public struct ControlReceipt: Sendable {
    public let message: String
    public let restartRequired: Bool?

    static func decode(_ data: Data, for action: ControlAction) throws -> Self {
        struct Wake: Decodable {
            let schema: String, configuredEnabled: Bool, effectiveEnabled: Bool?, restartRequired: Bool
            let applyError: String?
        }
        struct Service: Decodable {
            let schema: String, action: String, service: StatusSnapshot.Service
        }
        switch action {
        case .pause, .resume:
            guard let value = try? JSONDecoder().decode(Wake.self, from: data),
                  schemaKnown(value.schema, name: "murmur.wake"), value.configuredEnabled == (action == .resume),
                  value.applyError == nil else { throw ProfileError.invalidResponse }
            let message = action == .pause ? L10n.text("Pause saved in settings") : L10n.text("Resume saved in settings")
            return Self(message: message + L10n.text(". Status shows the effective mode"), restartRequired: value.restartRequired)
        case .start, .stop:
            guard let value = try? JSONDecoder().decode(Service.self, from: data),
                  schemaKnown(value.schema, name: "murmur.service"), value.action == action.rawValue,
                  value.service.state != nil else { throw ProfileError.invalidResponse }
            return Self(message: L10n.text("Command %@ completed. Status shows the result", String(describing: (action.title.lowercased()))), restartRequired: nil)
        }
    }
}

/// Only identity-validated observations may be published for the selected profile.
/// A failed observation retains the pinned identity, never the rejected counters.
public struct ProfileStatusRead: Sendable {
    public let status: StatusSnapshot?
    public let agentID: String?
    public let error: Verdict?
}

public struct ServiceSetupError: Error, LocalizedError, Sendable {
    public let reason: String
    public var errorDescription: String? {
        L10n.text("Service installed; startup could not be confirmed. %@", reason)
    }
}

/// One bound CLI executable/profile for reads and controls. No config or SQLite access.
public struct ProfileClient: Sendable {
    public let executable: URL
    public let profile: ProfileBinding
    private let environment: [String: String]
    private let statusTimeout: TimeInterval, actionTimeout: TimeInterval, doctorTimeout: TimeInterval

    public init(executable: URL, profile: ProfileBinding,
                environment: [String: String] = ProcessInfo.processInfo.environment,
                statusTimeout: TimeInterval = 5, actionTimeout: TimeInterval = 20, doctorTimeout: TimeInterval = 30) {
        self.executable = executable; self.profile = profile; self.environment = environment
        self.statusTimeout = statusTimeout; self.actionTimeout = actionTimeout; self.doctorTimeout = doctorTimeout
    }

    private func probe(timeout: TimeInterval) -> CLIProbe {
        CLIProbe(executable: executable, timeout: timeout, profile: profile, environment: environment)
    }
    public func readStatus() throws -> StatusSnapshot {
        try StatusSnapshot.decode(probe(timeout: statusTimeout).run("status").data)
    }
    public func readProfileStatus(expectedAgent: String?) -> ProfileStatusRead {
        do {
            let snapshot = try readStatus()
            let actualID = try verifiedAgent(in: snapshot)
            if let expectedAgent, expectedAgent != actualID { throw ProfileError.identityChanged }
            return ProfileStatusRead(status: snapshot, agentID: actualID, error: nil)
        } catch {
            return ProfileStatusRead(status: nil, agentID: expectedAgent, error: .unavailable(error))
        }
    }
    public func readDoctor() throws -> DoctorSnapshot {
        try DoctorSnapshot.decode(probe(timeout: doctorTimeout).run("doctor").data)
    }
    public func verifiedAgent(in snapshot: StatusSnapshot, now: Date = Date()) throws -> String {
        guard let id = snapshot.agentId,
              id.range(of: "\\A[A-Za-z0-9][A-Za-z0-9_-]{0,127}\\z", options: .regularExpression) != nil else {
            throw ProfileError.unverified
        }
        guard let at = timestamp(snapshot.generatedAt), now.timeIntervalSince(at) <= 120,
              at.timeIntervalSince(now) <= 5 else { throw ProfileError.stale }
        return id
    }
    public func perform(_ action: ControlAction, expectedAgent: String) throws -> ControlReceipt {
        // The identity shown when the user clicked must still belong to this profile.
        let fresh = try readStatus()
        guard try verifiedAgent(in: fresh) == expectedAgent else { throw ProfileError.identityChanged }
        if action == .pause || action == .resume {
            guard fresh.wake.config.enabled != nil else { throw ProfileError.unverified }
        }
        let result = try probe(timeout: actionTimeout).invoke(action.arguments)
        return try ControlReceipt.decode(result.data, for: action)
    }


    /// Explicit first-run action. Recheck identity between installation and start.
    public func installAndStart(expectedAgent: String) throws -> ControlReceipt {
        let fresh = try readStatus()
        guard try verifiedAgent(in: fresh) == expectedAgent else { throw ProfileError.identityChanged }
        let data = try probe(timeout: actionTimeout).invoke(["service", "install"]).data
        struct Installed: Decodable { let schema: String, action: String, service: StatusSnapshot.Service }
        guard let value = try? JSONDecoder().decode(Installed.self, from: data),
              schemaKnown(value.schema, name: "murmur.service"), value.action == "install",
              value.service.state != nil else { throw ProfileError.invalidResponse }
        do { return try perform(.start, expectedAgent: expectedAgent) }
        catch { throw ServiceSetupError(reason: error.localizedDescription) }
    }

    public func logDirectory(expectedAgent: String) throws -> URL {
        let fresh = try readStatus()
        guard try verifiedAgent(in: fresh) == expectedAgent else { throw ProfileError.identityChanged }
        let data = try probe(timeout: statusTimeout).invoke(["logs", "path"]).data
        struct Logs: Decodable {
            let schema: String, agentId: String, dataDir: String, serviceName: String, logDir: String, source: String
        }
        guard let value = try? JSONDecoder().decode(Logs.self, from: data),
              schemaKnown(value.schema, name: "murmur.logs"), value.source == "configured",
              value.agentId == expectedAgent,
              profile.serviceName == nil || profile.serviceName == value.serviceName else { throw ProfileError.invalidResponse }
        // Verify the CLI's returned directory; never derive a log path ourselves.
        guard let selected = existingRealPath(profile.dataDirectory) else { throw ProfileError.invalidResponse }
        let logs = URL(fileURLWithPath: value.logDir)
        guard value.dataDir == selected, value.logDir.hasPrefix(selected + "/"),
              explicitAbsolutePath(value.logDir), existingRealPath(value.logDir) == value.logDir else {
            throw ProfileError.invalidResponse
        }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: value.logDir, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw ProfileError.invalidResponse
        }
        return logs
    }
}
