import AppKit
import SwiftUI
import MurmurTrayCore

// Native screenshot of the exact Home/Settings heading from a read-only status
// measurement. Input: {"service": <status.service>}; no Identity or message data.
@main struct RenderServiceHeading {
    @MainActor static func main() throws {
        let args = CommandLine.arguments
        guard args.count == 4, ["en", "ru"].contains(args[2]) else {
            fatalError("usage: render-service-heading input.json en|ru output.png")
        }
        _ = NSApplication.shared
        UserDefaults.standard.setVolatileDomain(["interfaceLanguage": args[2]], forName: UserDefaults.argumentDomain)
        let input = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[1]))) as! [String: Any]
        let service = try JSONDecoder().decode(StatusSnapshot.Service.self,
            from: JSONSerialization.data(withJSONObject: input["service"]!))
        let content = VStack(alignment: .leading, spacing: 16) {
            Text("Murmur").font(.system(size: 24, weight: .semibold))
            ServiceHeading(service: service)
        }.padding(24).frame(width: 560, height: 160, alignment: .topLeading)
            .background(Color(nsColor: .windowBackgroundColor)).environment(\.colorScheme, .light)
        let host = NSHostingView(rootView: content)
        host.frame = NSRect(x: 0, y: 0, width: 560, height: 160)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { fatalError("bitmap unavailable") }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        guard let png = bitmap.representation(using: .png, properties: [:]) else { fatalError("PNG unavailable") }
        try png.write(to: URL(fileURLWithPath: args[3]))
        print(service.title)
        if let text = service.managementDescription { print(text) }
    }
}
