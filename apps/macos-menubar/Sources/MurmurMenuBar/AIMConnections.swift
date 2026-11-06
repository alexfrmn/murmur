import AppKit
import SwiftUI
import MurmurTrayCore

/// A compact human → assistant → owner exchange, using observed routes and policy.
struct AIMConnectionsView: View {
    @ObservedObject var model: AIMCompanionModel
    let openDesk: () -> Void
    let openPeople: () -> Void
    @MurmurViewState private var query = ""
    @MurmurViewState private var recipient: AIMCompanionSnapshot.Person?
    @MurmurViewState private var historyPerson: AIMCompanionSnapshot.Person?
    @MurmurViewState private var policyPerson: AIMCompanionSnapshot.Person?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(L10n.text("People → assistants → SHAPER")).font(AIMTheme.title)
                Spacer()
                Button(L10n.text("Dashboard")) { AIMCompanionModel.open("?view=mesh&section=map") }
            }
            if let data = model.snapshot {
                if !model.current {
                    Text(L10n.text("Retained observation · refresh before acting")).font(AIMTheme.meta).foregroundStyle(AIMTheme.signal)
                }
                HStack {
                    TextField(L10n.text("Name, nickname or agent"), text: $query).textFieldStyle(.roundedBorder)
                    Button(L10n.text("Your communication desk"), action: openDesk)
                    Button(L10n.text("People & agents"), action: openPeople)
                }
                let people = data.people.filter { person in
                    query.isEmpty || ([person.name, person.nickname ?? ""] + person.agents + Array((person.agent_labels ?? [:]).values))
                        .joined(separator: " ").localizedCaseInsensitiveContains(query)
                }
                HStack {
                    Text("\(people.count) / \(data.people.count) " + L10n.text("contacts"))
                    Spacer()
                    Text(AIMCompanionModel.stamp(data.snapshot_at))
                }.font(AIMTheme.meta).foregroundStyle(AIMTheme.muted)
                DisclosureGroup(sourceTitle(data)) {
                    if let sources = data.flow_sources, !sources.isEmpty {
                        ForEach(Array(sources.enumerated()), id: \.offset) { _, source in
                            Text(source.store + " · " + L10n.text(source.ok == true ? "Read succeeded" : (source.ok == false ? "Read failed" : "Not observed")) + " · " + AIMCompanionModel.stamp(source.observed_at))
                                .foregroundStyle(source.ok == false ? AIMTheme.signal : AIMTheme.muted)
                        }
                    } else { Text(L10n.text("Source receipts not observed")).foregroundStyle(AIMTheme.muted) }
                }.font(AIMTheme.meta)
                HStack(spacing: 8) {
                    Text(L10n.text("Person")).frame(width: 184, alignment: .leading)
                    Text("→").accessibilityHidden(true).frame(width: 12)
                    Text(L10n.text("Their assistant")).frame(width: 148, alignment: .leading)
                    Text("→").accessibilityHidden(true).frame(width: 12)
                    Text(L10n.text("SHAPER · you")).frame(maxWidth: .infinity, alignment: .leading)
                }.font(AIMTheme.meta).foregroundStyle(AIMTheme.muted)
                Divider()
                VStack(spacing: 0) {
                    ForEach(people) { person in
                        AIMConnectionRow(data: data, person: person, current: model.current,
                                         enabled: model.enabled, imageReadEnabled: !model.previewConnected,
                                         write: { recipient = person }, read: { historyPerson = person },
                                         settings: { policyPerson = person })
                        Divider()
                    }
                }
                if people.isEmpty { Text(L10n.text("No contacts match these filters.")) }
                Text(L10n.text("Counts cover retained server and Mac snapshots. Delivery, incoming handling and a person's availability are separate observations."))
                    .font(AIMTheme.meta).foregroundStyle(AIMTheme.muted).fixedSize(horizontal: false, vertical: true)
            } else {
                Text(L10n.text("Connect your server in Settings to load people."))
            }
        }
        .sheet(item: $recipient) { person in
            AIMComposeView(person: person, initialPeer: model.snapshot?.firstAllowedConnection(for: person, current: model.current))
        }
        .sheet(item: $historyPerson) { person in
            if let data = model.snapshot, let peer = data.communicationPeer(for: person) {
                AIMMessageSearchView(enabled: model.enabled, people: data.people, historyPeer: peer, snapshot: data)
            }
        }
        .sheet(item: $policyPerson) { person in AIMPolicyView(person: person) }
    }
    private func sourceTitle(_ data: AIMCompanionSnapshot) -> String {
        let sources = data.flow_sources ?? []
        let state = sources.isEmpty ? "Not observed" : (sources.contains { $0.ok == false } ? "Read failed" :
            (sources.allSatisfy { $0.ok == true } ? "Read succeeded" : "Not observed"))
        return L10n.text("Message source receipts") + " · " + L10n.text(state)
    }
}

