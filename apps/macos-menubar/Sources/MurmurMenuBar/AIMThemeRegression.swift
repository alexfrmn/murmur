import AppKit
import SwiftUI
import Combine
import MurmurTrayCore

/// Exercises production theme propagation with an isolated defaults suite and no transport.
@MainActor enum AIMThemeRegression {
    private static let suite = "org.aimindset.murmur.theme-regression"
    static var scratchDefaults: UserDefaults? {
        ProcessInfo.processInfo.arguments.contains("--aim-check-theme") ? UserDefaults(suiteName: suite) : nil
    }

    static func run() {
        let defaults = scratchDefaults!
        defaults.removePersistentDomain(forName: suite)
        defer { defaults.removePersistentDomain(forName: suite) }
        AIMTheme.registerFonts()
        let state = AIMWindowState.shared
        var failures = 0, checks = 0
        func need(_ ok: Bool, _ label: String) {
            checks += 1
            if !ok { failures += 1 }
            print("\(ok ? "PASS" : "FAIL") \(label)")
        }
        func rgb(_ color: NSColor) -> [Double] {
            let c = color.usingColorSpace(.sRGB)!
            return [Double(c.redComponent), Double(c.greenComponent), Double(c.blueComponent)]
        }
        func count(_ rep: NSBitmapImageRep, color: NSColor, region: NSRect? = nil) -> Int {
            let target = rgb(color)
            var matches = 0
            for y in stride(from: 0, to: rep.pixelsHigh, by: 4) {
                for x in stride(from: 0, to: rep.pixelsWide, by: 4) {
                    if let region, !region.contains(NSPoint(x: x, y: y)) { continue }
                    guard let c = rep.colorAt(x: x, y: y) else { continue }
                    let p = [Double(c.redComponent), Double(c.greenComponent), Double(c.blueComponent)]
                    if zip(p, target).allSatisfy({ abs($0 - $1) < 0.04 }) { matches += 1 }
                }
            }
            return matches
        }
        func bitmap(_ view: NSView) -> NSBitmapImageRep {
            let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)!
            view.cacheDisplay(in: view.bounds, to: rep)
            return rep
        }
        func descendants(_ view: NSView) -> [NSView] {
            [view] + view.subviews.flatMap(descendants)
        }
        let model = TrayModel(startRuntime: false)
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "--aim-fixture"), args.indices.contains(i + 1),
           let data = try? Data(contentsOf: URL(fileURLWithPath: args[i + 1])) {
            model.companion.snapshot = try? AIMCompanionSnapshot.decode(data)
            model.companion.previewConnected = model.companion.snapshot != nil
        }
        let output = args.firstIndex(of: "--aim-check-output").flatMap { args.indices.contains($0 + 1) ? args[$0 + 1] : nil }
        var expected: AIMThemePolicy.Mode = .light
        var publishedInExpectedAppearance = true
        let observation = state.objectWillChange.sink {
            publishedInExpectedAppearance = NSApp.effectiveAppearance.name == AIMThemePolicy.appearance(expected)!.name
        }
        defer { observation.cancel() }
        for page in ["Overview", "People", "Connections", "Home", "Settings"] {
            let host = NSHostingView(rootView: AIMHomeView(model: model, initialPage: page))
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 740, height: 700),
                                  styleMask: [.borderless], backing: .buffered, defer: false)
            window.contentView = host
            state.attach(window)
            let originalFrame = window.frame
            for (step, mode) in [AIMThemePolicy.Mode.light, .dark, .light, .dark, .light].enumerated() {
                expected = mode
                publishedInExpectedAppearance = false
                let opposite: AIMThemePolicy.Mode = mode == .dark ? .light : .dark
                AIMThemePolicy.withAppearance(opposite) { state.setTheme(mode) }
                RunLoop.main.run(until: Date().addingTimeInterval(0.15))
                host.layoutSubtreeIfNeeded()
                let prefix = "\(page)/\(step)-\(mode.rawValue)"
                need(publishedInExpectedAppearance, prefix + " publish after AppKit appearance")
                need(AIMThemePolicy.load(defaults) == mode, prefix + " saved theme")
                need(window.frame == originalFrame, prefix + " retained window frame")
                need(!window.isVisible, prefix + " never raises test window")
                let canvas = NSColor(cgColor: AIMThemePolicy.resolvedCGColor(AIMTheme.canvasColor))!
                let ink = NSColor(cgColor: AIMThemePolicy.resolvedCGColor(AIMAppShellStyle.ink))!
                let surface = NSColor(cgColor: AIMThemePolicy.resolvedCGColor(AIMAppShellStyle.surface))!
                let muted = NSColor(cgColor: AIMThemePolicy.resolvedCGColor(AIMAppShellStyle.muted))!
                let rep = bitmap(host)
                need(count(rep, color: canvas) > 1_500, prefix + " SwiftUI canvas pixels")
                need(count(rep, color: ink) > 30, prefix + " readable text pixels")
                need(count(rep, color: surface) > 60, prefix + " control background pixels")
                let chrome = descendants(host).filter { $0 is AIMAppHeader || $0 is AIMFooterLine }
                need(chrome.count == 2, prefix + " header and footer remain mounted")
                for view in chrome {
                    let name = view is AIMAppHeader ? "header" : "footer"
                    let part = bitmap(view)
                    let bounds = view.convert(view.bounds, to: host)
                    let scale = CGFloat(rep.pixelsWide) / host.bounds.width
                    let y = host.isFlipped ? bounds.minY : host.bounds.height - bounds.maxY
                    let region = NSRect(x: bounds.minX * scale, y: y * scale,
                                        width: bounds.width * scale, height: bounds.height * scale)
                    need(count(rep, color: canvas, region: region) > 100, prefix + " AppKit \(name) composited canvas")
                    need(count(part, color: name == "footer" ? muted : ink) > 8, prefix + " AppKit \(name) text")
                }
                if let output, let png = rep.representation(using: .png, properties: [:]) {
                    try! png.write(to: URL(fileURLWithPath: output).appendingPathComponent("\(page)-\(step)-\(mode.rawValue).png"))
                }
            }
            state.close(.escape)
            need(AIMThemePolicy.load(defaults) == .light, page + " Escape retains theme")
            window.contentView = nil
        }
        let reloaded = AIMWindowState(defaults: defaults)
        need(reloaded.theme == .light, "new controller reloads saved theme")
        reloaded.setFollowSystem(true)
        need(reloaded.followsSystem && defaults.bool(forKey: "org.aimindset.murmur.followSystemAppearance"), "system choice persists in isolated defaults")
        reloaded.setTheme(.dark)
        need(!reloaded.followsSystem && !defaults.bool(forKey: "org.aimindset.murmur.followSystemAppearance"), "manual theme leaves automatic mode")
        reloaded.setTheme(.light)
        print("\(checks) theme checks, \(failures) failures")
        exit(failures == 0 ? 0 : 1)
    }
}
