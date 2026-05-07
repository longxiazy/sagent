#!/usr/bin/env bash
# notify-approve.sh — 监听 Agent SSE 流，审批请求弹出 macOS 原生对话框
#
# 用法:
#   ./notify-approve.sh [run_id]           # 监听指定 run（不传则自动获取活跃 run）
#   ./notify-approve.sh auto               # 持续轮询，自动监听活跃 run
#
# 依赖: curl, osascript (macOS 自带)

set -euo pipefail

HOST="${SAGENT_HOST:-http://127.0.0.1:3001}"
RUN_ID="${1:-}"

approve() {
  local run_id="$1" approval_id="$2"
  curl -s -X POST "$HOST/api/agent/approvals" \
    -H 'Content-Type: application/json' \
    -d "{\"runId\":\"$run_id\",\"approvalId\":\"$approval_id\",\"decision\":\"approve\"}" \
    | python3 -c "import sys,json; print('✅ 已批准' if json.load(sys.stdin).get('ok') else '❌ 批准失败')"
}

reject() {
  local run_id="$1" approval_id="$2"
  curl -s -X POST "$HOST/api/agent/approvals" \
    -H 'Content-Type: application/json' \
    -d "{\"runId\":\"$run_id\",\"approvalId\":\"$approval_id\",\"decision\":\"reject\"}" \
    | python3 -c "import sys,json; print('⛔ 已拒绝' if json.load(sys.stdin).get('ok') else '❌ 拒绝失败')"
}

show_dialog() {
  local run_id="$1" approval_id="$2" message="$3" action_json="$4"
  # 截断过长内容
  local display_msg
  display_msg=$(echo "$message" | head -5 | cut -c1-300)
  local result
  result=$(osascript -e "display dialog \"$display_msg\" with title \"Agent 审批请求\" buttons {\"拒绝\", \"批准\"} default button \"批准\" cancel button \"拒绝\"" 2>/dev/null)
  if [[ "$result" == *"批准"* ]]; then
    echo "  → 批准"
    approve "$run_id" "$approval_id"
  else
    echo "  → 拒绝"
    reject "$run_id" "$approval_id"
  fi
}

# 获取活跃 run
get_active_run() {
  curl -s "$HOST/api/agent/active" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if d.get('active'):
    print(d['runId'])
else:
    print('')
"
}

listen_stream() {
  local run_id="$1"
  echo "🎧 监听 run=$run_id ..."
  curl -sN "$HOST/api/agent/stream/$run_id" | while IFS= read -r line; do
    # SSE 格式: "data: {json}"
    if [[ "$line" != data:* ]]; then
      continue
    fi
    local json="${line#data: }"

    # 提取事件类型
    local event_type
    event_type=$(echo "$json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('type',''))" 2>/dev/null || echo "")

    if [[ "$event_type" == "approval_required" ]]; then
      echo "🔔 收到审批请求"
      local approval_id message action_str
      approval_id=$(echo "$json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('approvalId',''))" 2>/dev/null)
      message=$(echo "$json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message',''))" 2>/dev/null)
      action_str=$(echo "$json" | python3 -c "import sys,json; a=json.load(sys.stdin).get('action',{}); print(f\"{a.get('tool','')}.{a.get('type','')}\")" 2>/dev/null)
      echo "  approvalId=$approval_id action=$action_str"
      echo "  message: $message"
      show_dialog "$run_id" "$approval_id" "$message" "$action_str"
    elif [[ "$event_type" == "done" ]]; then
      echo "✅ 任务完成"
      break
    elif [[ "$event_type" == "error" ]]; then
      echo "❌ 任务失败"
      break
    elif [[ "$event_type" == "cancelled" ]]; then
      echo "⛔ 任务已取消"
      break
    fi
  done
}

# 主逻辑
if [[ -z "$RUN_ID" || "$RUN_ID" == "auto" ]]; then
  echo "🔍 轮询活跃任务..."
  while true; do
    rid=$(get_active_run)
    if [[ -n "$rid" ]]; then
      listen_stream "$rid"
      echo ""
      echo "🔍 继续轮询..."
    fi
    sleep 3
  done
else
  listen_stream "$RUN_ID"
fi
