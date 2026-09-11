"""Run an explicitly supplied operator rehearsal against this public package.

The runner and its tests are maintained separately. Nothing is downloaded or
published by this launcher. Supply a trusted local runner and chat checkout.
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runner", type=Path, required=True, help="Trusted operator cycle.py")
    parser.add_argument("--chat-root", type=Path, required=True, help="Local chat source checkout")
    parser.add_argument("--python", default=sys.executable, help="Python with the runner dependencies")
    args = parser.parse_args()
    if not args.runner.is_file() or not (args.chat_root / "src" / "app.py").is_file():
        parser.error("runner and chat-root must exist locally")
    subprocess.run([sys.executable, str(ROOT / "scripts" / "verify.py")], check=True)
    result = subprocess.run(
        [args.python, str(args.runner.resolve()), "--package", str(ROOT),
         "--chat-root", str(args.chat_root.resolve())],
        cwd=ROOT, capture_output=True, text=True, timeout=300,
    )
    if result.returncode:
        sys.stderr.write(result.stderr)
        return result.returncode
    report = json.loads(result.stdout)
    if (report.get("status") != "passed" or report.get("mode") != "local-rehearsal"
            or report.get("completed_poems", 0) < 4 or report.get("finalists") != 3
            or report.get("external_effects") != "none"):
        raise ValueError("runner did not report a successful complete local rehearsal")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
