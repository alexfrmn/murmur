import SwiftUI
import MurmurTrayCore

enum PairingMode { case invite, join, reply }

struct PairingSheet: View {
    @ObservedObject var model: TrayModel
    private var title: String {
        switch model.pairingMode {
        case .invite: L10n.text("Invite a colleague")
        case .join: L10n.text("I have an invitation…")
        case .reply: L10n.text("Paste colleague's Reply")
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(title).font(.title2.weight(.semibold))
            if model.pairingMode == .invite {
                Text(L10n.text("Send an Invitation to your colleague. When they send their Reply, close this window and choose “Paste colleague's Reply”."))
                    .fixedSize(horizontal: false, vertical: true)
                if let invitation = model.pairingInvitation {
                    if invitation.containsBrokerCredential {
                        Label(L10n.text("Contains a Server access key. Send personally."), systemImage: "key.fill")
                            .fixedSize(horizontal: false, vertical: true)
                        Toggle(L10n.text("I will send this Invitation personally to my colleague."), isOn: $model.pairingConfirmed)
                    }
                    Button(L10n.text("Copy Invitation")) { model.copyPairingLine() }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.busy || (invitation.containsBrokerCredential && !model.pairingConfirmed))
                } else {
                    if model.pairingNeedsPublicServer {
                        Text(L10n.text("Public Server address")).font(.headline)
                        TextField("server.example.org:4222", text: $model.pairingServer)
                            .textFieldStyle(.roundedBorder).accessibilityLabel(L10n.text("Public Server address"))
                        Text(L10n.text("This address is used only in the Invitation. Your Service settings stay the same."))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Button(L10n.text("Create Invitation")) { model.makeInvitation() }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.busy || (model.pairingNeedsPublicServer && model.pairingServer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                }
            } else if model.pairingOutput == nil && model.pairingMessage == nil {
                if model.pairingMode == .join {
                    if let identity = model.pairingIdentity {
                        Text(L10n.text("Identity: %@", identity)).font(.headline)
                        Text(L10n.text("The Contact will be added to this Identity."))
                    } else {
                        Text(L10n.text("Identity name"))
                        TextField(L10n.text("Identity name"), text: $model.creationAgentID).textFieldStyle(.roundedBorder)
                    }
                    Text(L10n.text("Paste the Invitation line sent by your colleague."))
                } else {
                    Text(L10n.text("Paste the Reply line sent by your colleague."))
                }
                TextEditor(text: $model.pairingInput).font(.system(.body, design: .monospaced))
                    .frame(height: 110).border(Color.secondary.opacity(0.3))
                    .accessibilityLabel(model.pairingMode == .join ? L10n.text("Invitation") : L10n.text("Reply"))
                Button(model.pairingMode == .join ? L10n.text("Use invitation") : L10n.text("Add Contact")) {
                    if model.pairingMode == .join { model.joinInvitationLine() }
                    else { model.addReplyLine() }
                }.buttonStyle(.borderedProminent)
                    .disabled(model.busy || model.pairingInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (model.pairingMode == .join && model.pairingIdentity == nil && model.creationAgentID.isEmpty))
            }
            if model.pairingMode != .invite, let output = model.pairingOutput {
                Text(L10n.text("Reply")).font(.headline)
                ScrollView { Text(output).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading) }.frame(height: 100)
                Button(L10n.text("Copy Reply")) { model.copyPairingLine() }.disabled(model.busy)
            }
            if model.operating || model.creatingProfile { ProgressView(L10n.text("Working…")) }
            if let error = model.pairingError { Text(error).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
            if let message = model.pairingMessage { Text(message).fixedSize(horizontal: false, vertical: true) }
            HStack {
                Spacer()
                Button(L10n.text("Close")) { model.showPairingSheet = false }
                    .keyboardShortcut(.cancelAction).disabled(model.operating || model.creatingProfile)
            }
        }.padding(24).frame(width: 500)
            .interactiveDismissDisabled(model.operating || model.creatingProfile)
    }
}
