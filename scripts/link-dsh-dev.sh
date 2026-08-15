#!/usr/bin/env bash
# 开发期类型解析：把本机全局安装的 DSH SDK 包链接进项目 node_modules。
# 正式发布时不依赖这些链接——运行时由 DSH profile 的 node_modules 解析。
set -euo pipefail

DSH_ROOT="${DSH_SDK_ROOT:-/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai}"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKGS=(
  cordis
  dsh-host-webserver
  dsh-system-prompt
  dsh-tools
  dsh-client-runtime
  dsh-client-connection
  dsh-client-ui-slots
  dsh-client-ui-settings
)

mkdir -p "$PROJECT_ROOT/node_modules/@deepseek-ai"
for pkg in "${PKGS[@]}"; do
  src="$DSH_ROOT/$pkg"
  dst="$PROJECT_ROOT/node_modules/@deepseek-ai/$pkg"
  if [ ! -e "$src" ]; then
    echo "! 缺少 SDK 包: $src（跳过）" >&2
    continue
  fi
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
    echo "= $pkg（已链接）"
    continue
  fi
  rm -f "$dst"
  ln -s "$src" "$dst"
  echo "+ $pkg -> $src"
done
