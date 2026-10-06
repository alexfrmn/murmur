import Foundation

/// Operator configuration of the optional companion edition.
///
/// A stock build carries none of these Info.plist keys: the edition stays off, the stock window and
/// home are used, and no host, path, person, conversation or dashboard URL exists in the app. An
/// edition build stamps the keys at packaging time (`packaging/stamp-aim-edition.py`). Every value is
/// validated here; an invalid value is dropped instead of reaching a shell command or a URL.
public struct AIMEditionConfig: Sendable, Equatable {
    /// `AIMShellEdition`: presence turns the edition on.
    public var edition: Int?
    /// `AIMOwnerSSHHost`: the owner's existing SSH alias. No alias, no server reads or sends.
    public var ownerHost: String?
    /// `AIMServerRoot`: helper directory relative to the owner's home on that host.
    public var serverRoot: String
    /// `AIMServerDatabase`: Murmur store relative to the owner's home, read-only, for wake diagnostics.
    public var serverDatabase: String?
    /// `AIMServerLabel`: what the header calls the owner server.
    public var serverLabel: String
    /// `AIMBoardURL`: the owner dashboard. HTTPS only.
    public var boardURL: URL?
    /// `AIMAvatarPeople`: person IDs (without `person:`) whose approved portrait may be shown.
    public var avatarPeople: Set<String>
    /// `AIMPrivatePeers`: identities of a private contour; a person bound to one never shows a portrait.
    public var privatePeers: Set<String>
    /// `AIMOwnerResponsibility`: the responsibility token the server uses for owner decisions.
    public var ownerResponsibility: String

    public var isEnabled: Bool { edition != nil }
    public var canReachServer: Bool { isEnabled && ownerHost != nil }

    /// Shared search always uses the configured owner board; local preview settings stay unchanged.
    public var sharedSearchURL: URL? {
        guard isEnabled, let boardURL, boardURL.user == nil, boardURL.password == nil,
              var parts = URLComponents(url: boardURL, resolvingAgainstBaseURL: false) else { return nil }
        parts.queryItems = (parts.queryItems ?? []).filter { !["view", "command"].contains($0.name) }
            + [URLQueryItem(name: "view", value: "mesh"), URLQueryItem(name: "command", value: "search")]
        parts.fragment = nil
        return parts.url
    }


    public static let defaultServerRoot = "murmur-companion"
    public static let defaultOwnerResponsibility = "owner"

    public init(info: [String: Any] = [:]) {
        edition = (info["AIMShellEdition"] as? NSNumber)?.intValue
        ownerHost = Self.valid(info["AIMOwnerSSHHost"], Self.hostPattern)
        serverRoot = Self.valid(info["AIMServerRoot"], Self.relativePathPattern) ?? Self.defaultServerRoot
        serverDatabase = Self.valid(info["AIMServerDatabase"], Self.relativePathPattern)
        serverLabel = Self.valid(info["AIMServerLabel"], Self.labelPattern) ?? "owner server"
        boardURL = (info["AIMBoardURL"] as? String).flatMap { URL(string: $0) }.flatMap { $0.scheme == "https" && $0.host != nil ? $0 : nil }
        avatarPeople = Set(Self.list(info["AIMAvatarPeople"], Self.idPattern))
        privatePeers = Set(Self.list(info["AIMPrivatePeers"], Self.peerPattern))
        ownerResponsibility = Self.valid(info["AIMOwnerResponsibility"], Self.idPattern) ?? Self.defaultOwnerResponsibility
    }

    /// The configuration stamped into the running app.
    public static var current: AIMEditionConfig { AIMEditionConfig(info: Bundle.main.infoDictionary ?? [:]) }

    /// Environment for the owner-side helper. Values passed `init` validation, so they carry no shell syntax.
    public var helperEnvironment: [String] {
        var env = ["MURMUR_COMPANION_ROOT=" + serverRoot, "MURMUR_COMPANION_OWNER=" + ownerResponsibility]
        if let serverDatabase { env.append("MURMUR_COMPANION_DB=" + serverDatabase) }
        if !avatarPeople.isEmpty { env.append("MURMUR_COMPANION_AVATARS=" + avatarPeople.sorted().joined(separator: ",")) }
        if !privatePeers.isEmpty { env.append("MURMUR_COMPANION_PRIVATE=" + privatePeers.sorted().joined(separator: ",")) }
        return env
    }

    static let hostPattern = "^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$"
    static let relativePathPattern = "^[A-Za-z0-9_.][A-Za-z0-9._-]*(/[A-Za-z0-9_.][A-Za-z0-9._-]*)*$"
    static let labelPattern = "^[A-Za-z0-9 ._·-]{1,48}$"
    static let idPattern = "^[a-z0-9_]{1,40}$"
    static let peerPattern = "^[a-z0-9][a-z0-9._-]{0,62}$"

    private static func valid(_ value: Any?, _ pattern: String) -> String? {
        guard let text = value as? String, text.range(of: pattern, options: .regularExpression) != nil,
              !text.split(separator: "/").contains("..") else { return nil }
        return text
    }

    private static func list(_ value: Any?, _ pattern: String) -> [String] {
        (value as? [Any] ?? []).compactMap { valid($0, pattern) }
    }
}
