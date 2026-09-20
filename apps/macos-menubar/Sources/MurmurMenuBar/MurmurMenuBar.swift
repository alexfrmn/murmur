import AppKit
import SwiftUI
import ServiceManagement
import MurmurTrayCore

private struct DoctorRead: Sendable { let value: DoctorSnapshot?; let error: String? }

@MainActor
final class TrayModel: ObservableObject {
    @Published var status: StatusSnapshot?
    @Published var statusError = Verdict(.unknown, reason: "Выберите папку профиля Murmur")
    @Published var doctor: DoctorSnapshot?
    @Published var doctorError: String?
    @Published var operationError: String?
    @Published var operationMessage: String?
    @Published var operating = false
    @Published var profile: ProfileBinding?
    @Published var profileError: String? = "Выберите папку профиля Murmur"
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
                alert.messageText = "Murmur пока не может запуститься"
                alert.informativeText = error.localizedDescription
                if case RuntimeError.missingNode = error {
                    alert.addButton(withTitle: "Открыть сайт Node.js")
                    alert.addButton(withTitle: "Проверить снова")
                    alert.addButton(withTitle: "Закрыть")
                    NSApplication.shared.activate(ignoringOtherApps: true)
                    switch alert.runModal() {
                    case .alertFirstButtonReturn: NSWorkspace.shared.open(URL(string: "https://nodejs.org/en/download")!)
                    case .alertSecondButtonReturn: prepareRuntime()
                    default: break
                    }
                } else {
                    alert.addButton(withTitle: "Закрыть")
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
    // Update I/O never participates in profile/status/service command readiness.
    var canChangeUpdates: Bool { !isDemo && updatesClient != nil && !checkingUpdates }
    var updatesForcedOff: Bool { updatesClient?.forcedOff == true }
    var updateAvailable: Bool { updates?.releasePage() != nil }
    var accessibleStatus: String { "Murmur: " + verdict.reason + (updateAvailable ? "; доступно обновление" : "") }

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
        if !NSWorkspace.shared.open(page) { updateError = "Не удалось открыть страницу релиза" }
    }

    var controlBlockReason: String? {
        if isDemo { return "Демонстрационный режим" }
        if preparingRuntime { return "Проверяем движок Murmur…" }
        if let runtimeError { return runtimeError }
        if let profileError { return profileError }
        guard let client, let status, let agentID else { return "Профиль ещё не подтверждён" }
        do {
            guard try client.verifiedAgent(in: status) == agentID else { return ProfileError.identityChanged.localizedDescription }
        } catch { return error.localizedDescription }
        return busy ? "Дождитесь завершения текущей команды" : nil
    }

    var canControl: Bool { controlBlockReason == nil }
    var wakeAction: ControlAction { status?.wake.config.enabled == false ? .resume : .pause }