private struct AIMConnectionRow: View {
    let data: AIMCompanionSnapshot
    let person: AIMCompanionSnapshot.Person
    let current: Bool
    let enabled: Bool
    let imageReadEnabled: Bool
    let write: () -> Void
    let read: () -> Void
    let settings: () -> Void
    @MurmurViewState private var expanded = false

    private var statusOnly: Bool { data.isStatusOnly(person) }
    private var sending: AIMConnectionSending { data.connectionSending(for: person, current: current) }
    private var singleAgent: String? { person.agents.count == 1 ? person.agents.first : nil }
    private var sharingLabel: String {
        let keys = person.agents.compactMap { data.peer_policy?.peers[$0]?.sharingLabelKey }
        guard keys.count == person.agents.count, let first = keys.first else { return "Sharing policy not observed" }
        return keys.allSatisfy { $0 == first } ? first : "Sharing varies by assistant"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { expanded.toggle() } label: {
                HStack(alignment: .top, spacing: 8) {
                    personCell.frame(width: 184, alignment: .leading)
                    Text("→").foregroundStyle(AIMTheme.muted).frame(width: 12).accessibilityHidden(true)
                    assistantCell.frame(width: 148, alignment: .leading)
                    Text("→").foregroundStyle(AIMTheme.muted).frame(width: 12).accessibilityHidden(true)
                    exchangeCell.frame(maxWidth: .infinity, alignment: .leading)
                }.contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(L10n.text(expanded ? "Hide connection details" : "Show connection details"))
            .accessibilityLabel(person.name + " · " + person.agents.map { person.agent_labels?[$0] ?? $0 }.joined(separator: ", ") + " · " + L10n.text(sending.labelKey))
            .accessibilityValue(L10n.text(expanded ? "Expanded" : "Collapsed"))
            if expanded { details.padding(.leading, 50) }
        }.padding(.vertical, 8)
    }

