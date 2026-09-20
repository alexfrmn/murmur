#!/usr/bin/env python3
"""Check the localization resources that will actually ship inside the app."""
import json
from pathlib import Path
import plistlib
import re
import subprocess
import sys


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


app = Path(sys.argv[1]).resolve(strict=True)
info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
require(info.get("CFBundleDevelopmentRegion") == "en", "The app development language must be English")
require(set(info.get("CFBundleLocalizations", [])) == {"en", "ru"}, "The app must declare both languages")
resources = app / "Contents/Resources/MurmurMenuBarSpike_MurmurTrayCore.bundle"
if (resources / "Contents/Resources").is_dir():
    resources = resources / "Contents/Resources"
catalogs = {}
for language in ("en", "ru"):
    path = resources / f"{language}.lproj/Localizable.strings"
    result = subprocess.run(["/usr/bin/plutil", "-convert", "json", "-o", "-", str(path)],
                            capture_output=True, text=True, timeout=10)
    require(result.returncode == 0, f"Invalid or missing {language} catalog: {result.stderr}")
    catalogs[language] = json.loads(result.stdout)
require(catalogs["en"] and set(catalogs["en"]) == set(catalogs["ru"]), "Catalog key sets must agree")
for language, catalog in catalogs.items():
    for key, value in catalog.items():
        require(isinstance(value, str) and bool(value), f"Empty translation: {language}/{key}")
        require(key.count("%@") == value.count("%@"), f"Format argument mismatch: {language}/{key}")
        require("%" not in value.replace("%@", ""), f"Unsupported format directive: {language}/{key}")
require(catalogs["en"]["Language"] == "Language" and catalogs["ru"]["Language"] == "Язык",
        "Both language selectors must be present")
source = Path(__file__).resolve().parents[1] / "Sources"
called = set()
for file in source.rglob("*.swift"):
    for match in re.finditer(r'L10n\.text\(("(?:[^"\\]|\\.)*")', file.read_text()):
        called.add(json.loads(match.group(1)))
require(called <= set(catalogs["en"]), "A UI translation key is missing: " + repr(called - set(catalogs["en"])))
print(json.dumps({"localizationChecks": 5, "keysPerLanguage": len(catalogs["en"]),
                  "sourceKeysCovered": len(called), "languages": ["en", "ru"], "default": "en"}))
