import AppKit
import SwiftUI
import CoreText
import UserNotifications
import MurmurTrayCore

/// N1 product assembly. Shared files are vendored byte-for-byte; transport stays upstream.
@MainActor enum AIMTheme {
    /// The edition look applies only to a stamped edition build or an explicit `--aim-*` developer command.
    /// Shared stock views (profile, pairing, client setup, outbox) use system fonts and colors otherwise.
    static var active: Bool { AIMEditionConfig.current.isEnabled || AIMPreview.isRequested }
    static var canvasColor: NSColor { active ? AIMAppShellStyle.canvas : .windowBackgroundColor }
    static var ink: Color { active ? Color(nsColor: AIMAppShellStyle.ink) : .primary }
    static var canvas: Color { Color(nsColor: canvasColor) }
    static var surface: Color { active ? Color(nsColor: AIMAppShellStyle.surface) : Color(nsColor: .controlBackgroundColor) }
    static var signal: Color { active ? Color(nsColor: AIMAppShellStyle.signal) : .accentColor }
    static var muted: Color { active ? Color(nsColor: AIMAppShellStyle.muted) : .secondary }
    static var body: Font { active ? Font.custom("IBMPlexMono", size: 12) : .body }
    static var heading: Font { active ? Font.custom("IBMPlexMono-SmBld", size: 13) : .headline }
    static var title: Font { active ? Font.custom("IBMPlexMono-SmBld", size: 18) : .title2.weight(.semibold) }
    static var meta: Font { active ? Font.custom("IBMPlexMono-Medm", size: 11) : .caption }
    static var version: String {
        let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "2.12.0"
        let edition = Bundle.main.object(forInfoDictionaryKey: "AIMShellEdition") as? Int ?? 8
        return "\(v) · aim \(edition)"
    }
    /// The fonts come from the resource bundle packaged in Contents/Resources. The generated `Bundle.module`
    /// accessor falls back to the build directory under ~/Documents when the bundle is not beside the app, and an
    /// installed app waits on privacy consent there before its first frame (AIM 5 found it as a launch that never
    /// reached the run loop). `Bundle.module` stays for development runs outside an app bundle, the same rule
    /// `L10n` follows in MurmurTrayCore.
    static func registerFonts() {
        let packaged = Bundle.main.resourceURL?.appendingPathComponent("MurmurMenuBarSpike_MurmurMenuBar.bundle")
        let resources = packaged.flatMap(Bundle.init(url:)) ?? (Bundle.main.bundleURL.pathExtension == "app" ? nil : Bundle.module)
        for weight in [400, 500, 600] {
            if let url = resources?.url(forResource: "plex-mono-\(weight)", withExtension: "ttf") {
                CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
            }
        }
    }
    static func appIcon() -> NSImage {
        let image = NSImage(size: NSSize(width: 1024, height: 1024))
        image.lockFocus()
        NSColor.white.setFill()
        NSBezierPath(roundedRect: NSRect(x: 48, y: 48, width: 928, height: 928), xRadius: 196, yRadius: 196).fill()
        AIMAppMarkView.draw(.murmur, in: NSRect(x: 200, y: 200, width: 624, height: 624), mono: false)
        image.unlockFocus()
        return image
    }
}

extension View {
    /// The quiet edition button, or the system bordered button in a stock build.
    @MainActor @ViewBuilder func aimQuietButtonStyle() -> some View {
        if AIMTheme.active { buttonStyle(AIMQuietButtonStyle()) } else { buttonStyle(.bordered) }
    }
}

struct AIMQuietButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(AIMTheme.body)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .foregroundStyle(AIMTheme.ink.opacity(enabled ? 1 : 0.4))
            .background(configuration.isPressed ? Color(nsColor: AIMAppShellStyle.selected) : Color(nsColor: AIMAppShellStyle.surface))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(nsColor: AIMAppShellStyle.divider), lineWidth: 1))
    }
}

