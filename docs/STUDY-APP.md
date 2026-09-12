# 学习连接 App · v0.2

用户在 Codex 表达需求，Codex 通过 Skill 发一个简短目标到本机 API；Cordis 插件自动注入当前启用背景，调用 DSH 原生会话执行；学习页面自动显示新任务、完整回答、耗时与验收状态。Codex 实读结果后验收，必要时在同会话修正。DSH 本身还能通过 study_connection_status 和 study_personal_context 两个原生工具读取连接与背景。

本版本是**桌面启动器 + 官方 DSH 上的本地网页**，不是签名的 exe/dmg。输入、输出、计时、事实整理和质量评估仍会改进；未承诺任意任务 30 秒完成。

## 安装与首次使用

解压安装包，Windows 运行 Install.cmd，macOS 运行 Install.command。脚本发现已有可用 Node，否则从 nodejs.org 下载固定 Node 版本并核对官方 SHA256；安装缺失的官方 DSH、npm/pnpm 依赖、Cordis bundle 和两个 Codex Skill。默认桌面 DSH-Study，系统桌面重定向由 Windows API 解析。已有 DSH 会复用，profile 配置和 Skill 在修改前备份。

缺模型凭证时，安装器要求用户输入自己的 DeepSeek API key，隐藏输入并只存 DSH 项目根被忽略的 .env；已有凭证保留。不会复制浏览器凭证或取消认证。官方启动令牌经正常登录交换 Cookie；本应用使用 STUDY_LAUNCH_TOKEN 保存令牌，兼容旧 DSH_DIALOGUE_LAUNCH_TOKEN 命名迁移。

成功后桌面工作区生成“启动学习应用”。服务后台运行，正常登录后自动转到 /study。只有确认属于本 App 且没有原生运行会话的进程才允许 --restart-owned；运行端未配对或端口被其他进程占用时报告原因，不强占。安装过程中禁止开始自动导入，App 启动完成后才初始化，避免热加载时抢跑任务。

首次启动自动发现个人规则和其明确引用的学校资料，并生成个人 Skill。其他资料可在页面“添加其他来源”填写文件路径。已存在的个人规则只读。实际发现、跳过、缺失、尺寸限制均有记录，**云端 ChatGPT / Kimi 历史需要授权连接器导出，当前不会自动读取**。JSONL 支持明确提供的 Claude/Codex 用户消息格式，不复制工具结果与隐藏推理。PDF、Word 解析继续属于资料输入插件后续工作。

Node 已就绪时也可运行：

```text
node app/install.mjs --auto-import
node app/launch.mjs --config <已安装Skill>/connection.local.json --open
```

自定义参数：--workspace、--dsh-root、--dsh-home、--port、--skills-dir、--sources（包含授权文件路径的 JSON 数组）。凭证不得放参数里。安装器会复用现有 profile 使用的 pnpm 版本，避免改变其 store 主版本。

## 原生连接与 API

包名 @yorhagengyue/dsh-study-connection，官方 Cordis bundle patch 注册独立插件。通过 ctx.sessionController 的 create / selectModel / prompt / inspect / cancel 操作真实 DSH 会话；通过 ctx.webServer 提供 /study 和 /study/api，复用 ctx.connection.requestRejection 的 Host/Origin/Cookie 验证。不改 DSH 核心，不另建模型代理。

| API | 作用 |
|---|---|
| GET health | 存储、连接、模型目录、真实生成、背景、展示证据 |
| POST initialize | App 启动后初始化与已接收任务的恢复 |
| GET sources / POST onboard | 来源覆盖与自动背景整理 |
| GET profile / POST profile/fact | 背景详情与按版本启用/停用事实 |
| POST tasks | 新会话派工或 continue_run_id 同会话修正 |
| GET runs / runs/:id | 历史、完整有效输入、完整回答和指标 |
| GET events?id=… | 完整公开工具输入输出与生命周期事件 |
| POST review / display / cancel | 独立验收、浏览器渲染回执、停止当前任务 |

API 仅 loopback；跨机使用已有 SSH 隧道，不公开到网络。sources 为调用端已读取的文本数组；API 不会根据未经解析的 PDF 字节假装读懂资料。幂等 ID 内容不符会拒绝。派工回执不确定时从原生日志继续核对，不重新发任务。重启恢复读取日志，不重放已提交 prompt。

## 背景与记录

应用仅维护工作区 connection/，不会覆盖已有手工建档。profiles/<id>/vN 下包含 profile.json、sources.json、review.md、skill/SKILL.md 及按 person / education / working-style 分开的引用文档。active-profile.json 指向版本。事实含来源与原文，停用后不会进入后续 prompt；旧日志不追溯删除。

原文匹配只证明引用存在，不证明概括、身份归属和时效全部正确。当前已真实发现重复与旧偏好冲突，Codex 在验收后停用了相应事实。学生是否掌握只根据学习过程另行评估，不从提问或讲解记录推断。本插件不自动修改全局 AGENTS、源工具记忆或学业记录。

runs/<id>/ 保存完整公开 input.json、state.json、output.md、events.jsonl、reviews.jsonl；导入还保存 source-bundle.json。完整 prompt 与 source 快照可回查，认证敏感字段脱敏，系统提示及隐藏推理不导出。生成完成初始状态为 pending_review；模型自评不能代替 Codex 的验收。

计时分别表示 API 接收→生成结束、API 接收→浏览器显示回执、本页发送→完整显示。最后一项由发送处理器与两帧后的单调时钟测量，要求可见文档和完整输出 hash 匹配。外部 Codex 请求没有用户按键时刻，不把 API 用时冒充 Codex 用户端到端用时。浏览器回执不是用户眼睛注视的证明；关页、隐藏页面、没观测到时不填成功值。首次建档与日常提问单列。

## 检查与恢复

```text
node --test connection-plugin/tests/connection.test.mjs
node app/verify.mjs <connection.local.json> <可选报告路径>
```

安装失败时看 connection/install-error.log 和 install-backups；不手动删除已有用户数据。已有任务在运行时不重启。修复后重新安装相同目录；安装器会验证实际安装文件内容。macOS 实机可验证后台与 API，但本项目当前没有 Mac 原生窗口的目视证据。Windows 页面功能已检查，视觉细节待设计复核。
