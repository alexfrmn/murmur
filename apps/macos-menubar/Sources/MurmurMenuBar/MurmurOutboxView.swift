import SwiftUI
import MurmurTrayCore

struct MurmurOutboxView: View {
    @ObservedObject var model: TrayModel
    @MurmurViewState private var visibleCount = 50
    private func sentAt(_ value: String) -> String {
        guard let date = timestamp(value) else { return L10n.text("Time not recorded") }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
    var body: some View {
        if let status = model.status {
            if (status.outbox.queue.dlq ?? 0) > 0 {
                VStack(alignment: .leading, spacing: 10) {
                    Label(L10n.text("Undelivered messages: %@", String(status.outbox.queue.dlq ?? 0)), systemImage: "exclamationmark.triangle")
                        .font(.headline)
                    Text(L10n.text("These messages were not delivered. Dismissing a warning keeps their history and does not resend them."))
                        .font(.callout).fixedSize(horizontal: false, vertical: true)
                    if let attention = status.outbox.attention, attention.verifiedPending(total: status.outbox.queue.dlq) != nil {
                        ForEach(Array((attention.items ?? []).prefix(visibleCount))) { item in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(L10n.text("To %@ · %@", item.peer ?? L10n.text("Unknown participant"), sentAt(item.createdAt)))
                                    .font(.subheadline.weight(.semibold)).textSelection(.enabled)
                                Text(item.reasonText).font(.callout)
                                if item.dismissed { Text(L10n.text("Warning dismissed; delivery is still unconfirmed")).font(.caption) }
                                Button(L10n.text(item.dismissed ? "Restore warning" : "Dismiss warning")) {
                                    model.setOutboxDismissed(item, dismissed: !item.dismissed)
                                }.disabled(!model.canControl || !item.canSelect)
                            }
                        }
                        if (attention.items?.count ?? 0) > visibleCount {
                            Button(L10n.text("Show more messages")) { visibleCount += 50 }
                        }
                    } else {
                        Text(L10n.text("Message details are unavailable. Refresh status; no warning has been dismissed."))
                    }
                }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            }
            if status.wake.config.enabled == false && status.wake.effective.enabled == false {
                VStack(alignment: .leading, spacing: 8) {
                    Text(L10n.text("Agent delivery is paused; %@ messages are waiting", status.wake.delivery.pendingUndelivered.map(String.init) ?? L10n.text("not measured")))
                        .font(.headline).fixedSize(horizontal: false, vertical: true)
                    Text(L10n.text("Resume saves the setting. If status says a service restart is required, stop and start this profile's service in Settings."))
                        .font(.callout).fixedSize(horizontal: false, vertical: true)
                    Button(L10n.text("Resume agent delivery")) { model.perform(.resume) }.disabled(!model.canControl)
                }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            }
        }
    }
}
