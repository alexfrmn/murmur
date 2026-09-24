import AppKit
import SwiftUI
import MurmurTrayCore

@main struct RecoveryEvidence {
    @MainActor static func capture<V: View>(_ view: V, to path: URL) throws {
        let host = NSHostingView(rootView: view.frame(width: 580, height: 720)
            .background(Color(nsColor: .windowBackgroundColor)).environment(\.colorScheme, .light))
        host.frame = NSRect(x: 0, y: 0, width: 580, height: 720)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: .aqua); window.contentView = host
        host.layoutSubtreeIfNeeded(); host.displayIfNeeded()
        let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds)!
        host.cacheDisplay(in: host.bounds, to: bitmap)
        try bitmap.representation(using: .png, properties: [:])!.write(to: path)
    }
    @MainActor static func main() async throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1]), language = CommandLine.arguments[2], stage = CommandLine.arguments[3]
        precondition(FileManager.default.homeDirectoryForCurrentUser.path == root.appendingPathComponent("home").path)
        _ = NSApplication.shared
        UserDefaults.standard.setVolatileDomain(["interfaceLanguage": language], forName: UserDefaults.argumentDomain)
        let pictures = root.appendingPathComponent("screenshots")
        try FileManager.default.createDirectory(at: pictures, withIntermediateDirectories: true)
        let model = TrayModel(startRuntime: false)
        model.profile = try ProfileBinding(dataDirectory: root.appendingPathComponent("unavailable-identity").path)
        model.agentID = "current-identity"
        precondition(!model.busy && !model.canUseInvitation)
        try capture(MurmurHomeView(model: model).firstRun.padding(24), to: pictures.appendingPathComponent("\(stage)-recovery-\(language).png"))
        model.beginInviting()
        precondition(model.showCreateProfileSheet == (stage == "before"))
        print("PASS \(stage) \(language): bound Identity with unavailable status opens new Identity form = \(model.showCreateProfileSheet)")
        let setup = TrayModel(startRuntime: false)
        let access = root.appendingPathComponent("access-key.txt")
        try "test-only\nsecond-line".write(to: access, atomically: true, encoding: .utf8)
        setup.creationAgentID = "new-identity"; setup.creationServer = "nats://server.example.invalid:4222"; setup.creationAccessFile = access
        setup.createOwnProfile(agentID: setup.creationAgentID, server: setup.creationServer, accessFile: access)
        for _ in 0..<800 {
            if !setup.busy { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        precondition(!setup.busy && setup.creationError != nil && setup.profile == nil)
        let expected = stage == "before" ? ProbeError.failed(1).localizedDescription : L10n.text("The Server access key must be one line. Ask for the correct key and save it again.")
        precondition(setup.creationError == expected && !setup.creationError!.contains("test-only"))
        try capture(CreateProfileSheet(model: setup), to: pictures.appendingPathComponent("\(stage)-access-error-\(language).png"))
        print("PASS \(stage) \(language): invalid access file presentation, no input value displayed")
        let snapshot = try DoctorSnapshot.decode(JSONSerialization.data(withJSONObject: ["schema":"murmur.doctor/1", "generatedAt":"2026-09-24T16:00:00Z", "stages":[["id":"roundtrip", "state":"ok", "detail":"fixture", "elapsedMs":42]]]))
        let row = snapshot.rows().first { $0.id == "roundtrip" }!
        precondition((row.title == L10n.text("Reply")) == (stage == "before"))
        try capture(VStack(alignment: .leading, spacing: 24) {
            Text(L10n.text("Connection check")).font(.title2.weight(.semibold))
            Label("\(row.title): \(row.detail)", systemImage: row.symbol)
            Divider()
            Text(L10n.text("Paste colleague's Reply")).font(.title2.weight(.semibold))
            Text(L10n.text("Reply")).font(.headline)
        }.padding(24), to: pictures.appendingPathComponent("\(stage)-doctor-reply-\(language).png"))
        print("PASS \(stage) \(language): Doctor roundtrip and pairing title separation")
        print("3 native review observations passed")
    }
}
