import SwiftUI
import MurmurTrayCore

struct MurmurClientSetupView: View {
    @ObservedObject var model: TrayModel
    @MurmurViewState private var peer = ""
    private var peers: [String] { model.status?.peers.list?.map(\.agentId).filter { $0 != model.agentID } ?? [] }
    private var choices: [DetectedAIClient] {
        let all = model.aiClients ?? []
        // Codex CLI and Desktop share one config; prefer the installed application.
        return all.filter { $0.installed && !($0.id == .codexCLI && all.contains { $0.id == .codexDesktop && $0.installed }) }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(L10n.text("Connect your AI application")).font(.title3.weight(.semibold))
            Text(L10n.text("Choose where you work with your assistant. Murmur will show the change before you confirm it."))
                .fixedSize(horizontal: false, vertical: true)
            if model.aiClients == nil {
                Button(L10n.text("Find my AI applications")) { model.detectAIClients() }.disabled(model.busy)
            } else {
                if choices.isEmpty {
                    Text(L10n.text("No supported AI application was found. Install Claude Code or Codex, then look again."))
                        .fixedSize(horizontal: false, vertical: true)
                }
                ForEach(choices) { choice in
                    VStack(alignment: .leading, spacing: 4) {
                        Button(L10n.text("Connect %@…", choice.id.title)) { model.connectAIClient(choice.id) }
                            .disabled(model.busy || !choice.canConfigure)
                        if !choice.canConfigure {
                            Text(L10n.text("This application uses a custom configuration location that Murmur cannot verify yet."))
                                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                Button(L10n.text("Look again")) { model.detectAIClients() }.buttonStyle(.link).disabled(model.busy)
            }
            if model.configuringAI { ProgressView(L10n.text("Checking the application settings…")) }
            if let error = model.aiSetupError { Text(error).fixedSize(horizontal: false, vertical: true) }
            if let receipt = model.aiReceipt {
                Divider()
                Text(L10n.text("Connection saved for %@", receipt.client.title)).font(.headline)
                Text(L10n.text("Reload your AI application or start a new session so it can load Murmur. Your current conversation is not closed automatically."))
                    .fixedSize(horizontal: false, vertical: true)
                Text(L10n.text("Saved settings are only the first step. Test a returned reply below."))
                    .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                MurmurDisclosure(title: L10n.text("Changed file and backup")) {
                    Text(receipt.configPath).font(.caption).textSelection(.enabled)
                    if let backup = receipt.backup { Text(L10n.text("Backup: %@", backup)).font(.caption).textSelection(.enabled) }
                    if !receipt.changed { Text(L10n.text("The same connection was already saved; the file was not rewritten.")) }
                }
            }
            Divider()
            Text(L10n.text("Test a real reply")).font(.headline)
            Text(L10n.text("Keep both assistants open. The other participant needs their Murmur connection set up too. This test does not start a closed AI session."))
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if peers.isEmpty {
                Text(L10n.text("No participant is available yet. Finish exchanging the invitation and reply files, then refresh the connection."))
                    .fixedSize(horizontal: false, vertical: true)
            } else if let plan = model.replyPlan {
                Text(L10n.text("Test with %@", plan.peerId))
                Text(L10n.text("Copy this request into your AI conversation and ask your assistant to run it. Murmur will check for that request and its matching reply for up to 15 minutes."))
                    .fixedSize(horizontal: false, vertical: true)
                Button(L10n.text(model.testPromptCopied ? "Request copied — paste it into your AI conversation" : "Copy test request")) { model.copyReplyTestPrompt() }
                MurmurDisclosure(title: L10n.text("View the test request")) {
                    Text(plan.prompt).font(.caption).textSelection(.enabled)
                }
                if let observation = model.replyObservation {
                    switch observation.state {
                    case .notSent:
                        Text(L10n.text("The request has not appeared yet" )).font(.headline)
                        Text(L10n.text("Paste the copied request into the AI application you connected. Let it use the Murmur tool, then check again."))
                    case .waiting:
                        Text(L10n.text("Request recorded — waiting for a reply")).font(.headline)
                        Text(L10n.text("Ask the other participant to check their active assistant and usage limits. A recorded request alone does not prove delivery or a reply."))
                    case .replied:
                        Label(L10n.text("Reply received from %@", plan.peerId), systemImage: "checkmark.circle").font(.headline)
                        Text(L10n.text("The request and reply match this test. Continue working in your AI application. Automatic wake is a separate setting."))
                    case .expired:
                        Text(L10n.text("The test ended without a confirmed reply")).font(.headline)
                        Text(L10n.text("Keep both assistants open, check their connections and limits, then start a new test."))
                    }
                }
                if let error = model.replyError { Text(error).fixedSize(horizontal: false, vertical: true) }
                if model.watchingReply {
                    ProgressView(L10n.text("Waiting for the test reply…"))
                    Button(L10n.text("Stop checking")) { model.stopWatchingReply() }
                } else if model.replyObservation?.state != .replied && model.replyObservation?.state != .expired {
                    Button(L10n.text("I sent the request — check for a reply")) { model.watchReplyTest() }
                        .disabled(model.busy || model.checkingReply)
                }
                Button(L10n.text("Start a new test")) { model.resetReplyTest() }.buttonStyle(.link).disabled(model.busy)
            } else {
                Picker(L10n.text("Other participant"), selection: $peer) {
                    Text(L10n.text("Choose a participant")).tag("")
                    ForEach(peers, id: \.self) { Text($0).tag($0) }
                }
                Button(L10n.text("Prepare test request")) { model.prepareReplyTest(peer: peer) }
                    .disabled(model.busy || !peers.contains(peer))
                if let error = model.replyError { Text(error).fixedSize(horizontal: false, vertical: true) }
            }
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.accentColor.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
            .onAppear { if peers.count == 1 { peer = peers[0] } }
            .onChange(of: peers) { value in
                if !value.contains(peer) { peer = value.count == 1 ? value[0] : "" }
            }
    }
}
