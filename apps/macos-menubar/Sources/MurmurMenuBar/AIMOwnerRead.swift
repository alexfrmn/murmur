import AppKit
import Foundation
import SwiftUI
import MurmurTrayCore

/// Executes the bundled, reviewed Python reader in memory on the existing owner SSH host.
/// It installs nothing and never sends, acknowledges, or marks a message read.
enum AIMOwnerRead {
    static func exchange(_ request: [String: String]) throws -> Data {
        guard let payload = try? JSONSerialization.data(withJSONObject: request), payload.count <= 8192,
              let source = readerURL().flatMap({ try? Data(contentsOf: $0) }), source.count <= 32_768
        else { throw CocoaError(.fileReadUnknown) }
        let config = AIMEditionConfig.current
        guard config.canReachServer, let host = config.ownerHost else { throw CocoaError(.fileReadNoPermission) }
        let encoded = source.base64EncodedString()
        // The edition's validated settings travel as environment; the JSON request never carries a path.
        let remote = (["env"] + config.helperEnvironment).joined(separator: " ")
            + " python3 -B -c 'import base64;exec(compile(base64.b64decode(\"\(encoded)\"),\"<murmur-owner-reader>\",\"exec\"))'"
        let process = Process(), output = Pipe(), input = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        process.arguments = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=1", host, remote]
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        let deadline = DispatchWorkItem { if process.isRunning { process.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + 20, execute: deadline)
        defer { deadline.cancel() }
        try input.fileHandleForWriting.write(contentsOf: payload)
        try input.fileHandleForWriting.close()
        var data = Data()
        while true {
            let chunk = output.fileHandleForReading.availableData
            if chunk.isEmpty { break }
            data.append(chunk)
            if data.count > 1_048_576 { process.terminate(); throw CocoaError(.fileReadTooLarge) }
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw CocoaError(.fileReadUnknown) }
        return data
    }

    private static func readerURL() -> URL? {
        let packaged = Bundle.main.resourceURL?
            .appendingPathComponent("MurmurMenuBarSpike_MurmurMenuBar.bundle")
        let packagedBundle = packaged.flatMap(Bundle.init(url:))
        let bundle = packagedBundle ?? (Bundle.main.bundleURL.pathExtension == "app" ? nil : Bundle.module)
        return bundle?.url(forResource: "mesh-comms-query", withExtension: "py")
    }
}

struct AIMMessageSearchView: View {
    let enabled: Bool
    let people: [AIMCompanionSnapshot.Person]
    var historyPeer: String? = nil
    var snapshot: AIMCompanionSnapshot? = nil
    var initialSection = "Messages"
    var previewOnly = false
    var contextConfig: AIMEditionConfig
    @Environment(\.dismiss) private var dismiss
    @MurmurViewState private var query = ""
    @MurmurViewState private var result: AIMMessageSearchResult?
    @MurmurViewState private var busy = false
    @MurmurViewState private var failed = false
    @MurmurViewState private var selected: AIMMessageSearchResult.Match?
    @MurmurViewState private var selectedHistoryPeer = ""
    @MurmurViewState private var section = "Messages"
    @MurmurViewState private var replyDraft: AIMReplyDraft?

