#!/usr/bin/env bash
# Run ON THE VPS as root (cron-friendly):  bash /opt/flop-closecall/scripts/closecall-backup.sh
# 1. Online SQLite backup (db.backup + integrity_check), rotated (CLOSECALL_BACKUP_KEEP, default 48).
# 2. Keys + env: ONLY if CLOSECALL_BACKUP_AGE_RECIPIENT (an age public key) is set -> encrypted .tar.age.
#    Without a recipient the keys are NOT copied anywhere. Nothing ever leaves the VPS from this script:
#    pull the files from the Mac with the scp command printed at the end.
set -euo pipefail
ENV_FILE=/etc/flop-closecall/closecall.env
DATA=/var/lib/flop-closecall
set -a; . "$ENV_FILE"; set +a
KEEP="${CLOSECALL_BACKUP_KEEP:-48}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
umask 077

/usr/local/bin/flop-closecall backup --keep "$KEEP"

if [ -n "${CLOSECALL_BACKUP_AGE_RECIPIENT:-}" ]; then
  command -v age >/dev/null || { echo "age not installed (apt-get install -y age); keys NOT backed up" >&2; exit 1; }
  case "$CLOSECALL_BACKUP_AGE_RECIPIENT" in age1*) ;; *) echo "CLOSECALL_BACKUP_AGE_RECIPIENT must be an age1... public key" >&2; exit 1;; esac
  /usr/local/bin/flop-closecall keys --backup-canary >/dev/null
  STARTED=$(date +%s%3N)
  OUT="$DATA/backups/secrets-$STAMP.tar.age"
  tar -C / -cf - "${DATA#/}/keys" "${ENV_FILE#/}" | age -r "$CLOSECALL_BACKUP_AGE_RECIPIENT" -o "$OUT.tmp"
  mv "$OUT.tmp" "$OUT"; chown flopcc:flopcc "$OUT"; chmod 0600 "$OUT"
  /usr/local/bin/flop-closecall keys --record-backup "$OUT" --started "$STARTED"
  for old in $(ls -1t "$DATA"/backups/secrets-*.tar.age 2>/dev/null | tail -n +"$((KEEP + 1))"); do
    # never prune the archive the backup gate is currently verified against
    /usr/local/bin/flop-closecall keys --gate 2>/dev/null | grep -q "\"archive\": \"$(basename "$old")\"" && continue
    rm -f "$old" "${old%.tar.age}.manifest.json"
  done
  echo "encrypted keys+env: $OUT  -> check it on the Mac (closecall-restore-check.sh), then: flop-closecall keys --backup-verify --archive $(basename "$OUT") --code <VERIFY CODE>"
else
  echo "CLOSECALL_BACKUP_AGE_RECIPIENT empty: keys/env NOT backed up (by design)."
fi
echo "pull from the Mac:  scp 'root@$(hostname):$DATA/backups/*' ~/flop-closecall-backups/"
