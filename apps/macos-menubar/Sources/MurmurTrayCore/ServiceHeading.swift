import SwiftUI

/// Shared by Home, Settings and the read-only native acceptance renderer.
public struct ServiceHeading: View {
    private let service: StatusSnapshot.Service

    public init(service: StatusSnapshot.Service) { self.service = service }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(service.title).font(.headline)
            if let description = service.managementDescription {
                Text(description).foregroundStyle(.secondary)
            }
        }.fixedSize(horizontal: false, vertical: true)
    }
}
