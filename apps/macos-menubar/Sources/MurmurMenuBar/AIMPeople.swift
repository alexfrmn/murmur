import AppKit
import SwiftUI
import MurmurTrayCore

/// Compact directory: every current contact has a visible route or an explicit reason.
struct AIMPeopleView: View {
    @ObservedObject var model: AIMCompanionModel
    @MurmurViewState private var query = ""
    @MurmurViewState private var policyPerson: AIMCompanionSnapshot.Person?
    @MurmurViewState private var recipient: AIMCompanionSnapshot.Person?
    @MurmurViewState private var historyPerson: AIMCompanionSnapshot.Person?
    @MurmurViewState private var connectedOnly = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(L10n.text("People & agents")).font(AIMTheme.title)
                Spacer()
                if let url = teamDirectoryURL {
                    Button(L10n.text("Team directory")) { NSWorkspace.shared.open(url) }
                }
            }
            Text(L10n.text("Choose a person to read the conversation or send a message through their assistant.")).font(AIMTheme.meta)
            HStack {
                TextField(L10n.text("Name, nickname or agent"), text: $query).textFieldStyle(.roundedBorder)
                Toggle(L10n.text("Connected only"), isOn: $connectedOnly).toggleStyle(.checkbox)
            }
            if let data = model.snapshot {
                let rows = data.people.filter { person in
                    (!connectedOnly || !(person.writable_agents ?? []).isEmpty) &&
                    (query.isEmpty || ([person.name, person.nickname ?? ""] + person.agents + Array((person.agent_labels ?? [:]).values)).joined(separator: " ").localizedCaseInsensitiveContains(query))
                }
                Text("\(rows.count) / \(data.people.count) " + L10n.text("contacts") + " · " + AIMCompanionModel.stamp(data.snapshot_at)).font(AIMTheme.meta)
                ForEach(rows) { person in
                    AIMContactRow(data: data, person: person, current: model.current,
                                  enabled: model.enabled, imageReadEnabled: !model.previewConnected,
                                  write: { recipient = person }, read: { historyPerson = person },
                                  settings: { policyPerson = person },
                                  openBoard: { section in openBoard(person.id, section: section) })
                    Divider()
                }
                if rows.isEmpty { Text(L10n.text("No contacts match these filters.")) }
                if !model.current { Text(L10n.text("Refresh the server overview before sending.")).foregroundStyle(AIMTheme.signal) }
            } else {
                Text(L10n.text("Connect your server in Settings to load people."))
            }
        }
        .sheet(item: $recipient) { person in
            AIMComposeView(person: person, initialPeer: model.snapshot?.firstAllowedConnection(for: person, current: model.current))
        }
        .sheet(item: $policyPerson) { person in AIMPolicyView(person: person) }
        .sheet(item: $historyPerson) { person in
            if let data = model.snapshot, let peer = data.communicationPeer(for: person) {
                AIMMessageSearchView(enabled: model.enabled, people: data.people, historyPeer: peer)
            }
        }
    }
    private var teamDirectoryURL: URL? {
        AIMEditionConfig.current.teamDirectoryURL
    }
    private func openBoard(_ actor: String, section: String) {
        guard var parts = URLComponents(string: AIMCompanionModel.board) else { return }
        parts.queryItems = [.init(name: "view", value: "mesh"), .init(name: "section", value: section), .init(name: "actor", value: actor)]
        if let url = parts.url { NSWorkspace.shared.open(url) }
    }
}

/// A contact stays scannable; full evidence and policy controls open in place.
private struct AIMContactRow: View {
    let data: AIMCompanionSnapshot
    let person: AIMCompanionSnapshot.Person
    let current: Bool
    let enabled: Bool
    let imageReadEnabled: Bool
    let write: () -> Void
    let read: () -> Void
    let settings: () -> Void
    let openBoard: (String) -> Void