@MainActor final class AIMWindowState: NSObject, NSWindowDelegate, ObservableObject {
    static let shared = AIMWindowState(defaults: AIMThemeRegression.scratchDefaults ?? .standard)
    /// A saved pin survives migration, Escape and relaunch.
    static let pinKey = "org.aimindset.murmur.pinned"
    /// Rule 49: ⌥⌘U in the family pattern, recorded in settings (rule 50). Until AIM 5 the app held ⌃⌥⌘M.
    static let hotkeyStore = FamilyHotkeyStore(owner: FamilyHotkeys.murmur,
                                               fallback: FamilyHotkey(keyCode: 32, modifiers: [.option, .command], character: "u"))
    var surface: AIMSurface?
    private weak var attachedWindow: NSWindow?
    private let defaults: UserDefaults
    @Published var pinned: Bool
    /// Rule 53: white by default, `org.aimindset.murmur.theme`.
    @Published var theme: AIMThemePolicy.Mode
    @Published var followsSystem: Bool
    private var appearanceObservation: NSKeyValueObservation?
    @Published var hotkey: FamilyHotkey? = AIMWindowState.hotkeyStore.current
    @Published var hotkeyAvailable = true
    @Published var hotkeyLine = ""
    @Published var hotkeyRecording = false
    struct PageRequest { let id = UUID(); let page: String }
    @Published var pageRequest: PageRequest?
    func requestPage(_ page: String) { pageRequest = PageRequest(page: page) }
    /// The delegate re-registers the Carbon key when the field stores a new combination.
    var onHotkeyChange: ((FamilyHotkey?) -> Void)?
    var onStateChange: (() -> Void)?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        theme = AIMThemePolicy.load(defaults)
        followsSystem = defaults.bool(forKey: "org.aimindset.murmur.followSystemAppearance")
        let d = defaults
        let resolution = AIMPinPolicy.resolve(stored: d.object(forKey: Self.pinKey) == nil ? nil : d.bool(forKey: Self.pinKey),
                                              migrated: d.bool(forKey: AIMPinPolicy.migrationKey))
        if resolution.writePinned { d.set(resolution.pinned, forKey: Self.pinKey) }
        if resolution.markMigrated { d.set(true, forKey: AIMPinPolicy.migrationKey) }
        pinned = resolution.pinned
        super.init()
        appearanceObservation = NSApp.observe(\.effectiveAppearance, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.refreshSystemAppearance() }
        }
        if followsSystem { NSApp.appearance = nil; refreshSystemAppearance() }
    }
    func setFollowSystem(_ enabled: Bool) {
        followsSystem = enabled
        defaults.set(enabled, forKey: "org.aimindset.murmur.followSystemAppearance")
        if enabled { NSApp.appearance = nil; refreshSystemAppearance() }
        else { setTheme(theme) }
    }
    private func refreshSystemAppearance() {
        guard followsSystem else { return }
        let mode: AIMThemePolicy.Mode = NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? .dark : .light
        renderTheme(mode)
    }
    private func renderTheme(_ mode: AIMThemePolicy.Mode) {
        AIMThemePolicy.withAppearance(mode) {
            attachedWindow?.appearance = AIMThemePolicy.appearance(mode)
            attachedWindow?.backgroundColor = AIMTheme.canvasColor
            theme = mode
            attachedWindow?.contentView?.needsDisplay = true
            onStateChange?()
        }
    }
    func setPinned(_ value: Bool) {
        pinned = value
        defaults.set(value, forKey: Self.pinKey)
        surface?.pinned = value
        onStateChange?()
    }
    func setTheme(_ mode: AIMThemePolicy.Mode) {
        followsSystem = false
        defaults.set(false, forKey: "org.aimindset.murmur.followSystemAppearance")
        AIMThemePolicy.store(mode, defaults)
        AIMThemePolicy.apply(mode)
        renderTheme(mode)
    }
    func hotkeyChanged(_ combo: FamilyHotkey?) {
        hotkey = combo
        onHotkeyChange?(combo)
    }
    var keysLine: String { hotkey.map { $0.display + " open and close" } ?? "no global key" }
    func attach(_ window: NSWindow) {
        attachedWindow = window
        window.appearance = AIMThemePolicy.appearance(theme)
        surface = AIMSurface(host: .window(window), pinned: pinned)
        window.delegate = self
    }
    func close(_ reason: AIMSurface.CloseReason) { surface?.close(reason: reason) }
    func windowShouldClose(_ sender: NSWindow) -> Bool { close(.commandW); return false }
}

