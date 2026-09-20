#!/usr/bin/env python3
"""Exercise the shipped launchers with real Node and an isolated fixture CLI.

This does not test the real engine or claim GUI/agent wake acceptance. No user
profile is loaded. The running-app cases own a temporary copy of /bin/sleep;
an existing Murmur process causes refusal before any test starts.
"""

import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import stat
import subprocess
import tempfile
import time


def run(argv, env):
    return subprocess.run(argv, env=env, text=True, capture_output=True, timeout=15)


def murmur_pids():
    result = subprocess.run(
        ["/usr/bin/pgrep", "-x", "MurmurMenuBar"],
        text=True, capture_output=True, timeout=5,
    )
    if result.returncode not in (0, 1):
        raise RuntimeError(result.stderr)
    return {int(value) for value in result.stdout.split()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", default=shutil.which("node"))
    options = parser.parse_args()
    if not options.node:
        parser.error("Node is required; use --node /absolute/path/to/node")
    node = str(Path(options.node).resolve(strict=True))
    if murmur_pids():
        raise RuntimeError("Quit Murmur before launcher checks; no process was changed.")

    source = Path(__file__).resolve().parent
    checks = []

    def check(name, condition):
        if not condition:
            raise AssertionError(name)
        checks.append(name)

    with tempfile.TemporaryDirectory(prefix="murmur-launcher-checks-") as temporary:
        base = Path(temporary).resolve()
        bundle = base / "Bundle with spaces and 'apostrophe'"
        bundle.mkdir()
        home = base / "isolated-home"
        home.mkdir()
        for name in ("Open Murmur.command", "murmur"):
            shutil.copy2(source / name, bundle / name)
        launcher = bundle / "Open Murmur.command"
        wrapper = bundle / "murmur"
        binding = bundle / ".murmur-node"
        capture = base / "fixture-capture.json"
        poison_marker = base / "node-options-executed"
        app_marker = base / "app-executed"
        shell_marker = base / "shell-evaluated"
        app_binary = bundle / "Murmur Spike.app/Contents/MacOS/MurmurMenuBar"
        app_binary.parent.mkdir(parents=True)
        app_binary.write_text("#!/bin/sh\n/usr/bin/touch " + shlex.quote(str(app_marker)) + "\n")
        app_binary.chmod(0o755)
        cli = bundle / "runtime/packages/setup/bin/murmur.mjs"
        cli.parent.mkdir(parents=True)
        compiled = bundle / "runtime/packages/setup/dist/src/cli.js"
        compiled.parent.mkdir(parents=True)
        compiled.touch()
        cli.write_text(
            "import fs from 'node:fs';\n"
            "const result = {argv:process.argv.slice(2),env:process.env,execPath:process.execPath};\n"
            "fs.writeFileSync(" + json.dumps(str(capture)) + ",JSON.stringify(result));\n"
            "console.log(JSON.stringify({fixture:true}));\n"
        )
        poison = base / "poison module.cjs"
        poison.write_text(
            "require('node:fs').writeFileSync(" + json.dumps(str(poison_marker)) + ",'executed');\n"
        )
        node_alias = base / "Node path with spaces and 'apostrophe'/node"
        node_alias.parent.mkdir()
        node_alias.symlink_to(node)
        env = {
            "HOME": str(home), "USER": os.environ.get("USER", "tester"),
            "LOGNAME": os.environ.get("LOGNAME", "tester"), "TMPDIR": str(base),
            "LANG": "en_US.UTF-8", "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "MURMUR_NODE": str(node_alias), "MURMUR_UPDATE_CHECK": "0",
            "NODE_OPTIONS": '--require="' + str(poison) + '"', "NODE_PATH": str(base / "poison"),
            "TEST_SECRET_TOKEN": "fixture-only-not-a-real-secret",
            "DATA_DIR": str(base / "wrong-profile"), "MURMUR_DATA_DIR": "wrong-profile",
            "MURMUR_STORE_PATH": "wrong-store", "MURMUR_SERVICE_NAME": "wrong-service",
            "MURMUR_CLI": "wrong-cli", "MURMUR_BIN": "wrong-bin",
        }
        forbidden = {
            "NODE_OPTIONS", "NODE_PATH", "TEST_SECRET_TOKEN", "DATA_DIR",
            "MURMUR_DATA_DIR", "MURMUR_STORE_PATH", "MURMUR_SERVICE_NAME",
            "MURMUR_CLI", "MURMUR_BIN", "MURMUR_NODE",
        }
        result = run([str(launcher), "--check"], env)
        check("bundle path with spaces and apostrophe", result.returncode == 0)
        observed = json.loads(capture.read_text())
        check("external Node invocation path with spaces and apostrophe", observed["execPath"] == node)
        check("canonical absolute Node binding", binding.read_text() == node + "\n")
        check("binding mode0600", stat.S_IMODE(binding.stat().st_mode) == 0o600)
        check("poisoned NODE_OPTIONS not executed", not poison_marker.exists())
        check("secret/profile/Node override environment absent", not forbidden.intersection(observed["env"]))
        check("documented update optout preserved", observed["env"].get("MURMUR_UPDATE_CHECK") == "0")
        check("--check did not launch app", not app_marker.exists() and not murmur_pids())
        arguments = ["fixture", "two words", "apostrophe'quote", "$(touch " + str(shell_marker) + ")", "`touch " + str(shell_marker) + "`", "; exit 42"]
        result = run([str(wrapper)] + arguments, env)
        observed = json.loads(capture.read_text())
        check("CLI argv preserved without shell evaluation", result.returncode == 0 and observed["argv"] == arguments and not shell_marker.exists())
        check("CLI ignores poisoned external environment", not forbidden.intersection(observed["env"]) and not poison_marker.exists())
        before = binding.read_bytes()
        result = run([str(launcher), "--check"], dict(env, MURMUR_NODE=str(base / "missing-node")))
        check("missing selected Node fails without mutation", result.returncode != 0 and "Install Node.js" in result.stderr and binding.read_bytes() == before)
        parked = cli.with_suffix(".temporarily-absent")
        cli.rename(parked)
        try:
            result = run([str(launcher), "--check"], env)
            check("missing runtime fails without mutation", result.returncode != 0 and "runtime is missing" in result.stderr and binding.read_bytes() == before)
        finally:
            parked.rename(cli)

        sleeper = base / "MurmurMenuBar"
        # Do not copy Apple's protected filesystem flags onto the test fixture.
        shutil.copyfile("/bin/sleep", sleeper)
        sleeper.chmod(0o755)
        owned_process = subprocess.Popen([str(sleeper), "30"], env=env)
        try:
            deadline = time.monotonic() + 3
            while owned_process.pid not in murmur_pids():
                if owned_process.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError("Test process name was not observable; refusing normal-open test.")
                time.sleep(0.05)
            binding.write_text("/fixture/pre-existing-node-binding\n")
            before = binding.read_bytes()
            for arguments, name in [([], "normal open"), (["--check"], "--check")]:
                result = run([str(launcher)] + arguments, env)
                check(name + " refuses a running app before binding mutation", result.returncode != 0 and "already open" in result.stderr and binding.read_bytes() == before and not app_marker.exists())
        finally:
            if owned_process.poll() is None:
                owned_process.terminate()
            try:
                owned_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                owned_process.kill()
                owned_process.wait(timeout=5)

    print(json.dumps({"scope": "fixture CLI, real Node; no real engine/GUI/wake claim", "count": len(checks), "checks": checks, "allPassed": True}, indent=2))


if __name__ == "__main__":
    main()
