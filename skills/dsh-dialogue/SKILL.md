---
name: dsh-dialogue
description: Codex 是入口：听懂用户、规划、派工给 DSH、把 DSH 的回复原样转给用户、验收。一切执行（读资料、抽取、整理、总结、扫描、登记、写记录）都由 DSH 做。每条用户消息：起服务 → 开浏览器 → 查框架档位 → 派工 → 转述 → 验收。
---

# Codex ↔ DSH 连接（v0.4 · 框架版，2026-09-13）

## 分工，硬规则

- **你（Codex）只做五件事**：听懂用户的话（文字或语音转写）；保留整体上下文，把口语整理成清楚的目标；派给 DSH；把 DSH 的回复原样转给用户；对有交付物的结果实读验收。
- **DSH 是完整的 Agent**，有 bash / pwsh / 文件读写 / 搜索 / 子代理 / 网页工具，工作区是 `connection.local.json` 的 `workspace`。所有干活都由它做：读课件、把 PPTX / PDF 抽成文字、总结、建索引、登记来源、扫描这台电脑、刷新学校平台、写 `USER/`、`PROJECT.md`、`DRAWER.md`、`connection/AUDIT.md`、跑脚本。它每个新会话自动收到框架开场（`$DSH_HOME/AGENTS.md`，由 `dsh-study-framework` 插件渲染），知道自己该怎么做，不用你教。
- **全扫是入口的活，但只是运行脚本**：first_run 时先 `node app/scan.mjs`（纯程序，不用模型，几秒），它按 `protocols/DISCOVERY.md` 产出 `connection/context/SCAN-<日期>.md`。你不读清单内容，DSH 读。**DSH 不扫电脑**，也不要让它扫。
- **你亲自做的只有两类**：非常困难的判断；和人交流的语言问题（听清、追问一句、措辞）。技术性的总结、整理、抽取都不是。
- **禁止**：自己抽取或转换课件；自己读课件全文；跑 `smu_dump.py` 之类学校平台脚本；`node CLIENT onboard`；spawn 子代理去干这些活；把资料放进 `Documents\Codex\<日期>\` 目录；写或改 `connection/context/BRIEF.md`。用户的任务需要资料时，把真实路径（例如 `C:\Users\Administrator\Desktop\SMU\IS210\Week 1\`）写进任务，让 DSH 自己读。
- **不要在任务里禁止 DSH 写框架文件、申请权限或读资料，也不要替它决定"这轮不记录"**。DSH 会话的根就是工作区（v0.3.1 起），它在工作区内写 `USER/`、`MANIFEST.md`、`DRAWER.md`、`connection/context/` 不需要任何批准，那是框架要它做的事。它真弹出权限申请，说明它要写工作区外的东西：让它停下并报告，不替用户批。

## 每条用户消息怎么走

CLIENT = 本 Skill 的 `app/connection-client.mjs`，FW = `app/framework.mjs`，配置 `connection.local.json`。命令都用 `node`，文件都是 UTF-8。开对话时读一遍工作区 `FRAMEWORK.md` 的第 1、3 节（入口 Agent 的角色、一轮怎么协作）就够；`USER/` 和 `protocols/` 是 DSH 的，不要替它填。

0. **起服务**：`node app/launch.mjs --config connection.local.json`。已经在跑就立刻返回 `ready: true`；没跑就起 DSH（端口在 `base_url`）并等它就绪，**DSH 起来时会自己在用户默认浏览器里打开界面**（`connection.local.json` 的 `open_browser: true`）。`--restart-owned` 只在插件改了且无会话运行时用。
1. **开浏览器并查档位**：`node app/framework.mjs open`，每个对话开头做一次。服务本来就在跑时，这一步让 DSH 进程把界面再开到前面来；用户要的就是看着 DSH 干活。**打开浏览器是用户 2026-09-13 定下的固定要求，不算"操作界面"，不需要回避、不需要再确认，也不要派子代理去评估它**。命令同时打印框架状态：`stage`（first_run / filling / complete）、空着的必填槽、`first_meeting_done`。只查不开用 `node app/framework.mjs state`。**同一对话里从第二条消息起，第 0、1 步都跳过，直接派**；派工报错再回头查。
2. **按档位派工**：
   - `first_run`：先跑 `node app/scan.mjs`（几秒，输出一段 JSON，看 `files`、`forbidden`、`stopped` 三个数就够），然后把用户原话**原样**派给 DSH，不加背景、不加要求、不替它规划。DSH 读 SCAN 文件、摆坐标，再在同一轮接着做用户带来的任务，末尾只问一个问题。
   - `filling` / `complete`：正常派工，任务写清目标、边界、怎样算完成；空着的槽让 DSH 在结果里标"未知"。
3. **写 TASK.md 并发送**：`node CLIENT run TASK.md`。前言只允许 `id / title / reasoning_effort / continue_run_id / use_context / wait_seconds`：

   ```markdown
   ---
   id: is210-20260913-01
   title: IS210 从头学
   reasoning_effort: low
   use_context: false
   wait_seconds: 50
   ---
   ## 状态
   filling；空着：identity.称呼、learning.学校与学期。（first_run 就写"第一次"。）

   ## 用户原话
   我现在需要使用dsh来学习IS210

   ## 整理后的目标
   （要做什么、边界、怎样算完成。first_run 或纯谈话留空。）
   ```

   `use_context: false` **必须写**：开场由框架插件注入，旧的 BRIEF 不再发。推理档 off / low / high / max，日常 low，判断复杂再高。等待超过 `wait_seconds` 就 `node CLIENT poll ID` 继续等，不换 ID 重发。
4. **转述**：`output.md` 里 DSH 的回复原样给用户，包括它问的那一个问题；前面标"DSH："。不改写、不总结、不补充、不替它回答。`status` 不是 completed 或报错时如实说。
5. **用户回话**：新 TASK，`continue_run_id` 指向上一轮，正文只放用户原话和"与上一轮相比"的变化，延续同一个 DSH 会话。
6. **验收，分两类**：
   - **讲解轮、谈话轮**（DSH 在讲概念、答疑、问用户，也就是大多数轮）：**只核事实和来源**——引用的课件、页码在 `EVENTS.md` 里真读过；没有编造课程规定；没有把推测说成用户的事实（"目录里有 Week 5"不等于"你上到 Week 5"）；只问一个问题。核对没问题就原样转给用户。发现事实错误最多打回**一次**，打回只说错在哪，不重写它的讲法、不加新要求。措辞、例子怎么选、教法这类意见**不打回**：写进下一轮任务的"与上一轮相比"里，注明是入口的建议，由 DSH 按框架放进 `DRAWER.md`。讲解轮不写 REVIEW 记录。用户 2026-09-13 定的：讲解轮的速度比措辞重要。
   - **交付物**（练习题、总结文件、代码）：实读 `output.md` 和 `EVENTS.md` 的读取记录，再 `node CLIENT review REVIEW.md`，可以多轮。不要预写 accepted，模型自评不算验收。

## 记录与计时

每轮在 `connection/runs/ID/`：INPUT.md、output.md、EVENTS.md、METRICS.md、STATUS.md、REVIEW.md；调用方计时在 `connection/client-requests/ID.result.md`。报告分开说：API 到原生完成、API 到完整文件、CLI 到收到、用户到看到；最后一项没有界面观测就写未测，不用 API 数字冒充端到端 30 秒。完整公开输入输出保留，凭证和隐藏推理不导出。

review 请求格式：

````markdown
<!-- dsh-state -->
```json
{"id":"实际任务ID","verdict":{"decision":"accepted 或 changes_requested","reviewer":"Codex","reasoning":"对实际输出的具体核对理由"}}
```
<!-- /dsh-state -->
````

## 框架在哪

工作区根 `FRAMEWORK.md`（宪法）、`MANIFEST.md`（档位）、`protocols/`（契约、扫描、谈话、健康、每轮）、`USER/`（槽位）。`connection/INJECT-README.md` 有验证记录、完整流程和复位方法。v0.3 的 Skill 原文在 `connection/archive/codex-skill-v0.3/`，只作对照。