    private var peer: String? { data.communicationPeer(for: person) }
    private var attention: [AIMCompanionSnapshot.Attention.Item] { data.contactAttention(for: person) }
    private var owner: AIMCompanionSnapshot.OwnerThread? {
        guard let peer else { return nil }
        return data.ownerThread(for: peer)
    }
    private var relationship: String {
        let agent = peer.flatMap { person.agent_labels?[$0] } ?? person.agents.first.flatMap { person.agent_labels?[$0] }
        return [person.role, person.nickname, agent].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 12) {
                AIMPersonAvatar(person: person, imageReadEnabled: imageReadEnabled)
                VStack(alignment: .leading, spacing: 4) {
                    Text(person.name).font(AIMTheme.heading).lineLimit(1)
                    if !relationship.isEmpty {
                        Text(relationship).font(AIMTheme.meta).foregroundStyle(AIMTheme.muted).lineLimit(2)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 8) {
                    Button(L10n.text("Write"), action: write)
                        .disabled(data.connectionSending(for: person, current: current) != .allowed)
                        .help(L10n.text("Write message"))
                    Button(L10n.text("Read"), action: read)
                        .disabled(!enabled || peer == nil)
                        .help(L10n.text("Read conversation"))
                    if let owner, let url = owner.verifiedURL {
                        Button(L10n.text("Continue")) { NSWorkspace.shared.open(url) }
                            .help(L10n.text("Open owner chat") + " · " + owner.title)
                            .disabled(!current)
                    }
                }
            }
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                let sending = data.connectionSending(for: person, current: current)
                Text(L10n.text(sending.labelKey)).foregroundStyle(sending == .blocked ? AIMTheme.signal : AIMTheme.ink)
                if sending != .statusOnly, person.agents.count == 1 {
                    Text(L10n.text(data.peer_policy?.peers[person.agents[0]]?.sharingLabelKey ?? "Sharing policy not observed"))
                        .foregroundStyle(AIMTheme.muted)
                }
            }.font(AIMTheme.meta).fixedSize(horizontal: false, vertical: true)
            if let contour = data.privateContour(for: person) {
                AIMPrivateMetadataCard(contour: contour, current: current)
            }
            if let item = attention.first {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(L10n.text(item.kindLabelKey)).foregroundStyle(item.actionable ? AIMTheme.signal : AIMTheme.muted)
                    if attention.count > 1 { Text("+\(attention.count - 1)").foregroundStyle(AIMTheme.muted) }
                    Spacer()
                    Text(AIMCompanionModel.stamp(item.date)).foregroundStyle(AIMTheme.muted)
                }.font(AIMTheme.meta)
                Text(item.title).font(AIMTheme.body).lineLimit(2)
            } else {
                Text(peer == nil && !person.agents.isEmpty ? L10n.text("Private connection · status only") :
                        ((person.writable_agents ?? []).isEmpty ? L10n.text("No connected sending route") :
                            L10n.text("Last incoming") + " · " + AIMCompanionModel.stamp(person.last_at)))
                    .font(AIMTheme.meta).foregroundStyle(AIMTheme.muted).lineLimit(1)
            }
            DisclosureGroup(L10n.text("Conversation and access details")) {
                VStack(alignment: .leading, spacing: 10) {
                    if !attention.isEmpty { AIMAttentionList(data: data, items: attention) }
                    HStack {
                        Button(L10n.text("Connection map")) { openBoard("map") }
                        if peer != nil {
                            Button(L10n.text("History in dashboard")) { openBoard("history") }
                        }
                        if let nick = person.nickname, nick.hasPrefix("@"), let url = URL(string: "https://t.me/" + String(nick.dropFirst())) {
                            Button("Telegram ↗") { NSWorkspace.shared.open(url) }
                        }
                    }
                    if peer != nil && !(person.writable_agents ?? []).isEmpty {
                        Button(L10n.text("Connection settings"), action: settings)
                    }
                    ForEach(person.agents, id: \.self) { agent in
                        Text(person.agent_labels?[agent].map { $0 + " · " + agent } ?? agent).font(AIMTheme.meta)
                        if peer != nil, let linkedOwner = data.ownerThread(for: agent), let url = linkedOwner.verifiedURL {
                            Button(L10n.text("Open owner chat") + " · " + linkedOwner.title) { NSWorkspace.shared.open(url) }.disabled(!current)
                        }
                        if peer != nil, let policy = data.peer_policy?.peers[agent] {
                            Text(L10n.text("Responder") + ": " + (policy.responder == "none" ? L10n.text("Not assigned · manual reply needed") : policy.responder)).font(AIMTheme.meta)
                            Text(L10n.text(data.connectionSending(for: person, agent: agent, current: current).labelKey) + " · " + L10n.text(policy.sharingLabelKey)).font(AIMTheme.meta)
                            Text(L10n.text(policy.incomingLabelKey)).font(AIMTheme.meta)
                            Text(L10n.text("Policy checked") + " · " + AIMCompanionModel.stamp(data.peer_policy?.observed_at)).font(AIMTheme.meta)
                            if let reason = policy.wake_reason {
                                Text(L10n.text("Last wake") + ": " + L10n.text(reason)).font(AIMTheme.meta)
                            }
                        }
                    }
                }.padding(.top, 8)
            }.font(AIMTheme.meta)
        }.padding(.vertical, 10)
    }
}

