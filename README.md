# swms-auto-checkin

> 学工系统（智慧学工）**签到任务**自动打卡 —— 零依赖 Node.js。

[![CI](https://github.com/SqietonB/swms-auto-checkin/actions/workflows/ci.yml/badge.svg)](https://github.com/SqietonB/swms-auto-checkin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

自动完成「服务大厅 → 日常事务 → 签到任务 → 签到」的全流程：
识别验证码 → CAS 统一身份认证登录 → 查询签到任务 → 提交签到 → 发送邮件通知。

**不依赖** `npm install`、Python、Playwright/Puppeteer 或任何浏览器 —— 只用 Node 内置能力。
登录加密、验证码 OCR、SMTP 客户端都是自己实现的。


```
$ node checkin.mjs
[07:02:11] 复用已保存的会话（1 分钟前登录），跳过登录和验证码
[07:02:11] 邮件通知已启用 → me@qq.com（smtp.qq.com:465）
[07:02:11] 当前用户：学号 用户
[07:02:12] 共 10 个任务，可签到 1 个
[07:02:12] 沿用上次申报值（来自 晚检打卡 2026-10-22 22:00:00）：{"dkzp":"1","wd":"36","jszk":"1","yclx":"1"}
[07:02:12]   -> 晨检打卡 签到成功
[07:02:12] 完成：学号 用户 成功签到 1 个，失败 0 个。
[07:02:12] 邮件已发送 → me@qq.com（[签到成功] 学号 用户 · 晨检打卡）
```

## 特性

- **零依赖** —— 只需 Node.js 18+，`git clone` 后直接运行
- **邮件通知** —— 签到成功、失败、账号锁定、运行异常都会发邮件
- **会话复用** —— 登录后的 Cookie 缓存到本地，后续运行跳过登录和验证码，秒级完成
- **自动识别验证码** —— 内置字模 OCR，识别失败自动换一张重试
- **网络重试** —— 连接错误和 5xx 自动重试，偶发抖动不会导致失败
- **安全停锁** —— 检测到账号锁定立即停止，绝不延长锁定时间
- **健康申报沿用** —— 自动沿用你上次已签到记录里的申报值，不编造数据
- **多用户部署** —— 一个脚本目录服务多个账号，会话按学号隔离，见[多用户 / 多实例部署](#多用户--多实例部署)

## 快速开始

需要 **Node.js ≥ 18**（用到内置 `fetch`、`AbortSignal.timeout`、`node:test`）。

```bash
git clone https://github.com/SqietonB/swms-auto-checkin.git
cd swms-auto-checkin

cp config.example.json config.json
# 编辑 config.json，填入学号和密码，并按需修改位置、范围、健康申报和邮件通知
```

```json
{
  "username": "你的学号",
  "password": "你的密码",
  "location": "",
  "inRange": false,
  "health": {
    "dkzp": "1",
    "wd": "36",
    "jszk": "1",
    "yclx": "5"
  },
  "mail": {
    "host": "smtp.qq.com",
    "port": 465,
    "secure": true,
    "user": "你的邮箱@qq.com",
    "pass": "邮箱授权码",
    "to": ["你的邮箱@qq.com"]
  }
}
```

### 配置项

`config.json` 可直接从 `config.example.json` 复制。除账号和密码外，其余配置均可省略；
`mail` 段留空或删除即关闭邮件通知。

| 配置项 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `username` | 字符串 | 是 | 学号。可由命令行 `--user` 覆盖，也可用环境变量 `SWMS_USERNAME` 提供。 |
| `password` | 字符串 | 是 | 学工系统密码。可由命令行 `--pass` 覆盖，也可用环境变量 `SWMS_PASSWORD` 提供。 |
| `location` | 字符串 | 否 | 签到提交的位置 `wz`；省略或留空时为空字符串。可用 `--location "地址"` 覆盖。 |
| `inRange` | 布尔值 | 否 | 是否申报在签到范围内，对应 `sffwn`。仅设为 `true` 时提交 `1`，否则提交 `0`；命令行 `--in-range` / `--out-range` 可覆盖此值。 |
| `health` | 对象 | 否 | 健康申报答案。支持 `dkzp`、`wd`、`jszk`、`yclx` 四个字段；未配置的答案沿用最近一次已签到记录。 |
| `mail` | 对象 | 否 | 邮件通知配置，见[邮件通知](#邮件通知)。填了 `host` 和 `to` 就自动启用。 |

账号密码的取值优先级分别为：**命令行 > 环境变量 > `config.json`**。位置和范围的优先级为：**命令行 > `config.json` > 默认值**。健康申报只通过 `config.json` 的 `health` 设置；配置的字段会覆盖最近一次记录中的对应字段。

> 环境变量前缀为 `SWMS_`；旧前缀 `ZHGX_`（`ZHGX_USERNAME` / `ZHGX_PASSWORD` / `ZHGX_MAIL_*`）仍然可用，
> 两套同时设置时以 `SWMS_` 为准。

`health` 字段及可用值：

| 字段 | 含义 | 可选值 |
| --- | --- | --- |
| `dkzp` | 是否在校 | `"1"` 是，在学校；`"2"` 否，不在学校 |
| `wd` | 当前体温（℃） | 温度数字，例如 `"36"` |
| `jszk` | 现在精神状况如何 | `"1"` 好；`"2"` 一般；`"3"` 差 |
| `yclx` | 您是否有以下症状 | `"1"` 咳嗽；`"2"` 腹泻；`"4"` 流涕；`"5"` 以上都无 |

请如实填写健康信息。不要把真实密码提交到代码仓库；`config.json` 应仅保存在自己的运行环境中。

先看看当前任务状态（只读，不签到）：

```bash
node checkin.mjs --list
```

```
  午检打卡   2026-10-20 12:00:00 ~ 2026-10-20 14:30:00  已截止  未签到  [定位]
● 晚检打卡   2026-10-22 14:30:00 ~ 2026-10-22 22:00:00  进行中  已签到  [定位]
```

演练一次，确认要提交的内容，然后正式执行：

```bash
node checkin.mjs --dry-run
node checkin.mjs
```

## 命令参数

| 参数 | 说明 |
| --- | --- |
| `--list` | 只列出任务和状态，不签到 |
| `--dry-run` | 只打印将要提交的请求，不真正签到 |
| `--watch N` | 常驻运行，每 N 分钟检查一次 |
| `--user` / `--pass` | 指定账号密码 |
| `--location "地址"` | 写入「位置」字段 |
| `--in-range` | 标记为「在签到范围内」（`sffwn=1`） |
| `--out-range` | 标记为「不在签到范围内」（`sffwn=0`），可覆盖配置中的 `inRange: true` |
| `--mail-to a@b.c` | 覆盖收件人（逗号分隔多个） |
| `--no-mail` | 本次不发送邮件 |
| `--test-mail` | 发一封测试邮件然后退出（**不需要填账号密码**） |
| `--fresh` | 忽略已缓存的会话，强制重新登录 |
| `--no-session` | 不读写会话缓存 |
| `--json` | 输出机器可读的 JSON |
| `--help` | 帮助 |

**退出码**：`0` 成功 · `1` 出错 · `2` 当前没有需要签到的任务 · `3` 账号被锁定

`--json` 输出：

```json
{
  "ok": true,
  "学号": "学号",
  "姓名": "用户",
  "due": 0,
  "tasks": []
}
```

## 邮件通知

签到**成功和失败都会发邮件**，另外账号锁定、网络异常等意外情况也会通知。

SMTP 客户端是 `lib/mail.mjs` 里自己实现的（`node:net` + `node:tls`），
**不需要 nodemailer、不需要任何依赖**。支持隐式 TLS（465）和 STARTTLS（587），
认证走 AUTH LOGIN，服务器不认时自动回退 AUTH PLAIN。

先验证配置能不能发出去（**不需要填账号密码**）：

```bash
node checkin.mjs --test-mail
```

```
[22:14:43] 发送测试邮件 → me@qq.com（smtp.qq.com:465, 隐式 TLS）
[22:14:43] 邮件已发送 → me@qq.com（[测试] swms-auto-checkin 邮件通知配置正常）
```

> ⚠️ `pass` 填的是**邮箱授权码**，不是邮箱登录密码。
> QQ 邮箱在「设置 → 账户 → POP3/IMAP/SMTP服务」里生成；163 邮箱同理。

### 通知书长什么样

```
主题：[签到成功] 学号 用户 · 晨检打卡

✅ 签到成功

账号：学号 用户
时间：2026-10-23 07:02:12
结果：成功 1 个，失败 0 个

─ 签到成功 ─
✅ 晨检打卡  2026-10-23 06:30:00 ~ 2026-10-23 09:00:00
   提交内容：
     位置：(空)
     是否在范围内：0
     是否在校：1（是，在学校）
     体温：36
     精神状况：1（好）
     症状：5（以上都无）

— 由 swms-auto-checkin 自动发送
```

失败时会带上原因，一眼能看出是时间窗口、任务归属还是网络问题：

```
─ 签到失败 ─
❌ 午检打卡  2026-10-23 12:00:00 ~ 2026-10-23 14:30:00
   原因：不在打卡时间内
```

主题按情况变化：`[签到成功]`、`[签到失败]`、`[部分签到失败]`、`[账号锁定]`、`[运行异常]`。

### 各邮箱的配置

| 邮箱 | `host` | `port` | `secure` |
| --- | --- | --- | --- |
| QQ | `smtp.qq.com` | 465 | `true` |
| 163 | `smtp.163.com` | 465 | `true` |
| Gmail | `smtp.gmail.com` | 465 | `true` |
| Outlook | `smtp.office365.com` | 587 | `false` |

`port` 为 `587` 或 `25` 时自动改用 STARTTLS（`secure` 默认为 `false`）。

### 邮件可选字段

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `from` | 同 `user` | 发件人地址 |
| `enabled` | 自动 | 显式写 `false` 可关掉通知 |
| `to` | — | 字符串或数组，支持多个收件人 |
| `notifyWhenIdle` | `false` | 设为 `true` 则「无需签到」也发邮件 |

「无需签到」**默认不发信**，否则每 30 分钟跑一次的定时任务会刷屏。

也支持环境变量：`SWMS_MAIL_HOST`、`SWMS_MAIL_PORT`、`SWMS_MAIL_USER`、`SWMS_MAIL_PASS`、
`SWMS_MAIL_TO`、`SWMS_MAIL_FROM`、`SWMS_MAIL_SECURE`、`SWMS_MAIL_ALLOW_INSECURE`。
同时兼容 [Liansign](https://github.com/Yueosa/Liansign) 的字段名
`smtp_host` / `smtp_port` / `sender` / `sender_key` / `receiver`。

**邮件发不出去不会影响签到**：发送失败只会在日志里打一行，签到结果和退出码不受影响。

## 会话复用

第一次登录成功后，脚本把 Cookie 存到 `.session-<学号>.json`，之后每次运行先校验再复用，
不再重复登录、不再识别验证码：

```
[19:50:40] 登录中 ...
[19:52:13] 会话已保存到 .session-学号.json

[19:55:09] 复用已保存的会话（3 分钟前登录），跳过登录和验证码   ← 1 秒跑完
```

- 校验方式是请求 `getUserRoleInfo.zf`：服务端返回 `code:0` 才算有效，返回 `code:-3`（未登录）
  判定失效并自动重新登录、覆盖缓存。
- **网络超时不会被误判成「会话失效」**。请求根本没完成时会保留会话文件并提示网络问题，
  不会因为一次抖动就丢掉有效 Cookie。
- 缓存文件含登录凭证，权限 `600`（仅属主可读写），并已在 `.gitignore` 中排除。

## 定时任务

签到窗口（以系统实际配置为准）：

| 任务 | 时间 |
| --- | --- |
| 晨检打卡 | 06:30 – 09:00 |
| 午检打卡 | 12:00 – 14:30 |
| 晚检打卡 | 14:30 – 22:00 |

<details>
<summary><b>Linux / macOS（crontab）</b></summary>

```cron
# 6:00 到 22:30 之间每 30 分钟尝试一次
*/30 6-22 * * * cd /opt/swms-auto-checkin && /usr/bin/node checkin.mjs >> checkin.log 2>&1
```
</details>

<details>
<summary><b>systemd timer</b></summary>

`/etc/systemd/system/swms-auto-checkin.service`：

```ini
[Unit]
Description=swms auto check-in

[Service]
Type=oneshot
WorkingDirectory=/opt/swms-auto-checkin
ExecStart=/usr/bin/node checkin.mjs
```

`/etc/systemd/system/swms-auto-checkin.timer`：

```ini
[Unit]
Description=run swms auto check-in every 30 minutes

[Timer]
OnCalendar=*-*-* 06..22:00/30
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl enable --now swms-auto-checkin.timer
journalctl -u swms-auto-checkin -f
```
</details>

<details>
<summary><b>Windows 任务计划程序</b></summary>

```powershell
$dir = "C:\swms-auto-checkin"
$action  = New-ScheduledTaskAction -Execute "node.exe" -Argument "checkin.mjs" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -Daily -At 6:00am
$repeat  = New-ScheduledTaskTrigger -Once -At 6:00am `
             -RepetitionInterval (New-TimeSpan -Minutes 30) `
             -RepetitionDuration (New-TimeSpan -Hours 17)
Register-ScheduledTask -TaskName "swms-auto-checkin" -Action $action -Trigger $trigger,$repeat -RunLevel Highest
```
</details>

也可以不用定时任务，直接常驻：

```bash
node checkin.mjs --watch 30
```

## 多用户 / 多实例部署

**支持**。一个脚本目录可以服务多个账号，也可以同时跑多个实例。但有一条必须先知道的规则。

### 共享状态

项目**没有锁文件、没有 PID 文件、没有临时文件、不监听端口**。唯一的可写共享状态只有两处：

| 状态 | 位置 | 会不会互相干扰 |
| --- | --- | --- |
| `.session-<学号>.json` | **脚本所在目录**（不是 cwd） | 不会。文件名按学号生成并做了字符清洗，`学号` → `.session-学号.json`，不同账号天然隔离。 |
| `config.json` | **脚本目录优先，其次 cwd** | ⚠️ **会**。见下。 |

### ⚠️ `config.json` 会遮蔽 cwd 的配置

`config.json` 的查找顺序是 **脚本目录 → cwd**，谁先找到用谁。所以：

- **脚本目录里没有 `config.json`** → 多个实例共用一个脚本目录，各自从自己的 cwd 读配置，互不干扰。
- **脚本目录里有 `config.json`** → 它会把所有 cwd 的配置**全部盖掉**。此时无论开多少实例、`cd` 到哪个目录，**全都在用同一个账号**。

结论：**不要把 `config.json` 放在 `checkin.mjs` 旁边**，让它跟着各自的运行目录走。

目前没有 `--config` 参数，所以多用户只能靠「不同的 `WorkingDirectory`」或「环境变量 / 命令行参数」来区分账号。

### 推荐的目录布局

```
/opt/swms/
  app/                     ← 脚本 + lib/ + templates.json，这里绝对不要放 config.json
    checkin.mjs
    templates.json
  users/
    用户A/config.json      ← 用户A 的账号
    用户B/config.json      ← 用户B 的账号
```

会话文件会落在 `/opt/swms/app/` 下，按学号分开存，所以所有单元用同一个系统用户跑即可。

### systemd 模板单元

一个模板管所有用户：

`/etc/systemd/system/swms-checkin@.service`：

```ini
[Unit]
Description=swms auto check-in for %i

[Service]
Type=oneshot
User=swms
WorkingDirectory=/opt/swms/users/%i
ExecStart=/usr/bin/node /opt/swms/app/checkin.mjs
```

`/etc/systemd/system/swms-checkin@.timer`：

```ini
[Unit]
Description=Run swms check-in for %i every 30 minutes

[Timer]
OnCalendar=*-*-* 06..22:00/30:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
```

```bash
systemctl enable --now swms-checkin@用户A.timer swms-checkin@用户B.timer
journalctl -u swms-checkin@用户A -f
```

`RandomizedDelaySec=300` 是关键：它把各用户的触发时刻**随机错开最多 5 分钟**，
避免同一个 cron 分钟里所有实例一起冲击 CAS 服务器。

也可以用环境变量区分账号，连 `config.json` 都不用：

```ini
Environment=SWMS_USERNAME=学号
Environment=SWMS_PASSWORD=xxxx
```

### 并发注意事项

1. **别把多个用户排在同一分钟。** 错开时间，或者用上面的 `RandomizedDelaySec`。
2. **同一个用户不要同时跑两份。** 没有锁，两个进程会各自登录、各自识别验证码、各自覆盖会话文件——
   不会损坏数据，但纯属浪费，还可能多打几次验证码。
3. **日志一人一份。** 别让多个实例 `>> checkin.log` 写同一个文件，输出会交错。
4. **多用户别用 `--watch` 常驻。** 单个进程常驻约 **44 MB**（裸 Node 是 36 MB），
   10 个用户常驻接近 450 MB。用 systemd timer / cron 这种短命进程，跑完就退，内存几乎不占。

磁盘占用每份安装只有约 165 KB（其中 `templates.json` 105 KB），共享一个 `app/` 目录就够。

## 关于定位

该签到是「定位」模式，但任务配置为：

```json
{ "config": [{ "qddd": "<打卡地点>", "qdfw": 10000 }], "needFwn": false }
```

`needFwn: false` 表示**不在范围内也允许签到**（原话：*不在打卡地点范围内充许签到，并记录定位信息*）。

脚本跑在服务器上没有 GPS，所以默认：

- `wz`（位置）= 空字符串
- `sffwn`（是否在范围内）= `0`

需要记录具体地址时在 `config.json` 设置 `location`，或用 `--location "打卡地点"` 覆盖；可用 `inRange: true` 或 `--in-range` 标记在范围内。若配置中为 `true`，可用 `--out-range` 覆盖为不在范围内。

## 关于健康申报项

签到表单有四个**必填**项，且服务端不下发默认值：

| 字段 | 含义 | 可选值 |
| --- | --- | --- |
| `dkzp` | 是否在校 | `1` 是，在学校 / `2` 否，不在学校 |
| `wd` | 当前体温(℃) | 数字，例如 `36` |
| `jszk` | 现在精神状况如何 | `1` 好 / `2` 一般 / `3` 差 |
| `yclx` | 您是否有以下症状 | `1` 咳嗽 / `2` 腹泻 / `4` 流涕 / `5` 以上都无 |

脚本**不会编造**这些内容：默认读取你最近一次已签到记录里的申报值并沿用，运行时打印出来。要固定自己的答案，在 `config.json` 的 `health` 对象中设置对应字段；字段说明和可选值见上面的[配置项](#配置项)。只配置部分字段时，其余字段仍从最近记录沿用。

## 工作原理

### 1. 登录：CAS 统一身份认证

`https://<统一认证域名>/lyuapServer`，Apereo-CAS 风格的 REST 流程。

**密码加密是该站点的特殊实现**，也是最容易踩坑的地方：

```
ciphertext = powmod( int( reverse(utf8(password)) as big-endian ), e, n )
```

即**教科书式 RSA**（无 PKCS#1 填充），且明文字节**倒序**。用 `crypto.publicEncrypt`
或任何标准库的 PKCS#1 v1.5 都会被服务端拒绝（仅返回 `PASSERROR`）。
本项目复现的密文与浏览器发出的**逐字节一致**，该行为由 `test/smoke.test.mjs` 中的
真实密文向量锁定。

公钥从 CAS 前端 JS 里实时提取（服务端换密钥不会失效），取不到时回退到内置公钥。

登录流程：

1. `POST /lyuapServer/v1/tickets`（带 4 位图形验证码）
2. 响应体直接返回 `{ "tgt": "TGT-...", "ticket": "ST-..." }` —— **不是** `201 + Location`
3. `GET <service>?ticket=<ST-...>` 换取学工系统会话 Cookie

### 2. 验证码识别

验证码恒为 4 位，无旋转、无干扰线，字符集为 `0-9 A-Z a-z`（**不含 `i`**，共 61 个）。
识别流程：PNG 解码 → 按列投影切分字形 → 保留长宽比归一化到 16×16 → 与内置字模比对。

字模由实拍样本聚类得到（`templates.json` 共 **62 个模板**，覆盖 61 个字符，`K` 有两个变体），
判定阈值为 `maxDistance = 0.16`，并要求次优候选拉开 `minMargin = 0.02`。

大小写按**字符高度**区分（x-height = 10 为小写，cap-height = 13 为大写/数字，14 为 `l`）。
额外约束：若切分结果不是 4 段，则拆分最宽段 / 丢弃最窄段，强制得到 4 个字形。

### 3. 签到接口

| 用途 | 请求 |
| --- | --- |
| 任务列表 | `POST /zftal-xgxt-web/rcsw/qdrw/getStudentQdTask.zf` |
| 签到记录 | `GET /rcsw/qdrw/signData.zf?rwid=` |
| 记录状态 | `GET /rcsw/qdrw/signPersonData.zf?id=` |
| 签到表单 | `GET /dynamic/form/group/qdrwjg/qd.zf?dataId=` |
| **提交签到** | `POST /rcsw/qdrw/sign.zf` |

提交体为 `{ id, rwid, dkjg:"1", wz, sffwn, ...表单可编辑字段 }`，
其中可编辑字段的筛选规则取自前端 bundle：`editable && !hidden && showType !== 'hidden'`。

### 4. 邮件通知

`lib/mail.mjs` 是自己实现的 SMTP 客户端：`node:net` / `node:tls` 建连接，
支持隐式 TLS（465）与 STARTTLS（587），认证走 AUTH LOGIN（服务器不认时回退 AUTH PLAIN）。

正文用 base64 编码，这样中文不会乱码、不会撞上 SMTP 的 998 字符行长限制，
也不可能出现以 `.` 开头需要转义的行；主题用 RFC 2047 encoded-word 编码。

测试里起了一个本地假 SMTP 服务器，把真实客户端从 `EHLO` 一路驱动到 `QUIT`，
逐条断言命令序列、AUTH 凭据和最终落地的报文。

## 目录结构

```
checkin.mjs          主程序（CLI）
templates.json       验证码字模（62 个模板）
config.example.json  配置模板
lib/
  cas.mjs            Cookie 容器、RSA 加密、带重试的请求
  auth.mjs           CAS 登录流程、公钥提取
  api.mjs            学工系统 HTTP 客户端
  checkin.mjs        签到任务查询与提交
  ocr.mjs            验证码识别
  png.mjs            极简 PNG 解码（zlib + 反滤波）
  session.mjs        会话（Cookie）缓存读写
  mail.mjs           SMTP 客户端 + MIME 构造（零依赖）
  notify.mjs         通知内容渲染与发送
test/
  smoke.test.mjs     RSA 向量、字模结构、OCR 不变量、表单字段规则
  mail.test.mjs      MIME 构造、配置解析、通知渲染、真实 SMTP 会话
```

## 开发

```bash
node --test              # 跑测试（全部离线，不联网）
node --check checkin.mjs # 语法检查
```

CI 在 Node 18 / 20 / 22 / 24 上跑：语法检查、`--help`、无凭据时的干净失败、测试，
以及一道「`config.json` / `.session-*.json` 没有被提交」的检查。

## 常见问题

<details>
<summary><b>账号被锁定了？</b></summary>

连续 5 次密码错误会锁定账号约 10 分钟（服务端返回 `USERLOCK`，并给出解锁时间）。
脚本检测到锁定会**立刻停止**，不继续重试、不延长锁定。等解锁后再跑即可。
成功登录会重置计数。
</details>

<details>
<summary><b>校园网很慢 / 请求超时？</b></summary>

所有请求带自动重试（连接错误和 5xx 重试 3 次，指数退避，单次超时 25 秒）。
网络彻底不通时打印一行 `运行失败：请求失败 https://... （连接超时，网络不通或被墙）`
并以退出码 `1` 结束，而不是抛出堆栈。CAS 登录页取不到公钥时会自动使用内置公钥
（日志显示 `RSA key from built-in fallback`），不影响登录。
</details>

<details>
<summary><b>验证码识别不准？</b></summary>

字模由实拍样本聚类得到，`templates.json` 共 62 个模板、覆盖全部 61 个字符。
单张识别失败会自动换图重试（最多 6 次）。若长期识别困难，可重新采集样本并用
`tools/build-templates.mjs` 重建字模。
</details>

<details>
<summary><b>登录失败但密码没错？</b></summary>

先确认系统时间准确。脚本会打印每一步的失败原因：
`CODEFALSE` 验证码错 · `PASSERROR` 密码错 · `USERLOCK` 锁定，照提示排查即可。
</details>

<details>
<summary><b>收不到邮件 / 提示认证失败？</b></summary>

先用 `node checkin.mjs --test-mail` 单独排查——它不需要账号密码。

- **`认证失败 (535)`** —— 最常见的原因是填了邮箱**登录密码**而不是**授权码**。
  QQ 邮箱在「设置 → 账户 → POP3/IMAP/SMTP服务」里生成授权码。
- **`无法连接 ... 连接超时`** —— 服务器出不了外网，或者 465 端口被防火墙拦了。
  把 `port` 改成 `587` 会自动改走 STARTTLS。
- **端口 25** —— 很多云厂商默认封禁 25 端口，不要用。
- **`服务器不支持 STARTTLS，拒绝明文发送`** —— 这是有意的保护。
  真要明文发送（比如内网 relay）加 `"allowInsecure": true`。
</details>

<details>
<summary><b>邮件会不会发太多？</b></summary>

默认只在**真的发生了事情**（签到成功 / 失败 / 锁定 / 异常）时发，「无需签到」不发，
所以每 30 分钟跑一次的定时任务不会刷屏。
</details>

## 免责声明

本项目仅用于替代**本人**手动完成每日签到，请自行确认符合所在学校的管理规定。
健康申报数据请如实填写，脚本不会替你伪造。使用产生的一切后果由使用者自负。

## License

[MIT](LICENSE)