struct AIMHeaderBridge: NSViewRepresentable {
    let onSettings: () -> Void
    let status: String
    func makeNSView(context: Context) -> AIMAppHeader {
        let pin = AIMPinButton(pinned: AIMWindowState.shared.pinned) { value in AIMWindowState.shared.setPinned(value) }
        let header = AIMAppHeader(mark: .murmur, name: "mur·mur", status: status,
                                 version: AIMTheme.version, width: 708,
                                 onSettings: onSettings, pin: pin,
                                 onClose: { AIMWindowState.shared.close(.closeButton) })
        applyWordmark(to: header)
        header.closeButton?.toolTip = "close the window \u{00B7} esc or \u{2318}W"
        header.settingsButton?.toolTip = "settings: theme, the global key, the server companion and the local service"
        // N1 family character in the header; flat family mark remains in the menu bar.
        let voxel = AIMVoxelView(model: AIMVoxelModels.murmur)
        voxel.wantsLayer = true
        voxel.layer?.backgroundColor = AIMThemePolicy.resolvedCGColor(AIMAppShellStyle.plate, appearance: AIMThemePolicy.appearance(.light))
        voxel.toolTip = "murmur aim \u{00B7} live character \u{00B7} click: scatter and assemble"
        voxel.frame = header.markView.bounds
        voxel.autoresizingMask = [.width, .height]
        header.markView.addSubview(voxel)
        header.markView.setAccessibilityLabel("Murmur AIM")
        return header
    }
    private func applyWordmark(to header: AIMAppHeader) {
        let wordmark = NSMutableAttributedString(string: "mur·mur", attributes: [
            .font: header.nameLabel.font ?? NSFont.monospacedSystemFont(ofSize: AIMAppShellStyle.titleSize, weight: .semibold),
            .foregroundColor: AIMAppShellStyle.ink,
        ])
        wordmark.addAttribute(.foregroundColor, value: AIMAppShellStyle.signal, range: NSRange(location: 3, length: 1))
        header.nameLabel.attributedStringValue = wordmark
        header.nameLabel.setAccessibilityLabel("mur·mur")
    }
    func updateNSView(_ view: AIMAppHeader, context: Context) {
        applyWordmark(to: view)
        view.setStatus(status)
        view.pinButton?.setPinned(AIMWindowState.shared.pinned)
    }
}

struct AIMTabsBridge: NSViewRepresentable {
    @Binding var page: String
    func makeNSView(context: Context) -> AIMTabStrip {
        AIMTabStrip(tabs: [.init(id: "Overview", title: L10n.text("Overview").lowercased(), hint: L10n.text("The server desk: incoming requests, decisions and questions")),
                          .init(id: "People", title: L10n.text("People").lowercased(), hint: L10n.text("The roster: people, their agents and the last wake outcome")),
                          .init(id: "Connections", title: L10n.text("Connection flow").lowercased(), hint: L10n.text("People, assistants and the work reaching your desk")),
                          .init(id: "Home", title: L10n.text("Local").lowercased(), hint: L10n.text("This Mac: the local profile, invitations and the service")),
                          .init(id: "Help", title: L10n.text("Help").lowercased(), hint: L10n.text("How the companion, delivery and replies work"))],
                    selected: page, width: 708, tabWidth: 116, onSelect: { page = $0 })
    }
    func updateNSView(_ view: AIMTabStrip, context: Context) { view.select(page) }
}

