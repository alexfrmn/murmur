import Foundation

/// Presentation only. The CLI remains the source of profile and diagnostic facts.
public enum ConnectionGuidance {
    public static func profileLabel(agentID: String?, hasStatus: Bool, checking: Bool) -> String {
        if hasStatus, let agentID { return agentID }
        return L10n.text(checking ? "Checking your connection settings…" : "Connection settings need attention")
    }

    public static func diagnosticSummary(_ doctor: DoctorSnapshot) -> (title: String, message: String) {
        if let failure = doctor.stages.first(where: { $0.state == "fail" }) {
            switch failure.id {
            case "config":
                if failure.detail == "config.missing" {
                    return (L10n.text("This folder has no Murmur settings"),
                            L10n.text("Start a new connection or choose the folder where Murmur was set up before."))
                }
                return (L10n.text("Connection settings need attention"),
                        L10n.text("Murmur could not read these settings. Choose an existing connection or see the details below."))
            case "daemon":
                return (L10n.text("Background delivery needs attention"),
                        L10n.text("Check background operation before testing the server or another assistant."))
            case "broker":
                if failure.reason == "broker.unauthorized" {
                    return (L10n.text("The server refused access"),
                            L10n.text("Ask the server owner to check the access details for this connection."))
                }
                return (L10n.text("The connection server could not be reached"),
                        L10n.text("Check your internet connection and ask the server owner whether the server is available."))
            case "peers":
                return (L10n.text("Check the other participant's connection"),
                        L10n.text("Both sides need to exchange invitation and reply files. The other participant also needs Murmur running."))
            default:
                return (L10n.text("The connection check did not finish"),
                        L10n.text("Check that the other participant is connected. Message delivery and an AI assistant's answer are separate checks."))
            }
        }
        let complete = doctor.stages.count == DoctorSnapshot.stageIDs.count && doctor.stages.allSatisfy { $0.state == "ok" }
        return (L10n.text(complete ? "Murmur checks completed" : "Some checks are still unconfirmed"),
                L10n.text("These checks do not prove that an AI assistant has replied. Ask your assistant to send a test message and wait for the answer."))
    }
}
