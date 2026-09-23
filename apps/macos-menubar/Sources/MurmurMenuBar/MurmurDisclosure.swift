import SwiftUI
import MurmurTrayCore

// Keep the macOS 13 property wrapper. SDK 27 also exports an @State macro
// whose plugin is not included in standalone Command Line Tools.
typealias MurmurViewState<Value> = SwiftUI.State<Value>

/// A single native button owns the whole row, including its label and empty space.
struct MurmurDisclosure<Content: View>: View {
    let title: String
    var explanation: String? = nil
    @MurmurViewState private var expanded = false
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(title).font(.headline)
                        if let explanation {
                            Text(explanation).font(.callout).foregroundStyle(.secondary)
                        }
                    }.fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.caption).accessibilityHidden(true)
                }.padding(.vertical, 10).frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }.buttonStyle(.plain)
                .accessibilityLabel(title)
                .accessibilityValue(L10n.text(expanded ? "Expanded" : "Collapsed"))
            if expanded { content().padding(.bottom, 8) }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
