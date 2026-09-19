import Foundation

public enum UpdateError: Error, LocalizedError, Sendable {
    case invalidResponse, invalidReleasePage
    public var errorDescription: String? {
        switch self {
        case .invalidResponse: "CLI вернул неподтверждённый результат проверки обновлений"
        case .invalidReleasePage: "CLI не подтвердил официальную страницу релиза"
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
        if !enabled && reason == "updates.disabled" { return "Проверка обновлений отключена" }
        if state != .unknown && expired(now: now) { return "Результат проверки обновлений устарел" }
        switch state {
        case .available: return "Доступна версия \(latestVersion ?? "неизвестно")"
        case .current: return "Более нового стабильного релиза не найдено"
        case .unknown: return "Обновления: проверить не удалось"
        }
    }
    public var reasonText: String {
        switch reason {
        case "updates.disabled": "Автоматическая проверка выключена"
        case "updates.current-version-invalid": "CLI не определил версию продукта"
        case "updates.preferences-unavailable": "Настройка проверки недоступна"
        case "updates.cache-invalid": "Сохранённый результат некорректен"
        case "updates.cache-unavailable": "Сохранённый результат недоступен"
        case "updates.check-in-progress": "Проверка уже идёт в другом процессе"
        case "updates.interrupted": "Предыдущая проверка была прервана"
        case "updates.network-error": "Не удалось связаться с GitHub"
        case "updates.timeout": "GitHub не ответил вовремя"
        case "updates.rate-limited": "GitHub ограничил частоту запросов"
        case "updates.http-error": "GitHub вернул ошибку"
        case "updates.release-invalid": "Ответ GitHub не подтвердил стабильный релиз"
        case "updates.newer-release": "Есть более новый стабильный релиз"
        case "updates.no-newer-release": "Сравнение по объявленному номеру релиза"
        default: "CLI сообщил: \(reason)"
        }
    }
    public func ageText(now: Date = Date()) -> String {
        guard let checkedAt, let date = timestamp(checkedAt) else { return "Сетевая проверка ещё не измерена" }
        let age = max(0, Int(now.timeIntervalSince(date) / 60))
        return "\(cached ? "Из кеша" : "Проверка") · \(age) мин. назад"
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