    init(enabled: Bool, people: [AIMCompanionSnapshot.Person], historyPeer: String? = nil,
         snapshot: AIMCompanionSnapshot? = nil, initialSection: String = "Messages", previewOnly: Bool = false,
         contextConfig: AIMEditionConfig = .current) {
        self.enabled = enabled; self.people = people; self.historyPeer = historyPeer
        self.snapshot = snapshot; self.initialSection = initialSection; self.previewOnly = previewOnly; self.contextConfig = contextConfig
        _selectedHistoryPeer = MurmurViewState(wrappedValue: historyPeer ?? "")
        _section = MurmurViewState(wrappedValue: initialSection)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(L10n.text(historyPeer == nil ? "Search messages" : "History")).font(AIMTheme.title)
                Spacer()
                Button(L10n.text("Close")) { dismiss() }.keyboardShortcut(.cancelAction)
            }
            Text(L10n.text("Searches accessible server messages. Private conversations are excluded.")).font(AIMTheme.meta)
            if historyPeer == nil { HStack {
                TextField(L10n.text("Words in a message"), text: $query)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(search)
                Button(L10n.text("Search"), action: search)
                    .disabled(!enabled || busy || !(2...160).contains(query.trimmingCharacters(in: .whitespacesAndNewlines).count))
            }
            } else {
                Picker(L10n.text("Recipient agent"), selection: $selectedHistoryPeer) {
                    ForEach(people.first(where: { $0.agents.contains(historyPeer ?? "") })?.agents ?? [], id: \.self) { peer in
                        Text(participant(peer)).tag(peer)
                    }
                }
                Picker(L10n.text("Conversation context"), selection: $section) {
                    ForEach(["Messages", "Decisions", "Next steps"], id: \.self) { Text(L10n.text($0)).tag($0) }
                }.pickerStyle(.segmented)
                if section == "Messages" {
                    Text(L10n.text("Recent messages · open a row to read its text. No read receipts are sent.")).font(AIMTheme.meta)
                }
            }
            if historyPeer == nil || section == "Messages" {
            if busy { ProgressView(L10n.text("Searching server…")) }
            if failed { Text(L10n.text("Message search unavailable. No results were confirmed.")).foregroundStyle(AIMTheme.signal) }
            if let result {
                Text("\(result.total) " + L10n.text("matches") + " · \(result.searched) " + L10n.text("messages checked") + " · " + AIMCompanionModel.stamp(result.source_at)).font(AIMTheme.meta)
                if result.truncated || !result.unavailable.isEmpty {
                    Text(L10n.text("Partial search · some history was unavailable or the result limit was reached.")).foregroundStyle(AIMTheme.signal)
                }
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(result.matches, id: \.stableID) { match in
                            Button { selected = match } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(historyPeer == nil ? match.excerpt : L10n.text(match.excerpt)).lineLimit(3).frame(maxWidth: .infinity, alignment: .leading)
                                    Text([participant(match.peer_identity), match.direction.map { L10n.text($0) }, AIMCompanionModel.stamp(match.date)].compactMap { $0 }.joined(separator: " · ")).font(AIMTheme.meta)
                                }.frame(maxWidth: .infinity, alignment: .leading)
                            }.buttonStyle(.plain).help(L10n.text("Read the selected message"))
                            Divider()
                        }
                    }
                }
                if result.matches.isEmpty { Text(L10n.text("No accessible messages matched.")) }
            }
            } else {
                AIMConversationContextView(snapshot: snapshot, peer: selectedHistoryPeer, section: section,
                                           participant: participant(selectedHistoryPeer), enabled: enabled && !previewOnly, config: contextConfig,
                                           selectDraft: { draft in if replyDraft == nil { replyDraft = draft } }, selectSource: { selected = $0 })
                    .id(selectedHistoryPeer + ":" + section)
            }
        }.padding(24).frame(width: 660, height: 600).font(AIMTheme.body).aimQuietButtonStyle()
            .onExitCommand { if selected != nil { selected = nil } else { dismiss() } }
            .sheet(item: $replyDraft) { draft in
            if let person = people.first(where: { $0.agents.contains(draft.peer) }) {
                AIMComposeView(person: person, initialPeer: draft.peer, draft: draft)
            }
        }
        .sheet(item: $selected) { match in AIMMessageDetailView(match: match, participant: participant(match.peer_identity)) }
            .task(id: selectedHistoryPeer) { if !selectedHistoryPeer.isEmpty { loadHistory() } }
    }

    private func participant(_ peer: String?) -> String {
        guard let peer else { return "" }
        guard let person = people.first(where: { $0.agents.contains(peer) }) else { return peer }
        return person.name + " · " + (person.agent_labels?[peer] ?? peer)
    }

    private func loadHistory() {
        guard enabled, !previewOnly, !busy, !selectedHistoryPeer.isEmpty else { return }
        let historyPeer = selectedHistoryPeer
        busy = true; failed = false; result = nil
        Task {
            let response = await Task.detached { Result { try AIMMessageSearchResult.decode(AIMOwnerRead.exchange(["action": "history", "peer": historyPeer])) } }.value
            busy = false
            guard historyPeer == selectedHistoryPeer else { loadHistory(); return }
            switch response {
            case .success(let value): result = value
            case .failure: failed = true
            }
        }
    }

    private func search() {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard enabled, !busy, (2...160).contains(term.count) else { return }
        busy = true; failed = false; result = nil
        Task {
            let response = await Task.detached { Result { try AIMMessageSearchResult.decode(AIMOwnerRead.exchange(["action": "search", "query": term])) } }.value
            busy = false
            switch response {
            case .success(let value): result = value
            case .failure: failed = true
            }
        }
    }
}

struct AIMMessageDetailView: View {
    let match: AIMMessageSearchResult.Match
    let participant: String
    @Environment(\.dismiss) private var dismiss
    @MurmurViewState private var message: AIMMessageReadResult?
    @MurmurViewState private var failed = false
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(L10n.text("Message")).font(AIMTheme.title)
                Spacer()
                Button(L10n.text("Close")) { dismiss() }.keyboardShortcut(.cancelAction)
            }
            Text([participant, match.direction.map { L10n.text($0) }, AIMCompanionModel.stamp(match.date)].compactMap { $0 }.joined(separator: " · ")).font(AIMTheme.meta)
            if failed { Text(L10n.text("Message unavailable. The search excerpt is the only confirmed text.")).foregroundStyle(AIMTheme.signal) }
            if let message {
                ScrollView { Text(message.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                if message.truncated { Text(L10n.text("Message shortened by the server.")).font(AIMTheme.meta) }
            } else if !failed { ProgressView(L10n.text("Reading message…")) }
        }.padding(24).frame(width: 620, height: 460).font(AIMTheme.body).aimQuietButtonStyle()
            .onExitCommand { dismiss() }
            .task {
                let response = await Task.detached {
                    Result { try AIMMessageReadResult.decode(AIMOwnerRead.exchange(["action": "read", "store": match.store, "id": match.id]), expectedID: match.id) }
                }.value
                switch response {
                case .success(let value): message = value
                case .failure: failed = true
                }
            }
    }
}
