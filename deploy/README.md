# 多用户部署（Linux / systemd）

直接可用的 systemd 单元，配合 README 的[多用户 / 多实例部署](../README.md#多用户--多实例部署)章节。

```
deploy/systemd/
  swms-checkin@.service    模板服务：一个实例 = 一个学号
  swms-checkin@.timer      每 30 分钟触发，用户之间随机错开最多 5 分钟
  swms-netcheck.sh         网络自检：断网落盘，恢复后立刻补签
  swms-netcheck.service
  swms-netcheck.timer      每 10 分钟一次
```

## 安装

```bash
# 1. 程序与账号目录（脚本目录里不要放 config.json）
sudo mkdir -p /opt/swms/app /opt/swms/users
sudo cp -r checkin.mjs lib templates.json package.json /opt/swms/app/
sudo chown -R swms:swms /opt/swms/app /opt/swms/users

# 2. 每个学号一份配置，靠 WorkingDirectory 区分
sudo mkdir -p /opt/swms/users/2024000001
sudo install -m 600 config.json /opt/swms/users/2024000001/config.json
sudo chown -R swms:swms /opt/swms/users

# 3. 单元
sudo install -m 644 deploy/systemd/swms-checkin@.service /etc/systemd/system/
sudo install -m 644 deploy/systemd/swms-checkin@.timer   /etc/systemd/system/
sudo install -m 755 deploy/systemd/swms-netcheck.sh      /opt/swms/netcheck.sh
sudo install -m 644 deploy/systemd/swms-netcheck.service /etc/systemd/system/
sudo install -m 644 deploy/systemd/swms-netcheck.timer   /etc/systemd/system/
sudo systemctl daemon-reload

# 4. 每个学号启用一个定时器
sudo systemctl enable --now swms-checkin@2024000001.timer
sudo systemctl enable --now swms-netcheck.timer
```

## 为什么用 `SuccessExitStatus=2`

`checkin.mjs` 用退出码 `2` 表示「当前无需签到」——这是正常结果，不是故障。
单元里不写 `SuccessExitStatus=2` 的话，每次没任务 systemd 都会把服务标成 `failed`。

## 为什么要有网络自检

单机部署最常见的漏签原因不是代码，而是**虚拟机/服务器断网**（DHCP 变更、
虚拟网卡被禁用、宿主机睡眠）。断网期间每 30 分钟的重试全部失败，
而恢复后要等到下一个 30 分钟周期才会重试，可能正好错过窗口末尾。

`swms-netcheck` 每 10 分钟确认一次 DNS 与 CAS 可达性：

- 正常：什么都不做
- 断网：把时间点写进 `/opt/swms/state/net.log`（此时也发不出邮件）
- 恢复：立即 `systemctl start` 所有账号的服务，把错过的补上

```bash
cat /opt/swms/state/net.state   # 当前状态：up/down + 时间戳
cat /opt/swms/state/net.log     # 断网/恢复历史
```
