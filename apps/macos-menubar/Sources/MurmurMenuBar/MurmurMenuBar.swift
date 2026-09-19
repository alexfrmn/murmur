import AppKit
import SwiftUI
import ServiceManagement
import MurmurTrayCore

private struct StatusRead: Sendable { let value: StatusSnapshot?; let error: Verdict? }
private struct DoctorRead: Sendable { let value: DoctorSnapshot?; let error: String? }

@MainActor
final class TrayModel: ObservableObject {
    @Published var status: StatusSnapshot?
    @Published var statusError = Verdict(.unknown, reason: "Состояние ещё не получено")
    @Published var doctor: DoctorSnapshot?
    @Published var doctorError: String?
    @Published var operationError: String?
    @Published var checkingStatus = false
    @Published var checkingDoctor = false
    @Published var launchAtLogin = SMAppService.mainApp.status == .enabled
    @Published var demoState: Indicator = .unknown
    let isDemo: Bool
    private var timer: Timer?

    init() {
        isDemo = ProcessInfo.processInfo.arguments.contains("--demo")
        if !isDemo {
            refreshStatus()
            refreshDoctor()
            timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.refreshStatus() }
            }
        }
    }

    var verdict: Verdict {
        if isDemo {
            return Verdict(demoState, unread: demoState == .unread,
                           reason: "Демонстрация — \(demoState.title.lowercased())")
        }
        return status?.verdict() ?? statusError
    }

    func refreshStatus() {
        guard !checkingStatus, !isDemo else { return }
        checkingStatus = true
        Task {
            let result = await Task.detached { () -> StatusRead in
                guard let path = CLIProbe.locate() else {
                    return StatusRead(value: nil, error: .unavailable(ProbeError.missingCLI))
                }
                do {
                    let data = try CLIProbe(executable: path).run("status").data
                    return StatusRead(value: try StatusSnapshot.decode(data), error: nil)
                } catch { return StatusRead(value: nil, error: .unavailable(error)) }
            }.value
            status = result.value
            statusError = result.error ?? Verdict(.unknown, reason: "Состояние ещё не получено")
            checkingStatus = false
        }
    }

    // A doctor roundtrip is active traffic: startup or explicit button only.
    func refreshDoctor() {
        guard !checkingDoctor, !isDemo else { return }
        checkingDoctor = true
        Task {
            let result = await Task.detached { () -> DoctorRead in
                guard let path = CLIProbe.locate() else {
                    return DoctorRead(value: nil, error: ProbeError.missingCLI.localizedDescription)
                }
                do {
                    let data = try CLIProbe(executable: path, timeout: 30).run("doctor").data
                    return DoctorRead(value: try DoctorSnapshot.decode(data), error: nil)
                } catch { return DoctorRead(value: nil, error: error.localizedDescription) }
            }.value
            doctor = result.value
            doctorError = result.error
            checkingDoctor = false
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
        let image = NSImage(size: NSSize(width: 20, height: 20), flipped: false) { _ in
            color.setFill()
            NSBezierPath(ovalIn: NSRect(x: 3, y: 3, width: 14, height: 14)).fill()
            if unread {
                NSColor.systemBlue.setFill()
                NSBezierPath(ovalIn: NSRect(x: 13, y: 12, width: 7, height: 7)).fill()
            }
            return true
        }
        image.isTemplate = false
        image.accessibilityDescription = current.reason
        return image
    }
}

@main
struct MurmurMenuBarApp: App {
    @StateObject private var model = TrayModel()

    var body: some Scene {
        MenuBarExtra {
            Text(model.isDemo ? "Murmur — демо" : "Murmur — прототип")
            if let mismatch = model.status?.modeMismatch { Text(mismatch) }
            Label(model.verdict.reason, systemImage: model.verdict.indicator.symbol)
            if let operationError = model.operationError { Text(operationError) }
            if let count = model.status?.inbox.unread, count > 0 {
                Text("Непрочитанных: \(count)")
            }
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
                }.disabled(model.checkingDoctor || model.isDemo)
            }
            Button(model.status?.wake.effective.enabled == false ? "Возобновить" : "Пауза") {}.disabled(true)
            Button("Открыть inbox") {}.disabled(true)
            Button("Скопировать диагностику") { model.copyDiagnostics() }
            Menu("Служба") {
                Button("Запустить") {}.disabled(true)
                Button("Остановить") {}.disabled(true)
                Button("Открыть логи") {}.disabled(true)
                Text("Управление службой ещё не подключено")
            }
            Divider()
            Toggle("Запускать при входе", isOn: Binding(
                get: { model.launchAtLogin }, set: { model.setLaunchAtLogin($0) }
            )).disabled(model.isDemo)
            Button(model.checkingStatus ? "Обновляется…" : "Обновить статус") { model.refreshStatus() }
                .disabled(model.checkingStatus || model.isDemo)
            Button("Выход") { NSApplication.shared.terminate(nil) }.keyboardShortcut("q")
        } label: {
            Image(nsImage: model.icon).accessibilityLabel("Murmur: \(model.verdict.reason)")
        }
        .menuBarExtraStyle(.menu)
    }
}