    private var personCell: some View {
        HStack(alignment: .top, spacing: 10) {
            AIMPersonAvatar(person: person, imageReadEnabled: imageReadEnabled)
            VStack(alignment: .leading, spacing: 4) {
                Text(person.name).font(AIMTheme.heading).fixedSize(horizontal: false, vertical: true)
                if let nickname = person.nickname { Text(nickname).font(AIMTheme.meta).foregroundStyle(AIMTheme.muted).lineLimit(1) }
                HStack(spacing: 4) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right").font(.system(size: 8)).accessibilityHidden(true)
                    Text(L10n.text("Details")).font(AIMTheme.meta)
                }.foregroundStyle(AIMTheme.muted)
            }
        }
    }
    private var assistantCell: some View {
        VStack(alignment: .leading, spacing: 2) {
            if person.agents.isEmpty {
                Text(L10n.text(person.contact_state == "unlinked" ? "No connected assistant" : "Assistant not observed")).font(AIMTheme.meta)
            }
            ForEach(person.agents, id: \.self) { agent in
                Text(person.agent_labels?[agent] ?? agent).font(AIMTheme.heading).fixedSize(horizontal: false, vertical: true)
            }
            Text(L10n.text(statusOnly ? "Private connection · status only" : "Observed binding"))
                .font(AIMTheme.meta).foregroundStyle(AIMTheme.muted).fixedSize(horizontal: false, vertical: true)
        }
    }
    private var exchangeCell: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(L10n.text(sending.labelKey)).font(AIMTheme.heading)
                .foregroundStyle(sending == .blocked ? AIMTheme.signal : AIMTheme.ink)
            if !statusOnly {
                if !person.agents.isEmpty {
                    Text(L10n.text(sharingLabel)).font(AIMTheme.meta).foregroundStyle(AIMTheme.muted)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(L10n.text("From them → you") + ": " + personCount(inbound: true))
                        Text(L10n.text("You → them") + ": " + personCount(inbound: false))
                    }.font(AIMTheme.meta).foregroundStyle(AIMTheme.muted)
                }
            }
        }.fixedSize(horizontal: false, vertical: true)
    }
    private func personCount(inbound: Bool) -> String {
        let observation = data.connectionCount(for: person, inbound: inbound)
        guard let count = observation.count else { return L10n.text("Not observed") }
        return (observation.partial ? "≥ " : "") + String(count)
    }
    private func traffic(_ flow: AIMCompanionSnapshot.Person.Flow?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(L10n.text("From them → you") + ": " + count(flow, inbound: true))
            Text(L10n.text("You → them") + ": " + count(flow, inbound: false))
        }.font(AIMTheme.meta).foregroundStyle(AIMTheme.muted)
    }
    private func count(_ flow: AIMCompanionSnapshot.Person.Flow?, inbound: Bool) -> String {
        guard let value = flow?.observedCount(inbound: inbound) else { return L10n.text("Not observed") }
        return (flow?.scope == "partial_retained_snapshot" ? "≥ " : "") + String(value)
    }

    @ViewBuilder private var details: some View {
        if statusOnly {
            Text(L10n.text("Private connection · status only")).font(AIMTheme.meta).foregroundStyle(AIMTheme.muted)
        } else {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Button(L10n.text("Write"), action: write).disabled(sending != .allowed)
                        .help(L10n.text("Write message"))
                    Button(L10n.text("Read"), action: read).disabled(!enabled || data.communicationPeer(for: person) == nil)
                        .help(L10n.text("Read conversation"))
                    if !(person.writable_agents ?? []).isEmpty {
                        Button(L10n.text("Connection settings"), action: settings)
                    }
                }
                ForEach(person.agents, id: \.self) { agent in agentDetails(agent) }
                Text(L10n.text("A brief is attached only when selected for that send. Contact trust and incoming handling grant no vault or file access."))
                    .font(AIMTheme.meta).foregroundStyle(AIMTheme.muted).fixedSize(horizontal: false, vertical: true)
                if let attention = data.attention, attention.receipts_ok {
                    let items = attention.items.filter { person.agents.contains($0.peer) && $0.actionable }
                    Text(L10n.text("Your reply or decision") + ": \(items.filter { $0.kind == "owner" }.count) · " +
                         L10n.text("Assistant action needed") + ": \(items.filter { $0.kind == "agent" }.count) · " +
                         L10n.text("Delivery failed") + ": \(items.filter { $0.kind == "delivery" }.count)")
                        .font(AIMTheme.meta).fixedSize(horizontal: false, vertical: true)
                } else { Text(L10n.text("Work classification not observed")).font(AIMTheme.meta) }
            }
        }
    }
    /// These modes describe our handler for this peer's incoming messages.
    /// They contain no evidence about the peer's runtime or selected model.
    private func incomingHandlerKey(_ mode: String) -> String {
        switch mode {
        case "codex_app_server": return "Codex · server session"
        case "stateless", "stateful": return "Local handler"
        case "disabled": return "Incoming handler paused"
        case "none": return "Not assigned · manual reply needed"
        default: return "Handler type not observed"
        }
    }
    private func wakeKey(_ state: String) -> String {
        switch state {
        case "pending": return "Waiting for handler"
        case "inflight": return "In progress"
        case "handled": return "Handler completed"
        case "failed": return "Handler failed"
        case "muted": return "Wake muted"
        case "dlq": return "Wake needs attention"
        case "stored-only": return "Stored · no automatic handler"
        default: return "Not observed"
        }
    }
    private func agentDetails(_ agent: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text((person.agent_labels?[agent] ?? agent) + " · " + L10n.text(data.connectionSending(for: person, agent: agent, current: current).labelKey)).font(AIMTheme.heading)
            if let policy = data.peer_policy?.peers[agent] {
                Text(L10n.text("Your incoming handler · configured") + ": " + L10n.text(incomingHandlerKey(policy.responder)))
                Text(L10n.text("Your handler model") + ": " + L10n.text("Not observed")).foregroundStyle(AIMTheme.muted)
                Text(L10n.text("Incoming handling") + ": " + L10n.text(policy.incomingLabelKey))
                Text(L10n.text(policy.sharingLabelKey))
                Text(L10n.text("Last wake") + ": " + L10n.text(wakeKey(policy.wake_status)))
                Text(L10n.text("Policy checked") + " · " + AIMCompanionModel.stamp(data.peer_policy?.observed_at)).foregroundStyle(AIMTheme.muted)
            } else { Text(L10n.text("Your incoming handler not observed")) }
            Text(L10n.text("Their runtime / model") + ": " + L10n.text("Not observed")).foregroundStyle(AIMTheme.muted)
            Text(L10n.text("Incoming: their assistant → your Murmur inbox → your configured handler."))
                .foregroundStyle(AIMTheme.muted)
            Text(L10n.text("Outgoing: this app → Murmur → their inbox. Their assistant uses their own connected route."))
                .foregroundStyle(AIMTheme.muted)
            Text(L10n.text("Read the exchange to check replies; transport delivery and assistant work have separate outcomes."))
                .foregroundStyle(AIMTheme.muted)
            if let flow = person.flows?[agent] {
                if singleAgent == nil { traffic(flow) }
                Text(L10n.text(flow.scope == "retained_snapshot" ? "Retained message counts" :
                    (flow.scope == "partial_retained_snapshot" ? "Partial retained message counts" : "Traffic scope not observed")))
                    .foregroundStyle(AIMTheme.muted)
                Text(L10n.text("Status checked") + " · " + AIMCompanionModel.stamp(flow.source_at)).foregroundStyle(AIMTheme.muted)
            } else { Text(L10n.text("Traffic counts not observed")).foregroundStyle(AIMTheme.muted) }
        }.font(AIMTheme.meta).fixedSize(horizontal: false, vertical: true)
    }
}