struct AIMFooterBridge: NSViewRepresentable {
    let keys: String
    let status: String
    func makeNSView(context: Context) -> AIMFooterLine {
        let theme = AIMThemeButton(mode: AIMWindowState.shared.theme) { mode in AIMWindowState.shared.setTheme(mode) }
        // Rule 25: `apps` opens the catalog, the same address in every product.
        return AIMFooterLine(keys: keys, status: status, width: 708, theme: theme,
                             apps: { NSWorkspace.shared.open(URL(string: "https://apps.aimindset.org/")!) })
    }
    func updateNSView(_ view: AIMFooterLine, context: Context) {
        view.setStatus(status)
        view.setKeys(keys)
        view.themeButton?.setMode(AIMWindowState.shared.theme)
    }
}

/// Rule 50: the recorder field of the shared hotkey file inside the SwiftUI settings.
struct AIMHotkeyBridge: NSViewRepresentable {
    func makeNSView(context: Context) -> FamilyHotkeyField {
        let field = FamilyHotkeyField(store: AIMWindowState.hotkeyStore, width: 160)
        field.onLine = { line in
            AIMWindowState.shared.hotkeyLine = line
            AIMWindowState.shared.hotkeyRecording = line.hasPrefix("recording:")
        }
        field.onChange = { combo in AIMWindowState.shared.hotkeyChanged(combo) }
        return field
    }
    func updateNSView(_ view: FamilyHotkeyField, context: Context) {}
}

