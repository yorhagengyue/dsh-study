# 学习系统连接层 · 框架包 v0.2（草案，待耿越审核）

装到每一台机器上的是同一套东西：**空框架加判断规则**，不含任何用户内容。第一次启动，入口 Agent 的脚本按 `protocols/DISCOVERY.md` 扫描本机（DSH 只读结果），按 `protocols/CONVERSATION.md` 在谈话里认识用户，把槽位一条条填上；以后按 `FRAMEWORK.md` 第 5、6 节持续生长。

三层：**写死层**是宪法与协议，产品自带，人人相同；**槽位层**是 `USER/` 和 `MACHINE.md`，装机时空；**生长层**是 `PROJECT.md` 里的决定、`DRAWER.md`、`MEMORY.md` 和审计，装机时空。

## 文件表

| 路径 | 层 | 装机时 | 谁写 | 一句话 |
|---|---|---|---|---|
| `FRAMEWORK.md` | 写死 | 满 | 产品 | 宪法：开工先查状态；我们是谁、整件事、怎么协作、怎么认识用户、什么有价值、权限、禁区、健康 |
| `protocols/CONTRACT.md` | 写死 | 满 | 产品 | 记录格式、字段、状态、审计与版本 |
| `protocols/DISCOVERY.md` | 写死 | 满 | 产品 | 全扫：范围、排除、禁区、预算、输出、抽取 |
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
| `MACHINE.md` | 槽位 | 空 | 发现器 | 这台机器：系统、路径、工具、服务、最近健康 |
| `MANIFEST.md` | 实例 | `stage = first_run` | 安装器、Agent | Agent 每次开工先读：第一次吗、填过了吗、完整吗；框架与用户版本、覆盖、健康摘要 |
| `PROJECT.md` | 写死加生长 | 只有产品阶段 | 产品、用户 | 工程阶段；这个用户的进度与已确认的决定 |
| `DRAWER.md` | 生长 | 空 | Agent、用户 | 抽屉：建议、推测、候选事实、先放着的想法 |
| `MEMORY.md` | 生长 | 空 | Agent | 按时间记什么变了、为什么，以及经验与工程笔记 |
| `connection/AUDIT.md` | 生长 | 空 | Agent | 每一次写入的记录，方便撤 |
| `connection/framework-plugin/` | 实现 | 有 | Claude | 注入层插件：算 stage、渲染开场、写到 `$DSH_HOME/AGENTS.md`、留接口与工具 |
| `connection/templates/opening.md` | 写死（可调） | 有 | 产品 | 开场模板，改了即重渲染 |
| `connection/archive/codex-skill-v0.3/` | 存档 | 有 | Codex | 09-13 晚被 v0.4 替换前的两个 Codex Skill 原文 |
| `~/.codex/skills/dsh-dialogue/`（不在包内） | 实现 | 有 | Claude 改 v0.4 | 入口 Skill：只理解、规划、派工、转述、验收；`app/framework.mjs` 查档位、开浏览器 |
| `connection/OPENING.md` | 生成 | 有 | 插件 | 当前渲染出的开场副本，给人和 Codex 看，不要手改 |
| `connection/` 其余 | 实现 | 已有 | Codex v0.3 | 目录（`context/INDEX.md`、`CATALOG.md`）、每轮记录（`runs/`）、健康（`HEALTH.md`）、扫描输出（`context/SCAN-<日期>.md`） |
| `REVIEW-CHECKLIST.md` | 草案期 | 有 | Claude | 需要耿越审核的内容，定稿后删除 |

## 变量

写死层只有四个变量，由安装器和调用方填：`{{用户称呼}}`、`{{机器}}`、`{{工作区}}`、`{{当前角色}}`。写死层里不出现任何具体用户的信息，两台机器上的写死层 diff 必须为空（`protocols/ACCEPTANCE.md` C）。

## 发布与隐私

框架包发布时只带写死层和空模板。用户实例里的 `USER/`、`MANIFEST.md`、`DRAWER.md`、`MEMORY.md`、`PROJECT.md` 的生长部分和 `connection/` 属于用户本人，不进公共仓库，也不随框架包分发。现阶段一律 Markdown，结构化内容放在 Markdown 的状态块里。

## 与 Codex v0.3 的关系

`connection/` 保留，作为目录与每轮记录的实现。`profiles/`、`connection/context/BRIEF.md`、`active-profile.json`、`开始这里.md` 是 09-12 的测试实例，不属于框架包。迁移步骤见 `protocols/MIGRATION.md`；三个 draft PR 不动。

## 版本

`framework_version` 0.2。定稿后从 1.0 起；`user_version` 从 0 起，每批写入加一（`protocols/CONTRACT.md` 第 10 节）。
