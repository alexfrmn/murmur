import Foundation
import Darwin

public enum OnboardingKind: String, Codable, Sendable { case invitation, ownServer }

public struct PendingOnboarding: Equatable, Sendable {
    public let plan: NewProfilePlan
    public let kind: OnboardingKind
    public let creationConfirmed: Bool
    public let commandFinished: Bool
    public init(plan: NewProfilePlan, kind: OnboardingKind, creationConfirmed: Bool = false, commandFinished: Bool = false) {
        self.plan = plan; self.kind = kind; self.creationConfirmed = creationConfirmed; self.commandFinished = commandFinished
    }
}

public enum OnboardingJournalError: Error, LocalizedError, Sendable {
    case pendingExists, invalidJournal, filesExist, missingReply
    public var errorDescription: String? {
        switch self {
        case .pendingExists: L10n.text("Continue the saved setup before creating another profile")
        case .invalidJournal: L10n.text("The saved setup could not be read. Your profile files were kept")
        case .filesExist: L10n.text("Profile files already exist. Check the saved profile instead of creating another")
        case .missingReply: L10n.text("The profile exists, but its reply file was not found. Show the saved files to continue")
        }
    }
}

/// A small, private recovery record outside the CLI-owned profile. It contains no
/// invitation, broker credentials, config contents or key material. A record is
/// flushed before mutation; an unreadable or existing record blocks a new plan.
public struct OnboardingJournal: Sendable {
    public let applicationDirectory: URL
    private let beforeDirectorySync: (@Sendable (URL) throws -> Void)?
    private let synchronizer: JournalSynchronizer
    private let onSync: (@Sendable (JournalSyncOutcome) -> Void)?
    public var file: URL { applicationDirectory.appendingPathComponent("pending-setup.json") }
    public init(applicationDirectory: URL, beforeDirectorySync: (@Sendable (URL) throws -> Void)? = nil,
                synchronizer: JournalSynchronizer = JournalSynchronizer(), onSync: (@Sendable (JournalSyncOutcome) -> Void)? = nil) {
        self.applicationDirectory = applicationDirectory; self.beforeDirectorySync = beforeDirectorySync
        self.synchronizer = synchronizer; self.onSync = onSync
    }

