import AppKit
import SwiftUI
import UserNotifications
import CryptoKit
import MurmurTrayCore

@MainActor final class AIMCompanionModel: ObservableObject {
    @Published var snapshot: AIMCompanionSnapshot?
    @Published var busy = false
    @Published var failed = false
    @Published var notifications = UserDefaults.standard.bool(forKey: "aimCompanionNotifications")
    @Published var notificationDenied = false
    @Published var requestingNotifications = false
    @Published var previewConnected = false
    private var timer: Timer?
    private var cursor = AIMCompanionCursor(seen: UserDefaults.standard.stringArray(forKey: "aimCompanionSeen").map(Set.init))
    @Published var localDashboard = UserDefaults.standard.bool(forKey: "aimLocalDashboardPreview")
    /// The owner board comes from the edition; without one only the local development preview exists.
    static var board: String {
        let preview = "http://127.0.0.1:8768/"
        return UserDefaults.standard.bool(forKey: "aimLocalDashboardPreview") ? preview
            : (AIMEditionConfig.current.boardURL?.absoluteString ?? preview)
    }
    func setLocalDashboard(_ value: Bool) {
        localDashboard = value
        UserDefaults.standard.set(value, forKey: "aimLocalDashboardPreview")
    }
    var enabled: Bool { previewConnected || (AIMEditionConfig.current.canReachServer && UserDefaults.standard.bool(forKey: "aimServerEnabled")) }
    var current: Bool { !failed && snapshot?.isCurrent() == true }
    var badge: String {
        guard enabled else { return "" }
        guard current, let snapshot else { return " !" }
        let count = snapshot.decision_count + snapshot.incoming.reduce(0) { $0 + $1.ids.count }
        return count > 0 ? " \(count)" : ""
    }
    func start() {
        guard enabled, timer == nil else { return }
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }
    func connect() { UserDefaults.standard.set(true, forKey: "aimServerEnabled"); start() }
    func disconnect() {
        UserDefaults.standard.set(false, forKey: "aimServerEnabled")
        timer?.invalidate(); timer = nil; snapshot = nil; failed = false
    }
    func refresh() {
        guard enabled, !busy else { return }
        busy = true
        Task {
            let result = await Task.detached { Result { try Self.readServer() } }.value
            busy = false
            guard enabled else { return }
            switch result {
            case .failure: failed = true
            case .success(let data):
                snapshot = data; failed = false
                guard data.isCurrent() else { return }
                let keys = Set(data.attentionKeys.map { SHA256.hash(data: Data($0.utf8)).map { String(format: "%02x", $0) }.joined() })
                let added = cursor.observe(keys)
                // Only hashes are retained. Queue text and people are held in memory.
                let retained = Array(cursor.seen ?? []).sorted().suffix(8192)
                UserDefaults.standard.set(Array(retained), forKey: "aimCompanionSeen")
                if notifications && !added.isEmpty {
                    let senders = data.incoming.filter { row in row.ids.contains { id in
                        let key = "message:\(row.peer):\(id)"
                        let hash = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
                        return added.contains(hash)
                    }}.map { row in data.people.first { $0.agents.contains(row.peer) }?.name ?? row.peer }
                    notify(count: added.count, senders: Array(Set(senders)).sorted())
                }
            }
        }
    }
    nonisolated private static func readServer() throws -> AIMCompanionSnapshot {
        return try AIMCompanionSnapshot.decode(AIMOwnerRead.exchange(["action": "snapshot"]))
    }
    func toggleNotifications() {
        if notifications {
            notifications = false; UserDefaults.standard.set(false, forKey: "aimCompanionNotifications"); return
        }
        NSApp.activate(ignoringOtherApps: true)
        requestingNotifications = true
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            Task { @MainActor in
                self.requestingNotifications = false
                self.notifications = granted; self.notificationDenied = !granted
                UserDefaults.standard.set(granted, forKey: "aimCompanionNotifications")
            }
        }
    }
    private func notify(count: Int, senders: [String]) {
        let content = UNMutableNotificationContent()
        content.title = "Murmur AIM"
        content.body = L10n.text("New messages or decisions to review") + ": \(count)" + (senders.isEmpty ? "" : " · " + senders.prefix(2).joined(separator: ", "))
        content.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)) { _ in }
    }
    static func open(_ path: String = "") {
        guard let url = URL(string: board + path) else { return }
        NSWorkspace.shared.open(url)
    }
    static func stamp(_ raw: String?) -> String {
        guard let date = AIMCompanionSnapshot.date(raw) else { return L10n.text("Not observed") }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: L10n.language().rawValue)
        formatter.timeZone = .current
        formatter.dateStyle = .medium; formatter.timeStyle = .short
        return formatter.string(from: date)
    }
    static func privateStatus(_ contour: AIMCompanionSnapshot.PrivateContour) -> String {
        let state: String
        switch contour.service_active {
        case true: state = L10n.text("Active at last check")
        case false: state = L10n.text("Inactive at last check")
        case nil: state = L10n.text("Service unobserved")
        }
        return state + " · " + L10n.text("Status checked") + ": " + stamp(contour.updated_at)
            + " · " + L10n.text("Last message") + ": " + stamp(contour.last_at)
    }
}

