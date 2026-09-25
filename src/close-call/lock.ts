/**
 * Single-instance process lock. Two layers:
 *
 *  1. A lock file created with O_EXCL ('wx') holding {pid, host, bootId, startedAt}.
 *     An existing file only blocks us if its process is alive on this host and boot
 *     (and, on Linux, its /proc/<pid>/cmdline is a close-call process, so a reused
 *     PID does not keep a dead lock alive). A stale file is replaced.
 *  2. On Linux, an abstract-namespace UNIX socket named after the data directory.
 *     The kernel releases it the instant the process dies, whatever the lock file
 *     says, and a second process cannot bind it. Not available on macOS (dev only).
 *
 * systemd runs one unit instance; this lock is what also stops a manual `npm run
 * closecall:paper` from running beside the service against the same data directory.
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { createServer, type Server } from "node:net";
import { hostname, platform } from "node:os";

export class LockHeldError extends Error {}

export interface LockInfo { pid: number; host: string; bootId: string | null; startedAt: string; cmd: string }

function bootId(): string | null {
  try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch { return null; }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

function looksLikeCloseCall(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("close-call");
  } catch {
    return true; // no /proc (macOS): trust liveness alone
  }
}

export function readLock(path: string): LockInfo | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as LockInfo; } catch { return null; }
}

function held(info: LockInfo | null): boolean {
  if (!info || info.host !== hostname()) return false;
  const boot = bootId();
  if (boot && info.bootId && boot !== info.bootId) return false;
  return alive(info.pid) && looksLikeCloseCall(info.pid);
}

async function bindAbstractSocket(path: string): Promise<Server | null> {
  if (platform() !== "linux") return null;
  const name = "\0flop-closecall-" + createHash("sha256").update(path).digest("hex").slice(0, 24);
  return new Promise((resolveP, reject) => {
    const srv = createServer();
    srv.once("error", (e) => reject(new LockHeldError(`another close-call process holds the kernel lock (${(e as Error).message})`)));
    srv.listen({ path: name }, () => resolveP(srv));
  });
}

export async function acquireLock(path: string, cmd = process.argv.slice(1).join(" ")): Promise<{ info: LockInfo; release: () => void }> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const socket = await bindAbstractSocket(path);
  const info: LockInfo = { pid: process.pid, host: hostname(), bootId: bootId(), startedAt: new Date().toISOString(), cmd };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, JSON.stringify(info));
      closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const cur = readLock(path);
        if (cur && cur.pid === info.pid && cur.startedAt === info.startedAt) { try { unlinkSync(path); } catch { /* gone */ } }
        socket?.close();
      };
      process.once("exit", release);
      return { info, release };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") { socket?.close(); throw e; }
      const other = readLock(path);
      if (held(other)) {
        socket?.close();
        throw new LockHeldError(`close-call already running: pid ${other!.pid} on ${other!.host} since ${other!.startedAt} (${path})`);
      }
      try { unlinkSync(path); } catch { /* raced */ }
    }
  }
  socket?.close();
  throw new LockHeldError(`could not acquire ${path}`);
}

export function lockStatus(path: string): { present: boolean; held: boolean; info: LockInfo | null } {
  const info = existsSync(path) ? readLock(path) : null;
  return { present: !!info, held: held(info), info };
}
