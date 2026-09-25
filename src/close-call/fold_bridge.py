"""JSON-lines bridge to the OFFICIAL close-1 fold (vendored, unmodified close_call_fold.py).

Started by src/close-call/fold.ts as `python3 fold_bridge.py <vendor_root>`. One JSON request per line on stdin,
one JSON response per line on stdout. It never touches the network. Every number crosses the boundary as a
decimal string, and inside it is the fold's own Decimal arithmetic at the same 60-digit precision replay() uses.

ops:
  hash                                   -> sha256 of the fold file it imported
  reset {config}                         -> new Fold (contest.json fold settings)
  seed {px}
  sweep {n, ref, close, owners, trades}  -> the fold's own sweep() result
  check {n, ref, close, owners, trades}  -> same, on a deep copy (state unchanged)
  accounts {keys, mark}                  -> cash, lots, fees, position, value_at(mark) per key
  final {px}                             -> the fold's final() table
"""
import copy
import hashlib
import json
import sys
from decimal import Decimal, localcontext
from pathlib import Path

VENDOR = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(VENDOR))
import close_call_fold as official  # noqa: E402

FOLD_FILE = VENDOR / "close_call_fold.py"
FOLD_SHA = hashlib.sha256(FOLD_FILE.read_bytes()).hexdigest()
state = {"fold": None}


def dec(x):
    return str(x) if isinstance(x, Decimal) else x


def handle(req):
    op = req["op"]
    if op == "hash":
        return {"sha256": FOLD_SHA, "file": str(FOLD_FILE)}
    if op == "reset":
        state["fold"] = official.Fold(req.get("config") or None)
        return {"ok": True}
    fold = state["fold"]
    if fold is None:
        raise ValueError("reset first")
    with localcontext() as ctx:
        ctx.prec = 60
        if op == "seed":
            fold.seed(req["px"])
            return {"ok": True}
        if op in ("sweep", "check"):
            target = copy.deepcopy(fold) if op == "check" else fold
            return target.sweep(req["n"], req["ref"], req["close"], req.get("owners", []), req.get("trades", []))
        if op == "accounts":
            mark = Decimal(req["mark"]) if req.get("mark") else None
            out = {}
            for k in req.get("keys") or list(fold.accounts):
                a = fold.accounts.get(k)
                if a is None:
                    continue
                out[k] = {"cash": dec(a.cash), "fees": dec(a.fees), "position": dec(a.position),
                          "lots": [[dec(q), dec(p)] for q, p in a.lots],
                          "value": dec(a.value_at(mark)) if mark is not None else None}
            return {"accounts": out, "sweep_n": fold.sweep_n, "fees": dec(fold.fees), "settled": len(fold.settled)}
        if op == "final":
            return copy.deepcopy(fold).final(req["px"])
    raise ValueError(f"unknown op {op!r}")


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("rid")
            res = {"rid": rid, "ok": True, "result": handle(req)}
        except Exception as e:  # report, never crash the bridge
            res = {"rid": rid, "ok": False, "error": f"{type(e).__name__}: {e}"}
        sys.stdout.write(json.dumps(res) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