struct AIMCompanionView: View {
    @ObservedObject var model: AIMCompanionModel
    @State private var query = ""
    @State private var showAllQuestions = false
    @State private var showSearch = false
    @State private var queue = "owner"
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L10n.text("Your communication desk")).font(AIMTheme.title)
            Text(L10n.text("People, incoming requests and decisions. Open a linked owner chat when one is verified.")).fixedSize(horizontal: false, vertical: true)
            HStack {
                Button(L10n.text("Dashboard")) { AIMCompanionModel.open() }.help(L10n.text("Open the private mesh dashboard in the browser"))
                Button(L10n.text("History")) { AIMCompanionModel.open("?view=mesh&section=history") }.help(L10n.text("Open the message history of the mesh in the dashboard"))
                Button(L10n.text("Connection map")) { AIMCompanionModel.open("?view=mesh&section=map") }.help(L10n.text("Open the map of who is connected to whom"))
                Button(L10n.text("Search messages")) { showSearch = true }.help(L10n.text("Search accessible Murmur messages on your server"))
                if let searchURL = AIMEditionConfig.current.sharedSearchURL {
                    Button(L10n.text("Search tools")) { NSWorkspace.shared.open(searchURL) }
                        .help(L10n.text("Open the dashboard search across people, topics and tools"))
                }

            }
            if !model.enabled {
                Text(L10n.text("Read the existing owner server through your Mac's SSH connection. No new identity or private keys are created."))
                Button(L10n.text("Connect my server overview")) { model.connect() }.help(L10n.text("Read the server overview over your SSH alias once a minute; no keys are created"))
            } else {
                HStack {
                    Text(AIMEditionConfig.current.serverLabel).font(AIMTheme.heading)
                    Spacer()
                    Button(L10n.text("Refresh")) { model.refresh() }.help(L10n.text("Read the server overview again now")).disabled(model.busy)
                }
                if model.busy && model.snapshot == nil { ProgressView(L10n.text("Reading server…")) }
                if model.failed {
                    Text(L10n.text("Server overview unavailable. Check the network and the SSH alias. Retained observations are stale.")).foregroundStyle(AIMTheme.signal)
                }
                if let data = model.snapshot {
                    Text("Murmur \(data.server_version) · " + L10n.text("Transport") + ": \(data.transport) · " + L10n.text("Codex service") + ": \(data.responder)").font(AIMTheme.meta)
                    Text((model.current ? L10n.text("Snapshot") : L10n.text("Stale snapshot")) + " · " + AIMCompanionModel.stamp(data.snapshot_at)).font(AIMTheme.meta)
                    Text(L10n.text("Your action") + ": \(data.ownerQuestions.count) · " + L10n.text("Waiting for agents") + ": \(data.agentQuestions.count) · " + L10n.text("Waiting for people") + ": \(data.peerQuestions.count)").font(AIMTheme.heading)
                    Text(L10n.text("Open topics") + ": \(data.pending_count) · " + L10n.text("Needs verification") + ": \(data.verificationQuestions.count)").font(AIMTheme.meta)
                    if data.budget.allowed != true || data.budget.fresh != true {
                        Text(L10n.text("Budget observation is separate from each contact’s responder. Check People for missing responders.")).foregroundStyle(AIMTheme.signal)
                        Text((data.budget.reason ?? "unknown") + " · " + AIMCompanionModel.stamp(data.budget.observed_at)).font(AIMTheme.meta)
                    }
                    if let policies = data.peer_policy {
                        ForEach(policies.peers.keys.sorted(), id: \.self) { peer in
                            if policies.peers[peer]?.responder == "none" {
                                Text(peer + " · " + L10n.text("Not assigned · manual reply needed")).font(AIMTheme.meta)
                            }
                        }
                    }
                    Divider()
                    TextField(L10n.text("Filter people and questions"), text: $query).textFieldStyle(.roundedBorder)
                    Picker(L10n.text("Answer queue"), selection: $queue) {
                        Text(L10n.text("Mine") + " · \(data.ownerQuestions.count)").tag("owner")
                        Text(L10n.text("Agents") + " · \(data.agentQuestions.count)").tag("agent")
                        Text(L10n.text("People") + " · \(data.peerQuestions.count)").tag("peer")
                        Text(L10n.text("Review") + " · \(data.verificationQuestions.count)").tag("verify")
                    }.pickerStyle(.segmented)
                    let questions = queue == "owner" ? data.ownerQuestions : data.questions.filter { $0.responsibility == queue }
                    questionSection(L10n.text("Answer queue"), questions: questions, data: data)
                    if questions.isEmpty { Text(L10n.text("No questions in this queue.")).font(AIMTheme.meta) }
                    if questions.count > 3 {
                        Button(showAllQuestions ? L10n.text("Show fewer questions") : L10n.text("Show more questions")) { showAllQuestions.toggle() }
                    }
                    Text(L10n.text("Incoming awaiting review") + ": \(data.incoming.reduce(0) { $0 + $1.ids.count })").font(AIMTheme.heading)
                    ForEach(Array(data.incoming.enumerated()), id: \.offset) { _, row in
                        let person = data.people.first { $0.agents.contains(row.peer) }
                        Text("\(person?.name ?? row.peer) · \(row.ids.count) · " + AIMCompanionModel.stamp(row.date)).font(AIMTheme.meta)
                    }
                    if let contours = data.private_contours, !contours.isEmpty {
                        Divider()
                        Text(L10n.text("Private contours · status only")).font(AIMTheme.heading)
                        ForEach(contours) { contour in
                            Text(contour.name + " · " + AIMCompanionModel.privateStatus(contour)).font(AIMTheme.meta)
                        }
                        Text(L10n.text("Private conversations stay outside this search and message list.")).font(AIMTheme.meta)
                    }
                    Text(L10n.text("Message dates show observed activity, not online presence. Topic decisions are reviewed separately.")).font(AIMTheme.meta)
                }
            }
        }.fixedSize(horizontal: false, vertical: true)
            .sheet(isPresented: $showSearch) { AIMMessageSearchView(enabled: model.enabled, people: model.snapshot?.people ?? []) }
    }

    @ViewBuilder private func questionSection(_ title: String, questions: [AIMCompanionSnapshot.Question], data: AIMCompanionSnapshot) -> some View {
        let filtered = questions.filter { question in
            let person = data.people.first { $0.agents.contains(question.peer ?? "") }
            return query.isEmpty || [question.title, question.peer, question.next_action, person?.name, person?.nickname].compactMap { $0 }.joined(separator: " ").localizedCaseInsensitiveContains(query)
        }
        if !filtered.isEmpty {
            Text(title + " · \(filtered.count)").font(AIMTheme.heading)
            ForEach(Array(filtered.prefix(showAllQuestions || !query.isEmpty ? 100 : 3))) { question in
                VStack(alignment: .leading, spacing: 6) {
                    Text(question.title ?? question.id).font(AIMTheme.heading)
                    Text((question.peer.flatMap { peer in data.people.first { $0.agents.contains(peer) }?.name } ?? question.peer ?? "") + " · " + AIMCompanionModel.stamp(question.source_date)).font(AIMTheme.meta)
                    Text("\(question.status ?? "unknown") · \(L10n.text("Reviewed")): \(AIMCompanionModel.stamp(question.reviewed_at))").font(AIMTheme.meta)
                    if let action = question.next_action { Text(action).fixedSize(horizontal: false, vertical: true) }
                    if let source = question.source_id {
                        Text(L10n.text("Source message") + " · " + source).font(AIMTheme.meta).textSelection(.enabled)
                    }
                    HStack {
                        Button(L10n.text("Read conversation")) {
                            var parts = URLComponents(string: AIMCompanionModel.board)!
                            parts.queryItems = [URLQueryItem(name: "view", value: "mesh"), URLQueryItem(name: "section", value: "history"), URLQueryItem(name: "topic", value: question.id)]
                            if let url = parts.url { NSWorkspace.shared.open(url) }
                        }
                        if let owner = data.ownerThread(for: question.peer), let url = owner.verifiedURL {
                            Button(L10n.text("Open owner chat")) { NSWorkspace.shared.open(url) }.help(owner.title)
                        }
                    }
                }
                Divider()
            }
        }
    }
}

