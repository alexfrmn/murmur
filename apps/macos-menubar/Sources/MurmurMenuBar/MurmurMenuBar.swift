import AppKit
import SwiftUI
import ServiceManagement
import MurmurTrayCore

private struct DoctorRead: Sendable { let value: DoctorSnapshot?; let error: String? }

@MainActor
final class TrayModel: ObservableObject {
    @Published var language = L10n.language()
    @Published var status: StatusSnapshot?
    @Published var statusError = Verdict(.unknown, reason: L10n.text("Choose a Murmur profile folder"))
    @Published var doctor: DoctorSnapshot?
    @Published var doctorError: String?
    @Published var operationError: String?
    @Published var operationMessage: String?
    @Published var operating = false
    @Published var profile: ProfileBinding?
    @Published var profileError: String? = L10n.text("Choose a Murmur profile folder")
    @Published var agentID: String?
    @Published var checkingStatus = false
    @Published var checkingDoctor = false
    @Published var updates: UpdateSnapshot?
    @Published var updateError: String?
    @Published var checkingUpdates = false
    @Published var runtimeError: String?
    @Published var preparingRuntime = false
    @Published var launchAtLogin = SMAppService.mainApp.status == .enabled
    @Published var demoState: Indicator = .unknown
    let isDemo: Bool
    private var timer: Timer?
    private var updateTimer: Timer?
    private var client: ProfileClient?
    private var updatesClient: UpdatesClient?
    private var selectionID = UUID()

    init() {
        isDemo = ProcessInfo.processInfo.arguments.contains("--demo")
        if !isDemo { prepareRuntime() }
    }

    func prepareRuntime() {
        guard !isDemo, !preparingRuntime else { return }
        guard let helper = BundledRuntime.cli() else { connectClients(); return }
        preparingRuntime = true
        Task {
            let result = await Task.detached { () -> Result<Void, Error> in
                Result {
                    let runtime = try BundledRuntime.runtime(for: helper)
                    _ = try BundledRuntime.findNode(runtime: runtime)
                }
            }.value
            preparingRuntime = false
            switch result {
            case .success:
                runtimeError = nil
                connectClients()
            case .failure(let error):
                runtimeError = error.localizedDescription
                statusError = Verdict(.unknown, reason: error.localizedDescription)
                let alert = NSAlert()
                alert.messageText = L10n.text("Murmur cannot start yet")
                alert.informativeText = error.localizedDescription
                if case RuntimeError.missingNode = error {
                    alert.addButton(withTitle: L10n.text("Open Node.js website"))
                    alert.addButton(withTitle: L10n.text("Try again"))
                    alert.addButton(withTitle: L10n.text("Close"))
                    NSApplication.shared.activate(ignoringOtherApps: true)
                    switch alert.runModal() {
                    case .alertFirstButtonReturn: NSWorkspace.shared.open(URL(string: "https://nodejs.org/en/download")!)
                    case .alertSecondButtonReturn: prepareRuntime()
                    default: break
                    }
                } else {
                    alert.addButton(withTitle: L10n.text("Close"))
                    NSApplication.shared.activate(ignoringOtherApps: true)
                    alert.runModal()
                }
            }
        }
    }

