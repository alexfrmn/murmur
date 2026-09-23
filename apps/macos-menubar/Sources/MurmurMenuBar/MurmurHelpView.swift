import SwiftUI
import MurmurTrayCore

struct MurmurHelpView: View {
    private let questions: [(String, String)] = [
        ("What does Murmur do?", "Murmur lets AI assistants exchange messages. For example, ask your assistant in Codex to send work to a colleague's assistant in Claude Code. This window sets up and checks the connection; your conversations stay in your AI applications."),
        ("What should I choose on first launch?", "If someone already uses Murmur, ask for an invitation file. Murmur creates your settings from that file. If you are starting the network, you need an existing server and its connection details; this version does not provide a shared server automatically."),
        ("What is a profile?", "A profile is Murmur's saved connection settings and private keys on this computer. A project folder, Documents or your Claude account is not a profile. Choose a folder only to restore settings that Murmur already created."),
        ("Why return a reply file?", "The sender needs the reply file to add your assistant on their side. Importing an invitation alone does not complete the connection. Return the file to the person who invited you, then test a real answer."),
        ("Where do I write messages?", "In your connected Claude Code or Codex session. Ask your assistant to send a message through Murmur to a named participant. Restart or reload the AI client after adding its Murmur connection."),
        ("Can I close this window?", "Yes, if the Murmur background service is running. Closing the window does not stop that service. An AI assistant still needs an active session, or separately configured and verified automatic wake, to answer."),
        ("The message arrived, but there is no answer. Why?", "Delivery confirms that Murmur passed the message on. Ask the other participant to check that their AI session is open, can use Murmur and has not reached its model limit. Delivery alone does not confirm automatic wake."),
        ("Can I send someone my profile folder?", "Keep your profile folder private: it contains your identity and keys. Share only the intended invitation or reply file with its recipient. An invitation can also contain server access details; do not publish it."),
        ("I chose Documents by mistake. What now?", "Open an existing connection and choose the folder created by Murmur, or start a new connection from an invitation. Murmur checks a newly selected folder before replacing your saved selection."),
        ("Do I need another AI subscription?", "Murmur uses your existing AI assistants. Their sign-in, subscriptions and usage limits remain in their own applications. The connection server's owner may have separate access conditions.")
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n.text("Help")).font(.title2.weight(.semibold))
            Text(L10n.text("Answers about connecting and using Murmur.")).foregroundStyle(.secondary)
            ForEach(questions.indices, id: \.self) { index in
                MurmurDisclosure(title: L10n.text(questions[index].0)) {
                    Text(L10n.text(questions[index].1)).fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
                Divider()
            }
        }
    }
}
