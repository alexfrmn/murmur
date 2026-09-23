import Foundation
import Darwin
import MurmurTrayCore

private func onboardingShell(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
}
private func onboardingRejects(_ body: () throws -> Void) throws {
    do { try body() }
    catch is CheckFailure { throw CheckFailure(message: "Assertion failed inside rejection check") }
    catch { return }
    throw CheckFailure(message: "Expected onboarding rejection")
}
private struct OnboardingFixture {
    let directory: URL, executable: URL, plan: NewProfilePlan
    init(directory: URL, fixtures: URL, applicationDirectory: URL? = nil) throws {
        self.directory = directory
        plan = try NewProfilePlan(applicationDirectory: applicationDirectory ?? directory.appendingPathComponent("Murmur's $(literal)"), agentID: "mac-new-user")
        executable = directory.appendingPathComponent("fake-cli")
        var status = try materialized(JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent("status-green.json"))) as! [String: Any], now: Date())
        status["agentId"] = plan.agentID
        try write("status", status)
        try write("init", ["schema": "murmur.init/1", "agentId": plan.agentID,
                           "dataDir": plan.profile.dataDirectory, "existing": false])
        try write("join", ["schema": "murmur.join/1", "agentId": plan.agentID, "peerId": "inviter",
                           "paired": NSNull(), "replyFile": plan.replyFile.path, "restartRequired": true])
        let script = """
        #!/bin/sh
        key="$1"; shift
        [ "$PWD" = / ] || exit 71
        [ -z "${DATA_DIR+x}${MURMUR_DATA_DIR+x}${MURMUR_STORE_PATH+x}${NODE_OPTIONS+x}" ] || exit 72
        printf '%s\\n' "$key" >> \(onboardingShell(directory.appendingPathComponent("calls").path))
        printf '%s\\0' "$@" > \(onboardingShell(directory.path))/"$key.argv"
        case "$key" in
          init|join) /bin/mkdir -p \(onboardingShell(plan.profile.dataDirectory)); printf 'retained fixture identity' > \(onboardingShell(plan.profile.dataDirectory + "/agent-config.json")) ;;
          status) ;;
          *) exit 73 ;;
        esac
        if [ "$key" = join ]; then printf 'public reply' > \(onboardingShell(plan.replyFile.path)); fi
        exec /bin/cat \(onboardingShell(directory.path))/"$key.json"
        """
        try script.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
    }
    func write(_ key: String, _ object: [String: Any]) throws {
        try JSONSerialization.data(withJSONObject: object).write(to: directory.appendingPathComponent(key + ".json"))
    }
    func client() -> ProfileOnboardingClient {
        ProfileOnboardingClient(executable: executable, environment: ["HOME": directory.path,
            "DATA_DIR": "/production", "MURMUR_DATA_DIR": "/production", "MURMUR_STORE_PATH": "/production/db", "NODE_OPTIONS": "--bad-option"])
    }
    func calls() throws -> [String] {
        let file = directory.appendingPathComponent("calls")
        guard FileManager.default.fileExists(atPath: file.path) else { return [] }
        return try String(contentsOf: file, encoding: .utf8).split(separator: "\n").map(String.init)
    }
    func argv(_ key: String) throws -> [String] {
        try String(contentsOf: directory.appendingPathComponent(key + ".argv"), encoding: .utf8)
            .split(separator: "\0").map(String.init)
    }
}

