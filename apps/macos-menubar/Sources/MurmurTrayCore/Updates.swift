import Foundation

public enum UpdateError: Error, LocalizedError, Sendable {
    case invalidResponse, invalidReleasePage
    public var errorDescription: String? {
        switch self {
        case .invalidResponse: L10n.text("CLI returned an unverified update result")
        case .invalidReleasePage: L10n.text("CLI did not confirm the official release page")
        }
    }
}

/// A consumer of the shared CLI result. No version comparison, HTTP or cache paths.
public struct UpdateSnapshot: Decodable, Sendable {
    public enum State: String, Decodable, Sendable { case current = "up-to-date", available, unknown }
    public let schema: String, channel: String, versionSource: String, comparison: String
    public let currentVersion: String?, latestVersion: String?, releaseUrl: String?, action: String?
    public let enabled: Bool, state: State, reason: String
    public let checkedAt: String?, lastSuccessAt: String?, nextCheckAt: String?
    public let cached: Bool, stale: Bool
    public let checkIntervalMs: Int, timeoutMs: Int

    public static func decode(_ data: Data) throws -> Self {
        let required: Set<String> = ["schema", "channel", "currentVersion", "versionSource", "comparison", "enabled",
            "state", "reason", "latestVersion", "releaseUrl", "action", "checkedAt", "lastSuccessAt", "nextCheckAt",
            "cached", "stale", "checkIntervalMs", "timeoutMs"]
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              required.isSubset(of: Set(object.keys)),
              let value = try? JSONDecoder().decode(Self.self, from: data),
              schemaKnown(value.schema, name: "murmur.updates"), value.channel == "stable",
              value.versionSource == "root-package-json", value.comparison == "declared-release-version",
              value.checkIntervalMs == 21_600_000, value.timeoutMs == 4_000,
              value.reason.range(of: "\\Aupdates\\.[a-z0-9.-]{1,100}\\z", options: .regularExpression) != nil else {
            throw UpdateError.invalidResponse
        }
        for version in [value.currentVersion, value.latestVersion].compactMap({ $0 }) {
            guard !version.isEmpty, version.count <= 128,
                  !version.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
                throw UpdateError.invalidResponse
            }
        }
        for date in [value.checkedAt, value.lastSuccessAt, value.nextCheckAt].compactMap({ $0 }) {
            guard timestamp(date) != nil else { throw UpdateError.invalidResponse }
        }
        if value.state == .unknown {
            guard value.action == nil, value.releaseUrl == nil else { throw UpdateError.invalidResponse }
        } else {
            guard value.enabled, !value.stale, value.currentVersion != nil, value.latestVersion != nil,
                  value.checkedAt != nil, value.lastSuccessAt != nil else { throw UpdateError.invalidResponse }
            if value.state == .available {
                guard value.reason == "updates.newer-release", value.action == "open-release-page",
                      let page = value.releaseUrl, officialReleasePage(page) != nil else { throw UpdateError.invalidReleasePage }
            } else {
                guard value.reason == "updates.no-newer-release", value.action == nil,
                      value.releaseUrl == nil else { throw UpdateError.invalidResponse }
            }
        }
        return value
    }

    public static func officialReleasePage(_ value: String) -> URL? {
        let prefix = "/alexfrmn/murmur/releases/tag/"
        guard let parts = URLComponents(string: value), parts.scheme == "https", parts.host == "github.com",
              parts.user == nil, parts.password == nil, parts.port == nil, parts.query == nil, parts.fragment == nil,
              parts.percentEncodedPath.hasPrefix(prefix) else { return nil }
        guard let tag = String(parts.percentEncodedPath.dropFirst(prefix.count)).removingPercentEncoding,
              !tag.contains(".."), tag.range(of: "\\A[A-Za-z0-9][A-Za-z0-9._+-]{0,127}\\z", options: .regularExpression) != nil else { return nil }
        return parts.url
    }

    public func expired(now: Date = Date()) -> Bool {
        guard let checkedAt, let checked = timestamp(checkedAt) else { return true }
        return now.timeIntervalSince(checked) > Double(checkIntervalMs) / 1_000 || checked.timeIntervalSince(now) > 5
    }
    public func releasePage(now: Date = Date()) -> URL? {
        guard state == .available, enabled, !stale, !expired(now: now), action == "open-release-page",
              let releaseUrl else { return nil }
        return Self.officialReleasePage(releaseUrl)
    }
    public func title(now: Date = Date()) -> String {
        if !enabled && reason == "updates.disabled" { return L10n.text("Update checks are disabled") }
        if state != .unknown && expired(now: now) { return L10n.text("The update result is stale") }
        switch state {
        case .available: return L10n.text("Version %@ is available", String(describing: (latestVersion ?? L10n.text("unknown"))))
        case .current: return L10n.text("No newer stable release was found")
        case .unknown: return L10n.text("Updates could not be checked")
        }
    }
    public var reasonText: String {
        switch reason {
        case "updates.disabled": L10n.text("Automatic checks are disabled")
        case "updates.current-version-invalid": L10n.text("CLI could not determine the product version")
        case "updates.preferences-unavailable": L10n.text("The update preference is unavailable")
        case "updates.cache-invalid": L10n.text("The saved result is invalid")
        case "updates.cache-unavailable": L10n.text("The saved result is unavailable")
        case "updates.check-in-progress": L10n.text("Another process is already checking")
        case "updates.interrupted": L10n.text("The previous check was interrupted")
        case "updates.network-error": L10n.text("Could not reach GitHub")
        case "updates.timeout": L10n.text("GitHub did not respond in time")
        case "updates.rate-limited": L10n.text("GitHub limited the request rate")
        case "updates.http-error": L10n.text("GitHub returned an error")
        case "updates.release-invalid": L10n.text("GitHub did not confirm a stable release")
        case "updates.newer-release": L10n.text("A newer stable release is available")
        case "updates.no-newer-release": L10n.text("Compared using the declared release version")
        default: L10n.text("CLI reported: %@", String(describing: (reason)))
        }
    }
    public func ageText(now: Date = Date()) -> String {
        guard let checkedAt, let date = timestamp(checkedAt) else { return L10n.text("No network check has been recorded") }
        let age = max(0, Int(now.timeIntervalSince(date) / 60))
        return L10n.text("%@ · %@ minutes ago", String(describing: (cached ? L10n.text("Cached") : L10n.text("Checked"))), String(describing: (age)))
    }
}

public struct UpdatesClient: Sendable {
    public let executable: URL
    public let forcedOff: Bool
    private let environment: [String: String]
    private let timeout: TimeInterval
    public init(executable: URL, environment: [String: String] = ProcessInfo.processInfo.environment,
                timeout: TimeInterval = 6) {
        self.executable = executable; self.environment = environment; self.timeout = timeout
        forcedOff = environment["MURMUR_UPDATE_CHECK"] == "0"
    }
    public func check() throws -> UpdateSnapshot {
        let result = try CLIProbe(executable: executable, timeout: timeout, environment: environment).invoke(["updates", "check"])
        return try UpdateSnapshot.decode(result.data)
    }
    public func setEnabled(_ enabled: Bool) throws {
        let result = try CLIProbe(executable: executable, timeout: timeout, environment: environment)
            .invoke(["updates", enabled ? "enable" : "disable"])
        struct Preference: Decodable { let schema: String, enabled: Bool }
        guard let value = try? JSONDecoder().decode(Preference.self, from: result.data),
              schemaKnown(value.schema, name: "murmur.update-preferences"), value.enabled == enabled else {
            throw UpdateError.invalidResponse
        }
    }
}