/// Fixture-only offscreen capture; no window, profile, daemon or AI-client changes.
@MainActor enum AIMPreview {
    static let commands: Set<String> = ["--aim-icon", "--aim-check-avatars", "--aim-check-shell", "--aim-check-theme", "--aim-render", "--aim-notification-status"]
    static var isRequested: Bool { ProcessInfo.processInfo.arguments.contains(where: commands.contains) }
    static func runIfRequested() -> Bool {
        let args = ProcessInfo.processInfo.arguments
        if args.contains("--aim-notification-status") {
            // Read the OS decision for this bundle. No activation, permission prompt,
            // notification delivery, runtime startup or preference writes.
            Task { @MainActor in
                let settings = await UNUserNotificationCenter.current().notificationSettings()
                let names: [UNAuthorizationStatus: String] = [.notDetermined:"not_determined", .denied:"denied", .authorized:"authorized", .provisional:"provisional"]
                print("{\"bundle\":\"\(Bundle.main.bundleIdentifier ?? "unknown")\",\"authorization\":\"\(names[settings.authorizationStatus] ?? "unknown")\",\"alerts\":\(settings.alertSetting.rawValue),\"sounds\":\(settings.soundSetting.rawValue)}")
                exit(0)
            }
            Timer.scheduledTimer(withTimeInterval: 5, repeats: false) { _ in
                print("{\"authorization\":\"unavailable\"}"); exit(1)
            }
            RunLoop.main.run(); return true
        }
        if let index = args.firstIndex(of: "--aim-icon"), args.indices.contains(index + 1) {
            save(AIMTheme.appIcon(), to: args[index + 1]); return true
        }
        if args.contains("--aim-check-avatars") { AIMAvatarChecks.run(); return true }
        if args.contains("--aim-check-theme") { AIMThemeRegression.run(); return true }
        if args.contains("--aim-check-shell") { checkShell(); return true }
        guard let index = args.firstIndex(of: "--aim-render"), args.indices.contains(index + 1) else { return false }
        let model = TrayModel(startRuntime: false)
        if let fixture = args.firstIndex(of: "--aim-fixture"), args.indices.contains(fixture + 1),
           let data = try? Data(contentsOf: URL(fileURLWithPath: args[fixture + 1])) {
            model.companion.snapshot = try? AIMCompanionSnapshot.decode(data)
            model.companion.previewConnected = model.companion.snapshot != nil
        }
        let page = args.firstIndex(of: "--aim-page").flatMap { args.indices.contains($0 + 1) ? args[$0 + 1] : nil } ?? "Home"
        // `--aim-theme dark|light` renders one theme without storing it; the default reads the saved choice.
        let theme = args.firstIndex(of: "--aim-theme").flatMap { args.indices.contains($0 + 1) ? AIMThemePolicy.resolve(args[$0 + 1]) : nil }
            ?? AIMThemePolicy.load()
        AIMThemePolicy.apply(theme)
        AIMWindowState.shared.theme = theme
        // Render the existing conversation sheet with injected metadata only. No SSH reads occur.
        let historyPeer = args.firstIndex(of: "--aim-history-peer").flatMap { args.indices.contains($0 + 1) ? args[$0 + 1] : nil }
        let historySection = args.firstIndex(of: "--aim-history-section").flatMap { args.indices.contains($0 + 1) ? args[$0 + 1] : nil } ?? "Messages"
        var contextConfig = AIMEditionConfig.current
        if let ownerIndex = args.firstIndex(of: "--aim-history-owner"), args.indices.contains(ownerIndex + 1) {
            contextConfig.ownerResponsibility = AIMEditionConfig(info: ["AIMOwnerResponsibility": args[ownerIndex + 1]]).ownerResponsibility
        }
        let root: AnyView
        if args.contains("--aim-owner-attention"), let data = model.companion.snapshot, let attention = data.attention {
            root = AnyView(ScrollView {
                AIMAttentionList(data: data, items: attention.yourTurn, title: "Waiting for you").padding(24)
            }.font(AIMTheme.body).foregroundStyle(AIMTheme.ink).background(AIMTheme.canvas)
                .preferredColorScheme(theme == .dark ? .dark : .light).tint(AIMTheme.signal).aimQuietButtonStyle())
        } else if let historyPeer, ["Messages", "Decisions", "Next steps"].contains(historySection) {
            root = AnyView(AIMMessageSearchView(enabled: false, people: model.companion.snapshot?.people ?? [], historyPeer: historyPeer,
                                               snapshot: model.companion.snapshot, initialSection: historySection, previewOnly: true, contextConfig: contextConfig)
                .foregroundStyle(AIMTheme.ink).background(AIMTheme.canvas)
                .preferredColorScheme(theme == .dark ? .dark : .light).tint(AIMTheme.signal))
        } else { root = AnyView(AIMHomeView(model: model, initialPage: page)) }
        let view = NSHostingView(rootView: root)
        view.frame = historyPeer == nil ? NSRect(x: 0, y: 0, width: 740, height: 700) : NSRect(x: 0, y: 0, width: 660, height: 600)
        view.appearance = AIMThemePolicy.appearance(theme)
        view.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        view.layoutSubtreeIfNeeded()
        func capture(_ path: String) {
            guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { fatalError("Offscreen bitmap unavailable") }
            view.cacheDisplay(in: view.bounds, to: rep)
            guard let png = rep.representation(using: .png, properties: [:]) else { fatalError("PNG unavailable") }
            do { try png.write(to: URL(fileURLWithPath: path)) }
            catch { fatalError("Cannot save preview: \(error)") }
        }
        capture(args[index + 1])
        // `--aim-flip <path>`: the same view after the footer switch, without a restart (rule 53 says live).
        if let flip = args.firstIndex(of: "--aim-flip"), args.indices.contains(flip + 1) {
            let next: AIMThemePolicy.Mode = theme == .dark ? .light : .dark
            AIMThemePolicy.apply(next)
            AIMWindowState.shared.theme = next
            view.appearance = AIMThemePolicy.appearance(next)
            RunLoop.main.run(until: Date().addingTimeInterval(0.3))
            view.layoutSubtreeIfNeeded()
            capture(args[flip + 1])
        }
        return true
    }
    /// Offscreen check of the shell wiring: pin, theme, the family key table and the recorder. Nothing is shown,
    /// stored in the app domain or registered; the walk uses a scratch defaults suite and a fixed sibling reader.
    static func checkShell() {
        var failures: [String] = []
        func need(_ ok: Bool, _ what: String) { print((ok ? "PASS " : "FAIL ") + what); if !ok { failures.append(what) } }
        let suite = "org.aimindset.murmur.check"
        let scratch = UserDefaults(suiteName: suite)!
        scratch.removePersistentDomain(forName: suite)
        need(AIMMenuPresence.invalidPosition(5618, screenWidth: 1728), "menu: offscreen saved position is recovered")
        need(!AIMMenuPresence.invalidPosition(160, screenWidth: 1728), "menu: valid user placement is preserved")
        scratch.set(5618, forKey: AIMMenuPresence.positionKey)
        AIMMenuPresence.prepare(defaults: scratch, screenWidth: 1728)
        need(scratch.integer(forKey: AIMMenuPresence.positionKey) == 160 && scratch.bool(forKey: "NSStatusItem Visible Item-0"), "menu: own position and visibility restored")
        scratch.set(240, forKey: AIMMenuPresence.positionKey)
        AIMMenuPresence.prepare(defaults: scratch, screenWidth: 1728)
        need(scratch.integer(forKey: AIMMenuPresence.positionKey) == 240, "menu: relaunch retains valid placement")
        need(AIMAppMarkView.image(.murmur, size: 18, mono: true).isTemplate, "menu: canonical 18 pt template mark")
        let display = NSRect(x: 0, y: 0, width: 1440, height: 900)
        let panel = NSSize(width: 740, height: 640)
        let centered = AIMMenuPresence.panelFrame(size: panel, status: NSRect(x: 700, y: 900, width: 28, height: 24), visible: display)
        need(centered == NSRect(x: 344, y: 254, width: 740, height: 640), "menu anchor: below the actual status item")
        let left = AIMMenuPresence.panelFrame(size: panel, status: NSRect(x: 10, y: 900, width: 28, height: 24), visible: display)
        need(left?.minX == 0, "menu anchor: left edge stays on display")
        let right = AIMMenuPresence.panelFrame(size: panel, status: NSRect(x: 1400, y: 900, width: 28, height: 24), visible: display)
        need(right?.maxX == 1440, "menu anchor: right edge stays on display")
        let secondary = AIMMenuPresence.panelFrame(size: panel, status: NSRect(x: -1200, y: 100, width: 28, height: 24), visible: NSRect(x: -1440, y: -800, width: 1440, height: 900))
        need(secondary?.minX == -1440 && secondary?.maxY == 94, "menu anchor: negative-coordinate display")
        let short = AIMMenuPresence.panelFrame(size: panel, status: NSRect(x: 700, y: 500, width: 28, height: 24), visible: NSRect(x: 0, y: 0, width: 1440, height: 500))
        need(short?.height == 500 && short?.minY == 0, "menu anchor: short display contains panel")
        need(AIMMenuPresence.panelFrame(size: panel, status: .zero, visible: display) == nil, "menu anchor: hidden item keeps fallback window")
        need(AIMPinPolicy.resolve(stored: true, migrated: false).pinned == true && AIMPinPolicy.resolve(stored: true, migrated: true).pinned,
             "pin: explicit saved choice survives first migration and later launches")
        need(AIMThemePolicy.key(bundle: "org.aimindset.murmur") == "org.aimindset.murmur.theme", "theme: one key form, <bundle id>.theme")
        need(AIMThemePolicy.resolve(nil) == .light && AIMThemePolicy.resolve("dark") == .dark, "theme: white by default")
        AIMThemePolicy.store(.dark, scratch, key: suite + ".theme")
        need(AIMThemePolicy.load(scratch, key: suite + ".theme") == .dark, "theme: saved dark choice reloads from product defaults")
        AIMThemePolicy.store(.light, scratch, key: suite + ".theme")
        need(AIMThemePolicy.load(scratch, key: suite + ".theme") == .light, "theme: saved light choice reloads from product defaults")
        need(AIMAppMarkView.image(.murmur, size: 18, mono: true).tiffRepresentation != AIMAppMarkView.image(.family, size: 18, mono: true).tiffRepresentation,
             "identity: Murmur menu geometry differs from the family catalog")
        need(FamilyHotkeys.signature == FamilyHotkeys.sharedSignature, "keys: the family table matches the shared signature")
        need(FamilyHotkeys.familyDefaults.count == 6, "keys: six products in the family table")
        let store = FamilyHotkeyStore(owner: FamilyHotkeys.murmur, fallback: AIMWindowState.hotkeyStore.fallback, bundle: suite, defaults: scratch)
        need(store.current?.display == "\u{2325}\u{2318}U", "keys: Murmur AIM ships \u{2325}\u{2318}U")
        let field = FamilyHotkeyField(store: store)
        field.reader = .absent
        var line = ""
        field.onLine = { line = $0 }
        field.take(keyCode: 46, flags: [.control, .option, .command], characters: "m")
        need(store.current?.display == "\u{2303}\u{2325}\u{2318}M", "keys: the AIM 4 combination \u{2303}\u{2325}\u{2318}M can still be recorded by hand")
        field.take(keyCode: 7, flags: [.option, .command], characters: "x")
        need(line.contains("taken by krest"), "keys: \u{2325}\u{2318}X is refused by name, it belongs to krest")
        field.take(keyCode: 117, flags: [], characters: nil)
        need(store.current == nil, "keys: delete clears")
        scratch.removePersistentDomain(forName: suite)
        print(failures.isEmpty ? "PASS: murmur shell check, " + FamilyHotkeys.printedRows.joined(separator: " \u{00B7} ") : "FAIL: \(failures.count)")
        exit(failures.isEmpty ? 0 : 1)
    }

