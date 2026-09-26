#!/usr/bin/env bash
# Installed as /usr/local/bin/flop-closecall. Runs a close-call CLI command on the VPS as the
# service user, with the service's env file, against the service's data dir.
#   flop-closecall watch [--interval N] [--no-color]   live terminal monitor (read only; Ctrl+C quits)
#   flop-closecall status [--json] | health | positions | leaderboard | keys [--validate] | pending | report
#   flop-closecall reconcile | backup [--keep N] | restore-check <file> | unhalt --code <code> | bootstrap-plan
#   flop-closecall keys --gate | --backup-canary | --backup-verify --archive <name> --code <code>
#   flop-closecall live status | keygen --total N --i-understand-these-are-real-keys | bootstrap --dry-run
#   (the real `live bootstrap` refuses in this build: the live writer is not connected)
# Service commands (run/paper/observe/dry-run) are refused here: use systemctl.
set -euo pipefail
APP=/opt/flop-closecall
ENV_FILE=/etc/flop-closecall/closecall.env
NODE=/usr/local/lib/flop-closecall/node
cmd="${1:-status}"
case "$cmd" in
  run|paper|observe|dry-run) echo "use: systemctl start|restart flop-closecall  (this wrapper never starts a second instance)" >&2; exit 2 ;;
esac
[ "$(id -u)" -eq 0 ] || { echo "run as root (it drops to flopcc)" >&2; exit 2; }
cd "$APP"
ENTRY=src/close-call/cli.ts; ARGS=("$@")
if [ "$cmd" = "live" ]; then ENTRY=src/close-call/live/cli-live.ts; ARGS=("${@:2}"); fi
exec setpriv --reuid=flopcc --regid=flopcc --init-groups -- \
  env -i PATH=/usr/bin:/bin HOME=/var/lib/flop-closecall TERM="${TERM:-dumb}" ${NO_COLOR+NO_COLOR=1} \
  bash -c 'set -a; . "$0"; set +a; export CLOSECALL_DATA_DIR=/var/lib/flop-closecall; umask 077; exec "$1" --import tsx "${@:2}"' \
  "$ENV_FILE" "$NODE" "$ENTRY" "${ARGS[@]}"
