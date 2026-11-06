import AppKit
import SwiftUI
import MurmurTrayCore

/// Bounded status metadata only. No private body, traffic counter or ordinary history route.
struct AIMPrivateMetadataCard: View {
    let contour: AIMCompanionSnapshot.PrivateContour
    let current: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(contour.name).font(AIMTheme.heading)
                Spacer()
                Text(L10n.text(contour.workStatusLabelKey)).font(AIMTheme.meta)
            }
            if let detail = contour.workDetailLabelKey {
                Text(L10n.text(detail)).font(AIMTheme.body)
            }
            if let location = contour.processorLocationLabelKey {
                Text(L10n.text(location)).font(AIMTheme.meta)
            }
            Text(L10n.text("Work observed") + " · " + AIMCompanionModel.stamp(contour.work_at))
                .font(AIMTheme.meta)
            Text(L10n.text("Source date") + " · " + AIMCompanionModel.stamp(contour.source_at))
                .font(AIMTheme.meta)
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(L10n.text(contour.sourceFreshnessLabelKey(snapshotCurrent: current)))
                Text("·")
                Text(contour.source_age_seconds.map { L10n.text("Source age at snapshot: %@ seconds", String($0)) }
                     ?? L10n.text("Source age unknown"))
            }.font(AIMTheme.meta).foregroundStyle(AIMTheme.muted)
            if let reason = contour.admissionLabelKey {
                Text(L10n.text("Historical admission observation") + " · " + L10n.text(reason) + " · " + AIMCompanionModel.stamp(contour.wake_admission_at))
                    .font(AIMTheme.meta).foregroundStyle(AIMTheme.muted)
            }
            if contour.incoming_unreviewed == true {
                Text(L10n.text("Latest incoming needs review")).font(AIMTheme.meta).foregroundStyle(AIMTheme.signal)
            }
            if contour.owner_review_store_ok == false {
                Text(L10n.text("Private review inbox unavailable")).font(AIMTheme.meta).foregroundStyle(AIMTheme.signal)
            }
            Text(L10n.text("Source observations do not establish current availability."))
                .font(AIMTheme.meta).foregroundStyle(AIMTheme.muted)
            if let owner = contour.owner_thread, let url = owner.verifiedURL {
                Button(L10n.text("Open private owner chat")) { NSWorkspace.shared.open(url) }
                    .help(L10n.text("Open the verified private owner chat in Codex"))
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AIMTheme.muted.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(AIMTheme.muted.opacity(0.25), lineWidth: 1))
    }
}

/// Owner queue entry carries only aggregate metadata. Drafts remain in the private source store.
struct AIMPrivateOwnerReviewCard: View {
    let contour: AIMCompanionSnapshot.PrivateContour
    let current: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(contour.name + " · " + L10n.text("Private replies to review")).font(AIMTheme.heading)
            Text(L10n.text("Owner questions: %@ · Reply drafts: %@", String(contour.owner_review_count ?? 0), String(contour.owner_draft_count ?? 0))).font(AIMTheme.body)
            Text(L10n.text("Next: owner review · nothing sent")).font(AIMTheme.meta).foregroundStyle(AIMTheme.signal)
            if contour.incoming_unreviewed == true {
                Text(L10n.text("Latest incoming needs review")).font(AIMTheme.meta).foregroundStyle(AIMTheme.signal)
            }
            Text(L10n.text("Work observed") + " · " + AIMCompanionModel.stamp(contour.owner_review_at)).font(AIMTheme.meta)
            if let url = contour.owner_thread?.verifiedURL {
                Button(L10n.text("Open private owner chat")) { NSWorkspace.shared.open(url) }.disabled(!current)
            }
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
         .background(AIMTheme.muted.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }
}
