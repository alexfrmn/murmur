#!/usr/bin/env python3
"""Exercise the packaged native helper against real Node and a disposable fixture engine."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def main(app):
    helper = app / "Contents/MacOS/murmur"
    package = json.loads((app / "Contents/Resources/runtime/package.json").read_text())
    checks = []
    with tempfile.TemporaryDirectory(prefix="murmur bridge user's ") as temporary:
        root = Path(temporary)
        home = root / "home"
        home.mkdir()
        # CI may install Node in a tool cache. Expose that trusted installation only
        # inside the disposable HOME using a supported version-manager location.
        node = shutil.which("node")
        require(node is not None, "The packaging check needs Node on the build host")
        shim = home / ".volta/bin/node"
        shim.parent.mkdir(parents=True)
        shim.symlink_to(Path(node).resolve())
        environment = {"HOME": str(home), "PATH": "/usr/bin:/bin", "MURMUR_UPDATE_CHECK": "0",
                       "USER": os.environ.get("USER", "")}
        result = subprocess.run([str(helper), "version", "--json"], cwd=root, env=environment,
                                text=True, capture_output=True, timeout=10)
        require(result.returncode == 0, f"Bundled engine version failed: {result.stderr}")
        version = json.loads(result.stdout)
        require(version.get("version") == package["version"] and version.get("schema") == "murmur.version/1",
                "Helper must run this bundle's engine")
        checks.append("bundled engine version from unrelated cwd and disposable HOME")

        contents = root / "Murmur literal app.app/Contents"
        binary = contents / "MacOS/murmur"
        binary.parent.mkdir(parents=True)
        shutil.copy2(helper, binary)
        shutil.copy2(app / "Contents/Info.plist", contents / "Info.plist")
        resources = "MurmurMenuBarSpike_MurmurTrayCore.bundle"
        shutil.copytree(app / "Contents/Resources" / resources, contents / "Resources" / resources)
        runtime = contents / "Resources/runtime"
        for name in ["packages/setup/bin/murmur.mjs", "packages/setup/dist/src/cli.js",
                     "packages/mcp-server/dist/src/index.js", "scripts/murmur-daemon.mjs",
                     "scripts/runtime-capability.mjs"]:
            path = runtime / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("")
        (runtime / "package.json").write_text(json.dumps({"engines": package["engines"]}))
        cli = runtime / "packages/setup/bin/murmur.mjs"
        cli.write_text("console.log(JSON.stringify({pid:process.pid,argv:process.argv.slice(2),"
                       "env:Object.fromEntries(['NODE_OPTIONS','NODE_PATH','DYLD_INSERT_LIBRARIES',"
                       "'DATA_DIR','MURMUR_DATA_DIR','MURMUR_STORE_PATH','MURMUR_UPDATE_CHECK']"
                       ".map(k=>[k,process.env[k]??null]))}));")
        arguments = ["status", "/literal user's folder/кириллица", "; $(false) `false`", "line1\nline2"]
        hostile = {**environment, "NODE_OPTIONS": "--require /must-not-load.js", "NODE_PATH": "/wrong",
                   "DATA_DIR": "/production", "MURMUR_DATA_DIR": "/production", "MURMUR_STORE_PATH": "/production"}
        # DYLD injection must be stripped by the caller before a Mach-O loads; the
        # GUI's CLIProbe does that. Do not claim a helper can sanitize its own loader.
        process = subprocess.Popen([str(binary), *arguments], cwd=root, env=hostile,
                                   text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            output, error = process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise
        require(process.returncode == 0, f"Fixture helper failed: {error}")
        value = json.loads(output)
        require(value["argv"] == arguments, "Arguments must remain literal")
        require(value["pid"] == process.pid, "Helper must exec Node instead of leaving a child behind")
        expected = {key: None for key in ["NODE_OPTIONS", "NODE_PATH", "DYLD_INSERT_LIBRARIES", "DATA_DIR",
                                         "MURMUR_DATA_DIR", "MURMUR_STORE_PATH"]}
        expected["MURMUR_UPDATE_CHECK"] = "0"
        require(value["env"] == expected, "Node injection or production profile environment leaked")
        checks.extend(["literal argv including quotes Unicode shell syntax and newline",
                       "native exec preserves PID", "isolated environment with update opt-out"])
        (runtime / "scripts/murmur-daemon.mjs").unlink()
        result = subprocess.run([str(binary), "status"], cwd=root, env=environment,
                                text=True, capture_output=True, timeout=10)
        require(result.returncode != 0 and result.stderr.strip(), "Incomplete bundle must fail closed")
        checks.append("incomplete engine rejected")
    print(json.dumps({"checks": checks, "count": len(checks), "engineVersion": version,
                      "helperSHA256": hashlib.sha256(helper.read_bytes()).hexdigest()}, ensure_ascii=False))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: native-bridge-check.py /absolute/path/Murmur.app")
    main(Path(sys.argv[1]).resolve(strict=True))
