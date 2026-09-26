/**
 * LIVE ONLY wrapper: the readiness gate (../readiness.ts, the single implementation) plus the one check that needs
 * key material in memory -- every key file reloads and self-tests (sign + verify). Nothing is printed or stored.
 */

import type { CloseCallConfig } from "../config.js";
import type { Contest } from "../contest.js";
import { listKeys } from "../keys.js";
import { liveReadiness as core, renderReadiness, type ReadinessDeps, type ReadinessMode } from "../readiness.js";
import { loadSigners } from "./keygen.js";

export { renderReadiness };

export function liveReadiness(cfg: CloseCallConfig, contest: Contest, mode: ReadinessMode = "check", deps: ReadinessDeps = {}) {
  return core(cfg, contest, mode, {
    ...deps,
    signerCheck: (db) => {
      const real = listKeys(db).filter((k) => k.fake === 0);
      try { const s = loadSigners(db, cfg.keysDir); return { ok: s.size === real.length, detail: `${s.size} loaded and self-tested` }; } catch (e) { return { ok: false, detail: (e as Error).message }; }
    },
  });
}
