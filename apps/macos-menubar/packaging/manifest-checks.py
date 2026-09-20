#!/usr/bin/env python3
"""Prove that the packaging inventory gate rejects altered and extra payloads."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile


validator = Path(__file__).with_name("verify-runtime.py")
checks = []
with tempfile.TemporaryDirectory(prefix="murmur-manifest-check-") as temporary:
    root = Path(temporary)
    names = ["package.json", "scripts/runtime-capability.mjs", "packages/setup/bin/murmur.mjs",
             "packages/setup/dist/src/cli.js", "packages/mcp-server/dist/src/index.js", "scripts/murmur-daemon.mjs"]
    for name in names:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"")
    (root / "runtime-manifest.json").write_text(json.dumps({
        "schema": "murmur.runtime-bundle/1", "declaredVersion": "2.9.0", "sourceCommit": "test-fixture",
        "files": {name: {"size": 0, "sha256": hashlib.sha256(b"").hexdigest()} for name in names},
    }))

    def run(name, success):
        result = subprocess.run([sys.executable, "-O", str(validator), str(root)],
                                text=True, capture_output=True, timeout=10)
        if (result.returncode == 0) != success:
            raise RuntimeError(f"{name}: unexpected result {result.returncode}: {result.stdout}{result.stderr}")
        checks.append(name)

    run("complete inventory accepted under Python optimization", True)
    payload = root / names[0]
    payload.write_bytes(b"tampered")
    run("changed payload rejected", False)
    payload.write_bytes(b"")
    payload.unlink()
    run("missing payload rejected", False)
    payload.write_bytes(b"")
    extra = root / "unlisted"
    extra.write_bytes(b"")
    run("unlisted payload rejected", False)
    extra.unlink()
    (root / "linked").symlink_to(payload)
    run("symlink rejected", False)
print(json.dumps({"manifestChecks": checks, "count": len(checks)}))
