#!/bin/bash
# 网络恢复后立刻给所有账号跑一次，把断网期间错过的签到补上。
#
# 由 swms-catchup.path 监视 /opt/swms/state/catchup-wanted 触发，
# 需要 root（要 systemctl start 其它账号的单元），因此与探测脚本分开。
set -u

USERS_DIR=${SWMS_USERS_DIR:-/opt/swms/users}
STATE_DIR=${SWMS_STATE_DIR:-/opt/swms/state}
MARKER="${STATE_DIR}/catchup-wanted"
LOG="${STATE_DIR}/net.log"

# 没有标记就退出：手动 start 这个单元时也是安全的
[ -f "$MARKER" ] || exit 0
rm -f "$MARKER"

now=$(date '+%F %T')
n=0
for d in "$USERS_DIR"/*/; do
  u=$(basename "$d")
  [ -f "$d/config.json" ] || continue
  systemctl start --no-block "swms-checkin@${u}.service" >/dev/null 2>&1 && n=$((n + 1))
  # 稍微错开，避免所有账号同时登录把 CAS 打满
  sleep 3
done

echo "[$now] 补签已触发 $n 个账号" >> "$LOG"
echo "catch-up triggered for ${n} account(s)" >&2
