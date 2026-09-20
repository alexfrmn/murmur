#!/usr/bin/env python3
"""Compile the bounded shared SVG contract to Core Graphics; refuse unknown syntax."""
import argparse
import hashlib
import math
from pathlib import Path
import re
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "contracts/visual/murmur-mark.svg"
OUTPUT = ROOT / "apps/macos-menubar/Sources/MurmurTrayCore/GeneratedMurmurMark.swift"


def number(value):
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("Non-finite coordinate")
    return f"{result:.12g}"


def color(value):
    if re.fullmatch(r"#[0-9a-fA-F]{3}", value):
        value = "#" + "".join(c * 2 for c in value[1:])
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        raise ValueError(f"Unsupported colour: {value}")
    channels = [number(int(value[i:i + 2], 16) / 255) for i in (1, 3, 5)]
    return f"CGColor(srgbRed: {channels[0]}, green: {channels[1]}, blue: {channels[2]}, alpha: 1)"


def path_commands(value):
    tokens = re.findall(r"[A-Za-z]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?", value)
    if re.sub(r"[\s,]", "", "".join(tokens)) != re.sub(r"[\s,]", "", value):
        raise ValueError("Unsupported path syntax")
    i, x, y = 0, "0", "0"
    lines = []
    while i < len(tokens):
        command = tokens[i]
        i += 1
        count = {"M": 2, "L": 2, "H": 1, "V": 1, "Q": 4, "Z": 0}.get(command)
        if count is None:
            raise ValueError(f"Unsupported path command: {command}")
        args = [number(v) for v in tokens[i:i + count]]
        if len(args) != count:
            raise ValueError("Incomplete path command")
        i += count
        if command in ("M", "L"):
            x, y = args
            method = "move" if command == "M" else "addLine"
            lines.append(f"p.{method}(to: CGPoint(x: {x}, y: {y}))")
        elif command in ("H", "V"):
            if command == "H":
                x = args[0]
            else:
                y = args[0]
            lines.append(f"p.addLine(to: CGPoint(x: {x}, y: {y}))")
        elif command == "Q":
            a, b, x, y = args
            lines.append(f"p.addQuadCurve(to: CGPoint(x: {x}, y: {y}), control: CGPoint(x: {a}, y: {b}))")
        else:
            lines.append("p.closeSubpath()")
    return lines