    static func save(_ image: NSImage, to path: String) {
        guard let data = image.tiffRepresentation, let rep = NSBitmapImageRep(data: data),
              let png = rep.representation(using: .png, properties: [:]) else { fatalError("Icon render failed") }
        do { try png.write(to: URL(fileURLWithPath: path)) } catch { fatalError("Cannot save icon: \(error)") }
    }
}

/// Local panel shortcuts leave editors, attached dialogs and the hotkey recorder in control.
struct AIMKeyboardBridge: NSViewRepresentable {
    let onEscape: () -> Void
    let onSettings: () -> Void
    let onTab: (String) -> Void
    final class Coordinator {
        weak var view: NSView?
        var onEscape: (() -> Void)?
        var onSettings: (() -> Void)?
        var onTab: ((String) -> Void)?
        var monitor: Any?
        deinit { if let monitor { NSEvent.removeMonitor(monitor) } }
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        let c = context.coordinator
        c.view = view
        c.monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak c] event in
            guard let c, let window = c.view?.window, event.window === window,
                  window.attachedSheet == nil, !AIMWindowState.shared.hotkeyRecording else { return event }
            if event.keyCode == 53 { c.onEscape?(); return nil }
            let flags = event.modifierFlags.intersection([.command, .control, .option, .shift])
            if flags == .command, event.charactersIgnoringModifiers == "," {
                c.onSettings?(); return nil
            }
            guard flags.isEmpty, !(window.firstResponder is NSTextView), !(window.firstResponder is NSTextField),
                  let digit = Int(event.charactersIgnoringModifiers ?? ""), (1...5).contains(digit) else { return event }
            c.onTab?(["Overview", "People", "Connections", "Home", "Help"][digit - 1])
            return nil
        }
        return view
    }
    func updateNSView(_ view: NSView, context: Context) {
        context.coordinator.onEscape = onEscape
        context.coordinator.onSettings = onSettings
        context.coordinator.onTab = onTab
    }
    static func dismantleNSView(_ view: NSView, coordinator: Coordinator) {
        if let monitor = coordinator.monitor { NSEvent.removeMonitor(monitor); coordinator.monitor = nil }
    }
}
