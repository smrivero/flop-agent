# Close Call on the VPS: paper service, deploy, monitoring, backups

Nothing here has been run. Every block is written to be pasted as-is.
- **Mac** means the flop-agent repo root on your Mac.
- **VPS** means `root@srv792559`.

**Paper only.**
- `CLOSECALL_MODE=paper`: fake keys, no signing, no writes to Technocore.
- The build refuses `live` with exit 3, and systemd does not restart it after that.
- The installer also refuses an env file that says `live`.

## Layout

| path | what | owner / mode |
|---|---|---|
| `/opt/flop-closecall` | code (rsync from the Mac), separate from the git checkout `/opt/flop-agent` | root, read-only for the service |
| `/etc/flop-closecall/closecall.env` | config (see `closecall.env.example`); never in git; the installer never overwrites it | root:flopcc 0640 |
| `/var/lib/flop-closecall/` | `close-call.sqlite3` (+ WAL), `logs/`, `keys/`, `backups/`, `closecall.lock` | flopcc 0700, files 0600 (`UMask=0077`) |
| `/usr/local/lib/flop-closecall/node` | copy of root's nvm node (root's home is not readable by `flopcc`) | root 0755 |
| `/usr/local/bin/flop-closecall` | CLI wrapper: runs a command as flopcc with the service env | root 0755 |
| `/etc/systemd/system/flop-closecall.service` | the unit | root 0644 |

**The service:**
- runs as the system user `flopcc`, with `Restart=always`;
- stops gracefully on SIGTERM, with a 60 s timeout;
- does not restart on config error, live refused or lock held (exit 2, 3, 4);
- has a crash-loop guard of 10 starts in 10 minutes;
- is limited to `MemoryMax=768M`, `CPUQuota=80%` and `TasksMax=64`;
- runs with `ProtectSystem=strict` and can write only to `/var/lib/flop-closecall`.

**Single instance:**
- An O_EXCL pidfile plus a Linux abstract socket. A second `run` exits 4, and the wrapper refuses `run` altogether.

## 1. First deploy (Mac)

```bash
cd ~/Documents/GitHub/flop/flop-agent && DRY_RUN=1 VPS_HOST=srv792559 VPS_USER=root VPS_PATH=/opt/flop-closecall bash scripts/deploy-closecall.sh
```

Check the list: there should be no `.env`, `.technocore/`, `data/`, `*.sqlite3`, `research/` or `node_modules/`. Then:

```bash
cd ~/Documents/GitHub/flop/flop-agent && VPS_HOST=srv792559 VPS_USER=root VPS_PATH=/opt/flop-closecall bash scripts/deploy-closecall.sh
```

This runs rsync, then `npm ci` with root's nvm, then `install-closecall-service.sh`. **It does not start the service.** The installer:
- creates `flopcc` and the dirs;
- copies node;
- creates `/etc/flop-closecall/closecall.env` from the example if it is missing;
- installs the unit and the wrapper;
- enables the unit;
- runs `keys --validate`.

## 2. First start (VPS)

```bash
grep -E '^CLOSECALL_(MODE|DATA_DIR|HEALTH_HOST|HEALTH_PORT|CONFIRMATION_POLICY|STALE_POLICY)=' /etc/flop-closecall/closecall.env && systemctl start flop-closecall && sleep 10 && systemctl --no-pager status flop-closecall | head -15 && journalctl -u flop-closecall -n 30 --no-pager && flop-closecall health
```

Expected results:
- The journal starts with the `PAPER MODE` banner and `[CLOSECALL][LOCK] acquired`.
- `health` shows `"mode": "paper"`, `"execution_halted": false`, `"status": "ok"` and `process.lock.held: true`.
- The observer settles within about 1 minute.

## 3. Later deploys (Mac → VPS)

```bash
cd ~/Documents/GitHub/flop/flop-agent && VPS_HOST=srv792559 VPS_USER=root VPS_PATH=/opt/flop-closecall bash scripts/deploy-closecall.sh && ssh root@srv792559 'systemctl restart flop-closecall && sleep 10 && systemctl --no-pager status flop-closecall | head -12 && flop-closecall health'
```

A restart is safe:
- intents and write attempts are persisted before any network call;
- nonces and trade ids are persisted;
- on start, the fold replays the paper book and reconciles;
- a restart after a crash raises a `process_restart` alert (`clean_stop=0`).

## 4. Monitoring

**On the VPS (recommended): the terminal monitor.** It is read only: SQLite readonly, `/health`, `systemctl show`, never Technocore/Hyperliquid, never a write.

