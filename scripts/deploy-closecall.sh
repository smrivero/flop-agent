#!/usr/bin/env bash
# Run FROM THE MAC, in the flop-agent repo root:
#   VPS_HOST=srv792559 VPS_USER=root VPS_PATH=/opt/flop-closecall bash scripts/deploy-closecall.sh
# Copies code only. Never copies .env, identities, keys, databases, logs, node_modules or research data,
# and never deletes anything under data/ on the VPS (data actually lives in /var/lib/flop-closecall).
# DRY_RUN=1 shows what would change without changing anything.
set -euo pipefail
: "${VPS_HOST:?set VPS_HOST}"; VPS_USER="${VPS_USER:-root}"; VPS_PATH="${VPS_PATH:-/opt/flop-closecall}"
case "$VPS_PATH" in /opt/flop-agent|/opt/flop-agent/) echo "refusing: $VPS_PATH is the git-managed flop-agent checkout; use /opt/flop-closecall" >&2; exit 1;; /|"") exit 1;; esac
[ -f src/close-call/cli.ts ] || { echo "run from the flop-agent repo root" >&2; exit 1; }
TARGET="$VPS_USER@$VPS_HOST"
RSYNC_FLAGS=(-az --delete --itemize-changes)
[ "${DRY_RUN:-0}" = "1" ] && RSYNC_FLAGS+=(--dry-run)

ssh "$TARGET" "mkdir -p '$VPS_PATH'"
rsync "${RSYNC_FLAGS[@]}" \
  --filter='P data/***' --filter='P node_modules/***' \
  --include='.env.example' --exclude='.git/' --exclude='.env' --exclude='.env.*' \
  --exclude='.technocore/' --exclude='identity*.json' --exclude='keys/' --exclude='*.key' --exclude='*.pem' \
  --exclude='data/' --exclude='.data/' --exclude='node_modules/' --exclude='dist/' \
  --exclude='*.sqlite3' --exclude='*.sqlite3-*' --exclude='*.db' --exclude='events-*.jsonl' --exclude='logs/' \
  --exclude='research/' --exclude='.claude/' --exclude='.DS_Store' --exclude='scratchpad/' \
  ./ "$TARGET:$VPS_PATH/"
[ "${DRY_RUN:-0}" = "1" ] && { echo "dry run: nothing changed"; exit 0; }

# Remote: install deps with root's nvm node, then re-run the idempotent installer (does not start/restart).
ssh "$TARGET" "bash -lc 'set -e; export NVM_DIR=/root/.nvm; . \$NVM_DIR/nvm.sh >/dev/null; cd $VPS_PATH && npm ci --no-audit --no-fund && bash scripts/install-closecall-service.sh'"
echo "deployed to $TARGET:$VPS_PATH. Restart when ready: ssh $TARGET systemctl restart flop-closecall"
