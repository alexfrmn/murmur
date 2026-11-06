import SwiftUI
import AppKit
import MurmurTrayCore

struct AIMRecentInboxView: View {
    let data: AIMCompanionSnapshot
    @MurmurViewState private var selectedPeer: String?
    private var rows: [AIMCompanionSnapshot.Incoming] {
        data.incoming.filter { item in
            data.people.contains { person in person.contact_state != "status_only" && person.agents.contains(item.peer) }
        }.sorted { (AIMCompanionSnapshot.date($0.date) ?? .distantPast) > (AIMCompanionSnapshot.date($1.date) ?? .distantPast) }.prefix(6).map { $0 }
    }
    var body: some View {
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text(L10n.text("Recent incoming messages")).font(AIMTheme.heading)
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    Button { selectedPeer = row.peer } label: {
                        HStack(alignment: .firstTextBaseline) {
                            Text(data.people.first { $0.agents.contains(row.peer) }?.name ?? row.peer)
                            Spacer()
                            Text(AIMCompanionModel.stamp(row.date)).foregroundStyle(AIMTheme.muted)
                            Text(L10n.text("Read") + " ↗").foregroundStyle(AIMTheme.signal)
                        }.font(AIMTheme.meta).padding(.vertical, 7)
                    }.buttonStyle(.plain).help(L10n.text("Read conversation"))
                    Divider()
                }
            }.padding(.vertical, 10)
                .sheet(isPresented: Binding(get: { selectedPeer != nil }, set: { if !$0 { selectedPeer = nil } })) {
                    if let peer = selectedPeer {
                        AIMMessageSearchView(enabled: true, people: data.people, historyPeer: peer, snapshot: data)
                    }
                }
        }
    }
}

struct AIMDeskPulse: View {
    let data: AIMCompanionSnapshot
    let current: Bool
    let imageReadEnabled: Bool
    @MurmurViewState private var person: AIMCompanionSnapshot.Person?
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 24) {
                metric("People", value: data.people.count)
                metric("Waiting for you", value: data.ownerAttentionCount)
                Spacer(minLength: 0)
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), alignment: .leading), count: 3), alignment: .leading, spacing: 8) {
                ForEach(data.people) { row in
                    Button {
                        if let url = data.privateOwnerURL(for: row, current: current) { NSWorkspace.shared.open(url) }
                        else if data.communicationPeer(for: row) != nil { person = row }
                    } label: {
                        HStack(spacing: 7) {
                            AIMPersonAvatar(person: row, imageReadEnabled: imageReadEnabled).scaleEffect(0.6).frame(width: 24, height: 24)
                            Text(row.name).font(AIMTheme.meta).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }.buttonStyle(.plain).disabled(data.communicationPeer(for: row) == nil && data.privateOwnerURL(for: row, current: current) == nil)
                        .help(L10n.text(data.isStatusOnly(row) ? "Open the verified private owner chat in Codex" : "Read conversation") + " · " + row.name)
                }
            }
        }.padding(14).background(AIMTheme.surface)
            .overlay(alignment: .bottom) { Rectangle().fill(AIMTheme.muted.opacity(0.3)).frame(height: 1) }
            .sheet(item: $person) { row in
                if let peer = data.communicationPeer(for: row) {
                    AIMMessageSearchView(enabled: true, people: data.people, historyPeer: peer, snapshot: data)
                }
            }
    }
    private func metric(_ title: String, value: Int) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(current ? String(value) : "–").font(AIMTheme.title)
            Text(L10n.text(title)).font(AIMTheme.meta).foregroundStyle(AIMTheme.muted)
        }
    }
}

struct AIMCoworkView: View {
    let data: AIMCoworkSnapshot?
    let failed: Bool
    @MurmurViewState private var expanded = false
    private var fresh: Bool { !failed && data?.isCurrent() == true }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(L10n.text("Cowork now")).font(AIMTheme.heading)
                Spacer()
                Button(L10n.text("Dashboard") + " ↗") { AIMCompanionModel.open() }
                    .buttonStyle(.plain).font(AIMTheme.meta)
            }
            if let data {
                Text(data.members.map(\.name).joined(separator: " · ")).font(AIMTheme.meta)
                Text("\(data.tasks.count) " + L10n.text("tasks") + " · \(data.tasks.filter { $0.status == "blocked" }.count) " + L10n.text("Blocked"))
                    .font(AIMTheme.meta).foregroundStyle(fresh ? AIMTheme.ink : AIMTheme.muted)
                if !fresh { Text(L10n.text("Stale snapshot")).font(AIMTheme.meta).foregroundStyle(AIMTheme.signal) }
                ForEach(data.tasks.filter { $0.status == "blocked" }) { work in task(work, data: data) }
                DisclosureGroup(L10n.text("All cowork tasks"), isExpanded: $expanded) {
                    ForEach(data.tasks.filter { $0.status != "blocked" }) { work in task(work, data: data) }
                }.font(AIMTheme.meta)
                Text(L10n.text("Source") + " · " + AIMCompanionModel.stamp(data.observed_at) + " · \(data.collector_seconds)s")
                    .font(AIMTheme.meta).foregroundStyle(AIMTheme.muted)
            } else {
                Text(L10n.text(failed ? "Cowork source unavailable" : "Reading cowork tasks…"))
                    .font(AIMTheme.meta).foregroundStyle(AIMTheme.muted)
            }
        }.padding(.vertical, 14)
            .overlay(alignment: .top) { Rectangle().fill(AIMTheme.muted.opacity(0.4)).frame(height: 1) }
    }
    private func task(_ work: AIMCoworkSnapshot.Work, data: AIMCoworkSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(work.title).font(AIMTheme.heading)
                Spacer()
                Text(L10n.text(work.statusLabel)).font(AIMTheme.meta)
                    .foregroundStyle(work.status == "blocked" ? AIMTheme.signal : AIMTheme.muted)
            }
            Text(data.ownerName(work.owner)).font(AIMTheme.meta).foregroundStyle(AIMTheme.muted)
            Text(work.next_step).font(AIMTheme.meta).fixedSize(horizontal: false, vertical: true)
        }.padding(.vertical, 8)
    }
}
