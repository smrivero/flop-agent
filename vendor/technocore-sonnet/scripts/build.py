"""Generate standalone examples and a deterministic, locally verifiable manifest."""

import argparse
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION = "0.5.0-draft"
GENERATED = {
    "sonnet_validate.py": ("Python validator", "python"),
}
ARTIFACTS = (
    ".gitignore",
    "AGENTS.md",
    "README.md",
    "LICENSE",
    "NOTICE",
    "sonnet-game.md",
    "contest.json",
    "sonnet_validate.py",
    "cmudict.dict",
    "CMUDICT-LICENSE.txt",
    "upstream.json",
    "scripts/build.py",
    "scripts/verify.py",
    "scripts/check_word.py",
    "scripts/check_cycle.py",
    "examples/format-poem.txt",
    "tests/test_package.py",
    "tests/test_validator.py",
)


def extract_block(document: str, heading: str, language: str) -> bytes:
    sections = document.split(f"\n## {heading}\n")
    if len(sections) != 2:
        raise ValueError(f"document: expected one section titled {heading!r}")
    section = sections[1].split("\n## ", 1)[0]
    matches = re.findall(rf"^```{language}\n(.*?)^```\s*$", section, re.M | re.S)
    if len(matches) != 1:
        raise ValueError(f"document: expected one {language} block in {heading!r}")
    return matches[0].encode("utf-8")


def outputs(root: Path) -> dict[str, bytes]:
    provenance = json.loads((root / "upstream.json").read_text(encoding="utf-8"))
    for name in ("dictionary", "license"):
        entry = provenance["cmudict"][name]
        expected_path = {"dictionary": "cmudict.dict", "license": "CMUDICT-LICENSE.txt"}[name]
        if entry["path"] != expected_path:
            raise ValueError(f"upstream: unexpected {name} path")
        if hashlib.sha256((root / expected_path).read_bytes()).hexdigest() != entry["sha256"]:
            raise ValueError(f"{expected_path}: differs from the frozen upstream hash")

    document = (root / "sonnet-game.md").read_text(encoding="utf-8")
    dictionary_hash = provenance["cmudict"]["dictionary"]["sha256"]
    if dictionary_hash not in document:
        raise ValueError("document: missing frozen dictionary hash")
    generated = {
        path: extract_block(document, heading, language)
        for path, (heading, language) in GENERATED.items()
    }
    files = {}
    for path in sorted(ARTIFACTS):
        data = generated[path] if path in generated else (root / path).read_bytes()
        files[path] = {
            "url": path,
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }
    manifest = {
        "schema_version": 1,
        "package": "technocore-sonnet",
        "version": VERSION,
        "status": "draft",
        "entrypoint": "sonnet-game.md",
        "url_resolution": "Artifact URLs are relative to this manifest's URL.",
        "upstream": provenance,
        "files": files,
    }
    generated["manifest.json"] = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
    return generated


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="Refuse stale outputs without changing files")
    mode.add_argument("--archive", action="store_true", help="Also create a ZIP containing only package artifacts")
    args = parser.parse_args()
    try:
        expected = outputs(ROOT)
        stale = []
        for name, data in expected.items():
            path = ROOT / name
            if args.check:
                if not path.exists() or path.read_bytes() != data:
                    stale.append(name)
            else:
                path.write_bytes(data)
        if stale:
            raise ValueError("stale generated files: " + ", ".join(stale))
        if args.archive:
            destination = ROOT / "dist" / f"technocore-sonnet-{VERSION}.zip"
            destination.parent.mkdir(exist_ok=True)
            with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for name in sorted((*ARTIFACTS, "manifest.json")):
                    info = zipfile.ZipInfo(f"technocore-sonnet/{name}", date_time=(1980, 1, 1, 0, 0, 0))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    info.external_attr = 0o644 << 16
                    archive.writestr(info, (ROOT / name).read_bytes())
            print(f"Created {destination.relative_to(ROOT)}")
    except (OSError, ValueError, KeyError) as error:
        print(f"build: {error}", file=sys.stderr)
        return 1
    print("Generated files are current." if args.check else "Generated validator and manifest.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
