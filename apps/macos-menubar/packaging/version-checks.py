#!/usr/bin/env python3
"""Verify version propagation, disagreement rejection and read-only assertions."""
import json
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile


stamp = Path(__file__).with_name("stamp-version.py")
checks = []
with tempfile.TemporaryDirectory(prefix="murmur-version-check-") as temporary:
    root = Path(temporary)
    info = root / "Info.plist"
    package = root / "package.json"
    manifest = root / "runtime-manifest.json"
    info.write_bytes(plistlib.dumps({"CFBundleShortVersionString": "0.0.1", "CFBundleVersion": "1"}))
    package.write_text(json.dumps({"name": "murmur", "version": "4.12.3"}))

    def run(source, check=False, succeeds=True):
        before = info.read_bytes()
        result = subprocess.run([sys.executable, str(stamp), str(info), str(source)] + (["--check"] if check else []),
                                capture_output=True, text=True, timeout=10)
        if (result.returncode == 0) != succeeds:
            raise RuntimeError(result.stdout + result.stderr)
        if (check or not succeeds) and info.read_bytes() != before:
            raise RuntimeError("Read-only or rejected operation modified the plist")
        return result.stdout.strip()

    if run(package) != "4.12.3" or set(plistlib.loads(info.read_bytes()).values()) != {"4.12.3"}:
        raise RuntimeError("Both keys must follow the root version")
    checks.append("both template keys follow a future root version")
    run(package, check=True)
    checks.append("matching version assertion is read-only")
    changed = plistlib.loads(info.read_bytes()); changed["CFBundleVersion"] = "1"
    info.write_bytes(plistlib.dumps(changed))
    run(package, check=True, succeeds=False)
    checks.append("stale build number rejected without repair")
    manifest.write_text(json.dumps({"schema": "murmur.runtime-bundle/1", "declaredVersion": "4.12.3"}))
    run(manifest)
    checks.append("runtime manifest stamps both keys")
    manifest.write_text(json.dumps({"schema": "murmur.runtime-bundle/1", "declaredVersion": "4.12.4"}))
    run(manifest, succeeds=False)
    checks.append("manifest and engine disagreement rejected")
    for version in ["4.12.3-rc1", "4.12.3+build", "../4.12.3", "04.12.3", 4]:
        package.write_text(json.dumps({"name": "murmur", "version": version}))
        run(package, succeeds=False)
    checks.append("unsupported or unsafe version forms rejected without mutation")
print(json.dumps({"versionChecks": checks, "count": len(checks)}))