```bash
flop-closecall watch
```

- `flop-closecall watch --interval 2` refreshes every 2 s (default 5); Ctrl+C quits.
- `flop-closecall status` prints one snapshot; `status --json` gives the machine snapshot.
- Same from the code dir: `cd /opt/flop-closecall && npm run closecall:watch` (it reads `/etc/flop-closecall/closecall.env` for the data dir).
- `--no-color` or `NO_COLOR=1` for plain text.

### From the Mac (optional)

| what | command |
|---|---|
| service state | `ssh root@srv792559 systemctl --no-pager status flop-closecall` |
| live log (human) | `ssh root@srv792559 journalctl -u flop-closecall -f` |
| last hour | `ssh root@srv792559 journalctl -u flop-closecall --since '1 hour ago' --no-pager` |
| health (all fields) | `ssh root@srv792559 flop-closecall health` |
| status / positions / leaderboard | `ssh root@srv792559 flop-closecall status` (or `positions`, `leaderboard`) |
| pending writes/intents | `ssh root@srv792559 flop-closecall pending` |
| keys / key dir perms | `ssh root@srv792559 flop-closecall keys --validate` |
| report (estimate error, triggers, voids) | `ssh root@srv792559 flop-closecall report` |
| structured log (JSONL) | `ssh root@srv792559 'tail -f /var/lib/flop-closecall/logs/events-$(date -u +%F).jsonl'` |

**HTTP health through a tunnel.** The server listens on 127.0.0.1 only and never on a public interface. Open the tunnel:

```bash
ssh -N -L 8787:127.0.0.1:8787 root@srv792559
```

Then, in another Mac terminal:

```bash
curl -s localhost:8787/health | python3 -m json.tool && curl -s localhost:8787/metrics | head -40
```

**`flop-status.sh`.** Add these lines to the existing script on the VPS:

```bash
echo "== flop-closecall ==" ; systemctl is-active flop-closecall ; flop-closecall health 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["status"], d["mode"], "halted=%s" % d["execution_halted"], "sweep=%s delay=%smin age=%ss" % (d["sweep"]["last_received"], d["sweep"]["referee_delay_min"], d["sweep"]["last_age_s"]), "hl_age=%ss" % d["hyperliquid"]["age_s"], "pending=%s" % d["pending_writes"], "L1=%s" % d["reconciliation"]["l1"]); [print("  HALT", h["kind"], h["severity"], h["code"], h["reason"]) for h in d["halts"]]'
```

**Safe mode.**
- `"execution_halted": true` means the observer is still running but no new paper decisions are made.
- Transient halts clear themselves: referee stale, HL stale, disk low.
- Grave halts need you: reconcile mismatch, DB corruption, room ownership, nonce conflict, ambiguous operation.
- Clearing a grave halt takes the code shown in `health.halts[].code`, which is also in the journal line `HALTED: ... (manual: unhalt --code X)`:

```bash
ssh root@srv792559 'flop-closecall status | head -30 && flop-closecall unhalt --code <CODE>'
```

## 5. Backups

| what | how | where | frequency |
|---|---|---|---|
| SQLite (state, intents, nonces, trades, positions, alerts) | `db.backup()` online while the service runs, then `integrity_check` | `/var/lib/flop-closecall/backups/close-call-*.sqlite3`, keep 48 | hourly (cron) |
| keys + env (owner keys needed to **sign the prize claim**) | tar piped to `age -r <your public key>`; **only if** `CLOSECALL_BACKUP_AGE_RECIPIENT` is set, otherwise not copied at all | `/var/lib/flop-closecall/backups/secrets-*.tar.age` | same cron |
| strategy config | lives in git (`src/close-call`) + `/etc/flop-closecall/closecall.env` (inside the encrypted archive) | — | — |
| off-host copy | **you** pull it from the Mac; no script pushes anywhere | `~/flop-closecall-backups/` on the Mac | daily |

**Rules:**
- Private keys are never in SQLite and never in logs.
- They are never copied in plaintext, and never to a destination the script did not name.
- The age identity (private) lives only on your Mac; the VPS holds only the recipient (public).
- Losing the owner keys means a winner cannot sign the prize claim. The encrypted off-host copy is mandatory **before** any real key exists.

**One-time setup on the Mac.** It is required before the first real key exists, and it needs `brew install age`.

```bash
mkdir -p ~/.config/age && age-keygen -o ~/.config/age/flop-closecall.txt && chmod 600 ~/.config/age/flop-closecall.txt && grep 'public key' ~/.config/age/flop-closecall.txt
```

