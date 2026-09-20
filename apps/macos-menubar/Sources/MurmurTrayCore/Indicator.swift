import Foundation

// Internal presentation states, deliberately NOT a proposed CLI JSON schema.
public enum Indicator: String, CaseIterable, Sendable {
    case unknown, stopped, offline, ready, unread, failed, paused

    public var title: String {
        switch self {
        case .unknown: L10n.text("Status unknown")
        case .stopped: L10n.text("Service stopped")
        case .offline: L10n.text("Broker disconnected")
        case .ready: L10n.text("Murmur is running")
        case .unread: L10n.text("Unread messages")
        case .failed: L10n.text("Needs attention")
        case .paused: L10n.text("Agent delivery paused")
        }
    }

    public var symbol: String {
        switch self {
        case .unknown: "questionmark.circle"
        case .stopped: "stop.circle"
        case .offline: "wifi.exclamationmark"
        case .ready: "checkmark.circle"
        case .unread: "envelope.badge"
        case .failed: "exclamationmark.triangle"
        case .paused: "pause.circle"
        }
    }
}

public enum ProbeError: Error, LocalizedError, Sendable {
    case missingCLI, timedOut, outputLimit, failed(Int32), failedWithReason(Int32, String), invalidJSON, unsupportedSchema

    public var errorDescription: String? {
        switch self {
        case .missingCLI: L10n.text("Murmur CLI was not found")
        case .timedOut: L10n.text("CLI did not respond in time")
        case .outputLimit: L10n.text("CLI response exceeds the size limit")
        case .failed(let code): L10n.text("CLI exited with code %@", String(describing: (code)))
        case .failedWithReason(let code, let reason): L10n.text("CLI exited with code %@: %@", String(describing: (code)), String(describing: (reason)))
        case .invalidJSON: L10n.text("CLI returned invalid JSON")
        case .unsupportedSchema: L10n.text("The shared status / doctor contract is required")
        }
    }
}

public struct ProbeSummary: Sendable {
    public let command: String
    public let byteCount: Int
    public let exitCode: Int32
    public let data: Data
}
