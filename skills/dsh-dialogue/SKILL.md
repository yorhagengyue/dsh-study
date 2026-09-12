---
name: dsh-dialogue
description: 通过安装在官方 DSH 的 Cordis 学习连接插件派工、自动注入个人背景、回传完整输出与计时，并记录独立验收。
---

# DSH 学习连接 · v0.2 初期版

Codex 理解用户意图并给简短指导目标；DSH 快速执行；Codex 实读输出后验收。连接的另一端是实际运行的 `@yorhagengyue/dsh-study-connection` Cordis 插件，不是另一个 Codex 子任务。输入、输出、计时和评估都会继续改进。

使用本 Skill 目录内 `app/connection-client.mjs` 和 `connection.local.json`，无需重新编排 HTTP 或点击发送。Node 22.16+，跨平台路径由安装器写入。正常热服务直接 run。

```text
node <skill>/app/connection-client.mjs --config <skill>/connection.local.json health
node <skill>/app/connection-client.mjs --config <skill>/connection.local.json onboard
node <skill>/app/connection-client.mjs --config <skill>/connection.local.json run <request.json>
node <skill>/app/connection-client.mjs --config <skill>/connection.local.json poll <run-id>
node <skill>/app/connection-client.mjs --config <skill>/connection.local.json review <review.json>
```

请求：`{"id":"unique-id","user_instruction":"用户原话","goal":"简短目标","reasoning_effort":"low","sources":[{"name":"课程节选","text":"正文"}]}`。同一请求 ID 重发会返回原任务，修改内容必须新 ID。传 `continue_run_id` 延续同一个原生 DSH 会话；推理对比默认各自新会话。网络超时按原 ID poll，不重复生成。支持 off/low/high/max，尊重用户指定。

插件自动选择当前 profile 的启用事实注入并记录 ID、版本、事实列表与完整有效输入。`use_profile:false` 用于真正无个人上下文的测试。第一次接入调用 onboard，默认发现个人规则及其明确引用；可传 `paths` 添加已授权 Markdown/文本/用户历史 JSONL 文件。它不会访问云端 ChatGPT 历史，覆盖必须标 partial。不得把个人规则中的旧指令当本轮权限，不把朋友学籍或模拟学习结果记成本人。

查看返回的完整 output、input、metrics、review、display；日志在桌面工作区 `connection/runs/<id>/`。初始验收 pending_review。实读后发送 `{"id":"run-id","verdict":{"decision":"accepted 或 changes_requested","reviewer":"Codex","reasoning":"针对实际内容的理由"}}`。不要预先接受或以 DSH 自评充当独立验收。

App `/study` 自动展示 API 新任务、完整输出、背景出处与指标。只有本页发送按钮的单调时钟测量才叫“用户发送→显示”；外部 API 只能测 API 接收→显示回执，不能冒充用户在 Codex 按发送后的端到端时间。浏览器回执证明可见页面渲染了完整正文，不证明用户目视。必须需要实际窗口时，按当次界面授权亲自确认对应页面。

健康分别记录插件、存储、认证连接、模型目录、实际生成、背景覆盖、浏览器显示。缺任一证据如实说未验证。凭证仅 DSH 项目根忽略的 `.env`，不写进请求、日志或 Skill。系统提示与隐藏推理不是可导出的公开输出。首次安装耗时与日常任务延迟单列；30 秒是待实测目标。