    private func connectClients() {
            timer?.invalidate()
            let env = ProcessInfo.processInfo.environment
            let stored = UserDefaults.standard
            let directory = env["MURMUR_DATA_DIR"] ?? stored.string(forKey: "profileDirectory")
            let serviceName = env["MURMUR_DATA_DIR"] != nil ? env["MURMUR_SERVICE_NAME"] : stored.string(forKey: "profileServiceName")
            if let directory {
                do { bind(try ProfileBinding(dataDirectory: directory, serviceName: serviceName)) }
                catch { profileError = error.localizedDescription }
            }
            timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.refreshStatus() }
            }
            if let executable = CLIProbe.locate(environment: env) {
                updatesClient = UpdatesClient(executable: executable, environment: env)
                refreshUpdates()
            } else { updateError = ProbeError.missingCLI.localizedDescription }
    }

    var busy: Bool { preparingRuntime || operating || checkingStatus || checkingDoctor }
    func selectLanguage(_ value: AppLanguage) {
        guard !busy, !checkingUpdates, value != language else { return }
        L10n.select(value)
        language = value
        operationError = nil; operationMessage = nil
        doctorError = doctor == nil ? L10n.text("Not checked yet") : nil
        if profile == nil {
            profileError = L10n.text("Choose a Murmur profile folder")
            statusError = Verdict(.unknown, reason: L10n.text("Choose a Murmur profile folder"))
        } else {
            refreshStatus()
        }
        if runtimeError != nil { prepareRuntime() }
        refreshUpdates()
    }
    // Update I/O never participates in profile/status/service command readiness.
    var canChangeUpdates: Bool { !isDemo && updatesClient != nil && !checkingUpdates }
    var updatesForcedOff: Bool { updatesClient?.forcedOff == true }
    var updateAvailable: Bool { updates?.releasePage() != nil }
    var accessibleStatus: String { "Murmur: " + verdict.reason + (updateAvailable ? L10n.text("; update available") : "") }

    func refreshUpdates(enabled: Bool? = nil) {
        guard !isDemo, !checkingUpdates, let updatesClient else { return }
        checkingUpdates = true; updateError = nil
        Task { [self] in
            let result = await Task.detached { () -> Result<UpdateSnapshot, Error> in
                Result {
                    if let enabled { try updatesClient.setEnabled(enabled) }
                    // A disabled check is local-only in the CLI contract. Read back
                    // the effective preference, including a process opt-out.
                    return try updatesClient.check()
                }
            }.value
            switch result {
            case .success(let snapshot): updates = snapshot
            case .failure(let error): updates = nil; updateError = error.localizedDescription
            }
            checkingUpdates = false
            // Schedule from completion so a slow startup cannot make the next
            // invocation fall just before the CLI's six-hour cache deadline.
            updateTimer?.invalidate()
            updateTimer = Timer.scheduledTimer(withTimeInterval: 21_600, repeats: false) { [weak self] _ in
                Task { @MainActor in self?.refreshUpdates() }
            }
        }
    }

    func openUpdateRelease() {
        guard !isDemo, let page = updates?.releasePage() else { return }
        // No download, installer or shell: an explicit click opens an allowed page.
        if !NSWorkspace.shared.open(page) { updateError = L10n.text("Could not open the release page") }
    }

    var controlBlockReason: String? {
        if isDemo { return L10n.text("Demo mode") }
        if preparingRuntime { return L10n.text("Checking the Murmur engine…") }
        if let runtimeError { return runtimeError }
        if let profileError { return profileError }
        guard let client, let status, let agentID else { return L10n.text("The profile has not been verified yet") }
        do {
            guard try client.verifiedAgent(in: status) == agentID else { return ProfileError.identityChanged.localizedDescription }
        } catch { return error.localizedDescription }
        return busy ? L10n.text("Wait for the current command to finish") : nil
    }

    var canControl: Bool { controlBlockReason == nil }
    var wakeAction: ControlAction { status?.wake.config.enabled == false ? .resume : .pause }

    func chooseProfile() {
        guard !busy, !isDemo, runtimeError == nil else { return }
        let picker = NSOpenPanel()
        picker.title = L10n.text("Murmur profile folder")
        picker.message = L10n.text("Choose a profile folder created with Murmur CLI")
        picker.prompt = L10n.text("Choose profile")
        picker.canChooseFiles = false; picker.canChooseDirectories = true
        picker.canCreateDirectories = false; picker.allowsMultipleSelection = false
        picker.showsHiddenFiles = true
        NSApplication.shared.activate(ignoringOtherApps: true)
        guard picker.runModal() == .OK, let url = picker.url else { return }
        do {
            let chosen = try ProfileBinding(dataDirectory: url.path)
            UserDefaults.standard.set(chosen.dataDirectory, forKey: "profileDirectory")
            UserDefaults.standard.removeObject(forKey: "profileServiceName")
            bind(chosen)
        } catch { profileError = error.localizedDescription }
    }

    private func bind(_ chosen: ProfileBinding) {
        selectionID = UUID()
        profile = chosen; agentID = nil; status = nil; doctor = nil
        operationMessage = nil; operationError = nil
        profileError = L10n.text("Checking the selected profile…")
        statusError = Verdict(.unknown, reason: L10n.text("Checking the selected profile…"))
        guard let executable = CLIProbe.locate() else {
            client = nil; profileError = ProbeError.missingCLI.localizedDescription
            statusError = .unavailable(ProbeError.missingCLI)
            return
        }
        client = ProfileClient(executable: executable, profile: chosen)
        refreshStatus()
        refreshDoctor()
    }

    var verdict: Verdict {
        if isDemo {
            return Verdict(demoState, unread: demoState == .unread,
                           reason: L10n.text("Demo — %@", String(describing: (demoState.title.lowercased()))))
        }
        return status?.verdict() ?? statusError
    }

    func refreshStatus() {
        guard !checkingStatus, !operating, !isDemo, let client else { return }
        let selected = selectionID
        let expectedAgent = agentID
        checkingStatus = true
        Task {
            let result = await Task.detached {
                client.readProfileStatus(expectedAgent: expectedAgent)
            }.value
            guard selected == selectionID else { return }
            // Publish only a validated observation. A rejected identity supplies
            // no snapshot/counters and keeps the previous binding until reselect.
            status = result.status
            agentID = result.agentID
            statusError = result.error ?? Verdict(.unknown, reason: L10n.text("Status has not been received yet"))
            profileError = result.error?.reason
            checkingStatus = false
        }
    }

    // A doctor roundtrip is active traffic: startup or explicit button only.
    func refreshDoctor() {
        guard !checkingDoctor, !operating, !isDemo, let client else { return }
        let selected = selectionID
        checkingDoctor = true
        Task {
            let result = await Task.detached { () -> DoctorRead in
                do {
                    return DoctorRead(value: try client.readDoctor(), error: nil)
                } catch { return DoctorRead(value: nil, error: error.localizedDescription) }
            }.value
            guard selected == selectionID else { return }
            doctor = result.value
            doctorError = result.error
            checkingDoctor = false
        }
    }

    func perform(_ action: ControlAction) {
        guard canControl, let client, let agentID else { return }
        operating = true; operationError = nil; operationMessage = nil
        doctor = nil; doctorError = L10n.text("Run diagnostics again after making changes")
        let selected = selectionID
        Task {
            let result = await Task.detached { () -> Result<ControlReceipt, Error> in
                Result { try client.perform(action, expectedAgent: agentID) }
            }.value
            guard selected == selectionID else { return }
            switch result {
            case .success(let receipt): operationMessage = receipt.message
            case .failure(let error): operationError = error.localizedDescription
            }
            // Do not turn configuration acknowledgement into effective runtime state.
            // Refresh after errors too: a timed-out mutation may already have applied.
            status = nil
            statusError = Verdict(.unknown, reason: L10n.text("Checking status after the command…"))
            operating = false
            refreshStatus()
        }
    }

    func wakeState(_ value: Bool?) -> String {
        value.map { $0 ? L10n.text("agent delivery enabled") : L10n.text("agent delivery paused") } ?? L10n.text("not measured")
    }

    func openLogs() {
        guard canControl, let client, let agentID else { return }
        operating = true; operationError = nil; operationMessage = nil
        let selected = selectionID
        Task {
            let result = await Task.detached { () -> Result<URL, Error> in
                Result { try client.logDirectory(expectedAgent: agentID) }
            }.value
            guard selected == selectionID else { return }
            operating = false
            switch result {
            case .success(let directory):
                if !NSWorkspace.shared.open(directory) { operationError = L10n.text("Could not open the log folder") }
            case .failure(let error): operationError = error.localizedDescription
            }
        }
    }

    func copyDiagnostics() {
        // Copy an allowlisted summary, not arbitrary CLI fields/error output.
        var lines = ["Murmur macOS spike", "mode=\(isDemo ? "demo" : "CLI")", verdict.reason]
        if let status { lines.append("schema=\(status.schema); generatedAt=\(status.generatedAt)") }
        if let doctor {
            lines.append("doctor=\(doctor.schema); generatedAt=\(doctor.generatedAt)")
            lines += doctor.rows().map { "\($0.id): \($0.state)" }
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(lines.joined(separator: "\n"), forType: .string)
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        operationError = nil
        do {
            if enabled { try SMAppService.mainApp.register() }
            else { try SMAppService.mainApp.unregister() }
            launchAtLogin = SMAppService.mainApp.status == .enabled
            if SMAppService.mainApp.status == .requiresApproval {
                operationError = L10n.text("Launch at login needs approval in macOS settings")
                SMAppService.openSystemSettingsLoginItems()
            }
        } catch { operationError = error.localizedDescription }
    }

    var icon: NSImage {
        let current = verdict
        let color: NSColor = switch current.indicator {
        case .unknown, .stopped, .paused: .secondaryLabelColor
        case .offline: .systemYellow
        case .ready, .unread: .systemGreen
        case .failed: .systemRed
        }
        let unread = current.unread
        let hasUpdate = updateAvailable
        let image = NSImage(size: NSSize(width: 20, height: 20), flipped: false) { _ in
            color.setFill()
            NSBezierPath(ovalIn: NSRect(x: 3, y: 3, width: 14, height: 14)).fill()
            if unread {
                NSColor.systemBlue.setFill()
                NSBezierPath(ovalIn: NSRect(x: 13, y: 12, width: 7, height: 7)).fill()
            }
            if hasUpdate {
                NSColor.systemPurple.setFill()
                NSBezierPath(ovalIn: NSRect(x: 0, y: 0, width: 8, height: 8)).fill()
                NSColor.white.setStroke()
                let arrow = NSBezierPath(); arrow.lineWidth = 1.2
                arrow.move(to: NSPoint(x: 4, y: 1.5)); arrow.line(to: NSPoint(x: 4, y: 6))
                arrow.move(to: NSPoint(x: 2, y: 4)); arrow.line(to: NSPoint(x: 4, y: 6)); arrow.line(to: NSPoint(x: 6, y: 4))
                arrow.stroke()
            }
            return true
        }
        image.isTemplate = false
        image.accessibilityDescription = accessibleStatus
        return image
    }
}

