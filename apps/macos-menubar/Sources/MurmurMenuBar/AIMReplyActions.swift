import SwiftUI
import MurmurTrayCore

/// A choice opens the existing editor. Only the editor's separate submit can send.
struct AIMReplyActions: View {
    let data: AIMCompanionSnapshot
    let question: AIMCompanionSnapshot.Question
    var enabled = true
    var config: AIMEditionConfig = .current
    let selectDraft: (AIMReplyDraft) -> Void

    private var ready: Bool {
        enabled && data.isCurrent() && question.source_available == true && question.reply_context != nil
            && question.peer.flatMap { peer in data.people.first { $0.agents.contains(peer) && ($0.writable_agents ?? []).contains(peer) } } != nil
            && !question.isClosed
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                if question.draftProposedReply != nil {
                    Button(L10n.text("Use proposed reply")) { choose("proposal") }.disabled(!ready)
                }
                Button(L10n.text("Custom reply")) { choose("custom") }.disabled(!ready)
            }
            ForEach(question.draftReplyOptions, id: \.id) { option in
                HStack(alignment: .top, spacing: 10) {
                    Button(L10n.text(option.id == "yes" ? "Yes" : "No")) { choose(option.id) }.disabled(!ready)
                    Text(option.text).font(AIMTheme.meta).fixedSize(horizontal: false, vertical: true)
                }
            }
            Text(L10n.text("Opens an editable draft. Send separately after reviewing it.")).font(AIMTheme.meta).foregroundStyle(AIMTheme.muted)
            if !ready { Text(L10n.text("Reply source or route is unavailable. Refresh the desk and check contact settings.")).font(AIMTheme.meta).foregroundStyle(AIMTheme.muted) }
        }
    }
    private func choose(_ choice: String) {
        if let draft = data.replyDraft(for: question, choice: choice, config: config) { selectDraft(draft) }
    }
}
