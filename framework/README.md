# 学习系统连接层 · 框架包 v0.2（草案，待耿越审核）

装到每一台机器上的是同一套东西：**空框架加判断规则**，不含任何用户内容。第一次启动，入口 Agent 的脚本按 `protocols/DISCOVERY.md` 扫描本机（DSH 只读结果），按 `protocols/CONVERSATION.md` 在谈话里认识用户，把槽位一条条填上；以后按 `FRAMEWORK.md` 第 5、6 节持续生长。

三层：**写死层**是宪法与协议，产品自带，人人相同；**槽位层**是 `USER/` 和 `MACHINE.md`，装机时空；**生长层**是 `PROJECT.md` 里的决定、`DRAWER.md`、`MEMORY.md` 和审计，装机时空。

## 文件表

| 路径 | 层 | 装机时 | 谁写 | 一句话 |
|---|---|---|---|---|
| `FRAMEWORK.md` | 写死 | 满 | 产品 | 宪法：开工先查状态；我们是谁、整件事、怎么协作、怎么认识用户、什么有价值、权限、禁区、健康 |
| `protocols/CONTRACT.md` | 写死 | 满 | 产品 | 记录格式、字段、状态、审计与版本 |
| `protocols/DISCOVERY.md` | 写死 | 满 | 产品 | 全扫：范围、排除、禁区、预算、输出、抽取 |
| `protocols/UNDERSTANDING.md` | 写死 | 满 | 产品 | 第二步·理解人：原则（积极拆解、层级不是速度、先校尺子）、语料、读的九节、合的八节、问、记、引导、更新 |
| `protocols/CONVERSATION.md` | 写死 | 满 | 产品 | 谈话式认识用户：第一次见面、每轮动作、抽屉、撤回、结束 |
| `protocols/HEALTH.md` | 写死 | 满 | 产品 | 服务、背景、框架、谈话四类健康 |
| `protocols/ROUND.md` | 写死 | 满 | 产品 | 每轮：输入格式、开场组装、输出与验收记录、计时字段 |
| `protocols/ACCEPTANCE.md` | 写死 | 满 | 产品 | 定稿后怎么验收 |
| `protocols/MIGRATION.md` | 一次性 | 满 | 产品 | 从 Codex v0.3 迁过来，迁完可删 |
| `USER/identity.md` | 槽位 | 空 | 谈话、扫描 | 本人是谁、称呼、语言、要区分开的人 |
| `USER/learning.md` | 槽位 | 空 | 谈话、扫描 | 学校、学期、课程、考核、卡点三态、用户自己出的时间 |
| `USER/style.md` | 槽位 | 空 | 谈话、扫描 | 沟通与工作习惯、硬规则，每条带适用范围 |
| `USER/sources.md` | 槽位 | 空 | 扫描、谈话 | 资料在哪、怎么访问（不含凭证）、状态 |
| `USER/facts.md` | 槽位 | 空 | Agent | 账本：所有记录的真源 |
| `USER/understanding.md` | 槽位 | 空 | 主 agent、用户 | 这个人：尺子、用户点头过的理解、开口时机表、待确认、撤回；永不回传 |
| `UNDERSTANDING/raw/` | 生长 | 空 | 主 agent 的程序与子代理 | 第二步的原话时间线、分段、读者笔记、理解稿各版；永不回传、不进仓库 |
| `~/.codex/skills/dsh-understand/` 与 `~/.claude/skills/dsh-understand/`（不在包内，两份相同） | 实现 | 有 | Claude | 第二步 skill：`app/history.mjs` 抽原话，SKILL.md 六步操作（抽、读、合、问、记、引导） |
| `MACHINE.md` | 槽位 | 空 | 发现器 | 这台机器：系统、路径、工具、服务、最近健康 |
| `MANIFEST.md` | 实例 | `stage = first_run` | 安装器、Agent | Agent 每次开工先读：第一次吗、填过了吗、完整吗；框架与用户版本、覆盖、健康摘要 |
| `PROJECT.md` | 写死加生长 | 只有产品阶段 | 产品、用户 | 工程阶段；这个用户的进度与已确认的决定 |
| `DRAWER.md` | 生长 | 空 | Agent、用户 | 抽屉：建议、推测、候选事实、先放着的想法 |
| `MEMORY.md` | 生长 | 空 | Agent | 按时间记什么变了、为什么，以及经验与工程笔记 |
| `connection/AUDIT.md` | 生长 | 空 | Agent | 每一次写入的记录，方便撤 |
| `connection/framework-plugin/` | 实现 | 有 | Claude | 注入层插件：算 stage、渲染开场、写到 `$DSH_HOME/AGENTS.md`、留接口与工具 |
| `connection/templates/opening.md` | 写死（可调） | 有 | 产品 | 开场模板，改了即重渲染 |
| `connection/archive/codex-skill-v0.3/` | 存档 | 有 | Codex | 09-13 晚被 v0.4 替换前的两个 Codex Skill 原文 |
| `~/.codex/skills/dsh-dialogue/` 与 `~/.claude/skills/dsh-dialogue/`（不在包内，两份相同；装机时 Codex 与 Claude Code 同时适配） | 实现 | 有 | Claude 改 v0.4 | 入口 Skill：只理解、规划、派工、转述、验收；`app/framework.mjs` 查档位、开浏览器 |
| `connection/OPENING.md` | 生成 | 有 | 插件 | 当前渲染出的开场副本，给人和入口看，不要手改 |
| `connection/` 其余 | 实现 | 已有 | Codex v0.3 | 目录（`context/INDEX.md`、`CATALOG.md`）、每轮记录（`runs/`）、健康（`HEALTH.md`）、扫描输出（`context/SCAN-<日期>.md`） |
| `REVIEW-CHECKLIST.md` | 草案期 | 有 | Claude | 需要耿越审核的内容，定稿后删除 |
| `research/` | 研究期 | 有 | Claude | 研究文档与耿越的板书记录：`00-板书-2026-09-15.md`（七张板的转录、读法、待拍板）、`01-Linux与Harness.md`（OS 对照与核心插件系统提案）、`02-参考材料.md`（耿越转发的外部材料，来源另标）、`03-总合.md`（把板书、口述、参考与 01 合成一张图，标明谁定的）、`04-推演-01-本周截止日.md`（本机实跑一次、逐条核对、倒推受保护能力与两份契约）、`05-推演-02-全扫由主agent自己跑.md`（Claude 误读「主 agent」为 DSH 时的实跑记录，只当数据）、`06-真流程-01-Codex主agent全扫.md`（Codex 当主 agent 的真流程实跑：起服务、开窗、全扫、派工、转述，含对 05 的更正）、`07-对比-非程序化vs程序化全扫.md`（09-16 02:18–02:47 本机实跑：同一模型 gpt-6-astra/ultra、同一沙箱下 Codex 手工扫 vs 跑 scan.mjs 的对照，附 `07-附件/` 小件与两个分析脚本；主要发现是 Codex 的 workspace-write 沙箱不让列家目录根、脚本静默少扫四成，以及脚本重复计数；第 10.1 节是 09-16 白天追加的 C / D 实验：只靠 config.toml 里的 `danger-full-access`、不带命令行参数，Codex 不弹窗看全盘，脚本 13,216 条唯一路径与基线持平，对应耿越「装机时直接给全盘读权限」的决定）、`boards/` 板书原图、`refs/` 参考截图 |

## 变量

写死层只有四个变量，由安装器和调用方填：`{{用户称呼}}`、`{{机器}}`、`{{工作区}}`、`{{当前角色}}`。写死层里不出现任何具体用户的信息，两台机器上的写死层 diff 必须为空（`protocols/ACCEPTANCE.md` C）。

## 发布与隐私

框架包发布时只带写死层和空模板。用户实例里的 `USER/`、`MANIFEST.md`、`DRAWER.md`、`MEMORY.md`、`PROJECT.md` 的生长部分和 `connection/` 属于用户本人，不进公共仓库，也不随框架包分发。现阶段一律 Markdown，结构化内容放在 Markdown 的状态块里。

## 与 Codex v0.3 的关系

`connection/` 保留，作为目录与每轮记录的实现。`profiles/`、`connection/context/BRIEF.md`、`active-profile.json`、`开始这里.md` 是 09-12 的测试实例，不属于框架包。迁移步骤见 `protocols/MIGRATION.md`；三个 draft PR 不动。

## 版本

`framework_version` 0.2。定稿后从 1.0 起；`user_version` 从 0 起，每批写入加一（`protocols/CONTRACT.md` 第 10 节）。