struct AIMCompanionSettings: View {
    @ObservedObject var model: AIMCompanionModel
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n.text("Server companion")).font(AIMTheme.heading)
            Text(AIMEditionConfig.current.serverLabel + " · " + (AIMEditionConfig.current.ownerHost ?? L10n.text("No SSH alias configured"))).font(AIMTheme.meta)
            Text(L10n.text("Reads existing observations once per minute while the app is running. Server monitoring continues when the app closes."))
            HStack {
                Button(model.enabled ? L10n.text("Disconnect overview") : L10n.text("Connect my server overview")) { model.enabled ? model.disconnect() : model.connect() }.help(L10n.text("Stop or start the once-a-minute read of the overview; server monitoring keeps running"))
                Button(model.requestingNotifications ? L10n.text("Waiting for macOS permission…") : (model.notifications ? L10n.text("Disable notifications") : L10n.text("Enable notifications"))) { model.toggleNotifications() }.help(L10n.text("macOS notifications with sender names and counts, never the message text")).disabled(model.requestingNotifications)
            }
            if model.notificationDenied { Text(L10n.text("Allow Murmur AIM notifications in macOS System Settings.")).foregroundStyle(AIMTheme.signal) }
            Toggle(L10n.text("Local dashboard preview on this Mac"), isOn: Binding(get: { model.localDashboard }, set: { model.setLocalDashboard($0) }))
            Text(AIMCompanionModel.board).font(AIMTheme.meta).textSelection(.enabled)
            Text(L10n.text("Dates use this Mac's timezone") + " · " + TimeZone.current.identifier).font(AIMTheme.meta)
            Text(L10n.text("Notifications show sender names and counts, without message text. The first snapshot is silent. Delivery does not close a question."))
            Divider()
        }.fixedSize(horizontal: false, vertical: true)
    }
}

struct AIMCompanionHelp: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n.text("How these tools work together")).font(AIMTheme.title)
            Text(L10n.text("Mac app: overview, messages and shortcuts. Server: encrypted delivery and native WakeMonitor. Dashboard: history and sources. Each linked owner chat handles its own follow-up."))
            Text(L10n.text("Claude and local Codex profiles remain separate connections. Opening a window does not transfer conversation context or change the server responder."))
            Text(L10n.text("Task archive (formerly Recovery) is a dated dispatcher snapshot. It does not restart tasks or confirm their current status."))
            Text(L10n.text("Message search reads accessible Murmur history from your server. Private contours show status only."))
            Divider()
        }.fixedSize(horizontal: false, vertical: true)
    }
}
