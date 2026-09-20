import Foundation
import Darwin

public enum RuntimeError: Error, LocalizedError, Sendable {
    case missingNode(String), incompleteBundle, invalidPolicy, cannotLaunch

    public var errorDescription: String? {
        switch self {
        case .missingNode(let minimum): "Для Murmur нужен Node.js \(minimum) или новее. Установите актуальную LTS-версию с nodejs.org, затем нажмите «Проверить снова»."
        case .incompleteBundle: "В приложении не хватает файлов движка. Загрузите Murmur заново и перенесите приложение в папку «Программы»."
        case .invalidPolicy: "Не удалось прочитать требования движка к Node.js. Загрузите Murmur заново."
        case .cannotLaunch: "Не удалось запустить Node.js. Проверьте его установку и откройте Murmur снова."
        }
    }
}

/// The shipped engine owns the minimum; the Mac companion never declares another one.
public struct NodeRequirement: Sendable {
    public let minimumVersion: String
    private let minimum: [Int]

    public init(runtimeDirectory: URL) throws {
        struct Package: Decodable { struct Engines: Decodable { let node: String }; let engines: Engines }
        let path = runtimeDirectory.appendingPathComponent("package.json")
        guard let size = try? FileManager.default.attributesOfItem(atPath: path.path)[.size] as? Int,
              size > 0, size <= 65_536,
              let data = try? Data(contentsOf: path), let package = try? JSONDecoder().decode(Package.self, from: data),
              package.engines.node.hasPrefix(">="),
              let parsed = Self.components(String(package.engines.node.dropFirst(2))) else { throw RuntimeError.invalidPolicy }
        minimumVersion = String(package.engines.node.dropFirst(2))
        minimum = parsed
    }

    private static func components(_ version: String) -> [Int]? {
        guard version.range(of: "\\A[0-9]+\\.[0-9]+\\.[0-9]+\\z", options: .regularExpression) != nil else { return nil }
        let numbers = version.split(separator: ".").compactMap { Int($0) }
        return numbers.count == 3 ? numbers : nil
    }

    public func supports(version: String) -> Bool {
        guard let current = Self.components(version) else { return false }
        return !current.lexicographicallyPrecedes(minimum)
    }
}

/// The app is read-only: no node binding, generated wrapper, or installation in its bundle.
public enum BundledRuntime {
    public static func cli(in bundle: Bundle = .main) -> URL? {
        let helper = bundle.bundleURL.appendingPathComponent("Contents/MacOS/murmur")
        // A damaged distributed bundle must not silently switch to a global engine.
        if bundle.bundleIdentifier == "org.murmur.mac" { return helper }
        return FileManager.default.isExecutableFile(atPath: helper.path) ? helper : nil
    }

    public static func runtime(for helper: URL) throws -> URL {
        guard FileManager.default.isExecutableFile(atPath: helper.path) else { throw RuntimeError.incompleteBundle }
        let root = helper.resolvingSymlinksInPath().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Resources/runtime")
        let required = ["package.json", "scripts/runtime-capability.mjs", "packages/setup/bin/murmur.mjs", "packages/setup/dist/src/cli.js",
                        "packages/mcp-server/dist/src/index.js", "scripts/murmur-daemon.mjs"]
        guard required.allSatisfy({ FileManager.default.fileExists(atPath: root.appendingPathComponent($0).path) }) else {
            throw RuntimeError.incompleteBundle
        }
        return root
    }

    public static func cleanEnvironment(_ environment: [String: String]) -> [String: String] {
        let allowed = ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]
        var clean = environment.filter { allowed.contains($0.key) }
        clean["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        if environment["MURMUR_UPDATE_CHECK"] == "0" { clean["MURMUR_UPDATE_CHECK"] = "0" }
        return clean
    }

