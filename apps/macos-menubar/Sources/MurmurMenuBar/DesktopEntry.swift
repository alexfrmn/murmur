import AppKit
import Carbon
import Combine
import SwiftUI
import MurmurTrayCore

@MainActor
private final class GlobalShortcut {
    private var hotKey: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private let action: () -> Void

    init(action: @escaping () -> Void) { self.action = action }

    func register() -> Bool {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let result = InstallEventHandler(GetApplicationEventTarget(), { _, event, pointer in
            guard let pointer, let event else { return OSStatus(eventNotHandledErr) }
            var key = EventHotKeyID()
            guard GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                    nil, MemoryLayout<EventHotKeyID>.size, nil, &key) == noErr,
                  key.signature == 0x4D75726D, key.id == 1 else { return OSStatus(eventNotHandledErr) }
            MainActor.assumeIsolated {
                Unmanaged<GlobalShortcut>.fromOpaque(pointer).takeUnretainedValue().action()
            }
            return noErr
        }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), &handler)
        guard result == noErr else { return false }
        let status = RegisterEventHotKey(UInt32(kVK_ANSI_M), UInt32(controlKey | optionKey | cmdKey),
                                        EventHotKeyID(signature: 0x4D75726D, id: 1),
                                        GetApplicationEventTarget(), OptionBits(kEventHotKeyExclusive), &hotKey)
        if status != noErr { unregister() }
        return status == noErr
    }

    func unregister() {
        if let hotKey { UnregisterEventHotKey(hotKey); self.hotKey = nil }
        if let handler { RemoveEventHandler(handler); self.handler = nil }
    }
}

@MainActor
private final class CommandMenuItem: NSMenuItem {
    private let command: () -> Void

    init(_ title: String, enabled: Bool = true, command: @escaping () -> Void) {
        self.command = command
        super.init(title: title, action: #selector(invoke), keyEquivalent: "")
        target = self; isEnabled = enabled
    }

    required init(coder: NSCoder) { fatalError("Not used") }
    @objc private func invoke() { command() }
}

@MainActor
private final class MurmurAppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let model = TrayModel()
    private var item: NSStatusItem?
    private var window: NSWindow?
    private var observation: AnyCancellable?
    private var shortcut: GlobalShortcut?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        // Preserve the preference written by the previous single MenuBarExtra.
        // This API stores the user's Cmd-drag position; it cannot reveal notch overflow.
        item.autosaveName = "Item-0"
        self.item = item
        item.button?.target = self
        item.button?.action = #selector(statusButtonClicked)
        item.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        observation = model.objectWillChange.sink { [weak self] _ in
            Task { @MainActor [weak self] in self?.refreshStatusItem() }
        }
        let shortcut = GlobalShortcut { [weak self] in self?.toggleWindow() }
        self.shortcut = shortcut
        model.shortcutAvailable = shortcut.register()
        refreshStatusItem()
        // A real window is an independent entrance when macOS hides the status item.
        showWindow()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        shortcut?.unregister()
        observation?.cancel()
    }

    private func refreshStatusItem() {
        item?.button?.image = model.icon
        let entrance = model.shortcutAvailable ? L10n.text("Open Murmur: Control–Option–Command–M")
            : L10n.text("Shortcut unavailable. Open Murmur from Finder.")
        item?.button?.toolTip = model.accessibleStatus + "\n" + entrance
        item?.button?.setAccessibilityLabel(model.accessibleStatus)
    }

    @objc private func statusButtonClicked() {
        if NSApp.currentEvent?.type == .rightMouseUp {
            guard let item, let button = item.button else { return }
            let menu = quickMenu()
            menu.delegate = self
            item.menu = menu
            button.performClick(nil)
        } else { toggleWindow() }
    }

    func menuDidClose(_ menu: NSMenu) { item?.menu = nil }

    private func toggleWindow() {
        if window?.isVisible == true && NSApp.isActive { window?.orderOut(nil) }
        else { showWindow() }
    }

    private func showWindow() {
        if window == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 470, height: 520),
                                  styleMask: [.titled, .closable, .miniaturizable, .resizable],
                                  backing: .buffered, defer: false)
            window.title = "Murmur"
            window.minSize = NSSize(width: 430, height: 400)
            window.isReleasedWhenClosed = false
            window.contentView = NSHostingView(rootView: MurmurHomeView(model: model))
            window.center()
            window.setFrameAutosaveName("MurmurMainWindow")
            self.window = window
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    private func quickMenu() -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        func add(_ title: String, enabled: Bool = true, action: @escaping () -> Void) {
            menu.addItem(CommandMenuItem(title, enabled: enabled, command: action))
        }
        if model.profile != nil || model.isDemo {
            add(model.verdict.reason) { [weak self] in self?.showWindow() }
            add(L10n.text("Open Murmur")) { [weak self] in self?.showWindow() }
            menu.addItem(.separator())
        }
        add(L10n.text("Choose profile folder…"), enabled: !model.busy && !model.isDemo && model.runtimeError == nil) { [weak self] in
            self?.model.chooseProfile()
        }
        if model.profile != nil || model.isDemo {
            add(L10n.text("Refresh status"), enabled: !model.busy && !model.isDemo) { [weak self] in self?.model.refreshStatus() }
            if model.status?.wake.config.enabled != nil {
                add(model.wakeAction.title, enabled: model.canControl) { [weak self] in
                    guard let self else { return }; model.perform(model.wakeAction)
                }
            }
            if model.updateAvailable {
                add(L10n.text("Open release page"), enabled: !model.isDemo) { [weak self] in self?.model.openUpdateRelease() }
            }
            menu.addItem(.separator())
        }
        // Before a profile exists there are exactly these two commands. No unknown
        // counters, disabled feature catalogue, or placeholder inbox action.
        add(L10n.text("Quit")) { NSApp.terminate(nil) }
        return menu
    }
}

@main
struct MurmurMenuBarApp {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = MurmurAppDelegate()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