    func chooseProfile() {
        guard !busy, !isDemo, runtimeError == nil else { return }
        let picker = NSOpenPanel()
        picker.title = "Папка профиля Murmur"
        picker.message = "Выберите папку профиля, созданного через Murmur CLI"
        picker.prompt = "Выбрать профиль"
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
        profileError = "Проверяем выбранный профиль…"
        statusError = Verdict(.unknown, reason: "Проверяем выбранный профиль…")
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
                           reason: "Демонстрация — \(demoState.title.lowercased())")
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
            statusError = result.error ?? Verdict(.unknown, reason: "Состояние ещё не получено")
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
        doctor = nil; doctorError = "После изменения запустите проверку заново"
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
            statusError = Verdict(.unknown, reason: "Проверяем статус после команды…")
            operating = false
            refreshStatus()
        }
    }

    func wakeState(_ value: Bool?) -> String {
        value.map { $0 ? "передача агенту включена" : "передача агенту на паузе" } ?? "не измерено"
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
                if !NSWorkspace.shared.open(directory) { operationError = "Не удалось открыть папку логов" }
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
                operationError = "Автозапуск ожидает разрешения в настройках macOS"
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
            Text(model.isDemo ? "Murmur — демо" : "Murmur")
            if model.runtimeError != nil {
                Button("Проверить снова") { model.prepareRuntime() }.disabled(model.preparingRuntime)
            }
            if let profile = model.profile {
                Text("Профиль: \(model.agentID ?? "не подтверждён")")
                Text(profile.dataDirectory)
                if let service = profile.serviceName { Text("Служба: \(service)") }
            }
            Button("Выбрать папку профиля…") { model.chooseProfile() }
                .disabled(model.busy || model.isDemo || model.runtimeError != nil)
            if let reason = model.controlBlockReason { Text(reason) }
            if let mismatch = model.status?.modeMismatch { Text(mismatch) }
            Label(model.verdict.reason, systemImage: model.verdict.indicator.symbol)
            if let operationError = model.operationError { Text(operationError) }
            if let message = model.operationMessage { Text(message) }
            Text("Непрочитанных: \(model.status?.inbox.unread.map(String.init) ?? "не измерено")")
            Text("Ожидают передачи агенту: \(model.status?.wake.delivery.pendingUndelivered.map(String.init) ?? "не измерено")")
            Text("В настройках: \(model.wakeState(model.status?.wake.config.enabled))")
            Text("Сейчас: \(model.wakeState(model.status?.wake.effective.enabled))")
            if model.status?.wake.effective.needsRestart == true { Text("Для применения настройки нужен перезапуск службы") }
            if let status = model.status {
                ForEach(status.diagnosticNotes.filter { $0 != status.modeMismatch }, id: \.self) { note in Text(note) }
            }
            Divider()
            if model.isDemo {
                Menu("Проверить состояния") {
                    ForEach(Indicator.allCases, id: \.self) { state in
                        Button(state.title) { model.demoState = state }
                    }
                }
            }
            Menu("Диагностика") {
                if let doctor = model.doctor {
                    ForEach(doctor.rows()) { row in
                        Label("\(row.title): \(row.detail)", systemImage: row.symbol)
                    }
                    Text("Проверено: \(doctor.generatedAt)")
                } else {
                    Text(model.doctorError ?? "Ещё не проверялось")
                    ForEach(DoctorSnapshot.stageIDs.indices, id: \.self) { index in
                        Text("\(DoctorSnapshot.titles[index]) — нет в ответе")
                    }
                }
                Button(model.checkingDoctor ? "Проверяется…" : "Проверить сейчас") {
                    model.refreshDoctor(); model.refreshStatus()
                }.disabled(model.busy || model.isDemo || model.profile == nil)
            }
            Button(model.operating ? "Выполняется…" : model.wakeAction.title) { model.perform(model.wakeAction) }
                .disabled(!model.canControl || model.status?.wake.config.enabled == nil)
            Button("Открыть inbox") {}.disabled(true)
            Text("Просмотр inbox ещё не поддерживается Murmur CLI")
            Button("Скопировать диагностику") { model.copyDiagnostics() }
            Menu("Служба") {
                Button("Запустить") { model.perform(.start) }.disabled(!model.canControl)
                Button("Остановить") { model.perform(.stop) }.disabled(!model.canControl)
                Button("Открыть настроенный каталог журналов") { model.openLogs() }.disabled(!model.canControl)
            }
            Menu(model.updateAvailable ? "Доступно обновление Murmur" : "Обновления Murmur") {
                if let updates = model.updates {
                    Text(updates.title())
                    Text("Версия продукта: \(updates.currentVersion ?? "неизвестна")")
                    Text(updates.reasonText)
                    Text("Последняя попытка: \(updates.checkedAt ?? "не измерена")")
                    Text(updates.ageText())
                    Text("Последняя успешная проверка: \(updates.lastSuccessAt ?? "не измерена")")
                    if let next = updates.nextCheckAt { Text("Следующая проверка не раньше: \(next)") }
                    if updates.stale { Text("Прежний успешный результат устарел") }
                } else { Text("Обновления: результат неизвестен") }
                if model.checkingUpdates { Text("Проверка обновлений…") }
                if let error = model.updateError { Text(error) }
                Button("Открыть страницу релиза") { model.openUpdateRelease() }
                    .disabled(!model.updateAvailable || model.isDemo)
                Divider()
                Text("Проверка — раз в 6 часов, общий кеш для пользователя")
                Text("GitHub узнаёт ваш IP и факт использования Murmur")
                if model.updatesForcedOff { Text("Проверка запрещена через MURMUR_UPDATE_CHECK=0") }
                Button("Включить проверку обновлений") { model.refreshUpdates(enabled: true) }
                    .disabled(!model.canChangeUpdates || model.updatesForcedOff)
                Button("Отключить проверку обновлений") { model.refreshUpdates(enabled: false) }
                    .disabled(!model.canChangeUpdates)
            }
            Divider()
            Toggle("Запускать при входе", isOn: Binding(
                get: { model.launchAtLogin }, set: { model.setLaunchAtLogin($0) }
            )).disabled(model.isDemo)
            Button(model.checkingStatus ? "Обновляется…" : "Обновить статус") { model.refreshStatus() }
                .disabled(model.busy || model.isDemo || model.profile == nil)
            Button("Выход") { NSApplication.shared.terminate(nil) }.keyboardShortcut("q")
        } label: {
            Image(nsImage: model.icon).accessibilityLabel(model.accessibleStatus)
        }
        .menuBarExtraStyle(.menu)
    }
}
