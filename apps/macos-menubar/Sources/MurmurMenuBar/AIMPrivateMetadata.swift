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
