# 全扫协议

写死层。耿越 09-13 定：默认全扫，不逐来源问。扫描只出清单和候选，不复制原文；禁区不进；覆盖如实。

## 0. 谁来扫（耿越 2026-09-13 晚定）

扫描由**入口 Agent 的脚本**执行：`~/.codex/skills/dsh-dialogue/app/scan.mjs`，纯程序，不用模型，几秒钟跑完；在 `first_run` 派工之前运行，输出到 `connection/context/`。**DSH 不扫电脑**：它只读最新的 `SCAN-<日期>.md`，从"候选来源"里按需读原文、填槽、写候选事实。入口 Agent 只负责运行脚本，不读清单内容。原因：09-13 实测里 DSH 自己扫用了两分钟、卡在权限上、还崩过一次；扫描是一次性的机器活，不是学习。

## 1. 原则

1. **默认扫，不问。** 装好后第一次启动自动跑；用户之后可以停用任何来源、任何目录，停用即生效且保留记录。
2. **只出清单和候选，不复制原文。** 原文留在原位置，通过目录按需读。
3. **禁区不进**（第 5 节）：凭证、健康与私密对话、第三方私人信息。碰到只登记"此处有、未读"。
4. **覆盖如实**：`none` / `partial` / `user_confirmed_enough`。没扫到的说没扫到，预算用完的记为未覆盖。
5. **来源强度不因扫描而升级**：扫出来的东西按第 6 节定 `basis`；AI 写的总结永远是 `assistant_summary`。

## 2. 范围

### 2.1 已知入口

| 类别 | Windows | macOS | 抽什么 | basis |
|---|---|---|---|---|
| 用户维护的规则文件 | 用户目录、桌面、各代码仓根的 `CLAUDE.md`、`AGENTS.md`、`.cursorrules`、`.cursor/rules/*`；`%USERPROFILE%\.codex\AGENTS.md` | 同左；`~/.codex/AGENTS.md` | 身份、偏好、硬规则、项目索引 | `user_rule_file`；其中 AI 记忆日志段落按 `assistant_summary`（CONTRACT 第 3 节） |
| AI 工具的记忆 | `%USERPROFILE%\.claude\projects\*\memory\*.md`；`%USERPROFILE%\.codex\memories\*.md` | `~/.claude/projects/*/memory/*.md`；`~/.codex/memories/*.md` | 关于用户的总结、偏好 | `assistant_summary` |
| AI 工具的技能 | `%USERPROFILE%\.codex\skills\*\SKILL.md`；`%USERPROFILE%\.claude\skills\*` | 同左 | 只列名字和用途 | 不抽事实 |
| 笔记库 | `%APPDATA%\obsidian\obsidian.json` 登记的 vault 根；Notion、Logseq 导出目录 | `~/Library/Application Support/obsidian/obsidian.json` 登记的 vault 根 | 标题索引；用户自己写的笔记 | `user_rule_file`；镜像或 AI 生成的笔记按 `assistant_summary` |
| AI 对话导出包 | Downloads、Documents 里 ChatGPT、Claude、Gemini 的导出 zip 或 json | 同左 | 默认只列（第 5 节）；用户允许后抽用户自己发的消息 | 用户消息 `user_stated`；AI 回复 `assistant_summary` |
| 学校平台 | 不扫文件；从已有配置发现，例如 `sources.local.json`、`.env` 里的变量**名** | 同左 | 平台名、访问方式的名字 | 登记为 `source`，不读值 |
| 本地课件目录 | 桌面、Documents 下名字含课程代码、学校名，或"课件、课程、lecture、week"的目录 | 同左 | 课程名、周次、文件清单 | `inferred_from_behavior`，谈话里确认后升级 |
| 日历 | `.ics` 文件 | 同左 | 课表、截止 | `inferred_from_behavior` |

### 2.2 用户内容区

桌面、Documents、Downloads、笔记库根、用户目录下深度不超过 3 的代码仓（含 `.git` 的目录）。总深度不超过 6 层。其他账户的用户目录不扫。

### 2.3 类型

读：`.md` `.txt` `.pdf` `.docx` `.pptx` `.xlsx` `.csv` `.json` `.ics` `.html`。只列不读：图片、音视频、压缩包（导出包按 2.1 处理）、可执行文件。大于 50 MB 的文件只列。

