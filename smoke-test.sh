#!/usr/bin/env bash
# R2R 集成冒烟测试
# 针对本机五个 Agent：main / dev / test / ba / pm
# 前提：Gateway 已运行，agent-r2r 插件已 loaded
#
# 用法：bash plugins/agent-r2r/smoke-test.sh

set -euo pipefail

PASS=0
FAIL=0

GREEN='\033[0;32m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $1"; PASS=$((PASS+1)); }
fail() { echo -e "  ${RED}✗${NC} $1"; FAIL=$((FAIL+1)); }
info() { echo -e "  ${CYAN}·${NC} $1"; }

gcall() {
  openclaw gateway call "$1" --json --params "$2" 2>/dev/null
}

jget() {
  echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d$2)" 2>/dev/null || echo "0"
}

jget_queue() {
  echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['pendingQueues'].get('$2',0))" 2>/dev/null || echo "0"
}

assert_eq() {
  [ "$2" = "$3" ] && ok "$1" || fail "$1 (expected=$3, got=$2)"
}

assert_ok() {
  [ "$(jget "$2" "['ok']")" = "True" ] && ok "$1" || fail "$1"
}

r2r_send() {
  local from="$1" to="$2" theme="$3" purpose="$4" content="$5"
  local params
  params=$(python3 -c "
import json, sys
print(json.dumps({
  'fromAgent': '$from',
  'toAgent':   '$to',
  'body': {'themeId': '$theme', 'purpose': '$purpose', 'content': sys.argv[1]},
  'metadata': {'notifyUser': False}
}))" "$content")
  gcall r2r.send "$params"
}

# ── 1. 记录初始基线 ──────────────────────────────────────────────────────────
echo ""
echo "=== 1. 插件状态 & 基线 ==="

base=$(gcall r2r.status '{}')
assert_ok "r2r.status 可达" "$base"

base_total=$(jget "$base" "['totalPending']")
base_dev=$(jget_queue "$base" "dev")
base_ba=$(jget_queue "$base"  "ba")
base_pm=$(jget_queue "$base"  "pm")
base_main=$(jget_queue "$base" "main")

info "初始队列：total=$base_total  dev=$base_dev  ba=$base_ba  pm=$base_pm  main=$base_main"

# ── 2. main -> dev ───────────────────────────────────────────────────────────
echo ""
echo "=== 2. main -> dev：布置开发任务 ==="

res=$(r2r_send main dev sprint_001 request "请实现用户登录模块，截止周五")
assert_ok "r2r.send 成功" "$res"
mid=$(jget "$res" "['messageId']")
[ "$mid" != "0" ] && ok "返回 messageId: $mid" || fail "未返回 messageId"

# ── 3. main -> ba ────────────────────────────────────────────────────────────
echo ""
echo "=== 3. main -> ba：请求数据分析 ==="

res=$(r2r_send main ba report_001 request "请汇总本月 DAU/MAU 数据")
assert_ok "r2r.send 成功" "$res"

# ── 4. main -> pm ────────────────────────────────────────────────────────────
echo ""
echo "=== 4. main -> pm：发送产品需求 ==="

res=$(r2r_send main pm prd_001 request "请输出新版本 PRD，包含用户故事和验收标准")
assert_ok "r2r.send 成功" "$res"

# ── 5. test -> dev ───────────────────────────────────────────────────────────
echo ""
echo "=== 5. test -> dev：请求接口文档 ==="

res=$(r2r_send test dev sprint_001 request "需要登录模块接口文档，用于编写自动化测试")
assert_ok "r2r.send 成功" "$res"

# ── 6. 验证增量 ──────────────────────────────────────────────────────────────
echo ""
echo "=== 6. 验证队列增量（+4 条）==="

s2=$(gcall r2r.status '{}')
delta_total=$(( $(jget "$s2" "['totalPending']") - base_total ))
delta_dev=$(( $(jget_queue "$s2" "dev") - base_dev ))
delta_ba=$(( $(jget_queue "$s2"  "ba")  - base_ba ))
delta_pm=$(( $(jget_queue "$s2"  "pm")  - base_pm ))

assert_eq "新增消息总数 +4" "$delta_total" "4"
assert_eq "dev 新增 +2（main+test 各一条）" "$delta_dev" "2"
assert_eq "ba 新增 +1" "$delta_ba" "1"
assert_eq "pm 新增 +1" "$delta_pm" "1"

echo ""
echo "  当前各队列："
jget "$s2" "['pendingQueues']" | python3 -c "
import sys, ast
d = ast.literal_eval(sys.stdin.read())
for a, c in sorted(d.items()):
    print(f'    {a:8s}: {c} 条')
" 2>/dev/null || true

# ── 7. dev -> main 回复 ──────────────────────────────────────────────────────
echo ""
echo "=== 7. dev -> main：回复任务进展 ==="

res=$(r2r_send dev main sprint_001 response "已收到任务，预计周四完成，届时发接口文档")
assert_ok "r2r.send 成功" "$res"

# ── 8. ba -> main 回复 ───────────────────────────────────────────────────────
echo ""
echo "=== 8. ba -> main：回复分析结果 ==="

res=$(r2r_send ba main report_001 response "本月 DAU 均值 12.4k，MAU 89k，环比上涨 7%")
assert_ok "r2r.send 成功" "$res"

# ── 9. 最终状态 ──────────────────────────────────────────────────────────────
echo ""
echo "=== 9. 最终队列总览 ==="

final=$(gcall r2r.status '{}')
delta_final=$(( $(jget "$final" "['totalPending']") - base_total ))
delta_main_final=$(( $(jget_queue "$final" "main") - base_main ))

assert_eq "全程新增消息 +6（4发+2回）" "$delta_final" "6"
assert_eq "main 收到回复 +2（dev+ba）" "$delta_main_final" "2"

echo ""
echo "  最终各队列："
jget "$final" "['pendingQueues']" | python3 -c "
import sys, ast
d = ast.literal_eval(sys.stdin.read())
for a, c in sorted(d.items()):
    print(f'    {a:8s}: {c} 条')
" 2>/dev/null || true

# ── 结果 ─────────────────────────────────────────────────────────────────────
echo ""
echo "=== 结果：${PASS} passed, ${FAIL} failed ==="

if [ "$FAIL" -gt 0 ]; then
  echo "排查：确认 Gateway 运行中且插件已 loaded："
  echo "  openclaw plugins list | grep agent-r2r"
  exit 1
fi

echo ""
echo "Gateway 层验证通过。"
echo ""
echo "下一步：在 Channel 向各 Agent 发以下指令，验证工具端到端调用："
echo ""
echo "  → 对 dev  ：「调用 receive_r2r_messages，看有什么待处理任务」"
echo "  → 对 ba   ：「调用 receive_r2r_messages，看有什么待处理任务」"
echo "  → 对 pm   ：「调用 receive_r2r_messages，看有什么待处理任务」"
echo "  → 对 main ：「调用 receive_r2r_messages，看 dev 和 ba 的回复」"
echo ""
echo "预期：request 类消息被 dequeue 后自动 ACK 回送给发送方。"
