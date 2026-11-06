#!/usr/bin/env bash
# install.sh — link this repository into the Antigravity plugin directory.
# Uses a symlink and never deletes a real directory. Safe to re-run.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HOME/.gemini/config/plugins/pro-flash-orchestrator"

if [ -e "$TARGET" ] && [ ! -L "$TARGET" ]; then
  if [ "$(cd "$TARGET" 2>/dev/null && pwd)" = "$SRC" ]; then
    echo "已经在该位置运行，无需安装：$TARGET"
    exit 0
  fi
  echo "目标是一个真实目录，已停止以免误删：$TARGET" >&2
  echo "请先手动备份 / 删除后重试。" >&2
  exit 1
fi

mkdir -p "$(dirname "$TARGET")"
ln -sfn "$SRC" "$TARGET"

echo "已挂载：$TARGET"
echo "        -> $SRC"

if ! command -v node >/dev/null 2>&1; then
  echo "警告：PATH 中找不到 node，Hook 将静默失效。" >&2
else
  echo "下一步：node \"$TARGET/scripts/doctor.mjs\""
fi
