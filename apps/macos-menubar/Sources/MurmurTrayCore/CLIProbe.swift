import Foundation
import Darwin

/// CLI transport. `doctor` can send a roundtrip: callers must never poll it.
/// A successful process exit or JSON parse alone is not a health verdict.
public struct CLIProbe: Sendable {
    public let executable: URL
    public let timeout: TimeInterval
    public let profile: ProfileBinding?
    private let environment: [String: String]

    public init(executable: URL, timeout: TimeInterval = 5, profile: ProfileBinding? = nil,
                environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.executable = executable
        self.timeout = timeout
        self.profile = profile
        self.environment = environment
    }

    public static func locate(environment: [String: String] = ProcessInfo.processInfo.environment) -> URL? {
        // A distributed app always uses its own immutable engine, not a different global install.
        if let bundled = BundledRuntime.cli() { return bundled }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [environment["MURMUR_BIN"], environment["MURMUR_CLI"], "/opt/homebrew/bin/murmur",
                          "/usr/local/bin/murmur", "\(home)/.local/bin/murmur"].compactMap { $0 }
        return candidates.first(where: {
            var directory: ObjCBool = false
            return $0.hasPrefix("/") && FileManager.default.fileExists(atPath: $0, isDirectory: &directory)
                && !directory.boolValue && FileManager.default.isExecutableFile(atPath: $0)
        })
            .map { URL(fileURLWithPath: $0) }
    }

    public func run(_ command: String) throws -> ProbeSummary {
        guard command == "status" || command == "doctor" else { throw ProfileError.unsupportedCommand }
        return try invoke([command])
    }

    // Mutating argv comes from identity-checked ProfileClient or an explicit NewProfilePlan.
    func invoke(_ arguments: [String], input: Data? = nil, pairingErrors: Bool = false) throws -> ProbeSummary {
        if let input, input.count > PairingLine.maximumBytes { throw PairingError.tooLarge }
        guard timeout.isFinite, timeout > 0, timeout <= 60 else { throw ProfileError.invalidTimeout }
        guard executable.isFileURL, executable.path.hasPrefix("/") else { throw ProfileError.invalidCLI }
        let fm = FileManager.default
        let directory = fm.temporaryDirectory.appendingPathComponent("murmur-probe-\(UUID().uuidString)")
        try fm.createDirectory(at: directory, withIntermediateDirectories: false,
                               attributes: [.posixPermissions: 0o700])
        defer { try? fm.removeItem(at: directory) }
        let stdout = directory.appendingPathComponent("stdout")
        let stderr = directory.appendingPathComponent("stderr")
        fm.createFile(atPath: stdout.path, contents: nil, attributes: [.posixPermissions: 0o600])
        fm.createFile(atPath: stderr.path, contents: nil, attributes: [.posixPermissions: 0o600])
        let out = try FileHandle(forWritingTo: stdout)
        let err = try FileHandle(forWritingTo: stderr)
        defer { try? out.close(); try? err.close() }

        let process = Process()
        process.executableURL = executable
        process.arguments = arguments + ["--json"] + (profile?.arguments ?? [])
        process.currentDirectoryURL = URL(fileURLWithPath: "/")
        let stdin = input == nil ? nil : Pipe()
        process.standardInput = stdin?.fileHandleForReading ?? FileHandle.nullDevice
        process.standardOutput = out
        process.standardError = err
        // No shell; GUI launches must not depend on an interactive shell PATH.
        let inherited = ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]
        var childEnvironment = environment.filter { inherited.contains($0.key) }
        // Client routing belongs to the shared detector. Preserve explicit custom
        // homes for this command family so the GUI cannot silently write defaults.
        // Never inherit credentials, NODE_OPTIONS or arbitrary runtime overrides.
        if arguments.first == "clients" {
            for key in ["CODEX_HOME", "CLAUDE_CONFIG_DIR"] {
                if let value = environment[key] { childEnvironment[key] = value }
            }
        }
        // Preserve only the documented opt-out, never an opt-in or arbitrary value.
        if environment["MURMUR_UPDATE_CHECK"] == "0" { childEnvironment["MURMUR_UPDATE_CHECK"] = "0" }
        childEnvironment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        process.environment = childEnvironment
        try process.run()
        if let stdin, let input {
            // Never put Invitations in argv or a file. A non-reading child must
            // still time out; suppress SIGPIPE if it exits before reading.
            try? stdin.fileHandleForReading.close()
            let writer = stdin.fileHandleForWriting
            _ = fcntl(writer.fileDescriptor, F_SETNOSIGPIPE, 1)
            DispatchQueue.global().async {
                defer { try? writer.close() }
                try? writer.write(contentsOf: input)
            }
        }
        let deadline = Date().addingTimeInterval(timeout)
        let limit = 256 * 1024
        var failure: ProbeError?
        while process.isRunning {
            if Date() >= deadline { failure = .timedOut; break }
            let sizes = [stdout, stderr].map { (try? fm.attributesOfItem(atPath: $0.path)[.size] as? Int) ?? 0 }
            if sizes.contains(where: { $0 > limit }) { failure = .outputLimit; break }
            Thread.sleep(forTimeInterval: 0.025)
        }
        if process.isRunning {
            process.terminate()
            let killDeadline = Date().addingTimeInterval(0.25)
            while process.isRunning && Date() < killDeadline { Thread.sleep(forTimeInterval: 0.01) }
            if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
        }
        process.waitUntilExit()
        if let failure { throw failure }
        let size = (try fm.attributesOfItem(atPath: stdout.path)[.size] as? Int) ?? 0
        let errorSize = (try fm.attributesOfItem(atPath: stderr.path)[.size] as? Int) ?? 0
        guard size <= limit, errorSize <= limit else { throw ProbeError.outputLimit }
        if process.terminationStatus != 0 {
            if pairingErrors {
                // Only stable codes affect presentation. Never show raw stderr,
                // JSON, or a pasted Invitation in a pairing window.
                let text = String(data: try Data(contentsOf: stderr), encoding: .utf8) ?? ""
                throw PairingError.from(code: text.split(whereSeparator: \.isNewline).last.map(String.init), command: arguments.first)
            }
            let errorText = String(data: try Data(contentsOf: stderr), encoding: .utf8) ?? ""
            let firstLine = errorText.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
            // CLI promises a human-readable reason. Keep a bounded single line,
            // suppressing obvious credentials/URLs rather than copying a trace.
            let containsCredential = firstLine.range(of: "(?i)(authorization|token|secret|password|api[_ -]?key|bearer|://)", options: .regularExpression) != nil
            let clean = String(String(firstLine.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }).prefix(180))
            if !clean.isEmpty && !containsCredential { throw ProbeError.failedWithReason(process.terminationStatus, clean) }
            throw ProbeError.failed(process.terminationStatus)
        }
        let data = try Data(contentsOf: stdout)
        guard let object = try? JSONSerialization.jsonObject(with: data), object is [String: Any] else {
            throw ProbeError.invalidJSON
        }
        return ProbeSummary(command: arguments.joined(separator: " "), byteCount: data.count, exitCode: process.terminationStatus, data: data)
    }
}
