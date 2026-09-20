#!/usr/bin/env python3
"""Fail closed on incomplete, modified, linked, or unmanifested runtime payloads."""
import hashlib
import json
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1]).resolve(strict=True)
manifest = json.loads((root / "runtime-manifest.json").read_text())


def require(condition, message):
    if not condition:
        raise SystemExit(message)


require(manifest["schema"] == "murmur.runtime-bundle/1", "Unknown runtime schema")
require(re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", manifest["declaredVersion"]), "Invalid version")
files = manifest["files"]
require(isinstance(files, dict) and files, "Missing runtime inventory")
actual = set()
for path in root.rglob("*"):
    require(not path.is_symlink(), f"Runtime contains a symlink: {path.relative_to(root)}")
    if path.is_file():
        relative = path.relative_to(root).as_posix()
        if relative == "runtime-manifest.json":
            continue
        actual.add(relative)
        expected = files.get(relative)
        require(isinstance(expected, dict), f"Unmanifested runtime file: {relative}")
        payload = path.read_bytes()
        require(len(payload) == expected["size"], f"Size mismatch: {relative}")
        require(hashlib.sha256(payload).hexdigest() == expected["sha256"], f"Hash mismatch: {relative}")
require(actual == set(files), "Missing runtime files")
for required in ("package.json", "scripts/runtime-capability.mjs", "packages/setup/bin/murmur.mjs", "packages/setup/dist/src/cli.js",
                 "packages/mcp-server/dist/src/index.js", "scripts/murmur-daemon.mjs"):
    require(required in actual, f"Missing runtime entrypoint: {required}")
print(f"Verified {len(actual)} runtime files; source {manifest['sourceCommit']}; version {manifest['declaredVersion']}")