/// One explicit submit, one stable UUID. An uncertain result is checked without resending.
struct AIMComposeView: View {
    let person: AIMCompanionSnapshot.Person
    @Environment(\.dismiss) private var dismiss
    @MurmurViewState private var peer: String
    @MurmurViewState private var message = ""
    @MurmurViewState private var includeContext = false
    @MurmurViewState private var selectedPolicy: AIMPeerPolicySnapshot.Policy?
    @MurmurViewState private var requestID = UUID().uuidString.lowercased()
    @MurmurViewState private var attempted = false
    @MurmurViewState private var busy = false
    @MurmurViewState private var receipt: String?
    init(person: AIMCompanionSnapshot.Person, initialPeer: String? = nil) {
        self.person = person
        _peer = State(initialValue: initialPeer.flatMap { person.writable_agents?.contains($0) == true ? $0 : nil } ?? person.writable_agents?.first ?? "")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(L10n.text("Write message")).font(AIMTheme.title)
            Text(person.name + (person.nickname.map { " · " + $0 } ?? "")).font(AIMTheme.heading)
            Picker(L10n.text("Recipient agent"), selection: $peer) {
                ForEach(person.writable_agents ?? [], id: \.self) { agent in
                    Text("\(person.agent_labels?[agent] ?? agent) · \(agent)").tag(agent)
                }
            }.disabled(attempted).help(L10n.text("Which agent of this person receives the message"))
            Text(L10n.text("From your identity · encrypted Murmur delivery")).font(AIMTheme.meta)
            Text(L10n.text("Only this written message is shared. An approved brief needs a separate choice for this send; vault and file access are managed separately."))
                .font(AIMTheme.meta).foregroundStyle(AIMTheme.muted).fixedSize(horizontal: false, vertical: true)
            TextEditor(text: $message).font(AIMTheme.body).frame(height: 180).border(Color.gray.opacity(0.25)).disabled(attempted)
            Text("\(message.count) / 8000").font(AIMTheme.meta)
            if selectedPolicy?.context == "approved_brief" {
                Toggle(L10n.text("Attach the approved brief"), isOn: $includeContext).help(L10n.text("Send the brief approved in Access & context with this message")).disabled(attempted)
                if includeContext { Text(selectedPolicy?.brief ?? "").font(AIMTheme.meta).lineLimit(4) }
            }
            if selectedPolicy?.send_allowed == false { Text(L10n.text("Sending is disabled by your contact policy.")).foregroundStyle(AIMTheme.signal) }
            if let receipt { Text(receipt).textSelection(.enabled) }
            if attempted { Text(L10n.text("Queued or acknowledged delivery does not mean the person has read or answered. Check status before sending another copy.")).font(AIMTheme.meta) }
            HStack {
                Button(L10n.text("Close")) { dismiss() }.keyboardShortcut(.cancelAction).help(L10n.text("Close this sheet; an unsent message is discarded")).disabled(busy)
                Spacer()
                if attempted {
                    Button(L10n.text("Check delivery")) { submit(statusOnly: true) }.help(L10n.text("Ask the server what happened to this attempt; nothing is resent")).disabled(busy)
                } else {
                    Button(L10n.text("Send message")) { submit(statusOnly: false) }.help(L10n.text("Send once through the owner-only helper on your server with a stable id"))
                        .disabled(busy || selectedPolicy == nil || selectedPolicy?.send_allowed == false || peer.isEmpty || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || message.count > 8000)
                }
                if busy { ProgressView().controlSize(.small) }
            }
        }.padding(24).frame(width: 620).font(AIMTheme.body)
            .onExitCommand { if !busy { dismiss() } }
            .interactiveDismissDisabled(busy).aimQuietButtonStyle()
            .task(id: peer) { includeContext = false; selectedPolicy = nil; if let result = try? await Task.detached(operation: { try AIMPolicyTransport.load() }).value { selectedPolicy = result.peers[peer] } }
    }
    private func submit(statusOnly: Bool) {
        busy = true; attempted = true
        let request: [String: Any] = ["action": statusOnly ? "status" : "send", "request_id": requestID, "peer": peer, "text": message, "include_context": includeContext, "policy_revision": selectedPolicy?.revision ?? -1]
        guard let payload = try? JSONSerialization.data(withJSONObject: request) else { busy = false; return }
        let id = requestID
        Task {
            let result = await Task.detached { Result { try AIMMessageTransport.perform(payload, requestID: id) } }.value
            busy = false
            switch result {
            case .success(let status): receipt = L10n.text("Delivery status") + ": " + status
            case .failure: receipt = L10n.text("Send not confirmed. Check delivery before retrying.")
            }
        }
    }
}

enum AIMMessageTransport {
    nonisolated static func perform(_ payload: Data, requestID: String) throws -> String {
        let data = try exchange(payload, policy: false)
        guard let receipt = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              receipt["request_id"] as? String == requestID, let status = receipt["status"] as? String else { throw CocoaError(.fileReadUnknown) }
        return status
    }
    nonisolated static func exchange(_ payload: Data, policy: Bool) throws -> Data {
        let config = AIMEditionConfig.current
        guard config.canReachServer, let host = config.ownerHost else { throw CocoaError(.fileReadNoPermission) }
        // Relative to the owner's home on that host; `serverRoot` passed validation.
        let helper = config.serverRoot + (policy ? "/mesh_comms_policy.py" : "/send.py")
        let process = Process(), output = Pipe(), input = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        process.arguments = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=1", host, "python3 " + helper]
        process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.nullDevice
        try process.run()
        let deadline = DispatchWorkItem { if process.isRunning { process.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + 30, execute: deadline)
        defer { deadline.cancel() }
        try input.fileHandleForWriting.write(contentsOf: payload)
        try input.fileHandleForWriting.close()
        var data = Data()
        while true {
            let chunk = output.fileHandleForReading.availableData
            if chunk.isEmpty { break }
            data.append(chunk)
            if data.count > 131072 { process.terminate(); throw CocoaError(.fileReadTooLarge) }
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw CocoaError(.fileReadUnknown) }
        return data
    }
}