Put the `age1...` public key in `CLOSECALL_BACKUP_AGE_RECIPIENT=` in `/etc/flop-closecall/closecall.env`, and run `apt-get install -y age` on the VPS.

**Cron on the VPS**, hourly, at minute 7 so it doesn't land on a boundary:

```bash
( crontab -l 2>/dev/null | grep -v closecall-backup.sh ; echo '7 * * * * /bin/bash /opt/flop-closecall/scripts/closecall-backup.sh >> /var/lib/flop-closecall/logs/backup.log 2>&1' ) | crontab - && crontab -l | grep closecall
```

**Pull to the Mac:**

```bash
mkdir -p ~/flop-closecall-backups && chmod 700 ~/flop-closecall-backups && rsync -av root@srv792559:/var/lib/flop-closecall/backups/ ~/flop-closecall-backups/
```

**Restore check**, which never touches the live DB. On the VPS, it checks the newest backup:

```bash
bash /opt/flop-closecall/scripts/closecall-restore-check.sh
```

On the Mac, for a pulled SQLite copy:

```bash
cd ~/Documents/GitHub/flop/flop-agent && LOCAL=1 bash scripts/closecall-restore-check.sh "$(ls -1t ~/flop-closecall-backups/close-call-*.sqlite3 | head -1)"
```

On the Mac, for the secrets archive. It decrypts into a private temp dir, checks every key, prints the
**VERIFY CODE** and deletes the copy:

```bash
cd ~/Documents/GitHub/flop/flop-agent && LOCAL=1 AGE_IDENTITY=~/.config/age/flop-closecall.txt bash scripts/closecall-restore-check.sh "$(ls -1t ~/flop-closecall-backups/secrets-*.tar.age | head -1)"
```

**Real restore on the VPS.** Stop the service, copy the file, check it, start:

```bash
systemctl stop flop-closecall && cp -a /var/lib/flop-closecall/close-call.sqlite3 /var/lib/flop-closecall/backups/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).sqlite3 && rm -f /var/lib/flop-closecall/close-call.sqlite3-wal /var/lib/flop-closecall/close-call.sqlite3-shm && install -m 0600 -o flopcc -g flopcc /var/lib/flop-closecall/backups/close-call-<STAMP>.sqlite3 /var/lib/flop-closecall/close-call.sqlite3 && flop-closecall restore-check /var/lib/flop-closecall/close-call.sqlite3 && systemctl start flop-closecall
```

## 5b. Backup gate: required before any real key

`keygen` and every live write stay refused until this passes. You run it once now, and again after each
key generation.

1. **VPS:** a backup with the recipient already in the env.

```bash
bash /opt/flop-closecall/scripts/closecall-backup.sh && flop-closecall keys --gate
```

2. **Mac:** pull the backup and check it.

```bash
mkdir -p ~/flop-closecall-backups && chmod 700 ~/flop-closecall-backups && rsync -av root@srv792559:/var/lib/flop-closecall/backups/ ~/flop-closecall-backups/ && cd ~/Documents/GitHub/flop/flop-agent && LOCAL=1 AGE_IDENTITY=~/.config/age/flop-closecall.txt bash scripts/closecall-restore-check.sh "$(ls -1t ~/flop-closecall-backups/secrets-*.tar.age | head -1)"
```

3. **VPS:** paste the archive name and the VERIFY CODE printed on the Mac.

```bash
flop-closecall keys --backup-verify --archive secrets-<STAMP>.tar.age --code <VERIFY CODE> && flop-closecall live status
```

`live status` must show `backup_gate.ok: true`.

## 5c. Live preparation (the writer is NOT connected)

| what | command (VPS) |
|---|---|
| live DB, keys, room, gate, pending, halts | `flop-closecall live status` |
| full bootstrap simulation (in memory, throwaway keys, faults) | `flop-closecall live bootstrap --dry-run --faults --miss-first` |
| real bootstrap | `flop-closecall live bootstrap` refuses (exit 3) in this build |
| generate real keys (gate required; do **not** run yet) | `flop-closecall live keygen --total 2 --i-understand-these-are-real-keys` |

## 6. Stop / uninstall

Stopping:

```bash
systemctl stop flop-closecall && systemctl --no-pager status flop-closecall | head -5
```

Uninstalling leaves the data and the env:

```bash
systemctl disable --now flop-closecall && rm -f /etc/systemd/system/flop-closecall.service /usr/local/bin/flop-closecall && systemctl daemon-reload
```