@main
struct MurmurMenuBarApp: App {
    @StateObject private var model = TrayModel()

    var body: some Scene {
        MenuBarExtra {
            Text(model.isDemo ? L10n.text("Murmur — demo") : "Murmur")
            if model.runtimeError != nil {
                Button(L10n.text("Try again")) { model.prepareRuntime() }.disabled(model.preparingRuntime)
            }
            if let profile = model.profile {
                Text(L10n.text("Profile: %@", String(describing: (model.agentID ?? L10n.text("not verified")))))
                Text(profile.dataDirectory)
                if let service = profile.serviceName { Text(L10n.text("Service: %@", String(describing: (service)))) }
            }
            Button(L10n.text("Choose profile folder…")) { model.chooseProfile() }
                .disabled(model.busy || model.isDemo || model.runtimeError != nil)
            if let reason = model.controlBlockReason { Text(reason) }
            if let mismatch = model.status?.modeMismatch { Text(mismatch) }
            Label(model.verdict.reason, systemImage: model.verdict.indicator.symbol)
            if let operationError = model.operationError { Text(operationError) }
            if let message = model.operationMessage { Text(message) }
            Text(L10n.text("Unread: %@", String(describing: (model.status?.inbox.unread.map(String.init) ?? L10n.text("not measured")))))
            Text(L10n.text("Waiting for agent delivery: %@", String(describing: (model.status?.wake.delivery.pendingUndelivered.map(String.init) ?? L10n.text("not measured")))))
            Text(L10n.text("Configured: %@", String(describing: (model.wakeState(model.status?.wake.config.enabled)))))
            Text(L10n.text("Effective now: %@", String(describing: (model.wakeState(model.status?.wake.effective.enabled)))))
            if model.status?.wake.effective.needsRestart == true { Text(L10n.text("Restart the service to apply this setting")) }
            if let status = model.status {
                ForEach(status.diagnosticNotes.filter { $0 != status.modeMismatch }, id: \.self) { note in Text(note) }
            }
            Divider()
            if model.isDemo {
                Menu(L10n.text("Preview states")) {
                    ForEach(Indicator.allCases, id: \.self) { state in
                        Button(state.title) { model.demoState = state }
                    }
                }
            }
            Menu(L10n.text("Diagnostics")) {
                if let doctor = model.doctor {
                    ForEach(doctor.rows()) { row in
                        Label("\(row.title): \(row.detail)", systemImage: row.symbol)
                    }
                    Text(L10n.text("Checked: %@", String(describing: (doctor.generatedAt))))
                } else {
                    Text(model.doctorError ?? L10n.text("Not checked yet"))
                    ForEach(DoctorSnapshot.stageIDs.indices, id: \.self) { index in
                        Text(L10n.text("%@ — missing from response", String(describing: (DoctorSnapshot.titles[index]))))
                    }
                }
                Button(model.checkingDoctor ? L10n.text("Checking…") : L10n.text("Check now")) {
                    model.refreshDoctor(); model.refreshStatus()
                }.disabled(model.busy || model.isDemo || model.profile == nil)
            }
            Button(model.operating ? L10n.text("Working…") : model.wakeAction.title) { model.perform(model.wakeAction) }
                .disabled(!model.canControl || model.status?.wake.config.enabled == nil)
            Button(L10n.text("Open inbox")) {}.disabled(true)
            Text(L10n.text("Inbox viewing is not supported by Murmur CLI yet"))
            Button(L10n.text("Copy diagnostics")) { model.copyDiagnostics() }
            Menu(L10n.text("Service")) {
                Button(L10n.text("Start")) { model.perform(.start) }.disabled(!model.canControl)
                Button(L10n.text("Stop")) { model.perform(.stop) }.disabled(!model.canControl)
                Button(L10n.text("Open configured log folder")) { model.openLogs() }.disabled(!model.canControl)
            }
            Menu(model.updateAvailable ? L10n.text("Murmur update available") : L10n.text("Murmur updates")) {
                if let updates = model.updates {
                    Text(updates.title())
                    Text(L10n.text("Product version: %@", String(describing: (updates.currentVersion ?? L10n.text("unknown.version")))))
                    Text(updates.reasonText)
                    Text(L10n.text("Last attempt: %@", String(describing: (updates.checkedAt ?? L10n.text("not-measured.time")))))
                    Text(updates.ageText())
                    Text(L10n.text("Last successful check: %@", String(describing: (updates.lastSuccessAt ?? L10n.text("not-measured.time")))))
                    if let next = updates.nextCheckAt { Text(L10n.text("Next check no earlier than: %@", String(describing: (next)))) }
                    if updates.stale { Text(L10n.text("The previous successful result is stale")) }
                } else { Text(L10n.text("Updates: result unknown")) }
                if model.checkingUpdates { Text(L10n.text("Checking for updates…")) }
                if let error = model.updateError { Text(error) }
                Button(L10n.text("Open release page")) { model.openUpdateRelease() }
                    .disabled(!model.updateAvailable || model.isDemo)
                Divider()
                Text(L10n.text("Checks every 6 hours; cache shared by this user"))
                Text(L10n.text("GitHub receives your IP address and sees that you use Murmur"))
                if model.updatesForcedOff { Text(L10n.text("Checks are blocked by MURMUR_UPDATE_CHECK=0")) }
                Button(L10n.text("Enable update checks")) { model.refreshUpdates(enabled: true) }
                    .disabled(!model.canChangeUpdates || model.updatesForcedOff)
                Button(L10n.text("Disable update checks")) { model.refreshUpdates(enabled: false) }
                    .disabled(!model.canChangeUpdates)
            }
            Divider()
            Menu(L10n.text("Language")) {
                ForEach(AppLanguage.allCases, id: \.self) { language in
                    Button { model.selectLanguage(language) } label: {
                        if model.language == language {
                            Label(language.name, systemImage: "checkmark")
                        } else {
                            Text(language.name)
                        }
                    }.disabled(model.busy || model.checkingUpdates)
                }
            }
            Toggle(L10n.text("Launch at login"), isOn: Binding(
                get: { model.launchAtLogin }, set: { model.setLaunchAtLogin($0) }
            )).disabled(model.isDemo)
            Button(model.checkingStatus ? L10n.text("Refreshing…") : L10n.text("Refresh status")) { model.refreshStatus() }
                .disabled(model.busy || model.isDemo || model.profile == nil)
            Button(L10n.text("Quit")) { NSApplication.shared.terminate(nil) }.keyboardShortcut("q")
        } label: {
            Image(nsImage: model.icon).accessibilityLabel(model.accessibleStatus)
        }
        .menuBarExtraStyle(.menu)
    }
}
