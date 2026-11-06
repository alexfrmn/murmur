import AppKit
import SwiftUI
import MurmurTrayCore

/// The same server evidence appears in Overview and beside the relevant person.
struct AIMAttentionList: View {
    let data: AIMCompanionSnapshot
    let items: [AIMCompanionSnapshot.Attention.Item]
    var title = "Communication needs attention"
    @MurmurViewState private var expanded = false
    @MurmurViewState private var selectedItem: AIMCompanionSnapshot.Attention.Item?
    @MurmurViewState private var replyDraft: AIMReplyDraft?
    @MurmurViewState private var composeItem: AIMCompanionSnapshot.Attention.Item?
    @MurmurViewState private var openItems: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L10n.text(title) + " · \(items.count)").font(AIMTheme.heading)
            if items.isEmpty { Text(L10n.text("No communication needs action.")).font(AIMTheme.meta) }
            if items.allSatisfy({ $0.kind == "owner" }) {
                let ordered = AIMCompanionSnapshot.Attention.peerGroups(items).flatMap(\.items)
                let shown = Array(ordered.prefix(expanded ? 200 : 3))
                ForEach(AIMCompanionSnapshot.Attention.peerGroups(shown)) { group in
                    Text(data.participantLabel(for: group.peer)).font(AIMTheme.heading)
                    ForEach(group.items) { item in attentionCard(item) }
                }
            } else {
                ForEach(Array(items.prefix(expanded ? 200 : 3))) { item in attentionCard(item) }
            }
            if items.count > 3 {
                Button(L10n.text(expanded ? "Show fewer questions" : "Show more questions")) { expanded.toggle() }
            }
        }
        .sheet(item: $selectedItem) { item in
            AIMMessageSearchView(enabled: true, people: data.people, historyPeer: item.peer, snapshot: data)
        }
        .sheet(item: $composeItem) { item in
            if let person = data.people.first(where: { $0.agents.contains(item.peer) }) {
                AIMComposeView(person: person, initialPeer: item.peer)
            }
        }
        .sheet(item: $replyDraft) { draft in
            if let person = data.people.first(where: { $0.agents.contains(draft.peer) }) {
                AIMComposeView(person: person, initialPeer: draft.peer, draft: draft)
            }
        }
    }
    private func attentionCard(_ item: AIMCompanionSnapshot.Attention.Item) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                Text(L10n.text(item.kindLabelKey)).font(AIMTheme.meta).foregroundStyle(AIMTheme.signal)
                Spacer()
                Text(AIMCompanionModel.stamp(item.date)).font(AIMTheme.meta).foregroundStyle(AIMTheme.muted)
            }
            Text(item.title).font(AIMTheme.heading)
            Text(data.participantLabel(for: item.peer)).font(AIMTheme.meta).foregroundStyle(AIMTheme.muted)
            Text(item.next_action).font(AIMTheme.meta).lineLimit(openItems.contains(item.id) ? nil : 2)
            Button(L10n.text(openItems.contains(item.id) ? "Hide discussion" : "Read and respond")) {
                if !openItems.insert(item.id).inserted { openItems.remove(item.id) }
            }.buttonStyle(.plain).foregroundStyle(AIMTheme.signal)
            if openItems.contains(item.id) {
            if let proposed = data.proposedReply(for: item) {
                Text(L10n.text("Proposed reply · draft, not approved or sent")).font(AIMTheme.meta).foregroundStyle(AIMTheme.signal)
                Text(proposed).font(AIMTheme.meta).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
            if let question = data.replyQuestion(for: item) {
                AIMReplyActions(data: data, question: question) { draft in if replyDraft == nil { replyDraft = draft } }
            }
            HStack {
                if let owner = data.ownerThread(for: item.peer), let url = owner.verifiedURL {
                    Button(L10n.text("Continue in Codex")) { NSWorkspace.shared.open(url) }
                }
                if let person = data.people.first(where: { $0.agents.contains(item.peer) }) {
                    Button(L10n.text("History")) { selectedItem = item }
                    if (person.writable_agents ?? []).contains(item.peer) {
                        Button(L10n.text("Write message")) { composeItem = item }.disabled(!data.isCurrent())
                    }
                } else {
                    Button(L10n.text("Connection details")) { AIMCompanionModel.open("?view=mesh&section=sources") }
                }
            }
            }
        }.padding(.vertical, 12).padding(.horizontal, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(AIMTheme.surface)
            .overlay(alignment: .leading) { Rectangle().fill(AIMTheme.signal).frame(width: 2) }
    }

}
