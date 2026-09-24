import Foundation
import Darwin
import MurmurTrayCore

// A native exec bridge keeps CLI timeouts/signals attached to Node, with literal argv.
do {
    let helper = URL(fileURLWithPath: CommandLine.arguments[0])
    let runtime = try BundledRuntime.runtime(for: helper)
    let node = try BundledRuntime.findNode(runtime: runtime)
    let arguments = [node.path, runtime.appendingPathComponent("packages/setup/bin/murmur.mjs").path]
        + Array(CommandLine.arguments.dropFirst())
    let inherited = ProcessInfo.processInfo.environment
    var runtimeEnvironment = BundledRuntime.cleanEnvironment(inherited)
    // Match CLIProbe's command-scoped routing: a second environment filter must
    // not redirect client preview/configure to the user's default config.
    if CommandLine.arguments.dropFirst().first == "clients" {
        for key in ["CODEX_HOME", "CLAUDE_CONFIG_DIR"] {
            if let value = inherited[key] { runtimeEnvironment[key] = value }
        }
    }
    let environment = runtimeEnvironment
        .sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }
    let argv = arguments.map { strdup($0) } + [nil]
    let envp = environment.map { strdup($0) } + [nil]
    defer { for p in argv + envp { if let p { free(p) } } }
    argv.withUnsafeBufferPointer { a in
        envp.withUnsafeBufferPointer { e in
            _ = execve(node.path, a.baseAddress!, e.baseAddress!)
        }
    }
    throw RuntimeError.cannotLaunch
} catch {
    FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
    exit(1)
}
