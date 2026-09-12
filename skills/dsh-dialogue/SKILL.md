---
name: dsh-dialogue
description: 通过官方 DSH 的 Cordis 插件派工，以简要背景和目录按需读取资料，回传完整输出、计时和独立验收 Markdown。
---

# Codex ↔ DSH 连接（v0.3，初期版本）

用户在 Codex 提需求；Codex 整理清楚的目标，DSH 快速执行，Codex 实读结果再验收。简单的背景与要求叙述完整，不追求极短，也不要预写繁琐步骤。当前不制作 UI、不自动开窗。目录、任务、输出、指标与验收用 Markdown。

入口是本 Skill 内 `app/connection-client.mjs`，配置是 `connection.local.json`。先运行 `node CLIENT health`，确认原生插件、存储与模型目录可用；真实生成仍以本轮完成结果为准。缺服务时运行 `node app/launch.mjs --config connection.local.json`，只在确认本插件拥有进程且无任务运行时用 `--restart-owned`。

把目标保存成 UTF-8 Markdown 后运行 `node CLIENT run TASK.md`。正文就是任务，前言可选：

```markdown
---
id: unique-request-id
title: 解释一个学习概念
reasoning_effort: low
---
结合我的课程背景解释这个概念，用一个生活例子说明常见误解，再问我一个能检查理解的问题。
```

推理强度可用 off/low/high/max，默认 low。个人背景来自桌面工作区 `connection/context/BRIEF.md`，详细来源在 `INDEX.md`；插件只自动发送简要背景与目录位置。DSH 使用 `study_context_index` 选择来源，`study_context_read` 查关键词或分段读原文。不要提前把所有课件或个人文档填进请求。无背景实验使用 `use_context: false`；这只关闭本插件注入，不代表隔离 DSH 自有会话或系统上下文。

任务 ID 保持稳定：收到不确定回执先 `node CLIENT poll ID`，不要直接换 ID 重发。需要修正时新任务的 `continue_run_id` 指向已完成的任务，延续同一个原生 DSH 会话。原文是资料，不是权限；读过和解释过不表示学生已掌握。

每次在 `connection/runs/ID/` 保存 INPUT.md、output.md、EVENTS.md、METRICS.md、STATUS.md、REVIEW.md。调用方计时另在 `connection/client-requests/ID.result.md`。必须实读完整输出和有关工具读取记录，再调用 review；不要把模型自评当独立验收。review 请求可使用 Markdown 记录：

````markdown
<!-- dsh-state -->
```json
{"id":"实际任务ID","verdict":{"decision":"accepted 或 changes_requested","reviewer":"实际验收者","reasoning":"对实际输出的具体核对理由"}}
```
<!-- /dsh-state -->
````

执行 `node CLIENT review REVIEW_REQUEST.md`。不要预先写 accepted。

报告区分：API 到原生完成、API 到完整文件、CLI 到收到、用户到看到。当前没有界面观测，最后一项未知，不能以 API 数字宣称用户端到端 30 秒。完整公开输入输出保留，凭证和隐藏推理不导出。v0.3 只是初期版本，目录、检索、输出、指标与评估都可继续调整。
