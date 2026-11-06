import Foundation

/// The existing team task projection, independent of private messages and owner decisions.
public struct AIMCoworkSnapshot: Decodable, Sendable {
    public struct Member: Decodable, Sendable, Identifiable {
        public let identity: String
        public let name: String
        public let role: String
        public var id: String { identity }
    }
    public struct Work: Decodable, Sendable, Identifiable {
        public let id: String
        public let title: String
        public let owner: String
        public let status: String
        public let next_step: String
        public var statusLabel: String {
            ["planned": "Planned", "in_progress": "In progress", "blocked": "Blocked",
             "reported_done": "Reported done · verify", "verified": "Verified"][status] ?? "Not observed"
        }
    }
    public let schema: String
    public let scope: String
    public let observed_at: String
    public let collector_seconds: Int
    public let ok: Bool
    public let members: [Member]
    public let tasks: [Work]

    public func isCurrent(now: Date = Date()) -> Bool {
        guard let date = AIMCompanionSnapshot.date(observed_at) else { return false }
        let age = now.timeIntervalSince(date)
        return age >= 0 && age <= 300
    }
    public func ownerName(_ identity: String) -> String {
        members.first { $0.identity == identity }?.name ?? identity
    }
    public static func decode(_ data: Data) throws -> Self {
        func invalid() -> CocoaError { CocoaError(.fileReadCorruptFile) }
        guard data.count <= 131_072,
              let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(root.keys) == Set(["schema", "scope", "observed_at", "collector_seconds", "ok", "members", "tasks"]),
              let rawMembers = root["members"] as? [[String: Any]],
              let rawTasks = root["tasks"] as? [[String: Any]],
              rawMembers.allSatisfy({ Set($0.keys) == Set(["identity", "name", "role"]) }),
              rawTasks.allSatisfy({ Set($0.keys) == Set(["id", "title", "owner", "status", "next_step"]) }) else { throw invalid() }
        let value = try JSONDecoder().decode(Self.self, from: data)
        let validID: (String) -> Bool = { $0.range(of: "^[a-z0-9][a-z0-9._:-]{0,90}$", options: .regularExpression) != nil }
        let bounded: (String) -> Bool = { !$0.isEmpty && $0.count <= 2048 && !$0.contains("\0") }
        let ids = Set(value.members.map(\.identity))
        guard value.schema == "aim.cowork.desk/1", value.scope == "team-task-metadata", value.ok,
              AIMCompanionSnapshot.date(value.observed_at) != nil,
              (1...3600).contains(value.collector_seconds), value.members.count <= 16, value.tasks.count <= 128,
              ids.count == value.members.count, Set(value.tasks.map(\.id)).count == value.tasks.count,
              value.members.allSatisfy({ validID($0.identity) && bounded($0.name) && bounded($0.role) }),
              value.tasks.allSatisfy({ validID($0.id) && ids.contains($0.owner) && bounded($0.title) && bounded($0.next_step)
                  && ["planned", "in_progress", "blocked", "reported_done", "verified"].contains($0.status) }) else { throw invalid() }
        return value
    }
}
