# 从 Codex v0.3 迁到框架 v0.2

写死层里的一次性文档，迁完可删。对象：Codex 09-12 交付的 `dsh-study` 仓（PR #1 资料输入插件、PR #2 bridge、PR #3 connection-plugin v0.3）、两个 Codex Skill（`dsh-dialogue`、`dsh-context-onboarding`），以及桌面工作区里的 `connection/`、`profiles/`、`BRIEF.md`。

## 1. 文件对应

| Codex v0.3 | 框架 v0.2 | 怎么办 |
|---|---|---|
| `connection/context/BRIEF.md`（手写的简要背景） | `USER/identity.md`、`USER/style.md` 的已填部分 | 开场改为从槽位组装，不再手写；现有 BRIEF 作为 09-12 测试实例存档 |
| `connection/context/INDEX.md`、`CATALOG.md` | 同名，保留 | 不动；`CATALOG.md` 的来源记录补契约 v2 的 `source` 字段 |
| `connection/context/ONBOARDING.md`（建目录耗时） | 并入 `SCAN-<日期>.md` 的汇总 | 旧文件不动 |
| `profiles/profile-…/skill/SKILL.md` 与 `references/*.md`（个人 Skill） | 取消 | DSH 直接读 `USER/`；旧目录作为测试实例保留，不注入 |
| `profiles/profile-…/skill/references/sources.json`（22 条） | `USER/facts.md`（契约 v2） | 重新登记，作为 `protocols/ACCEPTANCE.md` B 的测试集 |
| `active-profile.json`、`profiles/…/manifest.json` | `MANIFEST.md` | 合并：`profile_id` 保留，加 `framework_version`、`user_version`、`machine_id`、`health`；旧 JSON 文件属于测试实例，不再更新 |
| 工作区 `AGENTS.md`（v0.3 安装器写的入口） | 指向 `FRAMEWORK.md` | 安装器只改自己写的这一份，改前备份，不碰用户的其他规则文件 |
| `connection/runs/<id>/` 六个文件 | 同名 | 保留；`INPUT.md` 加 `protocols/ROUND.md` 第 1 节的前言与"本轮注入"表 |
| `connection/HEALTH.md`（存储探测） | 同名，按 `protocols/HEALTH.md` 的四类格式 | 扩展 |
| 无 | `connection/AUDIT.md` | 新增：写入审计 |
| 无 | `connection/context/SCAN-<日期>.md` | 新增：全扫输出 |

## 2. Skill 与插件

| 现有 | 处理 |
|---|---|
| `~/.codex/skills/dsh-context-onboarding`（整理耿越、生成个人 Skill） | **09-13 晚已停用**（SKILL.md 改为转派说明，原文备份在 `connection/archive/codex-skill-v0.3/`）：见面是 DSH 的活；全扫改为入口跑脚本 `app/scan.mjs`（20:43 定），DSH 只读结果。它的 `references/context-contract.md` 由 `protocols/CONTRACT.md` 取代 |
| `~/.codex/skills/dsh-dialogue`（派工、验收） | **09-13 晚已改成 v0.4**（Claude 写，原文备份同上）：只做理解、规划、派工、转述、验收；每条消息先 `launch.mjs` 起服务、`framework.mjs open` 开浏览器并查档位、`use_context: false`；新增 `app/framework.mjs`。`references/user-context.md` 已置空待删。Codex 正式重写以 v0.4 为准 |
| `connection-plugin`（Cordis，注入 BRIEF 与 INDEX 指针） | 开场已由新插件 `connection/framework-plugin` 渲染到 `$DSH_HOME/AGENTS.md`，DSH 原生注入；v0.3 的 BRIEF 注入默认关掉（`use_context: false` 或删掉那段）；保留 `study_context_index`、`study_context_read`；自动导入改为全扫加候选；`INPUT.md` 加 `mode: talk` 等前言字段；**09-13 晚已改 0.3.1**：会话根从 run 目录改成工作区根（`engine.mjs` 的 `create({cwd})` 一行），DSH 在框架内写记录不再触发权限批准；原文在 `connection/archive/codex-plugin-v0.3/` |
| 资料输入插件（PR #1，七个 `study_*` 工具） | 不动 |
| bridge、fast、MCP（PR #2） | 不动，任务模式沿用 |
| 三个 draft PR | 不合并、不关闭；框架定稿后由 Codex 在 PR #3 之上开新分支实现上面两张表 |

## 3. 顺序

1. 耿越审完 `REVIEW-CHECKLIST.md`，定稿 `FRAMEWORK.md` 与 `protocols/*`，`framework_version` 升到 1.0。
2. Codex 按上面两张表改 connection-plugin 与两个 Skill；先在耿越的机器上跑 `protocols/ACCEPTANCE.md` 的 A、B、F。
3. 22 条重新登记，出 B 的报告。
4. Mac 上装同一份写死层，跑 C。
5. 朋友的实例在朋友自己的机器上、由朋友授权生成，跑 A。

## 4. 不迁的东西

09-12 的测试记录（`runs/onboarding-…`、`connection/runs/index-course-…` 等）原样保留，不作为任何新任务的背景。`profiles/` 不删，标为测试实例。凭证仍只在各自的 `.env`。
