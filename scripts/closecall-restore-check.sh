#!/usr/bin/env bash
# Verifies that the newest (or a given) backup can be restored, WITHOUT touching the live database.
#   ON THE VPS:  bash /opt/flop-closecall/scripts/closecall-restore-check.sh [backup.sqlite3]
#   ON THE MAC:  LOCAL=1 bash scripts/closecall-restore-check.sh ~/flop-closecall-backups/close-call-....sqlite3
# Copies the backup to a temp dir, runs integrity_check + schema/table counts, opens it with the CLI's
# own migrations (on the copy). A secrets-*.tar.age archive is checked ON THE MAC only (the age identity
# never goes to the VPS):  LOCAL=1 AGE_IDENTITY=~/.config/age/flop.txt bash scripts/closecall-restore-check.sh secrets-....tar.age
set -euo pipefail
FILE="${1:-}"
if [ "${LOCAL:-0}" = "1" ]; then
  [ -n "$FILE" ] || { echo "usage: LOCAL=1 $0 <backup.sqlite3 | secrets.tar.age>" >&2; exit 2; }
  case "$FILE" in *.tar.age)
    : "${AGE_IDENTITY:?set AGE_IDENTITY to your age identity file}"
    RT=$(mktemp -d); chmod 700 "$RT"; trap 'rm -rf "$RT"' EXIT
    age -d -i "$AGE_IDENTITY" "$FILE" | tar -C "$RT" -xf -
    KD=$(ls -d "$RT"/var/lib/flop-closecall*/keys 2>/dev/null | head -1)
    [ -n "$KD" ] && [ -d "$KD" ] || { echo "no keys directory in the archive" >&2; exit 1; }
    npx tsx src/close-call/live/cli-live.ts restore-verify "$KD"
    # Disaster-recovery drill: rebuild the live data dir from this archive alone (+ the pulled backups folder)
    # and run the readiness gate OFFLINE against it. Nothing is written anywhere but this temp dir.
    DB=$(ls -1t "$RT"/var/lib/flop-closecall*/backups/close-call-*.sqlite3 2>/dev/null | head -1)
    ENVF=$(ls "$RT"/etc/flop-closecall/closecall-live.env 2>/dev/null || true)
    if [ -n "$DB" ] && [ -n "$ENVF" ]; then
      D="$RT/drill"; install -d -m 700 "$D" "$D/backups"
      cp -a "$KD" "$D/keys"; chmod 700 "$D/keys"; install -m 600 "$DB" "$D/live.sqlite3"
      cp -a "$(dirname "$FILE")"/secrets-*.tar.age "$(dirname "$FILE")"/secrets-*.manifest.json "$D/backups/" 2>/dev/null || true
      echo "== disaster-recovery drill on the rebuilt state in $D (offline; nothing references the original machine) =="
      ( set -a; . "$ENVF"; set +a
        CLOSECALL_DATA_DIR="$D" CLOSECALL_DB_PATH="$D/live.sqlite3" CLOSECALL_LIVE_DB_PATH="$D/live.sqlite3" CLOSECALL_LOCK_PATH="$D/live.lock" \
          npx tsx src/close-call/live/cli-live.ts restore-drill --archive "$D/backups/$(basename "$FILE")" ) || true
    else
      echo "(no live DB snapshot / env in this archive: key check only)"
    fi
    echo "decrypted copy deleted on exit. Paste the VERIFY CODE on the VPS:"
    echo "  flop-closecall --live keys --backup-verify --archive $(basename "$FILE") --code <VERIFY CODE>"
    exit 0;; esac
  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
  cp "$FILE" "$TMP/restore.sqlite3"
  npx tsx src/close-call/cli.ts restore-check "$TMP/restore.sqlite3"
  CLOSECALL_DATA_DIR="$TMP" CLOSECALL_DB_PATH="$TMP/restore.sqlite3" npx tsx src/close-call/cli.ts status >/dev/null && echo "status on restored copy: OK"
  exit 0
fi
DATA=/var/lib/flop-closecall
[ -n "$FILE" ] || FILE=$(ls -1t "$DATA"/backups/close-call-*.sqlite3 2>/dev/null | head -1)
[ -n "$FILE" ] && [ -f "$FILE" ] || { echo "no backup found in $DATA/backups" >&2; exit 1; }
TMPD="$DATA/backups/.restore-check"
rm -rf "$TMPD"; install -d -m 0700 -o flopcc -g flopcc "$TMPD"
install -m 0600 -o flopcc -g flopcc "$FILE" "$TMPD/restore.sqlite3"
trap 'rm -rf "$TMPD"' EXIT
/usr/local/bin/flop-closecall restore-check "$TMPD/restore.sqlite3"
echo "backup OK: $FILE ($(du -h "$FILE" | cut -f1))"
