#!/usr/bin/env bash
# Run ON THE VPS, as root, from the deployed code dir:
#   sudo bash /opt/flop-closecall/scripts/install-closecall-service.sh
# Idempotent. Creates user/dirs, copies the node binary, installs the unit and the ctl wrapper.
# NEVER overwrites /etc/flop-closecall/closecall.env and never touches data in /var/lib/flop-closecall.
# Does NOT start the service unless CLOSECALL_START=1.
set -euo pipefail
APP="${APP:-/opt/flop-closecall}"
SVC_USER=flopcc
ETC=/etc/flop-closecall
DATA=/var/lib/flop-closecall
LIBDIR=/usr/local/lib/flop-closecall
UNIT=/etc/systemd/system/flop-closecall.service

[ "$(id -u)" -eq 0 ] || { echo "must run as root" >&2; exit 1; }
[ -f "$APP/src/close-call/cli.ts" ] || { echo "no code at $APP (run deploy-closecall.sh first)" >&2; exit 1; }

# 1. node binary readable by the service user. Source: NODE_SRC, else the node on root's PATH (nvm).
NODE_SRC="${NODE_SRC:-$(command -v node || true)}"
[ -x "$NODE_SRC" ] || { echo "node not found; export NODE_SRC=/root/.nvm/versions/node/vXX/bin/node" >&2; exit 1; }
# Close Call runs ONLY on this Node (TCLK workers keep nvm's default 20.15). Override on purpose only.
WANT_NODE="${CLOSECALL_NODE_VERSION:-v24.21.0}"
[ "$("$NODE_SRC" -v)" = "$WANT_NODE" ] || { echo "Close Call needs node $WANT_NODE, NODE_SRC is $("$NODE_SRC" -v): run 'nvm use ${WANT_NODE#v}' first" >&2; exit 1; }
install -d -m 0755 "$LIBDIR"
if ! cmp -s "$NODE_SRC" "$LIBDIR/node"; then install -m 0755 "$NODE_SRC" "$LIBDIR/node"; echo "node $("$LIBDIR/node" -v) -> $LIBDIR/node"; fi

# 2. system user
if ! id "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
  echo "created user $SVC_USER"
fi

# 3. dirs (never chmod -R the data: only the top levels)
install -d -m 0700 -o "$SVC_USER" -g "$SVC_USER" "$DATA" "$DATA/keys" "$DATA/backups" "$DATA/logs"
install -d -m 0750 -o root -g "$SVC_USER" "$ETC"

# 4. env file: create once, never overwrite
if [ ! -f "$ETC/closecall.env" ]; then
  install -m 0640 -o root -g "$SVC_USER" "$APP/deploy/closecall/closecall.env.example" "$ETC/closecall.env"
  echo "created $ETC/closecall.env from the example (review it)"
else
  chown root:"$SVC_USER" "$ETC/closecall.env"; chmod 0640 "$ETC/closecall.env"
  echo "kept existing $ETC/closecall.env"
fi
if grep -Eq '^\s*CLOSECALL_MODE\s*=\s*live' "$ETC/closecall.env"; then
  echo "REFUSING: $ETC/closecall.env sets CLOSECALL_MODE=live. This build is paper-only." >&2; exit 1
fi

# 5. code: root-owned, readable by the service, not writable by it
chown -R root:root "$APP"
chmod -R u=rwX,go=rX "$APP"
command -v python3 >/dev/null || { echo "python3 missing (apt-get install -y python3)" >&2; exit 1; }
# Close Call runs on its OWN dependency set (deploy/closecall/package.json: better-sqlite3 13 N-API, tsx),
# not the repo's package.json that Node 20 workers share. $APP/node_modules is a symlink to it.
RT="$APP/deploy/closecall/node_modules"
[ -d "$RT/better-sqlite3" ] || { echo "Close Call runtime missing: cd $APP/deploy/closecall && npm ci (with nvm use 24.21.0)" >&2; exit 1; }
if [ -e "$APP/node_modules" ] && [ ! -L "$APP/node_modules" ]; then rm -rf "$APP/node_modules"; echo "removed the old repo-wide node_modules from $APP"; fi
ln -sfn "$RT" "$APP/node_modules"
( cd "$APP" && "$LIBDIR/node" -e '
  const v = require("better-sqlite3/package.json").version;
  if (Number(v.split(".")[0]) < 13) { console.error("better-sqlite3 " + v + " aborts on Node >= 24.19: need 13+"); process.exit(1); }
  const D = require("better-sqlite3"); new D(":memory:").prepare("select 1").get();
  console.log("runtime OK: node " + process.version + ", better-sqlite3 " + v);' ) || exit 1
( cd "$APP" && "$LIBDIR/node" --import tsx -e 'console.log("tsx OK")' ) || { echo "tsx does not load" >&2; exit 1; }

# 6. unit + wrapper
install -m 0644 "$APP/deploy/closecall/flop-closecall.service" "$UNIT"
# The LIVE unit is installed but never enabled or started here: that is a manual step after live-check PASS.
install -m 0644 "$APP/deploy/closecall/flop-closecall-live.service" /etc/systemd/system/flop-closecall-live.service
install -m 0755 "$APP/scripts/closecall-ctl.sh" /usr/local/bin/flop-closecall
systemctl daemon-reload
systemctl enable flop-closecall.service >/dev/null
systemd-analyze verify "$UNIT" || true

# 7. key dir check (does not generate anything)
/usr/local/bin/flop-closecall keys --validate || echo "keys --validate reported problems (expected while no real keys exist)"

if [ "${CLOSECALL_START:-0}" = "1" ]; then systemctl restart flop-closecall.service; sleep 5; systemctl --no-pager status flop-closecall.service | head -15; else
  echo "installed, NOT started. Start with: systemctl start flop-closecall"; fi
