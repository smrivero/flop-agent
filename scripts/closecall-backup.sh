#!/usr/bin/env bash
# Run ON THE VPS as root (cron-friendly):  bash /opt/flop-closecall/scripts/closecall-backup.sh
#
# PAPER: online SQLite backup of the paper DB (no secrets), rotated.
# LIVE (only once /etc/flop-closecall/closecall-live.env exists):
#   1. online SQLite backup of live.sqlite3 (keys' dids/roles, live_trades, nonces, write journal, strategy state,
#      room state, halts) -- consistent snapshot, integrity-checked;
#   2. ONLY if CLOSECALL_BACKUP_AGE_RECIPIENT (an age PUBLIC key) is set: one encrypted archive holding everything
#      needed to continue on a new machine -- the live key files + canary, the live env, and that DB snapshot:
#      tar | age -r <recipient> > secrets-<ts>.tar.age, then `keys --record-backup` writes its manifest.
#   Without a recipient the keys are NOT copied anywhere. Nothing leaves the VPS from this script: pull from the Mac.
set -euo pipefail
KEEP="${CLOSECALL_BACKUP_KEEP:-48}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
umask 077

/usr/local/bin/flop-closecall backup --keep "$KEEP"

LIVE_ENV=/etc/flop-closecall/closecall-live.env
[ -r "$LIVE_ENV" ] || { echo "no live env: paper backup only"; exit 0; }
LIVE=$(set -a; . "$LIVE_ENV"; echo "${CLOSECALL_DATA_DIR:-/var/lib/flop-closecall-live}")
RECIPIENT=$(set -a; . "$LIVE_ENV"; echo "${CLOSECALL_BACKUP_AGE_RECIPIENT:-}")
/usr/local/bin/flop-closecall --live backup --keep "$KEEP"
if [ -z "$RECIPIENT" ]; then echo "CLOSECALL_BACKUP_AGE_RECIPIENT empty: live keys NOT backed up (by design)."; exit 0; fi
command -v age >/dev/null || { echo "age not installed (apt-get install -y age); live keys NOT backed up" >&2; exit 1; }
case "$RECIPIENT" in age1*) ;; *) echo "CLOSECALL_BACKUP_AGE_RECIPIENT must be an age1... public key" >&2; exit 1;; esac
/usr/local/bin/flop-closecall --live keys --backup-canary >/dev/null
DBSNAP=$(ls -1t "$LIVE"/backups/close-call-*.sqlite3 | head -1)
STARTED=$(date +%s%3N)
OUT="$LIVE/backups/secrets-$STAMP.tar.age"
tar -C / -cf - "${LIVE#/}/keys" "${LIVE_ENV#/}" "${DBSNAP#/}" | age -r "$RECIPIENT" -o "$OUT.tmp"
mv "$OUT.tmp" "$OUT"; chown flopcc:flopcc "$OUT"; chmod 0600 "$OUT"
/usr/local/bin/flop-closecall --live keys --record-backup "$OUT" --started "$STARTED"
for old in $(ls -1t "$LIVE"/backups/secrets-*.tar.age 2>/dev/null | tail -n +"$((KEEP + 1))"); do
  /usr/local/bin/flop-closecall --live keys --gate 2>/dev/null | grep -q "\"archive\": \"$(basename "$old")\"" && continue   # never prune the verified one
  rm -f "$old" "${old%.tar.age}.manifest.json"
done
echo "encrypted keys + env + live DB: $OUT"
echo "  -> Mac: rsync -av root@$(hostname):$LIVE/backups/ ~/flop-closecall-backups/ && LOCAL=1 AGE_IDENTITY=~/.config/age/flop-closecall.txt bash scripts/closecall-restore-check.sh ~/flop-closecall-backups/$(basename "$OUT")"
echo "  -> VPS: flop-closecall --live keys --backup-verify --archive $(basename "$OUT") --code <VERIFY CODE>"