### 2.4 排除

系统目录（`Windows`、`Program Files`、`ProgramData`、`AppData\Local\Temp`、`/System`、`/Library/Caches`）、`node_modules`、`.git/objects`、`.venv`、`__pycache__`、`dist`、`build`、各类缓存目录、回收站。

## 3. 预算（数字是提案）

首次全扫：最多 20,000 个文件、2 GB、10 分钟，先到为准；超出的部分记为未覆盖，下次重扫从那里继续。重扫：5 分钟。脚本在派工前几秒跑完；预算用完就停，未覆盖的目录写进文件，第一次见面在这份结果上开始，摆坐标时说明哪些没扫到。

## 4. 输出

脚本产出两份：`connection/context/SCAN-<日期>.md`（汇总、候选来源、按目录统计、禁区、未覆盖、与上次的变化）和 `SCAN-<日期>-清单.md`（完整清单表）。汇总文件的内容：

- 汇总：扫了哪些根、用时、文件数、未覆盖数、禁区计数、覆盖状态。
- 清单表：路径、类型、大小、修改时间、用途猜测、归属猜测（本人、他人、不确定）、处理（已读、只列、禁区未读、未覆盖）。
- 候选表：候选事实、来源、basis、去向（直接填槽、进抽屉）。

候选表由 **DSH** 在第一次见面读候选来源后填（脚本不做），写在 `SCAN-<日期>.md` 末尾的"候选事实"一节，或直接进槽、进抽屉。去向规则：`basis` 为 `user_stated`、`user_rule_file` 的直接进账本（`supported`）并填槽；`assistant_summary`、`inferred_from_behavior` 的进 `DRAWER.md` 作候选事实，谈话里确认后再升级。归属不确定的一律进抽屉。

同时更新 `USER/sources.md`、`connection/context/CATALOG.md`、`MACHINE.md` 和 `MANIFEST.md` 的覆盖状态。

## 5. 禁区判定

- **路径**：`.env*`、`*.pem`、`*.key`、`id_rsa*`、`.ssh/`、名字含 credential、cookie、token 的文件、浏览器 profile、密码管理器数据、钥匙串。只登记存在，不读。
- **内容**：读到形如密钥的行（`sk-` 开头、数字加 `~` 开头的长串、`Bearer` 后的长串、长随机串），整个文件标"含凭证形态，未读"，不摘录。
- **私密**：AI 对话导出包、日记类文件默认 `sensitivity = private`，只列不抽；用户在谈话里逐个允许后才抽。放了 `.dsh-private` 标记文件的目录整个不读。
- **第三方**：聊天记录、名册、别人的成绩、群文件默认 `third_party`，不抽。
- 用户在 `USER/sources.md` 停用的来源，重扫时跳过。

## 6. 抽取规则

| 来源 | 抽成什么 | 进哪 |
|---|---|---|
| 用户维护的规则文件 | 身份、语言、偏好、硬规则、项目名 | `identity`、`style`；明确写了学校课程的进 `learning` |
| AI 工具的记忆 | 关于用户的总结 | 抽屉，候选事实，`assistant_summary` |
| 导出包里用户自己的消息（用户允许后） | 用户自述的学校、课程、卡点、偏好 | 明确自述的 `supported`，其余进抽屉 |
| 课件目录 | 课程代码与名称、周次、资料清单 | `sources` 直接登记；课程事实进抽屉 |
| 配置文件里的平台变量名 | 学校平台存在、访问方式名 | `sources` |
| 日历 | 课表、截止 | 抽屉，谈话里确认 |

不抽的：健康、情绪、家庭、感情、他人的信息；AI 的隐藏推理；整段对话原文。

## 7. 重扫

重扫 = 入口再跑一次 `scan.mjs`（它自动对比上一份清单）。触发：用户要求、受权来源出现新文件、学期切换、每周一次。只报差异：新增、修改、消失、新禁区。差异写进当次 `SCAN-<日期>.md` 的"变化"一节，不重填已确认的槽位。

## 8. 告诉用户什么

扫完不发报告、不给用户列清单，按 `protocols/CONVERSATION.md` 第 3 节"摆坐标"说：读到了什么（三到五句）、哪几处还空着、哪些没读（禁区、未覆盖），然后只问一个问题。完整清单在 `SCAN-<日期>.md`，用户想看再看。
