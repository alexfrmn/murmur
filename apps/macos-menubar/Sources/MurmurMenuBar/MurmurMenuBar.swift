import AppKit
import SwiftUI
import ServiceManagement
import MurmurTrayCore

private struct DoctorRead: Sendable { let value: DoctorSnapshot?; let error: String? }

@MainActor
final class TrayModel: ObservableObject {
    @Published var language = L10n.language()
    @Published var status: StatusSnapshot?
    @Published var statusError = Verdict(.unknown, reason: L10n.text("Choose a Murmur profile folder"))
    @Published var doctor: DoctorSnapshot?
    @Published var doctorError: String?
    @Published var operationError: String?
    @Published var operationMessage: String?
    @Published var operating = false
    @Published var profile: ProfileBinding?
    @Published var profileError: String? = L10n.text("Choose a Murmur profile folder")
    @Published var agentID: String?
    @Published var checkingStatus = false
    @Published var checkingDoctor = false
    @Published var checkingSelection = false
    @Published var aiClients: [DetectedAIClient]?
    @Published var configuringAI = false
    @Published var aiSetupError: String?
    @Published var aiReceipt: ClientConfigurationReceipt?
    @Published var replyPlan: ReplyTestPlan?
    @Published var replyObservation: ReplyTestObservation?
    @Published var checkingReply = false
    @Published var watchingReply = false
    @Published var replyError: String?
    @Published var testPromptCopied = false
    @Published var selectionError: String?
    @Published var selectionErrorDetail: String?
    @Published var updates: UpdateSnapshot?
    @Published var updateError: String?
    @Published var checkingUpdates = false
    @Published var runtimeError: String?
    @Published var preparingRuntime = false
    @Published var launchAtLogin = SMAppService.mainApp.status == .enabled
    @Published var demoState: Indicator = .unknown
    @Published var shortcutAvailable = false
    @Published var creatingProfile = false
    @Published var creationError: String?
    @Published var creationAgentID = NewProfilePlan.suggestedAgentID()
    @Published var creationServer = ""
    @Published var creationAccessFile: URL?
    @Published var showCreateProfileSheet = false
    @Published var showPairingSheet = false
    @Published var pairingMode: PairingMode = .join
    @Published var pairingInput = ""
    @Published var pairingOutput: String?
    @Published var pairingError: String?
    @Published var pairingMessage: String?
    @Published var pairingInvitation: PairingInvitation?
    @Published var pairingConfirmed = false
    @Published var pairingNeedsPublicServer = false
    @Published var pairingServer = ""
    private var inviteAfterCreation = false
    private var openCreatedInvitation = false
    @Published var setupAgentID: String?
    @Published var setupReplyFile: URL?
    @Published var pendingCreation: PendingOnboarding?
    @Published var savedSetupError: String?
    @Published var savedProfiles: [ProfileBinding] = []
    @Published var allowSeparateProfile = false
    @Published var requiresRecoveryChoice = false
    @Published var archivedSetupRecord: URL?
    private var creationPlan: NewProfilePlan?
    let isDemo: Bool
    private var timer: Timer?
    private var updateTimer: Timer?
    private var replyTimer: Timer?
    private var client: ProfileClient?
    private var updatesClient: UpdatesClient?
    private var selectionID = UUID()

    init(startRuntime: Bool = true) {
        isDemo = ProcessInfo.processInfo.arguments.contains("--demo")
        if startRuntime && !isDemo { prepareRuntime() }
    }

    func prepareRuntime() {
        guard !isDemo, !preparingRuntime else { return }
        guard let helper = BundledRuntime.cli() else { connectClients(); return }
        preparingRuntime = true
        Task {
            let result = await Task.detached { () -> Result<Void, Error> in
                Result {
                    let runtime = try BundledRuntime.runtime(for: helper)
                    _ = try BundledRuntime.findNode(runtime: runtime)
                }
            }.value
            preparingRuntime = false
            switch result {
            case .success:
                runtimeError = nil
                connectClients()
            case .failure(let error):
                runtimeError = error.localizedDescription
                statusError = Verdict(.unknown, reason: error.localizedDescription)
                let alert = NSAlert()
                alert.messageText = L10n.text("Murmur cannot start yet")
                alert.informativeText = error.localizedDescription
                if case RuntimeError.missingNode = error {
                    alert.addButton(withTitle: L10n.text("Open Node.js website"))
                    alert.addButton(withTitle: L10n.text("Try again"))
                    alert.addButton(withTitle: L10n.text("Close"))
                    NSApplication.shared.activate(ignoringOtherApps: true)
                    switch alert.runModal() {
                    case .alertFirstButtonReturn: NSWorkspace.shared.open(URL(string: "https://nodejs.org/en/download")!)
                    case .alertSecondButtonReturn: prepareRuntime()
                    default: break
                    }
                } else {
                    alert.addButton(withTitle: L10n.text("Close"))
                    NSApplication.shared.activate(ignoringOtherApps: true)
                    alert.runModal()
                }
            }
        }
    }