    private struct Record: Codable {
        let schema: String
        let identifier: UUID
        let agentID: String
        let kind: OnboardingKind
        let creationConfirmed: Bool
        let commandFinished: Bool
        init(_ pending: PendingOnboarding) {
            schema = "murmur.mac.pending-setup/1"; identifier = pending.plan.identifier
            agentID = pending.plan.agentID; kind = pending.kind; creationConfirmed = pending.creationConfirmed
            commandFinished = pending.commandFinished
        }
    }
    private func validateRoot() throws {
        guard applicationDirectory.isFileURL, explicitAbsolutePath(applicationDirectory.path) else {
            throw OnboardingJournalError.invalidJournal
        }
        if let info = try metadata(applicationDirectory), (info.st_mode & S_IFMT) != S_IFDIR || info.st_uid != geteuid() {
            throw OnboardingJournalError.invalidJournal
        }
    }
    private func metadata(_ url: URL) throws -> stat? {
        var info = stat()
        if lstat(url.path, &info) == 0 { return info }
        if errno == ENOENT { return nil }
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    private func validate(_ pending: PendingOnboarding) throws {
        try validateRoot()
        guard pending.plan.applicationRoot == applicationDirectory else { throw OnboardingJournalError.invalidJournal }
    }
    private func synchronize(_ descriptor: Int32) throws {
        let outcome = synchronizer.synchronize(descriptor)
        onSync?(outcome)
        if case .failed(let code) = outcome { throw NSError(domain: NSPOSIXErrorDomain, code: Int(code)) }
    }
    private func syncDirectory(_ directory: URL) throws {
        // Fault injection observes the same boundaries as the real syscall; it
        // never replaces successful directory synchronization in production/tests.
        try beforeDirectorySync?(directory)
        let descriptor = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        defer { close(descriptor) }
        try synchronize(descriptor)
    }
    private func makeDirectories(_ directory: URL) throws {
        var missing: [URL] = [], candidate = directory
        while try metadata(candidate) == nil {
            missing.append(candidate)
            let parent = candidate.deletingLastPathComponent()
            guard parent != candidate else { throw OnboardingJournalError.invalidJournal }
            candidate = parent
        }
        if !missing.isEmpty {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                   attributes: [.posixPermissions: 0o700])
        }
        guard let directoryInfo = try metadata(directory), (directoryInfo.st_mode & S_IFMT) == S_IFDIR,
              directoryInfo.st_uid == geteuid(), let canonical = existingRealPath(directory.path) else {
            throw OnboardingJournalError.invalidJournal
        }
        // mkdir may have survived an earlier failed parent flush. Existence is
        // not durability evidence: on every attempt recheck the complete path
        // within this filesystem, including ancestors created before a restart.
        // Stop at a mount boundary; this operation never creates mount entries.
        candidate = URL(fileURLWithPath: canonical)
        while true {
            guard let info = try metadata(candidate), (info.st_mode & S_IFMT) == S_IFDIR else {
                throw OnboardingJournalError.invalidJournal
            }
            if info.st_dev != directoryInfo.st_dev { break }
            try syncDirectory(candidate)
            let parent = candidate.deletingLastPathComponent()
            if parent == candidate { break }
            candidate = parent
        }
    }
    public func load() throws -> PendingOnboarding? {
        try validateRoot()
        let descriptor = open(file.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        if descriptor < 0 {
            if errno == ENOENT { return nil }
            throw OnboardingJournalError.invalidJournal
        }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        var info = stat()
        guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
              info.st_uid == geteuid(), (info.st_mode & 0o077) == 0, info.st_nlink == 1,
              info.st_size > 0, info.st_size <= 16384,
              let data = try handle.read(upToCount: 16385), data.count <= 16384,
              let record = try? JSONDecoder().decode(Record.self, from: data), record.schema == "murmur.mac.pending-setup/1" else {
            throw OnboardingJournalError.invalidJournal
        }
        guard let plan = try? NewProfilePlan(applicationDirectory: applicationDirectory,
            agentID: record.agentID, identifier: record.identifier) else { throw OnboardingJournalError.invalidJournal }
        return PendingOnboarding(plan: plan, kind: record.kind,
            creationConfirmed: record.creationConfirmed, commandFinished: record.commandFinished)
    }
    private func write(_ data: Data, to url: URL) throws {
        let descriptor = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else {
            if errno == EEXIST { throw OnboardingJournalError.pendingExists }
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        try handle.write(contentsOf: data)
        try synchronize(descriptor)
    }
    public func save(_ pending: PendingOnboarding) throws {
        try validate(pending)
        try makeDirectories(applicationDirectory)
        // O_EXCL retains an earlier or damaged record instead of silently replacing its identity.
        try write(JSONEncoder().encode(Record(pending)), to: file)
        try syncDirectory(applicationDirectory)
    }
    public func markCreated(_ pending: PendingOnboarding) throws {
        try update(pending, created: true)
    }
    public func markCommandFinished(_ pending: PendingOnboarding) throws {
        try update(pending, finished: true)
    }
    private func update(_ pending: PendingOnboarding, created: Bool = false, finished: Bool = false) throws {
        try validate(pending)
        guard let current = try load(), current.plan == pending.plan, current.kind == pending.kind else {
            throw OnboardingJournalError.invalidJournal
        }
        let confirmed = PendingOnboarding(plan: pending.plan, kind: pending.kind,
            creationConfirmed: current.creationConfirmed || created, commandFinished: current.commandFinished || finished)
        let staging = applicationDirectory.appendingPathComponent(".pending-setup-\(UUID().uuidString).tmp")
        try write(JSONEncoder().encode(Record(confirmed)), to: staging)
        defer { _ = unlink(staging.path) }
        guard rename(staging.path, file.path) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        try syncDirectory(applicationDirectory)
    }
    /// Called only after the UI has durably saved the selected profile and setup steps.
    public func clear(_ pending: PendingOnboarding) throws {
        try validate(pending)
        guard let current = try load(), current.plan == pending.plan, current.kind == pending.kind else {
            throw OnboardingJournalError.invalidJournal
        }
        guard unlink(file.path) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        try syncDirectory(applicationDirectory)
    }
    public func canDiscard(_ pending: PendingOnboarding) -> Bool {
        do {
            try validate(pending)
            // An interrupted GUI may have left the CLI alive. Empty paths alone
            // are not evidence that it is safe to allocate a different identity.
            guard try load() == pending, pending.commandFinished, !pending.creationConfirmed,
                  try metadata(pending.plan.replyFile) == nil else { return false }
            let directory = URL(fileURLWithPath: pending.plan.profile.dataDirectory)
            if let info = try metadata(directory) {
                guard (info.st_mode & S_IFMT) == S_IFDIR else { return false }
                return try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty
            }
            return true
        } catch { return false }
    }
    public func discardIfUntouched(_ pending: PendingOnboarding) throws {
        guard canDiscard(pending) else { throw OnboardingJournalError.filesExist }
        try clear(pending) // Never removes a profile folder, reply or CLI-owned file.
    }
    public var canArchiveRecord: Bool {
        do {
            try validateRoot()
            guard let info = try metadata(file) else { return false }
            return (info.st_mode & S_IFMT) == S_IFREG && info.st_uid == geteuid() && info.st_nlink == 1
        } catch { return false }
    }
    /// Explicit user recovery, separate from retry. Preserve even a damaged record
    /// privately; never decode it as a new plan or touch profile/reply/key files.
    public func archiveRecord() throws -> URL {
        guard canArchiveRecord else { throw OnboardingJournalError.invalidJournal }
        let descriptor = open(file.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard descriptor >= 0 else { throw OnboardingJournalError.invalidJournal }
        defer { close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
              info.st_uid == geteuid(), info.st_nlink == 1,
              fchmod(descriptor, 0o600) == 0 else {
            throw OnboardingJournalError.invalidJournal
        }
        try synchronize(descriptor)
        let folder = applicationDirectory.appendingPathComponent("saved-setup-records")
        try makeDirectories(folder)
        guard let parent = try metadata(folder), (parent.st_mode & S_IFMT) == S_IFDIR,
              parent.st_uid == geteuid(), (parent.st_mode & 0o077) == 0,
              let current = try metadata(file), current.st_ino == info.st_ino, current.st_dev == info.st_dev else {
            throw OnboardingJournalError.invalidJournal
        }
        let archive = folder.appendingPathComponent("pending-setup-\(UUID().uuidString.lowercased()).json")
        guard renamex_np(file.path, archive.path, UInt32(RENAME_EXCL)) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        try syncDirectory(folder)
        try syncDirectory(applicationDirectory)
        return archive
    }
    /// Old app-created UUID folders remain visible even when their CLI status is
    /// unreadable. Metadata discovery neither reads keys nor claims a profile is unused.
    public func existingProfiles() throws -> [ProfileBinding] {
        try validateRoot()
        let root = applicationDirectory.appendingPathComponent("profiles")
        guard let info = try metadata(root) else { return [] }
        guard (info.st_mode & S_IFMT) == S_IFDIR else { throw OnboardingJournalError.invalidJournal }
        return try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
            .sorted { $0.lastPathComponent < $1.lastPathComponent }.compactMap { url in
                guard UUID(uuidString: url.lastPathComponent) != nil, let info = try metadata(url),
                      (info.st_mode & S_IFMT) == S_IFDIR,
                      try !FileManager.default.contentsOfDirectory(atPath: url.path).isEmpty else { return nil }
                return try ProfileBinding(dataDirectory: url.path)
            }
    }
}
