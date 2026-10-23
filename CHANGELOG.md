# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.0] - 2026-10-22

### 变更

- 项目更名为 **swms-auto-checkin**（原 `zhxg-checkin`），仓库名与其保持一致
- 环境变量前缀改为 `SWMS_`（`SWMS_USERNAME` / `SWMS_MAIL_*` 等），
  旧前缀 `ZHGX_` 仍然可用，两套同时设置时以 `SWMS_` 为准

### 新增

- **邮件通知**：签到成功、失败、账号锁定、运行异常都会发邮件
  - 自带 SMTP 客户端（`node:net` / `node:tls`），仍然零依赖
  - 支持隐式 TLS（465）与 STARTTLS（587），AUTH LOGIN + AUTH PLAIN 回退
  - 正文 base64 编码，主题 RFC 2047 编码，中文不乱码
  - `--test-mail` 可在不填账号密码的情况下验证配置
  - `--mail-to` / `--no-mail` / `SWMS_MAIL_*` 环境变量
  - 兼容 [Liansign](https://github.com/Yueosa/Liansign) 的 `smtp_host` / `sender` / `sender_key` / `receiver` 字段名
  - 「无需签到」默认不发信，避免定时任务刷屏（可用 `notifyWhenIdle` 打开）
  - 发信失败只记日志，不影响签到结果与退出码
- 测试从 13 项增加到 24 项：MIME 构造、配置解析、通知渲染，
  以及一个**本地假 SMTP 服务器**驱动的真实端到端会话测试

### 修复

- AUTH LOGIN 原本被当成单条命令发送，只读取了第一个 `334` 响应就判定认证失败；
  实际是三步交互（`AUTH LOGIN` → 用户名 → 密码），已修正
- `--test-mail` 不再要求先填好账号密码

## [1.0.0] - 2026-10-22

首个可用版本，全流程已对真实服务端验证。

### 新增

- 自动登录 CAS 统一身份认证（Apereo-CAS 风格的 REST 流程）
- 图形验证码 OCR 识别（零依赖，字模由实拍样本聚类得到：`templates.json` 共 62 个模板、覆盖 61 个字符）
- 签到任务查询与提交（`/rcsw/qdrw/*`）
- 会话复用：Cookie 缓存到 `.session-<学号>.json`，后续运行跳过登录与验证码
- 网络重试：连接错误与 5xx 自动重试，指数退避
- 账号锁定保护：检测到 `USERLOCK` 立即停止，不延长锁定
- 健康申报项自动沿用上次已签到记录的值，可用 `config.json` 覆盖
- CLI 参数：`--list`、`--dry-run`、`--watch`、`--fresh`、`--no-session`、`--json` 等
- 离线测试：RSA 向量、字模结构、OCR 不变量、表单字段筛选规则

### 技术要点

- 还原了该 CAS 的密码加密方案：**教科书式 RSA**（无 PKCS#1 填充），且明文字节**倒序**。
  任何标准库的 PKCS#1 v1.5 加密都会被服务端拒绝（只返回 `PASSERROR`）。
  该行为由 `test/smoke.test.mjs` 中的真实浏览器密文向量锁定。
- CAS 的 `/v1/tickets` 直接返回 `{"tgt":..., "ticket":...}`，而不是标准的 `201 + Location`，
  两种响应形态都已兼容。
