#!/bin/bash
# 网络自检：确认本机能访问学校 CAS。
#
#   · 正常时不做任何事，只在状态翻转时写一行日志；
#   · 断网时在本地记下时间点（此时发不出邮件，只能落盘）；
#   · 从「断」恢复到「通」的瞬间，立即触发所有账号补签，不用等下个 30 分钟周期。
#
# 由 swms-netcheck.timer 每 10 分钟调用一次，需要 root（要 systemctl start 其它单元）。
set -u

APP_DIR=${SWMS_APP_DIR:-/opt/swms/app}
USERS_DIR=${SWMS_USERS_DIR:-/opt/swms/users}
STATE_DIR=${SWMS_STATE_DIR:-/opt/swms/state}
PROBE="${APP_DIR}/checkin.mjs"

STATE_FILE="${STATE_DIR}/net.state"
LOG="${STATE_DIR}/net.log"
mkdir -p "$STATE_DIR"

now=$(date '+%F %T')
epoch=$(date +%s)

ok=1
reason=""
if ! getent hosts cas.kmyz.edu.cn >/dev/null 2>&1; then
  ok=0
  reason="DNS 解析 cas.kmyz.edu.cn 失败"
fi
if [ "$ok" = 1 ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://cas.kmyz.edu.cn/lyuapServer/login 2>/dev/null)
  if [ "$code" != "200" ]; then
    ok=0
    reason="CAS 返回 HTTP $code"
  fi
fi

prev_line=$(cat "$STATE_FILE" 2>/dev/null || echo "unknown 0")
prev_state=${prev_line%% *}
prev_epoch=${prev_line##* }

if [ "$ok" = 1 ]; then
  if [ "$prev_state" != "up" ]; then
    echo "up $epoch" > "$STATE_FILE"
    echo "[$now] 网络恢复（之前状态：$prev_state）" >> "$LOG"

    if [ "$prev_state" = "down" ]; then
      dur=$(( epoch - prev_epoch ))
      echo "[$now] 本次断网约 $(( dur / 60 )) 分钟，立即补签所有账号" >> "$LOG"
      n=0
      for d in "$USERS_DIR"/*/; do
        u=$(basename "$d")
        [ -f "$d/config.json" ] || continue
        systemctl start --no-block "swms-checkin@${u}.service" >/dev/null 2>&1 && n=$((n + 1))
        # 稍微错开，避免同时登录把 CAS 打满
        sleep 3
      done
      echo "[$now] 已触发 $n 个账号补签" >> "$LOG"
    fi
  fi

  # 日志保留最近 500 行
  if [ -f "$LOG" ]; then
    tail -n 500 "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
  fi
  exit 0
fi

if [ "$prev_state" != "down" ]; then
  echo "down $epoch" > "$STATE_FILE"
  echo "[$now] 网络中断：$reason" >> "$LOG"
fi
exit 1
