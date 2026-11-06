import SwiftUI
import MurmurTrayCore

/// Reviewed metadata stays inside the existing per-person reader. Message bodies remain on demand.
struct AIMConversationContextView: View {
    let snapshot: AIMCompanionSnapshot?
    let peer: String
    let section: String
    let participant: String
    let enabled: Bool
    var config: AIMEditionConfig = .current
    var selectDraft: ((AIMReplyDraft) -> Void)? = nil
    let selectSource: (AIMMessageSearchResult.Match) -> Void

    private var topics: [AIMCompanionSnapshot.Question]? { snapshot?.reviewedTopics(for: peer, config: config) }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(participant).font(AIMTheme.heading)
            Text(L10n.text("Review date") + " · " + AIMCompanionModel.stamp(snapshot?.review_at)).font(AIMTheme.meta)
            Text(L10n.text("Recorded decisions describe their source date. They do not establish current implementation or availability.")).font(AIMTheme.meta).foregroundStyle(AIMTheme.muted)
            if snapshot?.reviewed_topics_truncated == true {
                Text(L10n.text("Partial reviewed context · retained topic limit reached.")).font(AIMTheme.meta).foregroundStyle(AIMTheme.signal)
            }
            if let topics {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if section == "Decisions" {
                            let decisionTopics = topics.filter { !($0.confirmed_decisions ?? []).isEmpty }
                            if decisionTopics.isEmpty { Text(L10n.text("No confirmed decisions in this reviewed snapshot.")) }
                            ForEach(decisionTopics) { topic in
                                Text(topic.title ?? L10n.text("Reviewed topic")).font(AIMTheme.heading)
                                ForEach(topic.confirmed_decisions ?? []) { decision in
                                    VStack(alignment: .leading, spacing: 6) {
                                        Text(decision.label).textSelection(.enabled)
                                        Text(L10n.text("Decided by") + " · " + decision.decided_by).font(AIMTheme.meta)
                                        Text(L10n.text("Decision date") + " · " + AIMCompanionModel.stamp(decision.decided_at)).font(AIMTheme.meta)
                                        Text(L10n.text("Source date") + " · " + AIMCompanionModel.stamp(decision.source_date)).font(AIMTheme.meta)
                                        Text(L10n.text("Review date") + " · " + AIMCompanionModel.stamp(decision.reviewed_at ?? topic.reviewed_at)).font(AIMTheme.meta)
                                        Text(L10n.text("Evidence") + " · " + L10n.text(decision.evidenceLabelKey)).font(AIMTheme.meta)
                                        Text(L10n.text(decision.originLabelKey)).font(AIMTheme.meta)
                                        Text(L10n.text("Scope") + " · " + decision.scope).font(AIMTheme.meta)
                                        Text(L10n.text("Status") + " · " + L10n.text(topic.statusLabelKey)).font(AIMTheme.meta)
                                        if decision.evidence_kind == "direct_human_choice_recorded" {
                                            Text(L10n.text("Source: owner chat. This record does not confirm delivery to the contact.")).font(AIMTheme.meta)
                                        } else { source(decision.sourceMatch(peer: peer), id: decision.source_id, availability: decision.source_available) }
                                    }
                                    Divider()
                                }
                            }
                        } else {
                            let open = topics.filter { $0.nextStepGroup(config: config) != nil }
                            if open.isEmpty { Text(L10n.text("No open next steps in this reviewed snapshot.")) }
                            ForEach(AIMCompanionSnapshot.NextStepGroup.allCases, id: \.self) { group in
                                let rows = open.filter { $0.nextStepGroup(config: config) == group }
                                if !rows.isEmpty {
                                    Text(L10n.text(group.rawValue) + " · \(rows.count)").font(AIMTheme.heading)
                                    ForEach(rows) { topic in
                                        VStack(alignment: .leading, spacing: 6) {
                                            Text(topic.title ?? L10n.text("Reviewed topic")).font(AIMTheme.heading)
                                            if let summary = topic.summary { Text(summary).textSelection(.enabled) }
                                            if let proposed = topic.draftProposedReply {
                                                Text(L10n.text("Proposed reply · draft, not approved or sent")).font(AIMTheme.meta).foregroundStyle(AIMTheme.signal)
                                                Text(proposed).textSelection(.enabled)
                                            }
                                            if let snapshot, let selectDraft {
                                                AIMReplyActions(data: snapshot, question: topic, enabled: enabled, config: config, selectDraft: selectDraft)
                                            }
                                            Text(L10n.text("Next action") + " · " + (topic.next_action ?? L10n.text("Unknown")))
                                            Text(L10n.text("Status") + " · " + L10n.text(topic.statusLabelKey)).font(AIMTheme.meta)
                                            Text(L10n.text("Source date") + " · " + AIMCompanionModel.stamp(topic.source_date)).font(AIMTheme.meta)
                                            Text(L10n.text("Review date") + " · " + AIMCompanionModel.stamp(topic.reviewed_at)).font(AIMTheme.meta)
                                            Text(L10n.text("Evidence") + " · " + (topic.evidence ?? L10n.text("Unknown"))).font(AIMTheme.meta)
                                            ForEach(Array((topic.references ?? []).enumerated()), id: \.offset) { _, reference in
                                                Text(reference.label + " · " + reference.id).font(AIMTheme.meta).foregroundStyle(AIMTheme.muted)
                                            }
                                            source(topic.sourceMatch, id: topic.source_id, availability: topic.source_available)
                                        }
                                        Divider()
                                    }
                                }
                            }
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                Text(L10n.text("Reviewed conversation context unavailable in this snapshot.")).foregroundStyle(AIMTheme.signal)
                Text(L10n.text("Messages remain available through the existing history reader.")).font(AIMTheme.meta)
                Spacer()
            }
        }
    }
    private func source(_ match: AIMMessageSearchResult.Match?, id: String?, availability: Bool?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Button(L10n.text("Read source") + " · " + (id ?? L10n.text("Unknown"))) {
                if let match { selectSource(match) }
            }.disabled(!enabled || match == nil)
            if match == nil {
                Text(L10n.text(availability == false ? "Source outside retained snapshot; recorded date and status only." : "Source availability unknown in this snapshot.")).font(AIMTheme.meta).foregroundStyle(AIMTheme.muted)
            }
        }
    }
}
