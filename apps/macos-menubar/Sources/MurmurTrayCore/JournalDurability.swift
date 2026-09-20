import Foundation
import Darwin

public enum JournalSyncOutcome: Equatable, Sendable {
    case full, fsyncFallback(Int32), failed(Int32)

    public var diagnosticValue: String {
        switch self {
        case .full: "F_FULLFSYNC"
        case .fsyncFallback(let code): "fsync-only(errno=\(code))"
        case .failed(let code): "failed(errno=\(code))"
        }
    }
    fileprivate var storedValue: String {
        switch self {
        case .full: "full"
        case .fsyncFallback(let code): "fallback:\(code)"
        case .failed(let code): "failed:\(code)"
        }
    }
    fileprivate init?(stored: String) {
        if stored == "full" { self = .full; return }
        let parts = stored.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, let code = Int32(parts[1]), code > 0, code < 4096 else { return nil }
        if parts[0] == "fallback", code == EINVAL || code == ENOTSUP { self = .fsyncFallback(code) }
        else if parts[0] == "failed" { self = .failed(code) }
        else { return nil }
    }
}

/// A cold-path journal flush. Unsupported full flush can retain a completed
/// fsync; actual I/O failures never become a successful downgrade. This does
/// not promise power-loss atomicity for CLI-owned config/reply or preferences.
public struct JournalSynchronizer: Sendable {
    private let regular: @Sendable (Int32) -> Int32?
    private let full: @Sendable (Int32) -> Int32?

    public init(regular: @escaping @Sendable (Int32) -> Int32? = { fd in Darwin.fsync(fd) == 0 ? nil : errno },
                full: @escaping @Sendable (Int32) -> Int32? = { fd in Darwin.fcntl(fd, F_FULLFSYNC) == 0 ? nil : errno }) {
        self.regular = regular; self.full = full
    }
    public func synchronize(_ descriptor: Int32) -> JournalSyncOutcome {
        if let error = regular(descriptor) { return .failed(error) }
        if let error = full(descriptor) {
            if error == EINVAL || error == ENOTSUP { return .fsyncFallback(error) }
            return .failed(error)
        }
        return .full
    }
}

/// Allowlisted, non-secret diagnostic history. A later full flush does not erase
/// the fact that this installation previously fell back to ordinary fsync.
public enum JournalSyncDiagnostics {
    public static func record(_ outcome: JournalSyncOutcome, preferences: UserDefaults = .standard) {
        preferences.set(outcome.storedValue, forKey: "onboardingJournalSyncLatest")
        if case .fsyncFallback = outcome {
            preferences.set(outcome.storedValue, forKey: "onboardingJournalSyncPreviousFallback")
        }
        _ = preferences.synchronize()
    }
    public static func lines(preferences: UserDefaults = .standard) -> [String] {
        let latest = preferences.string(forKey: "onboardingJournalSyncLatest").flatMap(JournalSyncOutcome.init(stored:))
        var lines = ["journal-sync.latest=\(latest?.diagnosticValue ?? "not-observed")"]
        if let stored = preferences.string(forKey: "onboardingJournalSyncPreviousFallback"),
           let prior = JournalSyncOutcome(stored: stored), case .fsyncFallback = prior {
            lines.append("journal-sync.previous-fallback=\(prior.diagnosticValue)")
        }
        return lines
    }
}
