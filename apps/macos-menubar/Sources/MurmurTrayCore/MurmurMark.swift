import AppKit

public enum MarkState: String, CaseIterable, Sendable {
    case ready, idle, unread, failed

    public init(indicator: Indicator) {
        self = switch indicator {
        case .ready: .ready
        case .unread: .unread
        case .failed: .failed
        case .unknown, .stopped, .paused, .offline: .idle
        }
    }
}

public enum MurmurMark {
    /// Rasterise before handing the image to the status button. The source is shared
    /// with Windows; badges never replace the measured health of the base mark.
    public static func bitmap(state: MarkState, unread: Bool = false, update: Bool = false,
                              size: CGFloat = 18, scale: CGFloat = 1) -> CGImage {
        let pixels = Int((size * scale).rounded())
        precondition(pixels > 0 && pixels <= 2048)
        let ctx = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8,
                            bytesPerRow: pixels * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.translateBy(x: 0, y: CGFloat(pixels))
        ctx.scaleBy(x: CGFloat(pixels) / GeneratedMurmurMark.extent,
                    y: -CGFloat(pixels) / GeneratedMurmurMark.extent)
        switch state {
        case .ready: GeneratedMurmurMark.ready(ctx)
        case .idle: GeneratedMurmurMark.idle(ctx)
        case .unread: GeneratedMurmurMark.unread(ctx)
        case .failed: GeneratedMurmurMark.failed(ctx)
        }
        if unread && state != .unread { GeneratedMurmurMark.unreadOverlay(ctx) }
        if update {
            // An independent update signal in the lower left, away from unread.
            // Health still occupies the rest of the disk; the text names both.
            ctx.setFillColor(NSColor.systemPurple.cgColor)
            ctx.fillEllipse(in: CGRect(x: 0, y: 76, width: 44, height: 44))
            ctx.setStrokeColor(NSColor.white.cgColor)
            ctx.setLineWidth(7); ctx.setLineCap(.round)
            ctx.move(to: CGPoint(x: 22, y: 108)); ctx.addLine(to: CGPoint(x: 22, y: 87))
            ctx.move(to: CGPoint(x: 12, y: 97)); ctx.addLine(to: CGPoint(x: 22, y: 87))
            ctx.addLine(to: CGPoint(x: 32, y: 97)); ctx.strokePath()
        }
        return ctx.makeImage()!
    }

    public static func image(state: MarkState, unread: Bool = false, update: Bool = false,
                             size: CGFloat = 18, description: String? = nil) -> NSImage {
        let image = NSImage(size: NSSize(width: size, height: size))
        for scale: CGFloat in [1, 2] {
            let rep = NSBitmapImageRep(cgImage: bitmap(state: state, unread: unread, update: update, size: size, scale: scale))
            rep.size = image.size
            image.addRepresentation(rep)
        }
        // Colour is deliberate in murmur.mark/2, including on dark menu bars.
        image.isTemplate = false
        image.accessibilityDescription = description
        return image
    }
}
