#!/usr/bin/env bash
# start.sh — 启动 ZLMeetServer 信令服务。
# 用法：在任意位置执行。
#   bash backend/scripts/linux/start.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BIN_DIR="$BACKEND_DIR/bin"
BINARY="$BIN_DIR/ZLMeetServer"
CONFIG="$BIN_DIR/conf/config.yaml"

if [[ ! -f "$BINARY" ]]; then
    echo "[错误] 未找到可执行文件: $BINARY" >&2
    echo "       请先执行: bash $SCRIPT_DIR/build.sh" >&2
    exit 1
fi

if [[ ! -f "$CONFIG" ]]; then
    echo "[错误] 未找到配置文件: $CONFIG" >&2
    echo "       请先执行: bash $SCRIPT_DIR/build.sh" >&2
    exit 1
fi

echo "==> 启动 ZLMeetServer"
echo "    二进制: $BINARY"
echo "    配置:   $CONFIG"
echo "    工作目录: $BIN_DIR"
echo ""

cd "$BIN_DIR"
exec ./ZLMeetServer -config conf/config.yaml
