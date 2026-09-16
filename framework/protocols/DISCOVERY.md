# 全扫协议

写死层。耿越 09-13 定：默认全扫，不逐来源问。扫描只出清单和候选，不复制原文；禁区不进；覆盖如实。

## 0. 谁来扫（耿越 2026-09-13 晚定，2026-09-16 重申）

扫描由**主 agent 的脚本**执行。主 agent = 入口，Codex 或 Claude Code，用户在哪个里说话哪个就是（耿越 2026-09-16："全部由 Codex，这才是主 agent，DSH 的模型能力不够那么强大"）。脚本在入口 skill 目录下的 `app/scan.mjs`（`~/.codex/skills/dsh-dialogue/` 与 `~/.claude/skills/dsh-dialogue/` 各一份，内容相同），纯程序，不用模型，几秒钟跑完；在 `first_run` 派工之前运行，输出到 `connection/context/`。**DSH 不扫电脑**：它只读最新的 `SCAN-<日期>.md`，从"候选来源"里按需读原文、填槽、写候选事实。主 agent 运行脚本、也可以读清单做判断；DSH 只读结果。

历史：09-13 定"入口脚本跑、DSH 不扫"，原因是当时 DSH 用自己的工具扫花了两分钟、卡在权限上、还崩过一次。09-16 凌晨 Claude 把板一"Must be done by MAIN Agent"误读成"DSH 自己跑"，改过本节并让 DSH 实跑了一轮（记录在 `research/05-…md`，1.4 秒脚本、35 秒整轮，证明 DSH 也跑得动脚本）；耿越随即澄清主 agent 是 Codex，本节改回。设计不变：谁是主 agent，谁跑全扫。

**主 agent 的权限（耿越 2026-09-16 定）：全扫不弹窗，装机时直接给 Codex 全盘读权限。** 沙箱不是本协议的概念，只是 Codex（或 Claude Code）自己的启动参数；skill 说的是「干什么」，启动参数决定「手能伸到哪」。安装器在用户的 `~/.codex/config.toml` 写 `sandbox_mode = "danger-full-access"`，全局、对新会话生效；这版 Codex 在 Windows 上没有「只读全盘」的档（`disk-full-read-access` 不生效），所以这一行等于读写全开，「写成什么」由 `FRAMEWORK.md` 第 6、7 节约束。默认的 `workspace-write` 下 Codex 列不了家目录根和 AppData，脚本会静默只扫桌面、文档、下载三个根（`research/07-…md` 第 3、10 节）；给了全权限后脚本扫到 23 个根、13,216 条唯一路径，与命令行手动开全权限的基线一致，零弹窗（第 10.1 节）。落到实现（09-16 下午）：安装器 `app/install.mjs --framework` 做两件事，一是把用户 `~/.codex/config.toml` 顶层的 `sandbox_mode` 设成 `danger-full-access`、`approval_policy` 设成 `never`，并给工作区加 `trust_level = "trusted"`（原文件备份成 `config.toml.before-dsh-study-<日期>.bak`，逻辑在 `app/codex-config.mjs`；Claude Code 对应改 `~/.claude/settings.json` 的 `permissions.defaultMode = "bypassPermissions"`，逻辑在 `app/claude-config.mjs`）；二是在安装结束时**自己跑一次全扫**，安装器跑在用户自己的权限下、不在 Codex 沙箱里，所以第一次见面时 SCAN 已经在。权限改动只对重开后的 Codex 会话生效，README 让用户装完把 Codex 关掉重开一次；之后的重扫在重开后的会话里跑。脚本发现根被权限挡住（列不了家目录根、读不了笔记库登记表、根目录进不去）时，把这些写进汇总的「看不见的地方」、覆盖状态记 `blocked`、退出码 2、stderr 一句人话；主 agent 见到就报"被拦住"，不得报"扫完了"。

## 1. 原则

1. **默认扫，不问。** 装好后第一次启动自动跑；用户之后可以停用任何来源、任何目录，停用即生效且保留记录。
2. **只出清单和候选，不复制原文。** 原文留在原位置，通过目录按需读。
3. **禁区不进**（第 5 节）：凭证、健康与私密对话、第三方私人信息。碰到只登记"此处有、未读"。
4. **覆盖如实**：`none` / `partial` / `user_confirmed_enough` / `blocked`。没扫到的说没扫到，预算用完的记为未覆盖；`blocked` 是根一级被权限挡住，结果不算数，脚本退出码 2。
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

系统目录（`Windows`、`Program Files`、`ProgramData`、`AppData\Local\Temp`、`/System`、`/Library/Caches`）、`node_modules`、`.git/objects`、Python 虚拟环境（目录里有 `pyvenv.cfg`，或名字含 `venv`、`env`、`site-packages`、`.tox`）、`__pycache__`、`dist`、`build`、`Pods`、`DerivedData`、各类缓存目录、回收站。

## 3. 预算（数字是提案）

首次全扫：最多 100,000 个文件、2 GB、10 分钟，先到为准；超出的部分记为未覆盖，下次重扫从那里继续。重扫：5 分钟。（09-16 Mac 实测：桌面上 22 个代码仓加一个没被排除的 Python 虚拟环境，20,000 文件 0.7 秒就撞顶、扫到一半停下，所以数字提到 100,000，约 4 秒；同时虚拟环境不进，见 2.4。）脚本在派工前几秒跑完；预算用完就停，未覆盖的目录写进文件，第一次见面在这份结果上开始，摆坐标时说明哪些没扫到。

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

**扫完必写反思（耿越 2026-09-16 定：全扫的意义是理解用户，不是数文件）。** 不管扫描是安装器跑的还是入口跑的，入口读完汇总都要写 `connection/entry/SCAN-<日期>-反思.md`，四段：这次扫描说明了这个用户什么（三到五句，用候选来源、目录结构、课件和笔记的分布说话，不列文件）；哪些看不见、没覆盖、误判了（禁区误报、被当成课件的代码目录、iCloud 副本之类），下次怎么修；下一步该读哪几处原文、该问用户什么；和上一次扫描比变了什么。写进这份反思的「关于用户」的判断按 `ROUND.md` 第 7 节第 3 条落记录或进抽屉。没有这份反思，扫描不算完成。操作走入口的 `dsh-scan/SKILL.md`：`app/run.mjs` 跑扫描、出摘要、生成反思骨架；`app/run.mjs check` 判断反思写完没有，报 ok 才算扫完。
