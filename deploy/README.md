# 多用户部署（Linux / systemd）

直接可用的 systemd 单元，配合 README 的[多用户 / 多实例部署](../README.md#多用户--多实例部署)章节。

```
deploy/systemd/
  swms-checkin@.service    模板服务：一个实例 = 一个学号
  swms-checkin@.timer      每 30 分钟触发，用户之间随机错开最多 5 分钟

  swms-netcheck.sh         网络探测（普通用户运行，只读）
  swms-netcheck.service
  swms-netcheck.timer      每 10 分钟一次

  swms-catchup.sh          恢复后补签（root）
  swms-catchup.service
  swms-catchup.path        监视标记文件，出现即触发 catchup
```

## 安装

```bash
# 1. 程序与账号目录（脚本目录里不要放 config.json）
sudo mkdir -p /opt/swms/app /opt/swms/users
sudo cp -r checkin.mjs lib templates.json package.json /opt/swms/app/
sudo chown -R swms:swms /opt/swms/app /opt/swms/users

# 2. 状态目录：探测脚本以 swms 身份运行，需要可写
sudo install -d -o swms -g swms /opt/swms/state

# 3. 每个学号一份配置，靠 WorkingDirectory 区分
sudo mkdir -p /opt/swms/users/2024000001
sudo install -m 600 config.json /opt/swms/users/2024000001/config.json
sudo chown -R swms:swms /opt/swms/users

# 4. 单元与脚本
sudo install -m 644 deploy/systemd/swms-checkin@.service /etc/systemd/system/
sudo install -m 644 deploy/systemd/swms-checkin@.timer   /etc/systemd/system/
sudo install -m 755 deploy/systemd/swms-netcheck.sh      /opt/swms/netcheck.sh
sudo install -m 755 deploy/systemd/swms-catchup.sh       /opt/swms/catchup.sh
sudo install -m 644 deploy/systemd/swms-netcheck.service /etc/systemd/system/
sudo install -m 644 deploy/systemd/swms-netcheck.timer   /etc/systemd/system/
sudo install -m 644 deploy/systemd/swms-catchup.service  /etc/systemd/system/
sudo install -m 644 deploy/systemd/swms-catchup.path     /etc/systemd/system/
sudo systemctl daemon-reload

# 5. 告诉探测脚本要访问哪个统一认证域名（不要写进脚本）
sudo systemctl edit --full swms-netcheck.service
#   把 Environment=SWMS_CAS_HOST= 改成你学校的域名，例如
#   Environment=SWMS_CAS_HOST=cas.example.edu.cn

# 6. 启用
sudo systemctl enable --now swms-checkin@2024000001.timer
sudo systemctl enable --now swms-netcheck.timer
sudo systemctl enable --now swms-catchup.path

# 7. 验证配置有没有被读到（应能打印出你的域名）
sudo systemctl show swms-netcheck.service -p Environment
```

## 为什么用 `SuccessExitStatus=2`

`checkin.mjs` 用退出码 `2` 表示「当前无需签到」——这是正常结果，不是故障。
单元里不写 `SuccessExitStatus=2` 的话，每次没任务 systemd 都会把服务标成 `failed`。

同理，`swms-netcheck` 用 `1` 表示「当前探测不通」（断网是预期状态，用
`SuccessExitStatus=1` 放过），而 `2` 表示「没配置 `SWMS_CAS_HOST`」——这种情况
**故意不放进 SuccessExitStatus**，让服务标红，避免配置缺失却悄无声息。

## 为什么把探测和补签拆开

补签要 `systemctl start` 其它账号的单元，必须有 root；但每 10 分钟跑一次的探测
不需要任何特权，让它跟着 root 跑没必要。

所以拆成两半：探测以 `User=swms` 运行，只在网络恢复时创建一个标记文件；
`swms-catchup.path` 监视这个文件，出现后由 root 的 `swms-catchup.service` 补签。

## 为什么要网络自检

单机部署最常见的漏签原因不是代码，而是**虚拟机/服务器断网**（DHCP 变更、
虚拟网卡被禁用、宿主机睡眠）。断网期间每 30 分钟的重试全部失败，
而恢复后要等到下一个 30 分钟周期才会重试，可能正好错过窗口末尾。

`swms-netcheck` 每 10 分钟确认一次 DNS 与 CAS 可达性：

- 正常：什么都不做
- 断网：把时间点写进 `/opt/swms/state/net.log`（此时也发不出邮件）
- 恢复：立刻触发所有账号补签

```bash
cat /opt/swms/state/net.state   # 当前状态：up/down + 时间戳
cat /opt/swms/state/net.log     # 断网/恢复历史
```

```
[2026-11-02 15:37:51] 网络中断：CAS 返回 HTTP 000
[2026-11-02 15:47:51] 网络恢复（之前状态：down）
[2026-11-02 15:47:51] 本次断网约 10 分钟，请求补签所有账号
[2026-11-02 15:47:51] 补签已触发 10 个账号
```
