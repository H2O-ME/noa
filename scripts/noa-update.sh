#!/usr/bin/env bash
# 把部署目录拉到 origin 的最新提交，必要时重建并重启。
#
# 由 deploy/noa-update.timer 驱动（默认 5 分钟一跳）。三条底线：
#
#   1. commit 没变就什么都不做。一个每 5 分钟醒一次的定时器不该顺手把一个正在
#      服务的 bot 重启一遍——重启会断开 QQ 网关连接，代价由用户承担。
#   2. 构建失败绝不重启。旧 dist 还能用，坏构建上线才是真事故。失败时把工作树
#      退回上一个已知可用的 commit **并重建它**（否则 dist 里会留下半新半旧的
#      产物，下次崩溃重启就会加载一个拼出来的运行时），同时记下这个坏 SHA，
#      免得每 5 分钟重试同一个坏提交、白烧 CPU。
#   3. 同一时刻只有一个实例。构建可能比定时器周期还长，两个 git 同时改一棵树
#      是会出事的（flock）。
#
# 失败一律写 journal（SyslogIdentifier 见 deploy/noa-update.service），不静默。
set -euo pipefail

REPO_DIR="${NOA_REPO_DIR:-/opt/noa}"
BRANCH="${NOA_BRANCH:-master}"
STATE_DIR="${NOA_UPDATE_STATE:-/var/lib/noa-update}"
SERVICE="${NOA_SERVICE:-noa}"
LOCK_FILE="$STATE_DIR/lock"
BAD_SHA_FILE="$STATE_DIR/last-failed-sha"

log() { printf '%s noa-update: %s\n' "$(date -Is)" "$*"; }

mkdir -p "$STATE_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another run holds the lock, skipping"
  exit 0
fi

cd "$REPO_DIR"
# 幂等：目录属主若不是运行用户（例如部署包解出来带着开发机的 uid），git 会以
# "dubious ownership" 拒绝一切操作。重复写入同一个值是安全的。
git config --global --add safe.directory "$REPO_DIR" 2>/dev/null || true

before=$(git rev-parse HEAD)
git fetch --quiet --prune origin "$BRANCH"
target=$(git rev-parse "origin/$BRANCH")

if [ "$before" = "$target" ]; then
  log "already at ${before:0:7}, nothing to do"
  exit 0
fi

if [ -f "$BAD_SHA_FILE" ] && [ "$(cat "$BAD_SHA_FILE")" = "$target" ]; then
  log "origin/$BRANCH is ${target:0:7}, which already failed to build — not retrying until it moves"
  exit 0
fi

log "updating ${before:0:7} -> ${target:0:7}"

# --ff-only 而不是 pull 的默认行为：绝不自动合并，也绝不自动丢弃本地改动。
# 仓库里出现本地改动只可能是有人（或 agent）手动改了部署目录，那种事要看一眼，
# 不是让定时器半夜把它 reset 掉。
if ! git merge --ff-only "origin/$BRANCH"; then
  log "FF-ONLY FAILED: the working tree cannot fast-forward; leaving it untouched"
  git status --short | head -20
  exit 1
fi

if ! pnpm install --frozen-lockfile; then
  log "pnpm install failed; rolling back to ${before:0:7}"
  git reset --hard --quiet "$before"
  echo "$target" >"$BAD_SHA_FILE"
  exit 1
fi

if ! pnpm build; then
  log "BUILD FAILED at ${target:0:7}; rolling back to ${before:0:7} and rebuilding that"
  git reset --hard --quiet "$before"
  echo "$target" >"$BAD_SHA_FILE"
  pnpm build || log "REBUILD OF ${before:0:7} ALSO FAILED — dist is now inconsistent, fix by hand"
  exit 1
fi

rm -f "$BAD_SHA_FILE"
systemctl restart "$SERVICE"
log "restarted $SERVICE at ${target:0:7}"