    public static func nodeCandidates(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> [URL] {
        var paths = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node",
                     home.appendingPathComponent(".volta/bin/node").path,
                     home.appendingPathComponent(".local/share/fnm/aliases/default/bin/node").path,
                     home.appendingPathComponent(".nvm/current/bin/node").path]
        // Finder does not load shell startup files. Inspect known version-manager locations.
        for relative in [".nvm/versions/node", ".local/share/fnm/node-versions", "Library/Application Support/fnm/node-versions"] {
            let directory = home.appendingPathComponent(relative)
            let names = ((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? [])
                .filter { $0.range(of: "\\Av[0-9]+\\.[0-9]+\\.[0-9]+\\z", options: .regularExpression) != nil }
                .sorted { $0.compare($1, options: .numeric) == .orderedDescending }.prefix(20)
            for name in names {
                let suffix = relative.contains("fnm") ? "installation/bin/node" : "bin/node"
                paths.append(directory.appendingPathComponent(name).appendingPathComponent(suffix).path)
            }
        }
        return paths.map { URL(fileURLWithPath: $0) }
    }

    /// Bounded probe; a successful executable alone is not a supported Node installation.
    public static func findNode(runtime: URL, candidates: [URL]? = nil,
                                environment: [String: String] = ProcessInfo.processInfo.environment,
                                timeout: TimeInterval = 4) throws -> URL {
        let policy = try NodeRequirement(runtimeDirectory: runtime)
        guard timeout.isFinite, timeout > 0, timeout <= 10 else { throw RuntimeError.missingNode(policy.minimumVersion) }
        let deadline = Date().addingTimeInterval(timeout)
        let home = environment["HOME"].flatMap { $0.hasPrefix("/") && $0 != "/" ? URL(fileURLWithPath: $0) : nil }
            ?? FileManager.default.homeDirectoryForCurrentUser
        for candidate in candidates ?? nodeCandidates(home: home) {
            if Date() >= deadline { break }
            guard candidate.isFileURL, candidate.path.hasPrefix("/"),
                  FileManager.default.isExecutableFile(atPath: candidate.path) else { continue }
            if let node = try? probeNode(candidate, policy: policy, environment: environment,
                                         deadline: min(deadline, Date().addingTimeInterval(1))) { return node }
        }
        throw RuntimeError.missingNode(policy.minimumVersion)
    }

    private static func probeNode(_ candidate: URL, policy: NodeRequirement,
                                  environment: [String: String], deadline: Date) throws -> URL {
        let fm = FileManager.default
        let directory = fm.temporaryDirectory.appendingPathComponent("murmur-node-\(UUID().uuidString)")
        try fm.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? fm.removeItem(at: directory) }
        let output = directory.appendingPathComponent("stdout")
        fm.createFile(atPath: output.path, contents: nil, attributes: [.posixPermissions: 0o600])
        let handle = try FileHandle(forWritingTo: output)
        defer { try? handle.close() }
        let process = Process()
        process.executableURL = candidate
        process.arguments = ["-p", "JSON.stringify({executable:process.execPath,version:process.versions.node})"]
        process.environment = cleanEnvironment(environment)
        process.currentDirectoryURL = URL(fileURLWithPath: "/")
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = handle; process.standardError = FileHandle.nullDevice
        try process.run()
        while process.isRunning && Date() < deadline {
            if ((try? fm.attributesOfItem(atPath: output.path)[.size] as? Int) ?? 0) > 8192 { break }
            Thread.sleep(forTimeInterval: 0.01)
        }
        if process.isRunning {
            process.terminate()
            let grace = Date().addingTimeInterval(0.1)
            while process.isRunning && Date() < grace { Thread.sleep(forTimeInterval: 0.01) }
            if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
            process.waitUntilExit()
            throw RuntimeError.missingNode(policy.minimumVersion)
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0,
              ((try fm.attributesOfItem(atPath: output.path)[.size] as? Int) ?? 0) <= 8192 else { throw RuntimeError.missingNode(policy.minimumVersion) }
        struct Identity: Decodable { let executable: String; let version: String }
        let identity = try JSONDecoder().decode(Identity.self, from: Data(contentsOf: output))
        guard policy.supports(version: identity.version), identity.executable.hasPrefix("/"),
              !identity.executable.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw RuntimeError.missingNode(policy.minimumVersion)
        }
        let actual = URL(fileURLWithPath: identity.executable).resolvingSymlinksInPath()
        guard fm.isExecutableFile(atPath: actual.path) else { throw RuntimeError.missingNode(policy.minimumVersion) }
        return actual
    }
}
