/**
 * Optional local, READ-ONLY health server: GET /health, /status, /metrics. Binds 127.0.0.1 by default
 * (config refuses 0.0.0.0 unless explicitly allowed); reach it from a Mac with an SSH tunnel:
 *   ssh -L 8787:127.0.0.1:8787 <vps>   then   curl http://127.0.0.1:8787/health
 * No endpoint changes state, and nothing served contains keys, signatures or message bodies.
 */

import { createServer, type Server } from "node:http";
import type { Health } from "./health.js";
import { metrics } from "./health.js";

export function startHealthServer(host: string, port: number, getHealth: () => Health, getStatus: () => unknown): Promise<Server> {
  const srv = createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405, { allow: "GET" }).end("read-only\n");
      return;
    }
    try {
      if (req.url === "/health") {
        const h = getHealth();
        res.writeHead(h.status === "ok" ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify(h, null, 2));
      } else if (req.url === "/status") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(getStatus(), null, 2));
      } else if (req.url === "/metrics") {
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(metrics(getHealth()));
      } else {
        res.writeHead(404).end("GET /health | /status | /metrics\n");
      }
    } catch (e) {
      res.writeHead(500).end(`error: ${(e as Error).message}\n`);
    }
  });
  return new Promise((resolveP, reject) => {
    srv.once("error", reject);
    srv.listen(port, host, () => resolveP(srv));
  });
}
