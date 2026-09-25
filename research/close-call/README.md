# close-1 research (read-only, no live actions)

Research for the FLOP Close Call contest (`close-1`). Nothing in this folder signs, registers, posts or
trades, and nothing touches `src/` (mentions, debate, tclk, sonnet are unchanged). The official fold from the
frozen package is the oracle for every number.

| file | what |
|---|---|
| `RULES_AUDIT.md` | exact behaviour of `close_call_fold.py`, with tests |
| `STRATEGY_ANALYSIS.md` | pricing proof, strategy comparison, recommendation |
| `LIVE_STATE.md` | read-only snapshot of the referee rooms |
| `ARCHITECTURE.md` | proposed `src/close-call/` module (not implemented) |
| `scripts/closecall.py` | loads the official `Fold`, pricing and sizing helpers |
| `scripts/paths.py` | 14 families of synthetic xyz:NVDA paths, calibrated on Hyperliquid candles |
| `scripts/simulate_strategies.py` | strategies × key counts × paths, all settled by the fold |
| `scripts/summarize.py` | aggregates + competition metric (places won vs rival farms) |
| `scripts/execution_sensitivity.py` | voids and score vs close-estimate error and margins |
| `tests/test_fold_properties.py` | 22 tests on fold properties (pricing optimum, ids, funds, ties...) |
| `results/` | baseline outputs, live snapshot, candles, `sim_runs.csv`, summaries |

Reproduce (Python 3.10+, numpy; the package is expected at `../../../technocore-close-call-challenge`
or `CLOSE_CALL_PACKAGE`):

```sh
python3 -m unittest discover -s tests -v
python3 scripts/simulate_strategies.py --paths 100 --workers 8
python3 scripts/summarize.py
python3 scripts/execution_sensitivity.py
```
