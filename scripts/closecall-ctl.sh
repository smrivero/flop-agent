#!/usr/bin/env bash
# Installed as /usr/local/bin/flop-closecall. Runs a close-call CLI command on the VPS as the service user.
#
# PAPER (env /etc/flop-closecall/closecall.env, data /var/lib/flop-closecall):
#   flop-closecall watch [--interval N] [--no-color] | status [--json] | health | positions | leaderboard
#   flop-closecall keys [--validate] | pending | report | reconcile | backup [--keep N] | restore-check <file>
#   flop-closecall unhalt --code <code> | bootstrap-plan
# LIVE (env /etc/flop-closecall/closecall-live.env, data /var/lib/flop-closecall-live) -- never the paper state:
#   flop-closecall live-check [--offline]                 THE gate: every live precondition, read only
#   flop-closecall --live watch | status | backup | keys --gate | keys --backup-canary | keys --backup-verify ...
#   flop-closecall live status | keygen --role admin|staging|strategy --total N --i-understand-these-are-real-keys
#   flop-closecall live bootstrap --dry-run [...] | bootstrap [--loop]      (the real bootstrap refuses until connected)
# Service commands (run/paper/observe/live run) are refused here: use systemctl.
set -euo pipefail
APP=/opt/flop-closecall
PAPER_ENV=/etc/flop-closecall/closecall.env
LIVE_ENV=/etc/flop-closecall/closecall-live.env
NODE=/usr/local/lib/flop-closecall/node
ENV_FILE=$PAPER_ENV
FORCE_DATA=/var/lib/flop-closecall            # paper: pinned; live: taken from its env file (its own dir)
if [ "${1:-}" = "--live" ]; then ENV_FILE=$LIVE_ENV; FORCE_DATA=""; shift; fi
for a in "$@"; do if [ "$a" = "--live" ]; then ENV_FILE=$LIVE_ENV; FORCE_DATA=""; fi; done      # watch --live / status --live
cmd="${1:-status}"
case "$cmd" in
  run|paper|observe|dry-run) echo "use: systemctl start|restart flop-closecall  (this wrapper never starts a service)" >&2; exit 2 ;;
  live) [ "${2:-}" = "run" ] && { echo "use: systemctl start flop-closecall-live" >&2; exit 2; } ;;
esac
[ "$(id -u)" -eq 0 ] || { echo "run as root (it drops to flopcc)" >&2; exit 2; }
cd "$APP"
ENTRY=src/close-call/cli.ts; ARGS=("$@")
if [ "$cmd" = "live" ]; then ENV_FILE=$LIVE_ENV; FORCE_DATA=""; ENTRY=src/close-call/live/cli-live.ts; ARGS=("${@:2}"); fi
if [ "$cmd" = "live-check" ]; then ENV_FILE=$LIVE_ENV; FORCE_DATA=""; ENTRY=src/close-call/live/cli-live.ts; ARGS=(check "${@:2}"); fi
[ -r "$ENV_FILE" ] || { echo "no $ENV_FILE (install it first)" >&2; exit 2; }
exec setpriv --reuid=flopcc --regid=flopcc --init-groups -- \
  env -i PATH=/usr/bin:/bin HOME=/var/lib/flop-closecall TERM="${TERM:-dumb}" ${NO_COLOR+NO_COLOR=1} FORCE_DATA="$FORCE_DATA" CLOSECALL_ENV_FILE="$ENV_FILE" \
  bash -c 'set -a; . "$0"; set +a; [ -n "$FORCE_DATA" ] && export CLOSECALL_DATA_DIR="$FORCE_DATA"; umask 077; exec "$1" --import tsx "${@:2}"' \
  "$ENV_FILE" "$NODE" "$ENTRY" "${ARGS[@]}"
