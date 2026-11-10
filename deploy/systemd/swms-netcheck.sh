#!/bin/bash
# 网络自检：确认本机能连上学校的统一认证服务器（CAS）。
#
# 域名**不写死**在脚本里，由 SWMS_CAS_HOST 提供（在 swms-netcheck.service 里设置）。
# 本脚本以普通用户运行，只做探测与记录：
#   · 正常时什么都不做，只在状态翻转时写一行日志；
#   · 断网时记下时间点（此时也发不出邮件，只能落盘）；
#   · 恢复的瞬间写一个标记文件，由 swms-catchup.path 触发 root 侧补签。
set -u

CAS_HOST=${SWMS_CAS_HOST:-}
CAS_PATH=${SWMS_CAS_PATH:-/lyuapServer/login}
STATE_DIR=${SWMS_STATE_DIR:-/opt/swms/state}

if [ -z "$CAS_HOST" ]; then
  echo "SWMS_CAS_HOST 未设置，跳过 CAS 可达性探测。" >&2
  echo "请在 swms-netcheck.service 里设置 Environment=SWMS_CAS_HOST=<统一认证域名>" >&2
  # 用 2 而不是 1：1 在 SuccessExitStatus 里被当作正常，配置缺失应当让服务标红才看得见
  exit 2
fi

STATE_FILE="${STATE_DIR}/net.state"
LOG="${STATE_DIR}/net.log"
MARKER="${STATE_DIR}/catchup-wanted"
mkdir -p "$STATE_DIR"

now=$(date '+%F %T')
epoch=$(date +%s)

ok=1
reason=""
if ! getent hosts "$CAS_HOST" >/dev/null 2>&1; then
  ok=0
  reason="DNS 解析 ${CAS_HOST} 失败"
fi
if [ "$ok" = 1 ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://${CAS_HOST}${CAS_PATH}" 2>/dev/null)
  if [ "$code" != "200" ]; then
    ok=0
    reason="CAS 返回 HTTP ${code}"
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
      echo "[$now] 本次断网约 $(( dur / 60 )) 分钟，请求补签所有账号" >> "$LOG"
      : > "$MARKER"
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
