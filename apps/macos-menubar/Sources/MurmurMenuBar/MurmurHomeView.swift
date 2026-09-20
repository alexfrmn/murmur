import AppKit
import SwiftUI
import MurmurTrayCore

struct MurmurHomeView: View {
    @ObservedObject var model: TrayModel

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Image(nsImage: MurmurMark.image(state: .ready, size: 40, description: "Murmur"))
                    .accessibilityHidden(true)
                Text(model.isDemo ? L10n.text("Murmur — demo") : "Murmur")
                    .font(.system(size: 25, weight: .semibold))
                Spacer()
                Menu { preferences } label: { Image(systemName: "gearshape") }
                    .menuStyle(.borderlessButton).fixedSize()
                    .accessibilityLabel(L10n.text("Settings"))
            }.padding(24)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if model.hasPendingSetup {
                        savedSetup
                    } else if model.profile == nil && !model.isDemo {
                        firstRun
                    } else {
                        profileContent
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(24)
            }
            Divider()
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.shortcutAvailable ? L10n.text("Open or hide: ⌃⌥⌘M") : L10n.text("Shortcut unavailable. Open Murmur from Finder."))
                    Text(L10n.text("Right-click the menu bar icon for quick actions."))
                }.font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button(L10n.text("Quit")) { NSApp.terminate(nil) }.keyboardShortcut("q")
            }.padding(16)
        }.sheet(isPresented: $model.showCreateProfileSheet) { CreateProfileSheet(model: model) }
    }

    private var firstRun: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L10n.text("Connect your agents")).font(.title2.weight(.semibold))
            Text(L10n.text("Join with an invitation, or create a profile for your own server."))
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if model.preparingRuntime {
                ProgressView(L10n.text("Checking the Murmur engine…"))
            } else if let error = model.runtimeError {
                Text(error).foregroundStyle(.red).textSelection(.enabled)
                Button(L10n.text("Try again")) { model.prepareRuntime() }
            } else {
                if model.creatingProfile {
                    ProgressView(L10n.text("Creating your profile…"))
                } else if model.needsExistingProfileChoice {
                    Text(model.requiresRecoveryChoice ? L10n.text("Choose how to continue") : L10n.text("Profiles already on this Mac")).font(.headline)
                    Text(model.requiresRecoveryChoice ? L10n.text("The saved record was reset. The earlier setup outcome is still unknown. Choose an existing profile or create a separate one.") : L10n.text("Choose an existing profile to continue. These folders may contain profiles from an earlier setup attempt."))
                        .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    ForEach(model.savedProfiles, id: \.dataDirectory) { profile in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(profile.dataDirectory).font(.caption).textSelection(.enabled)
                            Button(L10n.text("Choose this profile")) { model.chooseSavedProfile(profile) }.disabled(model.busy)
                        }
                    }
                    if model.requiresRecoveryChoice {
                        Button(L10n.text("Choose profile folder…")) { model.chooseProfile() }.disabled(model.busy)
                        if model.archivedSetupRecord != nil {
                            Button(L10n.text("Show saved record copy")) { model.showArchivedSetupRecord() }.disabled(model.busy)
                        }
                    }
                    Button(L10n.text("Create a separate profile…")) { model.allowNewSeparateProfile() }.disabled(model.busy)
                } else {
                    Button(L10n.text("I have an invitation…")) { model.useInvitation() }
                        .buttonStyle(.borderedProminent).controlSize(.large)
                        .disabled(model.busy).keyboardShortcut(.defaultAction)
                    Button(L10n.text("Create a profile for my server…")) { model.beginOwnProfile() }
                        .disabled(model.busy)
                    Text(L10n.text("No invitation yet? Ask someone in your team to send one."))
                        .font(.callout).foregroundStyle(.secondary)
                    Divider()
                    Button(L10n.text("Already configured? Choose a profile folder…")) { model.chooseProfile() }
                        .buttonStyle(.link).disabled(model.busy)
                }
                if let error = model.creationError { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            }
        }.padding(.vertical, 24)
    }

    private var savedSetup: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(model.pendingTitle).font(.title2.weight(.semibold))
            if let pending = model.pendingCreation {
                Text(pending.plan.agentID).font(.headline)
                Text(pending.plan.profile.dataDirectory).font(.caption).textSelection(.enabled)
                if pending.kind == .invitation {
                    Text(L10n.text("Reply file: %@", pending.plan.replyFile.path)).font(.caption).textSelection(.enabled)
                }
                if model.pendingCanRetryCreation {
                    Text(L10n.text("No profile or reply files were found. You can try the setup again."))
                        .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Button(L10n.text("Try setup again")) { model.discardEmptySetup() }.disabled(model.busy)
                } else {
                    Text(L10n.text("Your files were kept. Check this same profile to continue; no new identity will be created."))
                        .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Button(model.creatingProfile ? L10n.text("Checking…") : L10n.text("Check saved profile and continue")) {
                        model.resumeSavedSetup()
                    }.buttonStyle(.borderedProminent).disabled(model.busy || model.runtimeError != nil)
                }
            }
            if let error = model.savedSetupError { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if let error = model.creationError { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            Button(L10n.text("Show saved files")) { model.showSavedSetupFiles() }.disabled(model.busy)
            if model.canResetSavedSetup {
                Button(L10n.text("Reset saved setup record…")) { model.resetSavedSetupRecord() }.buttonStyle(.link)
            }
        }.padding(.vertical, 24)
    }

    private var profileContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label(model.verdict.reason, systemImage: model.verdict.indicator.symbol)
                .font(.headline).fixedSize(horizontal: false, vertical: true)
            if let profile = model.profile {
                Text(model.agentID ?? L10n.text("Checking the selected profile…"))
                Text(profile.dataDirectory).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                if let service = profile.serviceName { Text(L10n.text("Service: %@", service)).font(.caption) }
            }
            if model.hasSetupSteps { setupSteps }
            if let mismatch = model.status?.modeMismatch { Text(mismatch) }
            if let error = model.operationError { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if let message = model.operationMessage { Text(message) }
            if let count = model.status?.inbox.unread { Text(L10n.text("Unread: %@", String(count))) }
            if let count = model.status?.wake.delivery.pendingUndelivered {
                Text(L10n.text("Waiting for agent delivery: %@", String(count)))
            }
            HStack {
                Button(L10n.text("Choose profile folder…")) { model.chooseProfile() }
                    .disabled(model.busy || model.isDemo || model.runtimeError != nil)
                Button(model.checkingStatus ? L10n.text("Refreshing…") : L10n.text("Refresh status")) { model.refreshStatus() }
                    .disabled(model.busy || model.isDemo)
            }
            if model.isDemo {
                Picker(L10n.text("Preview states"), selection: $model.demoState) {
                    ForEach(Indicator.allCases, id: \.self) { Text($0.title).tag($0) }
                }
            }
            if model.updateAvailable {
                Button(L10n.text("Murmur update available")) { model.openUpdateRelease() }.disabled(model.isDemo)
            }
            DisclosureGroup(L10n.text("Service")) { service.padding(.top, 10) }
            DisclosureGroup(L10n.text("Diagnostics")) { diagnostics.padding(.top, 10) }
            DisclosureGroup(L10n.text("Murmur updates")) { updateDetails.padding(.top, 10) }
        }
    }


    private var setupSteps: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n.text("Next steps")).font(.headline)
            if model.setupReplyFile != nil {
                Text(L10n.text("Send the reply file to the person who invited you so they can finish pairing."))
                    .fixedSize(horizontal: false, vertical: true)
                Button(L10n.text("Show reply file")) { model.showReplyFile() }.disabled(model.busy)
            }
            if model.status?.service.state == .running {
                Text(L10n.text("Murmur is running. Check the connection after exchanging reply files."))
                    .fixedSize(horizontal: false, vertical: true)
                Button(L10n.text("Check connection")) { model.refreshDoctor(); model.refreshStatus() }
                    .disabled(model.busy || !model.canControl)
            } else {
                Text(L10n.text("Start Murmur to keep delivery running when this window is closed."))
                    .fixedSize(horizontal: false, vertical: true)
                Button(model.operating ? L10n.text("Working…") : L10n.text("Start Murmur on this Mac")) { model.startNewProfile() }
                    .buttonStyle(.borderedProminent).disabled(!model.canStartNewProfile)
            }
            if model.status?.service.state == .running {
                Button(L10n.text("Hide setup steps")) { model.hideSetupSteps() }
                    .buttonStyle(.link).font(.caption).disabled(model.busy)
            }
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }

    private var service: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let enabled = model.status?.wake.config.enabled { Text(L10n.text("Configured: %@", model.wakeState(enabled))) }
            if let enabled = model.status?.wake.effective.enabled { Text(L10n.text("Effective now: %@", model.wakeState(enabled))) }
            if model.status?.wake.effective.needsRestart == true { Text(L10n.text("Restart the service to apply this setting")) }
            if let reason = model.controlBlockReason { Text(reason).font(.caption).foregroundStyle(.secondary) }
            if model.status?.wake.config.enabled != nil {
                Button(model.operating ? L10n.text("Working…") : model.wakeAction.title) { model.perform(model.wakeAction) }
                    .disabled(!model.canControl)
            }
            HStack {
                Button(L10n.text("Start")) { model.perform(.start) }.disabled(!model.canControl)
                Button(L10n.text("Stop")) { model.perform(.stop) }.disabled(!model.canControl)
                Button(L10n.text("Open configured log folder")) { model.openLogs() }.disabled(!model.canControl)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private var diagnostics: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let doctor = model.doctor {
                ForEach(doctor.rows()) { row in
                    Label("\(row.title): \(row.detail)", systemImage: row.symbol)
                }
                Text(L10n.text("Checked: %@", doctor.generatedAt)).font(.caption)
            } else if let error = model.doctorError { Text(error) }
            if let status = model.status {
                ForEach(status.diagnosticNotes.filter { $0 != status.modeMismatch }, id: \.self) { Text($0) }
            }
            HStack {
                Button(model.checkingDoctor ? L10n.text("Checking…") : L10n.text("Check now")) {
                    model.refreshDoctor(); model.refreshStatus()
                }.disabled(model.busy || model.isDemo)
                Button(L10n.text("Copy diagnostics")) { model.copyDiagnostics() }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private var updateDetails: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let updates = model.updates {
                Text(updates.title())
                Text(L10n.text("Product version: %@", updates.currentVersion ?? L10n.text("unknown.version")))
                Text(updates.reasonText)
                Text(L10n.text("Last attempt: %@", updates.checkedAt ?? L10n.text("not-measured.time")))
                Text(updates.ageText())
                Text(L10n.text("Last successful check: %@", updates.lastSuccessAt ?? L10n.text("not-measured.time")))
                if let next = updates.nextCheckAt { Text(L10n.text("Next check no earlier than: %@", next)) }
                if updates.stale { Text(L10n.text("The previous successful result is stale")) }
            } else { Text(L10n.text("Updates: result unknown")) }
            if model.checkingUpdates { Text(L10n.text("Checking for updates…")) }
            if let error = model.updateError { Text(error) }
            if model.updateAvailable { Button(L10n.text("Open release page")) { model.openUpdateRelease() }.disabled(model.isDemo) }
        }.font(.caption).frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var preferences: some View {
        Menu(L10n.text("Language")) {
            ForEach(AppLanguage.allCases, id: \.self) { language in
                Button { model.selectLanguage(language) } label: {
                    if model.language == language { Label(language.name, systemImage: "checkmark") }
                    else { Text(language.name) }
                }.disabled(model.busy || model.checkingUpdates)
            }
        }
        Toggle(L10n.text("Launch at login"), isOn: Binding(
            get: { model.launchAtLogin }, set: { model.setLaunchAtLogin($0) }
        )).disabled(model.isDemo)
        Menu(L10n.text("Murmur updates")) {
            Text(L10n.text("Checks every 6 hours; cache shared by this user"))
            Text(L10n.text("GitHub receives your IP address and sees that you use Murmur"))
            if model.updatesForcedOff { Text(L10n.text("Checks are blocked by MURMUR_UPDATE_CHECK=0")) }
            Button(L10n.text("Enable update checks")) { model.refreshUpdates(enabled: true) }
                .disabled(!model.canChangeUpdates || model.updatesForcedOff)
            Button(L10n.text("Disable update checks")) { model.refreshUpdates(enabled: false) }
                .disabled(!model.canChangeUpdates)
        }
    }
}
