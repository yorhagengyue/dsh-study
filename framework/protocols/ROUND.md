# 每轮协议 · 输入、开场、输出、计时

写死层。一轮 = 一次谈话或一次任务。目录 `connection/runs/<id>/`，文件名沿用 Codex v0.3：`INPUT.md`、`output.md`、`EVENTS.md`、`METRICS.md`、`STATUS.md`、`REVIEW.md`。

## 1. `INPUT.md`

```markdown
---
id: <唯一 id>
mode: talk | task
role: dsh | entry            # 本轮执行者
continue_run_id: <上一轮 id 或空>
reasoning_effort: off | low | high | max
origin_context: learning | work | health | other
framework_stage: first_run | filling | complete   # 本轮开工时按 MANIFEST.md 算出的档
user_version: <写入时的 user_version>
framework_version: 0.2
---

## 状态
（先查状态的结果：处在哪一档；空着的必填槽；抽屉里 open 几条；stale、conflicted 几条；上次谈到哪。first_run 时写"第一次，读 SCAN 结果和第一次见面"。）

## 用户原话
（一字不改，含语音转写的口误）

## 整理后的目标
要做什么、必要背景、边界、怎样算完成。简单的事说完整，不写繁琐步骤。谈话轮可为空。

## 与上一轮相比
新增、改变、撤回了什么。首轮为空。

## 本轮注入
| 文件 | 版本 / 哈希 | 字节 | 备注 |
（实际发送给模型的每个文件；账本记录号列表；被排除的记录及原因，例如 private、retracted）

## 实际发送
（拼装后的最终文本，或指向快照文件）
```

## 2. 开场怎么组装

**组装之前先查状态**（`FRAMEWORK.md` 开头）：`first_run` 只发用户原话，不组装任务开场，主 agent（入口）先跑 `scan.mjs` 写好 `SCAN-<日期>.md`，DSH 读它、摆坐标，再在同一轮接着做用户带来的任务；`filling` 的开场在第 2 项后面加一段"已知什么、还空着什么"，空着的槽在任务里标"未知"；`complete` 按下面正常组装。

**实现**：开场由注入插件 `connection/framework-plugin` 按 `connection/templates/opening.md` 渲染到 `$DSH_HOME/AGENTS.md`，DSH 原生的 agent-instructions 在每个新会话第一步注入。派工方不必再手工拼开场，`INPUT.md` 里只放本轮内容；"本轮注入"表记开场文件的版本与字节。

**新会话、换机器、换用户、上下文丢失、角色规则改了**，发完整开场：

1. `FRAMEWORK.md` 全文，四个变量已填。
2. `USER/identity.md`、`USER/style.md` 的已填部分；`USER/learning.md` 只带与本轮有关的课程、考核、卡点；`MACHINE.md` 的系统与运行环境两节；`PROJECT.md` 的产品阶段与最近三条决定。
3. `connection/context/INDEX.md` 的指针（不带正文）。
4. 本轮 `INPUT.md`。

**同一会话续轮**只带：`INPUT.md`（含"与上一轮相比"）、新增或改变的记录。不重复开场。

**不注入**：`sensitivity` 为 `private` / `third_party`；`origin_context` 与本轮不同；`retracted / superseded / disabled`；`must_confirm = true` 的判断；抽屉里的东西（除非本轮就是讨论它）。

开场总量以字节记录在"本轮注入"表里；不把字节数当 token 数。

## 3. 输出记录

- `output.md`：完整文本输出，一字不删。
- `EVENTS.md`：公开的工具调用与结果（读了哪个文件、哪一段、多少字节），模型公开消息；不含隐藏推理、不含凭证。
- `METRICS.md`：计时（第 4 节）、token（服务原值，缺则 null）、注入字节、模型与推理档。
- `STATUS.md`：`received / running / completed / failed / cancelled / max_tokens / interrupted` 之一，加原因。
- `REVIEW.md`：验收（第 5 节）。

## 4. 计时字段

| 字段 | 含义 | 谁能测 |
|---|---|---|
| `user_sent_at` | 用户按下发送 | 只有界面能测；测不到写 null |
| `api_accepted_at` | 请求被受理 | 调用端 |
| `first_visible_at` | 第一段正文出现在用户可见位置 | 界面观测 |
| `full_visible_at` | 完整回答出现在用户可见位置 | 界面观测（截图时间是上界） |
| `model_done_at` | 模型结束 | 服务 |
| `file_written_at` | 交付文件落盘 | 调用端 |
| `review_done_at` | 验收写入 | 验收方 |

**30 秒的口径** = `full_visible_at − user_sent_at`。任何一段缺测，就报"端到端未测"，不用 `model_done − api_accepted` 冒充。跨机器不直接相减，优先同一观察端。重试和失败计入等待。

## 5. 验收

`REVIEW.md`：

```markdown
---
decision: accepted | changes_requested
reviewer: <agent 名或 user>
reviewed_at: <时间>
---
## 核对了什么
（读了 output.md 全文；对照了哪些来源；重算了什么）
## 问题
（具体到句；没有就写"无"）
## 不代表
（验收通过不等于学生已掌握；不等于全部要求通过）
```

不预写 `accepted`；模型自评不算验收；一次验收意见不自动变成规则（进抽屉，见 `MEMORY.md`）。

## 6. 谈话轮的特例

`mode: talk` 的轮：`output.md` 是你的回应，`EVENTS.md` 记本轮填了哪些槽、进了什么抽屉、撤回了什么；`REVIEW.md` 可为空；不计入端到端 30 秒。

## 7. 入口收尾（每一轮都写，没派工也写）

耿越 2026-09-16 定：**任何一轮、任何一次全扫，都必须有反思和总结，因为整套系统的意义就是理解用户**。这不是某个模型的习惯，是包里的规矩，Codex 和 Claude Code 一样写。

每轮结束，入口（主 agent）写四段进 `connection/entry/<YYYY-MM-DD>.md`（按日追加，一轮一块，块头写时间和本轮 run id，没派工就写"未派工"）；有派工的轮同一块再写进 `connection/runs/<id>/REVIEW.md` 的"入口收尾"一节：

1. **做了什么、验了什么**：事实，含没验的、没做到的。
2. **哪里不对、为什么**：自己的错、规则的坑、环境的坑，分开写；能改成规则的写成一句"以后……"。
3. **这轮对用户多懂了什么**：从他这轮的话、他给的资料、他的反应里读出来的东西，按 `FRAMEWORK.md` 第 5 节六关判断：站得住的进记录，站不住的进 `DRAWER.md` 候选，关于他这个人的进 `USER/understanding.md` 的"待确认"；还想问他什么，留到下一轮那一个问题。
4. **下一步**：一句话。

短，写给维护者和下一轮的自己看；不重复 `output.md`；反思要具体到能改规则。写完再跑记录回传。全扫之后另按 `DISCOVERY.md` 第 8 节写扫描反思。没有这份收尾，这一轮不算完。
