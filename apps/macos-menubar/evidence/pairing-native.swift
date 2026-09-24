import AppKit
import SwiftUI
import MurmurTrayCore

// Compile with the app's views/model and TrayCore, excluding DesktopEntry.swift.
// Temporary HOME + CFFIXED_USER_HOME are mandatory; no live profile or Service.
@main struct PairingNativeAcceptance {
    static func legacyLine(_ line: String) -> String {
        var encoded = String(line.dropFirst("MURMUR:".count))
            .replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
        var payload = Data(base64Encoded: encoded)!
        // JSON trailing whitespace is valid; ensure padding exercises the
        // engine's standard-base64 branch even with an unpadded original.
        if payload.count % 3 == 0 { payload.append(0x20) }
        return "MURMUR:" + payload.base64EncodedString()
    }
    static func quotedWithFormatCharacters(_ line: String) -> String {
        let formatted = "MUR\u{200e}MUR:\u{200b}" + line.dropFirst("MURMUR:".count) + "\u{ad}"
        return "> " + formatted + "\n\n" + line + "\n— colleague"
    }
    @MainActor static func capture<V: View>(_ view: V, to path: URL, height: CGFloat = 680) throws {
        let host = NSHostingView(rootView: view.frame(width: 580, height: height)
            .background(Color(nsColor: .windowBackgroundColor)).environment(\.colorScheme, .light))
        host.frame = NSRect(x: 0, y: 0, width: 580, height: height)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: .aqua)
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        host.displayIfNeeded()
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { fatalError("bitmap") }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        try bitmap.representation(using: .png, properties: [:])!.write(to: path)
    }
    @MainActor static func settled(_ model: TrayModel) async throws {
        for _ in 0..<1200 {
            if !model.busy { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        fatalError("native action timed out")
    }
    @MainActor static func creationFailures(root: URL, cli: URL, pictures: URL, language: String) async throws {
        let fm = FileManager.default
        let invalidAccess = root.appendingPathComponent("invalid-access")
        try "test-only\nsecond-line".write(to: invalidAccess, atomically: true, encoding: .utf8)
        let plan = try NewProfilePlan(applicationDirectory: root.appendingPathComponent("invalid-init"), agentID: "invalid-init")
        let expectedAccessError: String
        do {
            _ = try ProfileOnboardingClient(executable: cli).initialize(plan, brokerURL: "nats://server.example.invalid:4222", tokenFile: invalidAccess)
            fatalError("Multiline access file must be refused")
        } catch { expectedAccessError = error.localizedDescription }
        let originalCLI = ProcessInfo.processInfo.environment["MURMUR_BIN"]
        defer {
            if let originalCLI { setenv("MURMUR_BIN", originalCLI, 1) }
            else { unsetenv("MURMUR_BIN") }
        }
        // Fault injection is local to this harness. No status, Service, or
        // network command may run through the stub; only a failing init.
        let failingCLI = root.appendingPathComponent("init-failure-cli")
        for (name, expected) in [("access-file", expectedAccessError),
                                 ("permission", ProbeError.failedWithReason(1, "Access denied.").localizedDescription),
                                 ("timeout", ProbeError.timedOut.localizedDescription)] {
            if name == "access-file" { setenv("MURMUR_BIN", cli.path, 1) }
            else {
                let failure = name == "permission" ? "printf 'Access denied.\\n' >&2\nexit 1\n" : "exec /bin/sleep 25\n"
                try ("#!/bin/sh\n[ \"$1\" = init ] || exit 73\n" + failure).write(to: failingCLI, atomically: true, encoding: .utf8)
                try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: failingCLI.path)
                setenv("MURMUR_BIN", failingCLI.path, 1)
            }
            let model = TrayModel(startRuntime: false)
            model.createOwnProfile(agentID: "failed-\(name)", server: "nats://server.example.invalid:4222",
                                   accessFile: name == "access-file" ? invalidAccess : nil)
            try await settled(model)
            precondition(model.creationError == expected && model.pairingError == nil && model.profile == nil)
            try capture(MurmurHomeView(model: model), to: pictures.appendingPathComponent("after-init-\(name)-\(language).png"), height: 760)
            precondition(model.pendingCanRetryCreation)
            model.discardEmptySetup()
            precondition(!model.hasPendingSetup)
            print("PASS native \(language): own Server \(name) preserves its error without asking for an Invitation or Reply")
        }
        setenv("MURMUR_BIN", cli.path, 1)
        let joining = TrayModel(startRuntime: false)
        joining.useInvitation(); joining.creationAgentID = "damaged-invitation"
        joining.pairingInput = "MURMUR:invalid"; joining.joinInvitationLine()
        try await settled(joining)
        precondition(joining.creationError == PairingError.damaged.localizedDescription && joining.pairingError == joining.creationError)
        precondition(joining.profile == nil && joining.pendingCanRetryCreation)
        joining.discardEmptySetup()
        precondition(!joining.hasPendingSetup)
        print("PASS native \(language): first-time join keeps Invitation-specific error handling")
    }
    @MainActor static func main() async throws {
        let args = CommandLine.arguments
        let root = URL(fileURLWithPath: args[1]), language = args[2]
        precondition(["en", "ru"].contains(language))
        precondition(FileManager.default.homeDirectoryForCurrentUser.path == root.appendingPathComponent("home").path)
        precondition(ProcessInfo.processInfo.environment["MURMUR_DATA_DIR"] == nil)
        _ = NSApplication.shared
        UserDefaults.standard.setVolatileDomain(["interfaceLanguage": language], forName: UserDefaults.argumentDomain)
        let pictures = root.appendingPathComponent("screenshots")
        try FileManager.default.createDirectory(at: pictures, withIntermediateDirectories: true)
        let welcome = TrayModel(startRuntime: false)
        try capture(MurmurHomeView(model: welcome), to: pictures.appendingPathComponent("after-welcome-\(language).png"), height: 760)
        welcome.pairingMode = .join; welcome.creationAgentID = "misha-mac"
        try capture(PairingSheet(model: welcome), to: pictures.appendingPathComponent("after-join-\(language).png"))

        guard let cli = CLIProbe.locate() else { fatalError("isolated CLI required") }
        try await creationFailures(root: root, cli: cli, pictures: pictures, language: language)
        let plan = try NewProfilePlan(applicationDirectory: root.appendingPathComponent("inviter"), agentID: "pair-inviter")
        let token = root.appendingPathComponent("disposable-token")
        try UUID().uuidString.write(to: token, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: token.path)
        _ = try ProfileOnboardingClient(executable: cli).initialize(plan, brokerURL: "nats://127.0.0.1:4222", tokenFile: token)
        let inviter = TrayModel(startRuntime: false)
        inviter.bind(plan.profile, expectedAgent: plan.agentID, skipInitialDoctor: true)
        try await settled(inviter)
        let clipboard = NSPasteboard.general
        clipboard.clearContents(); clipboard.setString("native-test-before-confirmation", forType: .string)
        inviter.beginInviting(); try await settled(inviter)
        precondition(inviter.pairingNeedsPublicServer && inviter.pairingInvitation == nil)
        try capture(PairingSheet(model: inviter), to: pictures.appendingPathComponent("after-public-server-\(language).png"))
        inviter.pairingServer = "pairing.example.invalid:4222"
        inviter.makeInvitation(); try await settled(inviter)
        precondition(inviter.pairingInvitation?.containsBrokerCredential == true && inviter.pairingOutput == nil)
        precondition(clipboard.string(forType: .string) == "native-test-before-confirmation")
        inviter.copyPairingLine()
        precondition(clipboard.string(forType: .string) == "native-test-before-confirmation")
        inviter.pairingError = nil
        try capture(PairingSheet(model: inviter), to: pictures.appendingPathComponent("after-confirm-\(language).png"))
        inviter.pairingConfirmed = true; inviter.copyPairingLine()
        let invitation = clipboard.string(forType: .string)!
        precondition(invitation.hasPrefix("MURMUR:") && inviter.pairingOutput == nil)
        try capture(PairingSheet(model: inviter), to: pictures.appendingPathComponent("after-invitation-copied-\(language).png"))

        let joining = TrayModel(startRuntime: false)
        joining.useInvitation(); joining.creationAgentID = "misha-mac"
        joining.pairingInput = quotedWithFormatCharacters(legacyLine(invitation)); joining.joinInvitationLine()
        try await settled(joining)
        precondition(joining.agentID == "misha-mac" && joining.creationError == nil)
        let reply = clipboard.string(forType: .string)!
        precondition(reply == joining.pairingOutput && reply.hasPrefix("MURMUR:") && reply != invitation)
        try capture(PairingSheet(model: joining), to: pictures.appendingPathComponent("after-reply-\(language).png"))
        inviter.beginPairing(.reply); inviter.pairingInput = quotedWithFormatCharacters(legacyLine(reply))
        try capture(PairingSheet(model: inviter), to: pictures.appendingPathComponent("after-paste-reply-\(language).png"))
        inviter.addReplyLine(); try await settled(inviter)
        precondition(inviter.pairingError == nil && inviter.status?.peers.list?.contains(where: { $0.agentId == "misha-mac" }) == true)
        try capture(PairingSheet(model: inviter), to: pictures.appendingPathComponent("after-contact-\(language).png"))
        precondition(joining.status?.peers.list?.contains(where: { $0.agentId == "pair-inviter" }) == true)
        let recoveredReply = try PairingLine.recovered(from: joining.setupReplyFile!)
        precondition(recoveredReply == reply)
        let first = TrayModel(startRuntime: false)
        first.allowSeparateProfile = true
        first.beginInviting()
        precondition(first.showCreateProfileSheet)
        first.showCreateProfileSheet = false; first.ownProfileSheetDismissed()
        precondition(!first.showPairingSheet && first.profile == nil)
        first.beginInviting()
        first.createOwnProfile(agentID: "first-inviter", server: "nats://pairing.example.invalid:4222", accessFile: nil)
        try await settled(first)
        precondition(first.agentID == "first-inviter" && !first.showCreateProfileSheet && !first.showPairingSheet)
        first.ownProfileSheetDismissed()
        precondition(first.showPairingSheet && first.pairingMode == .invite)
        first.makeInvitation(); try await settled(first)
        precondition(first.pairingInvitation?.containsBrokerCredential == false && first.pairingOutput == nil)
        let publicInvitation = clipboard.string(forType: .string)!
        precondition(publicInvitation.hasPrefix("MURMUR:"))

        // An already selected Identity joins through the menu action. This test
        // reads only its disposable configuration to prove keys/settings survive.
        let originalProfile = first.profile!
        let configFile = URL(fileURLWithPath: originalProfile.dataDirectory).appendingPathComponent("agent-config.json")
        let before = try Data(contentsOf: configFile)
        let selectedDirectory = UserDefaults.standard.string(forKey: "profileDirectory")
        let verifiedStatus = first.status
        first.status = nil; first.showPairingSheet = false; first.clearPairing()
        precondition(!first.busy && !first.canUseInvitation && first.invitationBlockReason == L10n.text("Refresh the status of this Identity before using an Invitation."))
        first.useInvitation()
        let afterBlockedJoin = try Data(contentsOf: configFile)
        precondition(!first.showPairingSheet && first.profile == originalProfile && afterBlockedJoin == before)
        precondition(!first.hasPendingSetup && UserDefaults.standard.string(forKey: "profileDirectory") == selectedDirectory)
        first.status = verifiedStatus
        precondition(first.canUseInvitation && first.invitationBlockReason == nil)
        print("PASS native \(language): unverified current Identity explains blocked Invitation action and stays unchanged")
        first.useInvitation()
        precondition(first.canUseInvitation && first.pairingIdentity == "first-inviter" && first.showPairingSheet)
        first.creationAgentID = "must-not-create-this"
        try capture(PairingSheet(model: first), to: pictures.appendingPathComponent("after-existing-join-\(language).png"))
        first.pairingInput = invitation + "\n" + publicInvitation
        let clipboardBeforeRefusal = clipboard.string(forType: .string)
        first.joinInvitationLine(); try await settled(first)
        let refusedConfig = try Data(contentsOf: configFile)
        precondition(first.pairingError != nil && refusedConfig == before && first.pairingOutput == nil)
        precondition(clipboard.string(forType: .string) == clipboardBeforeRefusal)
        first.pairingInput = quotedWithFormatCharacters(invitation)
        first.joinInvitationLine(); try await settled(first)
        let existingReply = first.pairingOutput!
        precondition(first.pairingError == nil && first.profile == originalProfile && first.agentID == "first-inviter")
        precondition(UserDefaults.standard.string(forKey: "profileDirectory") == selectedDirectory && !first.hasPendingSetup)
        var configBefore = try JSONSerialization.jsonObject(with: before) as! [String: Any]
        var configAfter = try JSONSerialization.jsonObject(with: Data(contentsOf: configFile)) as! [String: Any]
        configBefore.removeValue(forKey: "peers"); configAfter.removeValue(forKey: "peers")
        precondition(NSDictionary(dictionary: configBefore).isEqual(to: configAfter))
        precondition(clipboard.string(forType: .string) == existingReply && existingReply != invitation)
        precondition(first.status?.peers.list?.contains(where: { $0.agentId == "pair-inviter" }) == true)
        try capture(PairingSheet(model: first), to: pictures.appendingPathComponent("after-existing-reply-\(language).png"))
        inviter.beginPairing(.reply); inviter.pairingInput = "Reply: «" + existingReply + "»"
        inviter.addReplyLine(); try await settled(inviter)
        precondition(inviter.pairingError == nil && inviter.status?.peers.list?.contains(where: { $0.agentId == "first-inviter" }) == true)

        // The other selected Identity uses loopback; joining this public Server
        // must fail with a human action and leave that disposable config intact.
        let inviterFile = URL(fileURLWithPath: plan.profile.dataDirectory).appendingPathComponent("agent-config.json")
        let inviterBefore = try Data(contentsOf: inviterFile)
        inviter.useInvitation(); inviter.pairingInput = publicInvitation
        inviter.joinInvitationLine(); try await settled(inviter)
        let inviterAfter = try Data(contentsOf: inviterFile)
        precondition(inviter.pairingError == PairingError.differentServer.localizedDescription && inviterBefore == inviterAfter)
        inviter.pairingInput = ""
        try capture(PairingSheet(model: inviter), to: pictures.appendingPathComponent("after-existing-server-refusal-\(language).png"))

        first.useInvitation(); first.pairingInput = invitation
        first.bind(originalProfile, expectedAgent: "first-inviter", skipInitialDoctor: true)
        try await settled(first)
        first.joinInvitationLine()
        precondition(!first.operating && first.pairingError == PairingError.unconfirmed.localizedDescription)
        clipboard.clearContents()
        print("PASS native \(language): public-address prompt, credential gate, clipboard Invitation, legacy/Cf/quoted stdin join, clipboard Reply, legacy/Cf/quoted stdin add-peer, both Contacts verified, Reply recovery, cancellation, first-run inviter, existing Identity form, different tokens refused unchanged, identical Cf quote accepted with Identity and keys preserved, existing Reply and both Contacts, Server conflict unchanged, changed selection refused")
        print("PASS native \(language): copied Invitation stays out of visible output, with or without a Server key")
        print("22 native checks passed; no Service or network exchange claimed")
    }
}
