import AppKit
import SwiftUI
import MurmurTrayCore

struct CreateProfileSheet: View {
    @ObservedObject var model: TrayModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L10n.text("Create a profile for your server")).font(.title2.weight(.semibold))
            Text(L10n.text("Use this path if you already have a Murmur server. Your profile is saved privately on this Mac."))
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 6) {
                Text(L10n.text("Agent name"))
                TextField(L10n.text("Agent name"), text: $model.creationAgentID).textFieldStyle(.roundedBorder)
                Text(L10n.text("Server address"))
                TextField("tls://broker.example.org:4222", text: $model.creationServer).textFieldStyle(.roundedBorder)
                    .accessibilityLabel(L10n.text("Server address"))
            }.disabled(model.creatingProfile)
            HStack {
                Button(L10n.text("Choose access file…")) { chooseAccessFile() }.disabled(model.creatingProfile)
                if let accessFile = model.creationAccessFile {
                    Text(accessFile.lastPathComponent).lineLimit(1).truncationMode(.middle)
                    Button(L10n.text("Remove")) { model.creationAccessFile = nil }.disabled(model.creatingProfile)
                }
            }
            Text(L10n.text("An access file is only needed if your server requires one."))
                .font(.caption).foregroundStyle(.secondary)
            if let error = model.creationError { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if model.creatingProfile { ProgressView(L10n.text("Creating your profile…")) }
            HStack {
                Spacer()
                Button(L10n.text("Cancel")) { model.showCreateProfileSheet = false }
                    .keyboardShortcut(.cancelAction).disabled(model.creatingProfile)
                Button(L10n.text("Create profile")) { model.createOwnProfile(agentID: model.creationAgentID, server: model.creationServer, accessFile: model.creationAccessFile) }
                    .keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
                    .disabled(model.busy || model.creationServer.isEmpty || model.creationAgentID.isEmpty)
            }
        }.padding(24).frame(width: 450).interactiveDismissDisabled(model.creatingProfile)
    }
    private func chooseAccessFile() {
        let picker = NSOpenPanel()
        picker.title = L10n.text("Choose access file…")
        picker.canChooseFiles = true; picker.canChooseDirectories = false; picker.allowsMultipleSelection = false
        if picker.runModal() == .OK { model.creationAccessFile = picker.url }
    }
}