    private func connectClients() {
            timer?.invalidate()
            let env = ProcessInfo.processInfo.environment
            let stored = UserDefaults.standard
            requiresRecoveryChoice = stored.bool(forKey: "requiresProfileChoiceAfterSetupReset")
            if let name = stored.string(forKey: "archivedSetupRecordName"),
               name.range(of: "\\Apending-setup-[a-f0-9-]{36}\\.json\\z", options: .regularExpression) != nil {
                let file = applicationDirectory.appendingPathComponent("saved-setup-records").appendingPathComponent(name)
                if FileManager.default.fileExists(atPath: file.path) { archivedSetupRecord = file }
            }
            refreshSavedSetup()
            let directory = env["MURMUR_DATA_DIR"] ?? stored.string(forKey: "profileDirectory")
            let serviceName = env["MURMUR_DATA_DIR"] != nil ? env["MURMUR_SERVICE_NAME"] : stored.string(forKey: "profileServiceName")
            if let directory, !hasPendingSetup, !requiresRecoveryChoice {
                do { bind(try ProfileBinding(dataDirectory: directory, serviceName: serviceName)) }
                catch { profileError = error.localizedDescription }
            }
            timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.refreshStatus() }
            }
            if let executable = CLIProbe.locate(environment: env) {
                updatesClient = UpdatesClient(executable: executable, environment: env)
                refreshUpdates()
            } else { updateError = ProbeError.missingCLI.localizedDescription }
    }

    var busy: Bool { preparingRuntime || creatingProfile || operating || checkingStatus || checkingDoctor || checkingSelection || configuringAI }
    func selectLanguage(_ value: AppLanguage) {
        guard !busy, !checkingUpdates, value != language else { return }
        L10n.select(value)
        language = value
        operationError = nil; operationMessage = nil
        doctorError = doctor == nil ? L10n.text("Not checked yet") : nil
        if profile == nil {
            profileError = L10n.text("Choose a Murmur profile folder")
            statusError = Verdict(.unknown, reason: L10n.text("Choose a Murmur profile folder"))
        } else {
            refreshStatus()
        }
        if runtimeError != nil { prepareRuntime() }
        refreshUpdates()
    }
    // Update I/O never participates in profile/status/service command readiness.
    var canChangeUpdates: Bool { !isDemo && updatesClient != nil && !checkingUpdates }
    var updatesForcedOff: Bool { updatesClient?.forcedOff == true }
    var updateAvailable: Bool { updates?.releasePage() != nil }
    var accessibleStatus: String {
        "Murmur: " + verdict.reason
            + (verdict.unread ? "; " + L10n.text("Unread messages") : "")
            + (updateAvailable ? L10n.text("; update available") : "")
    }

    func refreshUpdates(enabled: Bool? = nil) {
        guard !isDemo, !checkingUpdates, let updatesClient else { return }
        checkingUpdates = true; updateError = nil
        Task { [self] in
            let result = await Task.detached { () -> Result<UpdateSnapshot, Error> in
                Result {
                    if let enabled { try updatesClient.setEnabled(enabled) }
                    // A disabled check is local-only in the CLI contract. Read back
                    // the effective preference, including a process opt-out.
                    return try updatesClient.check()
                }
            }.value
            switch result {
            case .success(let snapshot): updates = snapshot
            case .failure(let error): updates = nil; updateError = error.localizedDescription
            }
            checkingUpdates = false
            // Schedule from completion so a slow startup cannot make the next
            // invocation fall just before the CLI's six-hour cache deadline.
            updateTimer?.invalidate()
            updateTimer = Timer.scheduledTimer(withTimeInterval: 21_600, repeats: false) { [weak self] _ in
                Task { @MainActor in self?.refreshUpdates() }
            }
        }
    }

    func openUpdateRelease() {
        guard !isDemo, let page = updates?.releasePage() else { return }
        // No download, installer or shell: an explicit click opens an allowed page.
        if !NSWorkspace.shared.open(page) { updateError = L10n.text("Could not open the release page") }
    }

    var controlBlockReason: String? {
        if isDemo { return L10n.text("Demo mode") }
        if preparingRuntime { return L10n.text("Checking the Murmur engine…") }
        if let runtimeError { return runtimeError }
        if hasPendingSetup { return L10n.text("Continue the saved setup before creating another profile") }
        if let profileError { return profileError }
        guard let client, let status, let agentID else { return L10n.text("The profile has not been verified yet") }
        do {
            guard try client.verifiedAgent(in: status) == agentID else { return ProfileError.identityChanged.localizedDescription }
        } catch { return error.localizedDescription }
        return busy ? L10n.text("Wait for the current command to finish") : nil
    }

    var canControl: Bool { controlBlockReason == nil }
    var wakeAction: ControlAction { status?.wake.config.enabled == false ? .resume : .pause }

    func chooseProfile() {
        guard !busy, !isDemo, runtimeError == nil, !hasPendingSetup else { return }
        let picker = NSOpenPanel()
        picker.title = L10n.text("Open an existing connection")
        picker.message = L10n.text("Choose the folder where Murmur already stores its settings and keys. A project folder or Documents alone will not work. Your saved selection stays unchanged until this folder is verified.")
        picker.prompt = L10n.text("Check this folder")
        picker.canChooseFiles = false; picker.canChooseDirectories = true
        picker.canCreateDirectories = false; picker.allowsMultipleSelection = false
        picker.showsHiddenFiles = true
        // The CLI derives service identity from the chosen lexical path.
        // Preserve it before AppKit can replace an alias with its target.
        picker.resolvesAliases = false
        NSApplication.shared.activate(ignoringOtherApps: true)
        guard picker.runModal() == .OK, let url = picker.url else { return }
        do {
            let chosen = try ProfileBinding(dataDirectory: url.path)
            recoverProfileSelection(chosen)
        } catch { selectionError = error.localizedDescription }
    }

    func bind(_ chosen: ProfileBinding, expectedAgent: String? = nil, skipInitialDoctor: Bool = false) {
        selectionID = UUID()
        aiClients = nil; aiReceipt = nil; aiSetupError = nil
        resetReplyTest()
        restoreSetup(for: chosen)
        profile = chosen; agentID = expectedAgent ?? setupAgentID; status = nil; doctor = nil
        operationMessage = nil; operationError = nil
        profileError = L10n.text("Checking the selected profile…")
        statusError = Verdict(.unknown, reason: L10n.text("Checking the selected profile…"))
        guard let executable = CLIProbe.locate() else {
            client = nil; profileError = ProbeError.missingCLI.localizedDescription
            statusError = .unavailable(ProbeError.missingCLI)
            return
        }
        client = ProfileClient(executable: executable, profile: chosen)
        refreshStatus()
        if setupAgentID == nil && !skipInitialDoctor { refreshDoctor() }
    }


    private var applicationDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Murmur")
    }
    private var onboardingJournal: OnboardingJournal {
        OnboardingJournal(applicationDirectory: applicationDirectory, onSync: { JournalSyncDiagnostics.record($0) })
    }
    var hasPendingSetup: Bool { pendingCreation != nil || savedSetupError != nil }
    var needsExistingProfileChoice: Bool { (!savedProfiles.isEmpty || requiresRecoveryChoice) && !allowSeparateProfile }
    var canResetSavedSetup: Bool { hasPendingSetup && !busy && onboardingJournal.canArchiveRecord }
    var pendingCanRetryCreation: Bool { pendingCreation.map { onboardingJournal.canDiscard($0) } ?? false }
    var pendingTitle: String {
        if pendingCreation?.creationConfirmed == true { return L10n.text("Profile created; verification could not finish") }
        if pendingCanRetryCreation { return L10n.text("The profile was not created") }
        return L10n.text("The saved setup needs checking")
    }
    private func refreshSavedSetup() {
        do {
            pendingCreation = try onboardingJournal.load()
            savedProfiles = try onboardingJournal.existingProfiles()
            savedSetupError = nil
        } catch { savedSetupError = error.localizedDescription }
    }
    func allowNewSeparateProfile() {
        guard !busy, !hasPendingSetup else { return }
        completeRecoveryChoice()
        allowSeparateProfile = true
    }
    private func completeRecoveryChoice() {
        requiresRecoveryChoice = false
        UserDefaults.standard.removeObject(forKey: "requiresProfileChoiceAfterSetupReset")
    }
    func chooseSavedProfile(_ chosen: ProfileBinding) {
        guard savedProfiles.contains(chosen) else { return }
        recoverProfileSelection(chosen)
    }
    private func recoverProfileSelection(_ chosen: ProfileBinding) {
        guard !busy, !isDemo, !hasPendingSetup else { return }
        guard let executable = CLIProbe.locate() else {
            selectionError = ProbeError.missingCLI.localizedDescription
            selectionErrorDetail = nil
            return
        }
        checkingSelection = true; selectionError = nil; selectionErrorDetail = nil
        let onboarding = ProfileOnboardingClient(executable: executable), root = applicationDirectory
        Task {
            let result = await Task.detached { Result { try onboarding.recoverSelectedProfile(chosen, applicationDirectory: root) } }.value
            defer { checkingSelection = false }
            switch result {
            case .success(let selected):
                let confirmation = NSAlert()
                confirmation.messageText = L10n.text("Open connection %@?", selected.agentID)
                confirmation.informativeText = L10n.text("Murmur found saved settings in this folder. Opening them changes only the selected connection; no new identity is created.") + "\n\n" + chosen.dataDirectory
                confirmation.addButton(withTitle: L10n.text("Open connection"))
                confirmation.addButton(withTitle: L10n.text("Cancel"))
                guard confirmation.runModal() == .alertFirstButtonReturn else { return }
                checkingSelection = false
                do {
                    try persistCreatedSelection(selected)
                    completeRecoveryChoice()
                    bind(selected.profile, expectedAgent: selected.agentID, skipInitialDoctor: true)
                    operationMessage = L10n.text("Profile selected; connection has not been checked yet")
                } catch { selectionError = error.localizedDescription }
            case .failure(let error):
                // No preference, binding, identity or file was changed by this read-only attempt.
                selectionError = L10n.text("This folder could not be opened as a Murmur connection. Choose settings created by Murmur, or start from an invitation. Your previous selection has been kept.")
                selectionErrorDetail = error.localizedDescription
            }
        }
    }
    func showSavedSetupFiles() {
        let folder = pendingCreation.map { URL(fileURLWithPath: $0.plan.profile.dataDirectory) } ?? applicationDirectory
        NSWorkspace.shared.activateFileViewerSelecting([FileManager.default.fileExists(atPath: folder.path) ? folder : onboardingJournal.file])
    }
    func showArchivedSetupRecord() {
        guard let archivedSetupRecord else { return }
        NSWorkspace.shared.activateFileViewerSelecting([archivedSetupRecord])
    }
    func resetSavedSetupRecord() {
        guard canResetSavedSetup else { return }
        let alert = NSAlert()
        alert.messageText = L10n.text("Reset the saved setup record?")
        alert.informativeText = L10n.text("Murmur will keep a private copy of this record. Profiles, keys and reply files will stay where they are. The earlier setup may still finish; choose an existing profile or explicitly create a separate one afterwards.")
        alert.addButton(withTitle: L10n.text("Cancel"))
        alert.addButton(withTitle: L10n.text("Reset record"))
        guard alert.runModal() == .alertSecondButtonReturn else { return }
        do {
            // A reset is never interpreted as proof that the earlier CLI wrote nothing.
            // Keep the explicit-choice gate even across a restart after archiving.
            let preferences = UserDefaults.standard
            preferences.set(true, forKey: "requiresProfileChoiceAfterSetupReset")
            guard preferences.synchronize() else { throw OnboardingJournalError.invalidJournal }
            requiresRecoveryChoice = true; allowSeparateProfile = false
            archivedSetupRecord = try onboardingJournal.archiveRecord()
            preferences.set(archivedSetupRecord?.lastPathComponent, forKey: "archivedSetupRecordName")
            selectionID = UUID(); profile = nil; client = nil; agentID = nil; status = nil; doctor = nil
            setupAgentID = nil; setupReplyFile = nil
            creationPlan = nil; creationError = nil
            refreshSavedSetup()
        } catch { creationError = error.localizedDescription; refreshSavedSetup() }
    }
    func discardEmptySetup() {
        guard !busy, let pendingCreation else { return }
        do {
            try onboardingJournal.discardIfUntouched(pendingCreation)
            creationPlan = nil; creationError = nil; allowSeparateProfile = false
            refreshSavedSetup()
        } catch { creationError = error.localizedDescription; refreshSavedSetup() }
    }
    func resumeSavedSetup() {
        guard !busy, !isDemo, runtimeError == nil, let pendingCreation,
              let executable = CLIProbe.locate() else { return }
        creatingProfile = true; creationError = nil
        let onboarding = ProfileOnboardingClient(executable: executable)
        Task {
            let result = await Task.detached { Result { try onboarding.resume(pendingCreation) } }.value
            finishCreation(result)
        }
    }
    var hasSetupSteps: Bool { setupAgentID != nil }
    var canStartNewProfile: Bool { canControl && agentID == setupAgentID }

    func beginOwnProfile() {
        guard !busy, !isDemo, runtimeError == nil else { return }
        inviteAfterCreation = false
        refreshSavedSetup()
        guard !hasPendingSetup, !needsExistingProfileChoice else { return }
        selectionError = nil; selectionErrorDetail = nil
        creationPlan = nil; creationError = nil
        creationAgentID = NewProfilePlan.suggestedAgentID(); creationServer = ""; creationAccessFile = nil
        showCreateProfileSheet = true
    }
    func useInvitation() {
        guard !busy, !isDemo, runtimeError == nil else { return }
        refreshSavedSetup()
        guard !hasPendingSetup, !needsExistingProfileChoice else { return }
        selectionError = nil; selectionErrorDetail = nil
        creationAgentID = NewProfilePlan.suggestedAgentID()
        beginPairing(.join)
    }
    var canPair: Bool { !busy && !isDemo && client != nil && agentID != nil && status != nil }
    func beginPairing(_ mode: PairingMode) {
        guard !busy, !isDemo else { return }
        if mode != .join { guard canPair else { return } }
        pairingMode = mode; pairingInput = ""; pairingOutput = nil
        pairingError = nil; pairingMessage = nil; pairingInvitation = nil
        pairingConfirmed = false; pairingNeedsPublicServer = false; pairingServer = ""
        showPairingSheet = true
        if mode == .invite { makeInvitation() }
    }
    func beginInviting() {
        if canPair { beginPairing(.invite); return }
        beginOwnProfile()
        inviteAfterCreation = showCreateProfileSheet
    }
    func ownProfileSheetDismissed() {
        guard openCreatedInvitation else { inviteAfterCreation = false; return }
        openCreatedInvitation = false
        pairingMode = .invite; clearPairing()
        pairingNeedsPublicServer = false; pairingServer = ""
        showPairingSheet = true
    }
    func joinInvitationLine() {
        guard !busy, !hasPendingSetup, !isDemo else { return }
        do {
            let line = try PairingLine.validated(pairingInput)
            let plan = try NewProfilePlan(applicationDirectory: applicationDirectory, agentID: creationAgentID)
            creationPlan = plan
            create(plan: plan, invitation: line)
        } catch { pairingError = PairingError.message(for: error) }
    }
    private var pairingClient: ProfilePairingClient? {
        guard let client else { return nil }
        return ProfilePairingClient(executable: client.executable, profile: client.profile)
    }
    func makeInvitation() {
        guard !busy, !isDemo, let helper = pairingClient, let agentID else { return }
        let selected = selectionID
        let server = pairingNeedsPublicServer ? pairingServer : nil
        operating = true; pairingError = nil; pairingMessage = nil
        Task {
            let result = await Task.detached { Result { try helper.invite(expectedAgent: agentID, publicServer: server) } }.value
            guard selectionID == selected else { return }
            operating = false
            switch result {
            case .success(let invitation):
                pairingInvitation = invitation; pairingConfirmed = false
                if !invitation.containsBrokerCredential { copyPairingLine() }
            case .failure(let error):
                if let cause = error as? PairingError, cause == .publicServerRequired || cause == .invalidServer {
                    pairingNeedsPublicServer = true
                }
                pairingError = PairingError.message(for: error)
            }
        }
    }
    func addReplyLine() {
        guard !busy, !isDemo, let helper = pairingClient, let agentID else { return }
        let selected = selectionID, line = pairingInput
        operating = true; pairingError = nil; pairingMessage = nil
        Task {
            let result = await Task.detached { Result { try helper.addReply(line, expectedAgent: agentID) } }.value
            guard selectionID == selected else { return }
            operating = false
            switch result {
            case .success(let contact):
                pairingInput = ""
                pairingMessage = L10n.text("Contact %@ added. Check the connection after both Services are running.", contact)
            case .failure(let error): pairingError = PairingError.message(for: error)
            }
            refreshStatus()
        }
    }
    func copyPairingLine() {
        guard !operating, !creatingProfile else { return }
        do {
            let line: String
            if let invitation = pairingInvitation {
                line = try invitation.lineForCopy(confirmedPersonalSharing: pairingConfirmed)
            } else if let output = pairingOutput { line = try PairingLine.validated(output) }
            else { return }
            NSPasteboard.general.clearContents()
            guard NSPasteboard.general.setString(line, forType: .string) else { throw PairingError.failed }
            pairingOutput = line
            pairingMessage = L10n.text("Copied. Send this line personally to your colleague.")
        } catch { pairingError = PairingError.message(for: error) }
    }
    func showSavedReply() {
        guard !busy, setupAgentID == agentID, let setupReplyFile else { return }
        do {
            let reply = try PairingLine.recovered(from: setupReplyFile)
            beginPairing(.join)
            pairingOutput = reply
            copyPairingLine()
        } catch { operationError = PairingError.message(for: error) }
    }
    func clearPairing() {
        pairingInput = ""; pairingOutput = nil; pairingInvitation = nil
        pairingConfirmed = false; pairingError = nil; pairingMessage = nil
    }
    func createOwnProfile(agentID: String, server: String, accessFile: URL?) {
        guard !busy, !isDemo, runtimeError == nil, !hasPendingSetup else { return }
        do {
            let plan: NewProfilePlan
            if let previous = creationPlan, previous.agentID == agentID { plan = previous }
            else { plan = try NewProfilePlan(applicationDirectory: applicationDirectory, agentID: agentID); creationPlan = plan }
            create(plan: plan, server: server, accessFile: accessFile)
        } catch { creationError = error.localizedDescription }
    }
    private func create(plan: NewProfilePlan, invitation: String? = nil, server: String? = nil, accessFile: URL? = nil) {
        guard let executable = CLIProbe.locate() else { creationError = ProbeError.missingCLI.localizedDescription; return }
        creatingProfile = true; creationError = nil
        let onboarding = ProfileOnboardingClient(executable: executable)
        let journal = onboardingJournal
        Task {
            let result = await Task.detached { () -> Result<CreatedProfile, Error> in
                Result {
                    if let invitation { return try onboarding.join(plan, invitationLine: invitation, journal: journal) }
                    return try onboarding.initialize(plan, brokerURL: server ?? "", tokenFile: accessFile, journal: journal)
                }
            }.value
            finishCreation(result)
        }
    }
    private func persistCreatedSelection(_ created: CreatedProfile) throws {
        let preferences = UserDefaults.standard
        preferences.set(created.profile.dataDirectory, forKey: "profileDirectory")
        if let name = created.profile.serviceName { preferences.set(name, forKey: "profileServiceName") }
        else { preferences.removeObject(forKey: "profileServiceName") }
        preferences.set(created.profile.dataDirectory, forKey: "setupProfileDirectory")
        preferences.set(created.agentID, forKey: "setupAgentID")
        if let file = created.replyFile { preferences.set(file.path, forKey: "setupReplyFile") }
        else { preferences.removeObject(forKey: "setupReplyFile") }
        guard preferences.synchronize() else { throw OnboardingJournalError.invalidJournal }
    }
    private func finishCreation(_ result: Result<CreatedProfile, Error>) {
        creatingProfile = false
        switch result {
        case .success(let created):
            do {
                guard let pending = try onboardingJournal.load(), pending.plan.profile == created.profile,
                      pending.plan.agentID == created.agentID else { throw OnboardingJournalError.invalidJournal }
                // Keep recovery until selection and next steps have reached persistent preferences.
                try persistCreatedSelection(created)
                try onboardingJournal.clear(pending)
                refreshSavedSetup()
                showCreateProfileSheet = false
                bind(created.profile, expectedAgent: created.agentID)
                operationMessage = L10n.text("Profile created; connection has not been checked yet")
                if let reply = created.reply {
                    pairingMode = .join; showPairingSheet = true
                    pairingInput = ""; pairingOutput = reply
                    copyPairingLine()
                } else if inviteAfterCreation {
                    inviteAfterCreation = false
                    // Open the next sheet only after the creation sheet closes.
                    openCreatedInvitation = true
                }
            } catch {
                creationError = error.localizedDescription; refreshSavedSetup()
                showCreateProfileSheet = false
                // A failed cleanup sync may follow an already successful unlink.
                // The verified profile and persisted selection still exist: show
                // them instead of reopening a creation form after that partial success.
                if !hasPendingSetup, UserDefaults.standard.string(forKey: "profileDirectory") == created.profile.dataDirectory {
                    bind(created.profile, expectedAgent: created.agentID)
                    operationMessage = L10n.text("Profile created; connection has not been checked yet")
                    operationError = error.localizedDescription
                }
            }
        case .failure(let error):
            creationError = PairingError.message(for: error)
            pairingError = creationError
            refreshSavedSetup()
        }
        if hasPendingSetup { showCreateProfileSheet = false; showPairingSheet = false }
    }
    private func restoreSetup(for profile: ProfileBinding) {
        setupAgentID = nil; setupReplyFile = nil
        let preferences = UserDefaults.standard
        guard preferences.string(forKey: "setupProfileDirectory") == profile.dataDirectory,
              let id = preferences.string(forKey: "setupAgentID"),
              id.range(of: "\\A[A-Za-z0-9][A-Za-z0-9_-]{0,127}\\z", options: .regularExpression) != nil else { return }
        setupAgentID = id
        if let path = preferences.string(forKey: "setupReplyFile"),
           path.hasPrefix(applicationDirectory.appendingPathComponent("replies").path + "/"),
           URL(fileURLWithPath: path).standardizedFileURL.path == path,
           let values = try? URL(fileURLWithPath: path).resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
           values.isRegularFile == true, values.isSymbolicLink != true { setupReplyFile = URL(fileURLWithPath: path) }
    }
    func showReplyFile() {
        guard let setupReplyFile else { return }
        NSWorkspace.shared.activateFileViewerSelecting([setupReplyFile])
    }
    func startNewProfile() {
        guard canStartNewProfile, let client, let agentID else { return }
        operating = true; operationError = nil; operationMessage = nil
        let selected = selectionID
        Task {
            let result = await Task.detached { () -> Result<ControlReceipt, Error> in
                Result { try client.installAndStart(expectedAgent: agentID) }
            }.value
            guard selected == selectionID else { return }
            switch result {
            case .success: operationMessage = L10n.text("Start requested. Status shows whether Murmur is running")
            case .failure(let error): operationError = error.localizedDescription
            }
            operating = false; status = nil
            statusError = Verdict(.unknown, reason: L10n.text("Checking status after the command…"))
            refreshStatus()
        }
    }
    func hideSetupSteps() {
        guard !busy, status?.service.isRunning == true else { return }
        setupAgentID = nil; setupReplyFile = nil; operationMessage = nil
        for key in ["setupProfileDirectory", "setupAgentID", "setupReplyFile"] { UserDefaults.standard.removeObject(forKey: key) }
    }

    private var aiSetupClient: ClientSetupClient? {
        guard let profile, let executable = CLIProbe.locate() else { return nil }
        return ClientSetupClient(executable: executable, profile: profile)
    }
    func detectAIClients() {
        guard !busy, !isDemo, let helper = aiSetupClient, let agent = agentID, status != nil else { return }
        let selected = selectionID
        configuringAI = true; aiSetupError = nil
        Task {
            let result = await Task.detached { Result { try helper.detect(expectedAgent: agent) } }.value
            guard selected == selectionID else { return }
            configuringAI = false
            switch result {
            case .success(let choices): aiClients = choices
            case .failure: aiClients = []; aiSetupError = L10n.text("Could not find your AI applications. Check the connection settings and try again.")
            }
        }
    }
    func connectAIClient(_ kind: AIClientKind) {
        guard !busy, !isDemo, let helper = aiSetupClient, let agent = agentID, status != nil else { return }
        let selected = selectionID
        configuringAI = true; aiSetupError = nil
        Task {
            defer { if selected == selectionID { configuringAI = false } }
            do {
                let plan = try await Task.detached { try helper.preview(kind, expectedAgent: agent) }.value
                guard selected == selectionID else { return }
                let alert = NSAlert()
                alert.messageText = L10n.text(plan.action == .replace ? "Replace the Murmur connection in %@?" : "Connect %@ to Murmur?", kind.title)
                alert.informativeText = L10n.text("This connects %@ using the selected Murmur settings. Your sign-in, model choices and other connections are kept. An existing file is backed up before a change. Reload the AI application afterwards.", agent)
                    + "\n\n" + plan.configPath
                if plan.action == .replace {
                    alert.informativeText += "\n\n" + L10n.text("This application already has a different Murmur connection. Replacing it switches which connection its assistant uses.")
                }
                alert.addButton(withTitle: L10n.text(plan.action == .replace ? "Replace Murmur connection" : "Connect application"))
                alert.addButton(withTitle: L10n.text("Cancel"))
                guard alert.runModal() == .alertFirstButtonReturn else { return }
                aiReceipt = nil; resetReplyTest()
                let receipt = try await Task.detached { try helper.configure(plan, expectedAgent: agent) }.value
                guard selected == selectionID else { return }
                aiReceipt = receipt
                resetReplyTest()
            } catch {
                guard selected == selectionID else { return }
                aiSetupError = L10n.text("The change could not be confirmed. Settings may have changed while this window was open. Choose the application again to review its current settings; nothing is retried automatically.")
            }
        }
    }
    func prepareReplyTest(peer: String) {
        guard !busy, !isDemo, let helper = aiSetupClient, let agent = agentID,
              status?.peers.list?.contains(where: { $0.agentId == peer }) == true else { return }
        let selected = selectionID
        resetReplyTest(); configuringAI = true
        Task {
            let result = await Task.detached { Result { try helper.prepareTest(peerID: peer, expectedAgent: agent) } }.value
            guard selected == selectionID else { return }
            configuringAI = false
            switch result {
            case .success(let plan): replyPlan = plan
            case .failure: replyError = L10n.text("Could not prepare the test. Refresh the connection and check that the other participant has been added.")
            }
        }
    }
    func copyReplyTestPrompt() {
        guard let plan = replyPlan else { return }
        NSPasteboard.general.clearContents()
        testPromptCopied = NSPasteboard.general.setString(plan.prompt, forType: .string)
    }
    func watchReplyTest() {
        guard replyPlan != nil, !isDemo, !watchingReply else { return }
        watchingReply = true
        checkReplyTest()
        replyTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.checkReplyTest() }
        }
    }
    func checkReplyTest() {
        guard !checkingReply, !configuringAI, !isDemo, let plan = replyPlan, let helper = aiSetupClient, let agent = agentID else { return }
        let selected = selectionID
        checkingReply = true; replyError = nil
        Task {
            let result = await Task.detached { Result { try helper.checkTest(plan, expectedAgent: agent) } }.value
            guard selected == selectionID, replyPlan?.token == plan.token else { return }
            checkingReply = false
            switch result {
            case .success(let observation):
                replyObservation = observation
                if observation.state == .replied || observation.state == .expired { stopWatchingReply() }
            case .failure:
                replyError = L10n.text("The test result is unavailable. Keep both assistants open, check Murmur is running, then try checking again.")
                stopWatchingReply()
            }
        }
    }
    func stopWatchingReply() {
        replyTimer?.invalidate(); replyTimer = nil; watchingReply = false
    }
    func resetReplyTest() {
        stopWatchingReply(); replyPlan = nil; replyObservation = nil; replyError = nil; checkingReply = false; testPromptCopied = false
    }

    var verdict: Verdict {
        if isDemo {
            return Verdict(demoState, unread: demoState == .unread,
                           reason: L10n.text("Demo — %@", String(describing: (demoState.title.lowercased()))))
        }
        return status?.verdict() ?? statusError
    }

    func refreshStatus() {
        guard !checkingStatus, !checkingSelection, !configuringAI, !operating, !isDemo, let client else { return }
        let selected = selectionID
        let expectedAgent = agentID
        checkingStatus = true
        Task {
            let result = await Task.detached {
                client.readProfileStatus(expectedAgent: expectedAgent)
            }.value
            guard selected == selectionID else { return }
            // Publish only a validated observation. A rejected identity supplies
            // no snapshot/counters and keeps the previous binding until reselect.
            status = result.status
            agentID = result.agentID
            statusError = result.error ?? Verdict(.unknown, reason: L10n.text("Status has not been received yet"))
            profileError = result.error?.reason
            checkingStatus = false
        }
    }

    // A doctor roundtrip is active traffic: startup or explicit button only.
    func refreshDoctor() {
        guard !checkingDoctor, !operating, !isDemo, let client else { return }
        let selected = selectionID
        checkingDoctor = true
        Task {
            let result = await Task.detached { () -> DoctorRead in
                do {
                    return DoctorRead(value: try client.readDoctor(), error: nil)
                } catch { return DoctorRead(value: nil, error: error.localizedDescription) }
            }.value
            guard selected == selectionID else { return }
            doctor = result.value
            doctorError = result.error
            checkingDoctor = false
        }
    }

    func perform(_ action: ControlAction) {
        guard canControl, let client, let agentID else { return }
        operating = true; operationError = nil; operationMessage = nil
        doctor = nil; doctorError = L10n.text("Run diagnostics again after making changes")
        let selected = selectionID
        Task {
            let result = await Task.detached { () -> Result<ControlReceipt, Error> in
                Result { try client.perform(action, expectedAgent: agentID) }
            }.value
            guard selected == selectionID else { return }
            switch result {
            case .success(let receipt): operationMessage = receipt.message
            case .failure(let error): operationError = error.localizedDescription
            }
            // Do not turn configuration acknowledgement into effective runtime state.
            // Refresh after errors too: a timed-out mutation may already have applied.
            status = nil
            statusError = Verdict(.unknown, reason: L10n.text("Checking status after the command…"))
            operating = false
            refreshStatus()
        }
    }

    func wakeState(_ value: Bool?) -> String {
        value.map { $0 ? L10n.text("agent delivery enabled") : L10n.text("agent delivery paused") } ?? L10n.text("not measured")
    }

    func setOutboxDismissed(_ item: OutboxAttentionItem, dismissed: Bool) {
        guard canControl, let client, let agentID else { return }
        operating = true; operationError = nil; operationMessage = nil
        let selected = selectionID
        Task {
            let result = await Task.detached { () -> Result<Void, Error> in
                Result { try client.setOutboxDismissed(item, dismissed: dismissed, expectedAgent: agentID) }
            }.value
            guard selected == selectionID else { return }
            switch result {
            case .success:
                operationMessage = L10n.text(dismissed ? "Warning dismissed. Message history was kept; nothing was resent." : "Warning restored. Message history is unchanged.")
            case .failure(let error): operationError = error.localizedDescription
            }
            operating = false
            refreshStatus()
        }
    }

    func openLogs() {
        guard canControl, let client, let agentID else { return }
        operating = true; operationError = nil; operationMessage = nil
        let selected = selectionID
        Task {
            let result = await Task.detached { () -> Result<URL, Error> in
                Result { try client.logDirectory(expectedAgent: agentID) }
            }.value
            guard selected == selectionID else { return }
            operating = false
            switch result {
            case .success(let directory):
                if !NSWorkspace.shared.open(directory) { operationError = L10n.text("Could not open the log folder") }
            case .failure(let error): operationError = error.localizedDescription
            }
        }
    }

    func copyDiagnostics() {
        // Copy an allowlisted summary, not arbitrary CLI fields/error output.
        var lines = ["Murmur macOS spike", "mode=\(isDemo ? "demo" : "CLI")", verdict.reason]
        lines += JournalSyncDiagnostics.lines()
        if let status { lines.append("schema=\(status.schema); generatedAt=\(status.generatedAt)") }
        if let doctor {
            lines.append("doctor=\(doctor.schema); generatedAt=\(doctor.generatedAt)")
            lines += doctor.rows().map { "\($0.id): \($0.state)" }
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(lines.joined(separator: "\n"), forType: .string)
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        operationError = nil
        do {
            if enabled { try SMAppService.mainApp.register() }
            else { try SMAppService.mainApp.unregister() }
            launchAtLogin = SMAppService.mainApp.status == .enabled
            if SMAppService.mainApp.status == .requiresApproval {
                operationError = L10n.text("Launch at login needs approval in macOS settings")
                SMAppService.openSystemSettingsLoginItems()
            }
        } catch { operationError = error.localizedDescription }
    }

    var icon: NSImage {
        MurmurMark.image(state: MarkState(indicator: verdict.indicator), unread: verdict.unread,
                         update: updateAvailable, description: accessibleStatus)
    }
}
