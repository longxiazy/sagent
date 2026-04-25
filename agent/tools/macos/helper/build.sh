#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$SCRIPT_DIR/bin"
mkdir -p "$OUT_DIR"

xcrun swiftc \
  -O \
  "$SCRIPT_DIR/MacOSAgentHelper.swift" \
  -o "$OUT_DIR/macos-agent-helper"

echo "Built helper at $OUT_DIR/macos-agent-helper"