func runOnboardingChecks(fixtures: URL) throws -> Int {
    var count = 0
    func scenario(_ name: String, _ test: (OnboardingFixture) throws -> Void) throws {
        let fm = FileManager.default
        let folder = fm.temporaryDirectory.appendingPathComponent("murmur-onboarding-\(UUID().uuidString)")
        try fm.createDirectory(at: folder, withIntermediateDirectories: false)
        defer { try? fm.removeItem(at: folder) }
        guard let resolved = realpath(folder.path, nil) else { throw CheckFailure(message: "Missing test realpath") }
        defer { free(resolved) }
        try test(OnboardingFixture(directory: URL(fileURLWithPath: String(cString: resolved)), fixtures: fixtures))
        count += 1; print("PASS onboarding: \(name)")
    }
    try scenario("init uses literal explicit profile and verifies identity, without starting service") { f in
        let token = f.directory.appendingPathComponent("token's $(literal).txt")
        try "test-only".write(to: token, atomically: true, encoding: .utf8)
        let result = try f.client().initialize(f.plan, brokerURL: "tls://broker.example.org:4222", tokenFile: token)
        try check(result.profile == f.plan.profile && result.agentID == f.plan.agentID && result.replyFile == nil,
                  "Only bound identity, not a healthy verdict")
        try check(try f.calls() == ["init", "status"], "No daemon, doctor or extra mutation")
        try check(try f.argv("init") == ["--agent-id", f.plan.agentID, "--broker-url", "tls://broker.example.org:4222", "--token-file", token.path,
                    "--json", "--data-dir", f.plan.profile.dataDirectory], "Literal scoped argv")
    }
    try scenario("invitation creates a separate private reply and preserves unconfirmed pairing") { f in
        let invite = f.directory.appendingPathComponent("invite's $(literal).txt")
        try "private test invite".write(to: invite, atomically: true, encoding: .utf8)
        let result = try f.client().join(f.plan, invitation: invite)
        try check(result.replyFile == f.plan.replyFile && result.peerID == "inviter", "Reply is available for human handoff")
        try check(!f.plan.replyFile.path.hasPrefix(f.plan.profile.dataDirectory + "/"), "Reply stays outside profile")
        let mode = try FileManager.default.attributesOfItem(atPath: f.plan.replyFile.deletingLastPathComponent().path)[.posixPermissions] as? Int
        try check(mode == 0o700, "Private reply parent")
        try check(try f.calls() == ["join", "status"], "Join is not a daemon or pairing proof")
        try check(try f.argv("join") == ["--agent-id", f.plan.agentID, "--invite-file", invite.path, "--reply-out", f.plan.replyFile.path,
                    "--json", "--data-dir", f.plan.profile.dataDirectory], "Invite path is literal")
    }
    for address in ["", "https://example.org", "tls://user:secret@example.org", "nats://example.org?token=secret", "nats://example.org\n"] {
        try scenario("invalid server address is rejected before CLI") { f in
            try onboardingRejects { _ = try f.client().initialize(f.plan, brokerURL: address) }
            try check(try f.calls().isEmpty, "No creation on bad input")
        }
    }
    for agent in ["", "wrong agent", "../other", "mac\n", String(repeating: "x", count: 129)] {
        try scenario("invalid agent name is rejected before allocating a profile") { f in
            try onboardingRejects { _ = try NewProfilePlan(applicationDirectory: f.directory, agentID: agent) }
        }
    }
    for field in ["schema", "agentId", "dataDir"] {
        try scenario("mismatched init \(field) is not accepted") { f in
            var value: [String: Any] = ["schema": "murmur.init/1", "agentId": f.plan.agentID, "dataDir": f.plan.profile.dataDirectory, "existing": false]
            value[field] = field == "schema" ? "murmur.init/2" : field == "agentId" ? "foreign-agent" : f.directory.path
            try f.write("init", value)
            try onboardingRejects { _ = try f.client().initialize(f.plan, brokerURL: "nats://localhost:4222") }
        }
    }
    try scenario("changed identity after init prevents binding") { f in
        var status = try JSONSerialization.jsonObject(with: Data(contentsOf: f.directory.appendingPathComponent("status.json"))) as! [String: Any]
        status["agentId"] = "another-agent"
        try f.write("status", status)
        try onboardingRejects { _ = try f.client().initialize(f.plan, brokerURL: "nats://localhost:4222") }
    }
    try scenario("claimed paired receipt is not a join proof") { f in
        let invite = f.directory.appendingPathComponent("invite.txt")
        try "test".write(to: invite, atomically: true, encoding: .utf8)
        try f.write("join", ["schema": "murmur.join/1", "agentId": f.plan.agentID, "peerId": "inviter", "paired": true,
                             "replyFile": f.plan.replyFile.path, "restartRequired": true])
        try onboardingRejects { _ = try f.client().join(f.plan, invitation: invite) }
    }
    try scenario("existing reply is never overwritten") { f in
        try FileManager.default.createDirectory(at: f.plan.replyFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "keep-me".write(to: f.plan.replyFile, atomically: true, encoding: .utf8)
        try onboardingRejects { _ = try f.client().join(f.plan, invitation: f.directory.appendingPathComponent("invite.txt")) }
        try check(try String(contentsOf: f.plan.replyFile, encoding: .utf8) == "keep-me", "Existing reply retained")
        try check(try f.calls().isEmpty, "No CLI mutation when reply destination exists")
    }
    try scenario("join write survives failed status and app restart without a second join") { f in
        let invite = f.directory.appendingPathComponent("invite.txt")
        try "test".write(to: invite, atomically: true, encoding: .utf8)
        let journal = OnboardingJournal(applicationDirectory: f.plan.applicationRoot)
        let goodStatus = try Data(contentsOf: f.directory.appendingPathComponent("status.json"))
        try f.write("status", ["schema": "broken"])
        try onboardingRejects { _ = try f.client().join(f.plan, invitation: invite, journal: journal) }
        let restored = try OnboardingJournal(applicationDirectory: f.plan.applicationRoot).load()!
        try check(restored.plan == f.plan && restored.kind == .invitation && restored.creationConfirmed, "Same durable plan and confirmed write after restart")
        let reply = try Data(contentsOf: f.plan.replyFile)
        let config = try Data(contentsOf: URL(fileURLWithPath: f.plan.profile.dataDirectory + "/agent-config.json"))
        try check(!journal.canDiscard(restored), "Existing identity cannot be forgotten by retry")
        try goodStatus.write(to: f.directory.appendingPathComponent("status.json"))
        let resumed = try f.client().resume(restored)
        try check(resumed.profile == f.plan.profile && resumed.replyFile == f.plan.replyFile, "Resume uses original files")
        try check(try f.calls() == ["join", "status", "status"], "Resume is read-only; never a second join")
        try check(try Data(contentsOf: f.plan.replyFile) == reply, "Reply retained")
        try check(try Data(contentsOf: URL(fileURLWithPath: f.plan.profile.dataDirectory + "/agent-config.json")) == config, "Identity retained")
    }
    try scenario("malformed join receipt after write retains recoverable paths") { f in
        let invite = f.directory.appendingPathComponent("invite.txt")
        try "test".write(to: invite, atomically: true, encoding: .utf8)
        let journal = OnboardingJournal(applicationDirectory: f.plan.applicationRoot)
        try f.write("join", ["schema": "broken"])
        try onboardingRejects { _ = try f.client().join(f.plan, invitation: invite, journal: journal) }
        let pending = try journal.load()!
        try check(!pending.creationConfirmed && !journal.canDiscard(pending), "Files exist but receipt is not proof")
        let resumed = try f.client().resume(pending)
        try check(resumed.profile == f.plan.profile && resumed.replyFile == f.plan.replyFile, "Fresh read recovers same profile and reply")
        try check(try f.calls() == ["join", "status"], "Malformed receipt cannot provoke repeated mutation")
    }
    try scenario("init write survives verification failure with a durable confirmed stage") { f in
        let journal = OnboardingJournal(applicationDirectory: f.plan.applicationRoot)
        try f.write("status", ["schema": "broken"])
        try onboardingRejects { _ = try f.client().initialize(f.plan, brokerURL: "nats://localhost:4222", journal: journal) }
        let pending = try journal.load()!
        try check(pending.plan == f.plan && pending.kind == .ownServer && pending.creationConfirmed, "Init and join preserve write evidence equally")
        try onboardingRejects { try journal.discardIfUntouched(pending) }
    }
    try scenario("existing pending plan blocks a second creation before CLI") { f in
        let journal = OnboardingJournal(applicationDirectory: f.plan.applicationRoot)
        let pending = PendingOnboarding(plan: f.plan, kind: .ownServer)
        try journal.save(pending)
        let other = try NewProfilePlan(applicationDirectory: f.plan.applicationRoot)
        try onboardingRejects { _ = try f.client().initialize(other, brokerURL: "nats://localhost:4222", journal: journal) }
        try check(try journal.load()?.plan == f.plan && f.calls().isEmpty, "Original plan retained and no second CLI invocation")
    }
    try scenario("input validation failure does not leave a pending setup") { f in
        let journal = OnboardingJournal(applicationDirectory: f.plan.applicationRoot)
        try onboardingRejects { _ = try f.client().initialize(f.plan, brokerURL: "bad address", journal: journal) }
        try check(try journal.load() == nil && f.calls().isEmpty, "No write started")
    }
    try scenario("an untouched plan can be explicitly discarded without removing files") { f in
        let journal = OnboardingJournal(applicationDirectory: f.plan.applicationRoot)
        let pending = PendingOnboarding(plan: f.plan, kind: .ownServer)
        try journal.save(pending)
        try check(!journal.canDiscard(pending), "An interrupted command may still write later")
        try onboardingRejects { try journal.discardIfUntouched(pending) }
        try journal.markCommandFinished(pending)
        let finished = try journal.load()!
        try check(journal.canDiscard(finished), "Command finished and no CLI artifacts")
        try journal.discardIfUntouched(finished)
        try check(try journal.load() == nil, "Only pending record removed")
    }
    try scenario("resume rejects changed identity and missing invitation reply") { f in
        let journal = OnboardingJournal(applicationDirectory: f.plan.applicationRoot)
        _ = try f.client().initialize(f.plan, brokerURL: "nats://localhost:4222", journal: journal)
        let invitationPlan = PendingOnboarding(plan: f.plan, kind: .invitation)
        try onboardingRejects { _ = try f.client().resume(invitationPlan) }
        var status = try JSONSerialization.jsonObject(with: Data(contentsOf: f.directory.appendingPathComponent("status.json"))) as! [String: Any]
        status["agentId"] = "foreign-agent"; try f.write("status", status)
        try onboardingRejects { _ = try f.client().resume(try journal.load()!) }
        try check(try f.calls() == ["init", "status", "status", "status"], "Recovery never writes or starts service")
    }
    try scenario("pending journal is private, bounded metadata and corrupt state blocks creation") { f in
        let journal = OnboardingJournal(applicationDirectory: f.plan.applicationRoot)
        try journal.save(PendingOnboarding(plan: f.plan, kind: .ownServer))
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: journal.file)) as! [String: Any]
        try check(Set(object.keys) == ["schema", "identifier", "agentID", "kind", "creationConfirmed", "commandFinished"], "No credentials, invitation or config contents stored")
        let mode = try FileManager.default.attributesOfItem(atPath: journal.file.path)[.posixPermissions] as? Int
        try check(mode == 0o600, "Private journal permissions")
        var invalid = object; invalid["agentID"] = "bad agent"
        try JSONSerialization.data(withJSONObject: invalid).write(to: journal.file)
        do { _ = try journal.load(); throw CheckFailure(message: "Invalid saved identity must be rejected") }
        catch OnboardingJournalError.invalidJournal { /* Explain record damage, not new-agent input validation. */ }
        try "broken".write(to: journal.file, atomically: false, encoding: .utf8)
        try onboardingRejects { _ = try journal.load() }
        try onboardingRejects { _ = try f.client().initialize(f.plan, brokerURL: "nats://localhost:4222", journal: journal) }
        try check(try f.calls().isEmpty, "Corrupt state does not become a fresh plan")
    }
    try scenario("previous private profile folders are discoverable and preserved") { f in
        let another = try NewProfilePlan(applicationDirectory: f.plan.applicationRoot)
        for plan in [f.plan, another] {
            try FileManager.default.createDirectory(atPath: plan.profile.dataDirectory, withIntermediateDirectories: true)
            try "keep".write(toFile: plan.profile.dataDirectory + "/agent-config.json", atomically: true, encoding: .utf8)
        }
        let partial = try NewProfilePlan(applicationDirectory: f.plan.applicationRoot)
        try FileManager.default.createDirectory(atPath: partial.profile.dataDirectory, withIntermediateDirectories: true)
        try "keep partial files".write(toFile: partial.profile.dataDirectory + "/partial-write", atomically: true, encoding: .utf8)
        let profiles = try OnboardingJournal(applicationDirectory: f.plan.applicationRoot).existingProfiles()
        try check(Set(profiles.map(\.dataDirectory)) == [f.plan.profile.dataDirectory, another.profile.dataDirectory, partial.profile.dataDirectory], "Previous and partial folders are offered, not hidden")
        try check(try f.calls().isEmpty, "Discovery uses metadata only")
    }
    try scenario("corrupt setup can be archived without touching an existing identity or reply") { f in
        let journal = OnboardingJournal(applicationDirectory: f.plan.applicationRoot)
        try journal.save(PendingOnboarding(plan: f.plan, kind: .invitation))
        try "damaged record".write(to: journal.file, atomically: false, encoding: .utf8)
        try FileManager.default.createDirectory(atPath: f.plan.profile.dataDirectory, withIntermediateDirectories: true)
        let config = URL(fileURLWithPath: f.plan.profile.dataDirectory + "/agent-config.json")
        try "keep identity".write(to: config, atomically: true, encoding: .utf8)
        try FileManager.default.createDirectory(at: f.plan.replyFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "keep reply".write(to: f.plan.replyFile, atomically: true, encoding: .utf8)
        try check(journal.canArchiveRecord, "A damaged own regular journal has a recovery action")
        let archive = try journal.archiveRecord()
        try check(try journal.load() == nil, "Old journal no longer blocks choosing a profile")
        try check(try String(contentsOf: archive, encoding: .utf8) == "damaged record", "Record retained for recovery")
        try check(try String(contentsOf: config, encoding: .utf8) == "keep identity", "Keys and config untouched")
        try check(try String(contentsOf: f.plan.replyFile, encoding: .utf8) == "keep reply", "Reply untouched")
        try check(try journal.existingProfiles() == [f.plan.profile], "Existing identity remains offered")
        try check(try f.calls().isEmpty, "Reset cannot call CLI or create a new identity")
    }
    try scenario("interrupted setup can be explicitly archived but cannot become a silent retry") { f in
        let journal = OnboardingJournal(applicationDirectory: f.plan.applicationRoot)
        let pending = PendingOnboarding(plan: f.plan, kind: .ownServer)
        try journal.save(pending)
        try check(!journal.canDiscard(pending), "Interrupted attempt is not classified as unwritten")
        let archive = try journal.archiveRecord()
        try check(FileManager.default.fileExists(atPath: archive.path), "Uncertain state remains recoverable")
        let mode = try FileManager.default.attributesOfItem(atPath: archive.path)[.posixPermissions] as? Int
        try check(mode == 0o600, "Archived record remains private")
        try journal.save(pending)
        let second = try journal.archiveRecord()
        try check(second != archive && FileManager.default.fileExists(atPath: archive.path), "A later reset preserves earlier copies")
        try check(try f.calls().isEmpty, "Explicit metadata reset performs no automatic mutation")
    }
    try scenario("setup reset refuses linked files without changing their target") { f in
        let journal = OnboardingJournal(applicationDirectory: f.plan.applicationRoot)
        try FileManager.default.createDirectory(at: f.plan.applicationRoot, withIntermediateDirectories: true)
        let external = f.directory.appendingPathComponent("unrelated.txt")
        try "keep unrelated".write(to: external, atomically: true, encoding: .utf8)
        try FileManager.default.createSymbolicLink(at: journal.file, withDestinationURL: external)
        try check(!journal.canArchiveRecord, "Symlink is not a resettable journal")
        try onboardingRejects { _ = try journal.archiveRecord() }
        try FileManager.default.removeItem(at: journal.file)
        try FileManager.default.linkItem(at: external, to: journal.file)
        try check(!journal.canArchiveRecord, "Hardlink is not a resettable journal")
        try onboardingRejects { _ = try journal.archiveRecord() }
        try check(try String(contentsOf: external, encoding: .utf8) == "keep unrelated", "Unrelated target retained")
    }
    try scenario("initial directory sync failure blocks CLI after writing the pending record") { f in
        let file = f.plan.applicationRoot.appendingPathComponent("pending-setup.json")
        let journal = OnboardingJournal(applicationDirectory: f.plan.applicationRoot, beforeDirectorySync: { _ in
            if FileManager.default.fileExists(atPath: file.path) { throw NSError(domain: NSPOSIXErrorDomain, code: Int(EIO)) }
        })
        try onboardingRejects { _ = try f.client().initialize(f.plan, brokerURL: "nats://localhost:4222", journal: journal) }
        try check(FileManager.default.fileExists(atPath: file.path), "Failure occurs after pending bytes, before CLI")
        try check(try f.calls().isEmpty, "Cannot create keys without completing initial persistence")
    }
    try scenario("directory entries are synchronized after create, rename and clear") { f in
        let log = f.directory.appendingPathComponent("directory-sync.log")
        let root = f.plan.applicationRoot
        let record = root.appendingPathComponent("pending-setup.json")
        let journal = OnboardingJournal(applicationDirectory: root, beforeDirectorySync: { directory in
            var rows = (try? String(contentsOf: log, encoding: .utf8)) ?? ""
            rows += directory.path + ":" + (FileManager.default.fileExists(atPath: record.path) ? "record" : "empty") + "\n"
            try rows.write(to: log, atomically: true, encoding: .utf8)
        })
        let pending = PendingOnboarding(plan: f.plan, kind: .ownServer)
        try journal.save(pending)
        try journal.markCreated(pending)
        try journal.clear(try journal.load()!)
        let rows = try String(contentsOf: log, encoding: .utf8).split(separator: "\n").map(String.init)
        try check(rows.contains(root.deletingLastPathComponent().path + ":empty"), "New application directory entry reaches its parent")
        try check(rows.filter { $0 == root.path + ":record" }.count == 2, "Directory synchronized after initial create and staging rename")
        try check(rows.last == root.path + ":empty", "Directory synchronized after clear")
    }
    try scenario("an earlier own-server profile is adopted without repeating init") { f in
        _ = try f.client().initialize(f.plan, brokerURL: "nats://localhost:4222")
        let chosen = try f.client().adoptExistingProfile(f.plan.profile, applicationDirectory: f.plan.applicationRoot)
        try check(chosen.profile == f.plan.profile && chosen.agentID == f.plan.agentID && chosen.replyFile == nil, "Same identity is available for install/start")
        try check(try f.calls() == ["init", "status", "status"], "Adoption only reads status")
    }
    try scenario("an earlier invited profile recovers its original reply link") { f in
        let invite = f.directory.appendingPathComponent("invite.txt")
        try "test".write(to: invite, atomically: true, encoding: .utf8)
        _ = try f.client().join(f.plan, invitation: invite)
        let reply = try Data(contentsOf: f.plan.replyFile)
        let chosen = try f.client().adoptExistingProfile(f.plan.profile, applicationDirectory: f.plan.applicationRoot)
        try check(chosen.replyFile == f.plan.replyFile && chosen.agentID == f.plan.agentID, "Known reply and original identity restored")
        try check(try Data(contentsOf: f.plan.replyFile) == reply && f.calls() == ["join", "status", "status"], "No reply rewrite or repeated join")
    }
    try scenario("adoption refuses a folder outside the private UUID root before CLI") { f in
        let unrelated = try ProfileBinding(dataDirectory: f.directory.path)
        try onboardingRejects { _ = try f.client().adoptExistingProfile(unrelated, applicationDirectory: f.plan.applicationRoot) }
        try check(try f.calls().isEmpty, "No unrelated profile probe")
    }
    try scenario("recovery folder picker adopts an app profile through a filesystem alias") { f in
        let invite = f.directory.appendingPathComponent("invite.txt")
        try "test".write(to: invite, atomically: true, encoding: .utf8)
        _ = try f.client().join(f.plan, invitation: invite)
        let alias = f.directory.appendingPathComponent("selected folder")
        try FileManager.default.createSymbolicLink(atPath: alias.path, withDestinationPath: f.plan.profile.dataDirectory)
        let reply = try Data(contentsOf: f.plan.replyFile)
        let selected = try f.client().recoverSelectedProfile(try ProfileBinding(dataDirectory: alias.path), applicationDirectory: f.plan.applicationRoot)
        try check(selected.profile == f.plan.profile && selected.agentID == f.plan.agentID && selected.replyFile == f.plan.replyFile,
                  "Picker and list both restore the original setup, identity and reply")
        try check(try f.calls() == ["join", "status", "status"] && Data(contentsOf: f.plan.replyFile) == reply,
                  "Alias selection performs only status and does not rewrite the reply")
    }
    try scenario("recovery folder picker verifies an external profile without active commands") { f in
        let folder = f.directory.appendingPathComponent("external profile")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
        let config = folder.appendingPathComponent("agent-config.json")
        try "existing identity".write(to: config, atomically: false, encoding: .utf8)
        let binding = try ProfileBinding(dataDirectory: folder.path)
        let selected = try f.client().recoverSelectedProfile(binding, applicationDirectory: f.plan.applicationRoot)
        try check(selected.profile == binding && selected.agentID == f.plan.agentID && selected.replyFile == nil,
                  "An observed external identity is usable for explicit setup; its reply location is not invented")
        try check(try f.calls() == ["status"] && f.argv("status") == ["--json", "--data-dir", folder.path],
                  "No doctor, service, init or join during recovery selection")
        try check(try String(contentsOf: config, encoding: .utf8) == "existing identity", "Existing config retained")
    }
    try scenario("recovery folder picker rejects failed status before returning a selection") { f in
        try f.write("status", ["schema": "broken"])
        let binding = try ProfileBinding(dataDirectory: f.directory.path)
        try onboardingRejects { _ = try f.client().recoverSelectedProfile(binding, applicationDirectory: f.plan.applicationRoot) }
        try check(try f.calls() == ["status"], "Rejected selection cannot trigger active fallback commands")
    }
    try scenario("recovery cannot disguise a malformed app-owned folder as an external profile") { f in
        let folder = f.plan.applicationRoot.appendingPathComponent("profiles/not-a-uuid")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try onboardingRejects { _ = try f.client().recoverSelectedProfile(try ProfileBinding(dataDirectory: folder.path), applicationDirectory: f.plan.applicationRoot) }
        try check(try f.calls().isEmpty, "App-owned folder keeps the adoption guard before CLI")
    }
    try scenario("recovery folder picker rejects a missing folder without allocating one") { f in
        let folder = f.directory.appendingPathComponent("missing profile")
        try onboardingRejects { _ = try f.client().recoverSelectedProfile(try ProfileBinding(dataDirectory: folder.path), applicationDirectory: f.plan.applicationRoot) }
        try check(try f.calls().isEmpty && !FileManager.default.fileExists(atPath: folder.path), "No probe or profile allocation")
    }
    for error in [EINVAL, ENOTSUP] {
        try scenario("unsupported full sync retains ordinary sync and records fallback") { f in
            let log = f.directory.appendingPathComponent("sync-calls")
            let sync = JournalSynchronizer(regular: { _ in
                try? "fsync".write(to: log, atomically: true, encoding: .utf8)
                return nil
            }, full: { _ in error })
            try check(sync.synchronize(-1) == .fsyncFallback(error), "Only unsupported operation may fall back")
            try check(try String(contentsOf: log, encoding: .utf8) == "fsync", "Ordinary flush completed first")
        }
    }
    try scenario("full sync IO failure is not downgraded to ordinary sync") { f in
        let sync = JournalSynchronizer(regular: { _ in nil }, full: { _ in EIO })
        try check(sync.synchronize(-1) == .failed(EIO), "Real I/O failures remain failures")
    }
    try scenario("ordinary sync failure cannot be hidden by full sync success") { f in
        let log = f.directory.appendingPathComponent("unexpected-full-sync")
        let sync = JournalSynchronizer(regular: { _ in ENOSPC }, full: { _ in
            try? "called".write(to: log, atomically: true, encoding: .utf8)
            return nil
        })
        try check(sync.synchronize(-1) == .failed(ENOSPC) && !FileManager.default.fileExists(atPath: log.path), "Stop at the first real flush failure")
    }
    try scenario("full sync failure blocks initial CLI creation and remains diagnosable") { f in
        try FileManager.default.createDirectory(at: f.plan.applicationRoot, withIntermediateDirectories: true)
        let log = f.directory.appendingPathComponent("sync-result")
        let journal = OnboardingJournal(applicationDirectory: f.plan.applicationRoot,
            synchronizer: JournalSynchronizer(regular: { fd in fsync(fd) == 0 ? nil : errno }, full: { _ in EIO }),
            onSync: { outcome in try? outcome.diagnosticValue.write(to: log, atomically: true, encoding: .utf8) })
        try onboardingRejects { _ = try f.client().initialize(f.plan, brokerURL: "nats://localhost:4222", journal: journal) }
        try check(try f.calls().isEmpty && String(contentsOf: log, encoding: .utf8) == JournalSyncOutcome.failed(EIO).diagnosticValue,
                  "The failed stronger flush is reported before any CLI mutation")
    }
    try scenario("diagnostics retain observed fallback after a later full sync") { f in
        let name = "murmur-sync-test-\(UUID().uuidString)"
        let preferences = UserDefaults(suiteName: name)!
        defer { preferences.removePersistentDomain(forName: name) }
        JournalSyncDiagnostics.record(.fsyncFallback(ENOTSUP), preferences: preferences)
        JournalSyncDiagnostics.record(.full, preferences: preferences)
        let reopened = UserDefaults(suiteName: name)!
        let lines = JournalSyncDiagnostics.lines(preferences: reopened)
        try check(lines.contains("journal-sync.latest=F_FULLFSYNC") && lines.contains("journal-sync.previous-fallback=fsync-only(errno=\(ENOTSUP))"),
                  "Copied diagnostics distinguish the latest success from a previous downgrade after reopen")
        preferences.set("untrusted /path/private-key", forKey: "onboardingJournalSyncLatest")
        try check(!JournalSyncDiagnostics.lines(preferences: preferences).joined().contains("private-key"), "Only known diagnostic values are copied")
    }
    for serviceName in [nil, "existing-explicit-service"] as [String?] {
        try scenario("external alias recovery preserves the lexical path and optional service identity") { f in
            let folder = f.directory.appendingPathComponent("external profile")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
            let alias = f.directory.appendingPathComponent("external alias")
            try FileManager.default.createSymbolicLink(atPath: alias.path, withDestinationPath: folder.path)
            let selected = try ProfileBinding(dataDirectory: alias.path, serviceName: serviceName)
            let recovered = try f.client().recoverSelectedProfile(selected, applicationDirectory: f.plan.applicationRoot)
            try check(recovered.profile == selected, "External service identity is derived from the supplied path, not realpath")
            let expected = ["--json", "--data-dir", alias.path] + (serviceName.map { ["--service-name", $0] } ?? [])
            try check(try f.argv("status") == expected && f.calls() == ["status"], "Probe keeps the exact external binding and only reads status")
        }
    }
    try scenario("retry after new-parent full sync failure repeats the whole gate before CLI") { original in
        let f = try OnboardingFixture(directory: original.directory, fixtures: fixtures,
            applicationDirectory: original.directory.appendingPathComponent("new parents/inner/Murmur"))
        var parentInfo = stat()
        try check(lstat(f.directory.path, &parentInfo) == 0, "Known existing ancestor")
        let parentDevice = parentInfo.st_dev, parentInode = parentInfo.st_ino
        let latch = f.directory.appendingPathComponent("parent-full-sync-failed-once")
        let observations = f.directory.appendingPathComponent("parent-full-sync-attempts")
        let calls = f.directory.appendingPathComponent("calls")
        let synchronizer = JournalSynchronizer(full: { fd in
            var info = stat()
            if fstat(fd, &info) == 0, info.st_dev == parentDevice, info.st_ino == parentInode {
                let previous = (try? String(contentsOf: observations, encoding: .utf8)) ?? ""
                let phase = FileManager.default.fileExists(atPath: calls.path) ? "after-cli" : "before-cli"
                try? (previous + phase + "\n").write(to: observations, atomically: false, encoding: .utf8)
                if !FileManager.default.fileExists(atPath: latch.path) {
                    try? "failed".write(to: latch, atomically: false, encoding: .utf8)
                    return EIO
                }
            }
            return Darwin.fcntl(fd, F_FULLFSYNC) == 0 ? nil : errno
        })
        let first = OnboardingJournal(applicationDirectory: f.plan.applicationRoot, synchronizer: synchronizer)
        try onboardingRejects { _ = try f.client().initialize(f.plan, brokerURL: "nats://localhost:4222", journal: first) }
        try check(FileManager.default.fileExists(atPath: f.plan.applicationRoot.path), "mkdir remains after failed sync")
        try check(try first.load() == nil && f.calls().isEmpty, "No journal or CLI mutation before successful directory gate")
        let reopened = OnboardingJournal(applicationDirectory: f.plan.applicationRoot, synchronizer: synchronizer)
        _ = try f.client().initialize(f.plan, brokerURL: "nats://localhost:4222", journal: reopened)
        let attempts = try String(contentsOf: observations, encoding: .utf8).split(separator: "\n").map(String.init)
        try check(attempts == ["before-cli", "before-cli"], "Retry rechecks the failed ancestor even though all nested directories already exist")
        try check(try f.calls() == ["init", "status"], "Only the successfully resynchronized retry may invoke CLI")
    }
    return count
}
