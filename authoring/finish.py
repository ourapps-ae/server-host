"""Run after tools/scaffold_component.py: marks host-settings.ts and wrangler.jsonc as aepm template artefacts (the scaffolder has no template option) and keeps the committed manifest layout."""
import json
from pathlib import Path

path = Path(__file__).resolve().parents[1] / "component.json"
manifest = json.loads(path.read_text())
for artefact in manifest["artefacts"]:
    if artefact["source"] in ("implementation/server/host-settings.ts", "implementation/server/wrangler.jsonc"):
        artefact["template"] = True
manifest["files"] = [item for item in manifest["files"] if item["path"] not in (".gitattributes", ".gitignore")]
manifest["documents"]["interfaces"].sort()
path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
