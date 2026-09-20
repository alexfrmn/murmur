import AppKit
import CryptoKit
import MurmurTrayCore

func runMarkChecks(fixtures: URL) throws -> Int {
    let source = fixtures.deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("visual/murmur-mark.svg")
    let digest = SHA256.hash(data: try Data(contentsOf: source)).map { String(format: "%02x", $0) }.joined()
    try check(digest == GeneratedMurmurMark.sourceSHA256, "The mark must match the current shared SVG bytes")
    var count = 1
    for state in [Indicator.unknown, .stopped, .paused, .offline] {
        try check(MarkState(indicator: state) == .idle, "Unmeasured or disconnected state must not be drawn as ready")
        count += 1
    }
    try check(MarkState(indicator: .failed) == .failed && MarkState(indicator: .ready) == .ready
              && MarkState(indicator: .unread) == .unread, "Distinct live states retain their symbols")
    count += 1

    func pixels(_ state: MarkState, _ size: CGFloat, unread: Bool = false, update: Bool = false) -> (Int, Int, Int) {
        let image = MurmurMark.bitmap(state: state, unread: unread, update: update, size: size)
        let bytes = [UInt8](image.dataProvider!.data! as Data)
        var opaque = 0, red = 0, white = 0
        for i in stride(from: 0, to: bytes.count, by: 4) where bytes[i + 3] > 128 {
            opaque += 1
            if Int(bytes[i]) > Int(bytes[i + 1]) + 60 && Int(bytes[i]) > Int(bytes[i + 2]) + 60 { red += 1 }
            if bytes[i] > 210 && bytes[i + 1] > 210 && bytes[i + 2] > 210 { white += 1 }
        }
        return (opaque, red, white)
    }
    for size: CGFloat in [18, 32, 36, 64] {
        let ready = pixels(.ready, size), idle = pixels(.idle, size)
        let unread = pixels(.unread, size), failed = pixels(.failed, size)
        try check(ready.0 > Int(size * size / 2) && ready.1 == 0 && ready.2 > 5, "Ready logo retains a filled circle and white glyph at \(size) px")
        try check(idle.1 == 0 && idle.2 > 5, "Idle retains the glyph without a red alarm")
        try check(unread.1 > 5 && unread.1 < unread.0 / 3, "Unread is a small red overlay")
        try check(failed.1 > failed.0 / 2, "Failure is the red base, not a small unread dot")
        try check(pixels(.failed, size, unread: true, update: true).1 > failed.0 / 3,
                  "Unread and update overlays must not mask failure")
        try check(pixels(.idle, size, unread: true).1 < idle.0 / 3, "Unread on idle does not promote health to ready")
        print("PASS mark \(Int(size))px: ready=\(ready), idle=\(idle), unread=\(unread), failed=\(failed) [opaque, red, white]")
        count += 6
    }
    let image = MurmurMark.image(state: .ready)
    try check(!image.isTemplate && image.size == NSSize(width: 18, height: 18)
              && image.representations.count == 2, "18pt colour status mark includes native 1x and 2x raster representations")
    print("PASS shared mark source SHA, seven state mapping, colour and badge pixel checks")
    return count + 1
}