def compile_mark(raw):
    root = ET.fromstring(raw)
    if root.get("data-schema") != "murmur.mark/2":
        raise ValueError("Unsupported Murmur mark schema")
    view = [number(v) for v in root.attrib["viewBox"].split()]
    if len(view) != 4 or view[0:2] != ["0", "0"] or view[2] != view[3]:
        raise ValueError("Expected a square viewBox with zero origin")
    ids = {el.attrib["id"]: el for el in root.iter() if "id" in el.attrib}
    gradients = {}
    for name, el in ids.items():
        if el.tag.rsplit("}", 1)[-1] != "linearGradient":
            continue
        if set(el.attrib) - {"id", "x1", "y1", "x2", "y2"}:
            raise ValueError("Unsupported gradient attributes")
        stops = list(el)
        if any(set(stop.attrib) - {"offset", "stop-color"} for stop in stops):
            raise ValueError("Unsupported gradient stop attributes")
        if [s.get("offset") for s in stops] != ["0%", "100%"]:
            raise ValueError("Expected two endpoint gradient stops")
        if [el.get(k) for k in ("x1", "y1", "x2", "y2")] != ["0%", "0%", "100%", "100%"]:
            raise ValueError("Unsupported gradient direction")
        gradients[name] = [color(s.attrib["stop-color"]) for s in stops]

    def shape(el, stack=()):
        tag, a = el.tag.rsplit("}", 1)[-1], el.attrib
        allowed = {
            "use": {"href"}, "g": {"id"}, "symbol": {"id", "viewBox"},
            "circle": {"cx", "cy", "r"}, "rect": {"x", "y", "width", "height", "rx"},
            "path": {"d"},
        }
        style = {"fill", "stroke", "stroke-width", "stroke-linecap", "data-overlay"}
        supported_style = style if tag in ("circle", "rect", "path") else set()
        if tag not in allowed or set(a) - allowed[tag] - supported_style:
            raise ValueError(f"Unsupported SVG element/attributes: {tag} {a}")
        if tag == "use":
            if not a["href"].startswith("#"):
                raise ValueError("Only local SVG references are supported")
            ref = a["href"][1:]
            if ref in stack or ref not in ids:
                raise ValueError("Invalid or cyclic SVG reference")
            return shape(ids[ref], stack + (ref,))
        if tag == "symbol" and a.get("viewBox") != root.get("viewBox"):
            raise ValueError("Each symbol must use the shared viewBox")
        if tag in ("g", "symbol"):
            return [line for child in el for line in shape(child, stack)]
        lines = ["do {", "    let p = CGMutablePath()"]
        if tag == "circle":
            cx, cy, r = [float(a[k]) for k in ("cx", "cy", "r")]
            lines.append(f"    p.addEllipse(in: CGRect(x: {number(cx-r)}, y: {number(cy-r)}, width: {number(2*r)}, height: {number(2*r)}))")
        elif tag == "rect":
            x, y, w, h = [number(a[k]) for k in ("x", "y", "width", "height")]
            rx = number(a.get("rx", "0"))
            lines.append(f"    p.addRoundedRect(in: CGRect(x: {x}, y: {y}, width: {w}, height: {h}), cornerWidth: {rx}, cornerHeight: {rx})")
        else:
            lines.extend("    " + line for line in path_commands(a["d"]))
        fill = a.get("fill", "#000")
        if fill.startswith("url(#") and fill.endswith(")"):
            colors = gradients[fill[5:-1]]
            lines += ["    ctx.saveGState()", "    ctx.addPath(p); ctx.clip()",
                      f"    let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!, colors: [{', '.join(colors)}] as CFArray, locations: [0, 1])!",
                      "    let b = p.boundingBox",
                      "    ctx.drawLinearGradient(gradient, start: b.origin, end: CGPoint(x: b.maxX, y: b.maxY), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])",
                      "    ctx.restoreGState()"]
        elif fill != "none":
            lines += [f"    ctx.setFillColor({color(fill)})", "    ctx.addPath(p); ctx.fillPath()"]
        if a.get("stroke", "none") != "none":
            cap = a.get("stroke-linecap", "butt")
            if cap not in ("butt", "round", "square"):
                raise ValueError("Unsupported line cap")
            lines += [f"    ctx.setStrokeColor({color(a['stroke'])})",
                      f"    ctx.setLineWidth({number(a.get('stroke-width', '1'))}); ctx.setLineCap(.{cap})",
                      "    ctx.addPath(p); ctx.strokePath()"]
        return lines + ["}"]

    lines = ["// Generated by scripts/generate-mark.py from contracts/visual/murmur-mark.svg.",
             "// Do not edit. Regenerate both native consumers when the shared source changes.",
             "import CoreGraphics", "import Foundation", "", "public enum GeneratedMurmurMark {",
             f'    public static let sourceSHA256 = "{hashlib.sha256(raw).hexdigest()}"',
             f"    static let extent: CGFloat = {view[2]}"]
    for state in ("ready", "idle", "unread", "failed"):
        lines.append(f"    static func {state}(_ ctx: CGContext) {{")
        lines.extend("        " + s for s in shape(ids["murmur-" + state]))
        lines.append("    }")
    overlays = [el for el in ids["murmur-unread"].iter() if el.get("data-overlay") == "unread"]
    if len(overlays) != 1:
        raise ValueError("Expected one explicit unread overlay")
    lines.append("    static func unreadOverlay(_ ctx: CGContext) {")
    lines.extend("        " + s for s in shape(overlays[0]))
    lines += ["    }", "}", ""]
    return "\n".join(lines)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    expected = compile_mark(SOURCE.read_bytes())
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_text() != expected:
            parser.exit(1, "Murmur mark drift: run apps/macos-menubar/scripts/generate-mark.py\n")
        print("PASS canonical SVG / generated Swift exact source binding")
    else:
        OUTPUT.write_text(expected)
        print(OUTPUT)
