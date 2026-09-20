#!/usr/bin/env python3
"""Stamp or verify both macOS version fields from the product version owner."""
import argparse
import json
from pathlib import Path
import plistlib
import re


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("plist", type=Path)
parser.add_argument("source", type=Path, help="Root package.json or verified runtime-manifest.json")
parser.add_argument("--check", action="store_true", help="Verify without modifying the plist")
args = parser.parse_args()
source = json.loads(args.source.read_text())
if source.get("schema") == "murmur.runtime-bundle/1":
    version = source.get("declaredVersion")
    package = json.loads(args.source.with_name("package.json").read_text())
    if package.get("name") != "murmur" or package.get("version") != version:
        raise SystemExit("Runtime manifest and root package versions disagree")
elif source.get("name") == "murmur":
    version = source.get("version")
else:
    raise SystemExit("Expected a Murmur root package or runtime manifest")
# Both Apple version keys require numeric components. Refuse unsupported release
# forms instead of silently stripping metadata or keeping a stale template value.
if not isinstance(version, str) or not re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", version):
    raise SystemExit("Mac packaging requires a numeric major.minor.patch product version")
keys = ("CFBundleShortVersionString", "CFBundleVersion")
info = plistlib.loads(args.plist.read_bytes())
if not args.check:
    info.update({key: version for key in keys})
    args.plist.write_bytes(plistlib.dumps(info, sort_keys=False))
recorded = plistlib.loads(args.plist.read_bytes())
if any(recorded.get(key) != version for key in keys):
    raise SystemExit("App version fields do not match the product version")
print(version)
