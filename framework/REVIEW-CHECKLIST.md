# 耿越需要审核的内容（框架 v0.2 草案）

按重要程度排。每项写了在哪个文件、审什么、我做的默认选择。审完这份，框架就能定稿到 1.0 交 Codex 实现。定稿后删除本文件。

## 一、必须你拍板的

0. **开工先查状态**（你 09-13 下午加的，晚上按实测改过）：`FRAMEWORK.md` 开头一节和 `MANIFEST.md` 的 `stage` 三档。现在的判定：`first_run` 是没有 profile，或第一次见面没做过（`first_meeting_done` 为 false、没有完成的谈话轮、必填槽全空）——**任务轮不算数**，因为 19:40 实测里 Codex 派的一个任务就把档位推成了 filling 而见面根本没发生；`filling` 是必填没满或见面没走完；`complete` 是必填全满、见面走完、机器填了、健康查过。first_run 时不再"不接任务"：摆坐标后同一轮接着做用户带来的任务，空槽标未知，只问一个问题。你看这两处改得对不对。
1. **宪法正文** `FRAMEWORK.md`，十节逐节读。特别看：
   - 第 1 节：入口 Agent 和 DSH 的分工这样写对不对；"DSH 是完整 Agent"写到位没有。
   - 第 2 节：30 秒目标要不要写死在宪法里。我写了"简单任务半分钟内"。
   - 第 4 节：谈话规则的口气和例句，这是每个新用户第一天会经历的东西。
   - 第 6 节：完整权限的边界。我写的是"环境内完整权限，环境外的电脑界面仍要当次授权"。
   - 第 7 节：禁区清单，多了还是少了。
2. **规则文件算不算"用户自己写的"** `protocols/CONTRACT.md` 第 3 节、`protocols/DISCOVERY.md` 第 2.1 节。来源强度第三档是"用户自己维护的规则文件"，能直接写成事实。你的 CLAUDE.md、AGENTS.md 大多是 AI 按你的话写的。我暂定：规则文件里你明确写下或认可的段落算第三档；"记忆追加区"这类 AI 记忆日志段落只算 AI 总结，要在谈话里确认。这条直接决定你机器上全扫能直接填多少槽。
3. **全扫的范围和禁区** `protocols/DISCOVERY.md` 第 2、5 节：用户内容区（桌面、Documents、Downloads、笔记库、代码仓）够不够；AI 对话导出包和日记默认私密、只列不抽，对不对；有没有要排除或加入的目录。
4. **谈话协议** `protocols/CONVERSATION.md` 第 3、4 节：第一次见面的摆坐标和那一个问题；十三个动作的例句，改成你的话。
5. **第一次见面由谁谈**：我写的是"用户当时面对哪个 Agent 就由它谈，记录同一处"（CONVERSATION 第 1 节）。想固定由 DSH 谈，改这一条。

## 二、字段和名字

6. **契约 v2** `protocols/CONTRACT.md`：五种记录（事实、决定、建议、推测、来源）够不够；来源强度五档的名字和顺序；第 8 节每种记录的状态；场合四种（学习、工作、健康、其他）够不够。
7. **抽屉的出路** `DRAWER.md`、CONVERSATION 第 5 节：建议点头是 `accepted`、否掉是 `declined`；推测确认是 `confirmed`、被纠正是 `retracted`；适用范围过了是 `expired`。过期我没用天数，用"学期结束、任务完成"这类条件。
8. **槽位模板** `USER/*.md`：必填只有称呼、语言、学校与学期，其余可选；卡点三态的名字（`explained` / `self_reported` / `demonstrated`）；时间表只填用户自己出的数。
9. **两份日志**：`MEMORY.md` 按时间记"什么变了、为什么"和经验，照你 CLAUDE.md 第 8 节记忆追加区的样子；`connection/AUDIT.md` 记每一次写入，方便撤。要不要合成一份，你定。
10. **文件名**：`DRAWER.md`、`MEMORY.md`、`PROJECT.md`、`MANIFEST.md`、`protocols/`；`connection/` 保留为实现目录。

## 三、数字（都是提案）

11. 全扫预算：首次 20,000 文件、2 GB、10 分钟；重扫 5 分钟（DISCOVERY 第 3 节）。
12. 框架"停滞"阈值：14 天没谈话也没新知（HEALTH 第 3 节）。
13. 抽屉里同一件提两次没接就不再提（CONVERSATION 第 5 节）。
14. 端到端计时至少 5 次，报中位数和最大值（ACCEPTANCE D）。

## 四、迁移与 Codex

15. `protocols/MIGRATION.md`：取消个人 Skill、开场改为从槽位组装、两个 Codex Skill 的改法、三个 PR 不动。同意就交 Codex。
16. Codex 09-13 凌晨的 `AGENTS-system-v0.4-review.md` 已并入：引导那一节进了 CONVERSATION，STATE.md 拆成 PROJECT 和 DRAWER。那份文件留不留，你定。

## 五、我没法替你定的

17. Mac 的路径表（DISCOVERY 2.1 的 macOS 列）按常规写，没在你的 Mac 上核过；Mac 从 09-12 晚上起离线。
18. 朋友的实例怎么启动：朋友有没有 Claude 或 Codex、用哪个当入口、全扫在朋友机器上的授权怎么给。
19. 学校平台的访问方式在 `USER/sources.md` 里怎么写：我写的是只写种类和存放位置的名字，不写值。

## 我顺手统一的（知会，不用审）

- 注入层已做成插件 `connection/framework-plugin`（0.1.1，已装进 DSH web profile 并验证）：开场渲染到 `C:\Users\Administrator\dsh\home\AGENTS.md`，DSH 每个新会话第一步自动读；模板在 `connection/templates/opening.md`，改了即生效。桌面工作区的 `AGENTS.md`（Codex v0.3 写的入口，指向旧 BRIEF）20:08 换成了指向框架的指针，原文在 `connection/archive/codex-skill-v0.3/workspace.AGENTS.v0.3.md`。
- 09-13 晚实测后加的：插件升到 0.1.2，多了 `POST /framework/api/open`（DSH 进程在用户默认浏览器里打开自己的界面）；Codex 的 `dsh-dialogue` Skill 改成 v0.4（只做理解、规划、派工、转述、验收，不抽取、不读课件、不刷平台；每次先起服务、开浏览器、查档位，`use_context: false`）；`dsh-context-onboarding` 停用改为转派。旧版原文在 `connection/archive/codex-skill-v0.3/`。这属于 MIGRATION 第 2 步，Codex 正式重写时以这版为准。
- 20:24 实测（Codex 入口，v0.4）后又改三处：① 启动器不再传 `--no-open`，DSH 起服务时自己开浏览器（Codex 会回避主动开窗）；② v0.3 连接插件 0.3.1，会话根从 run 目录换成工作区根，DSH 写框架不再等人批准（那次卡了两分半）；③ Skill：讲解轮只核事实和来源、最多打回一次、措辞意见进抽屉，第二条消息起跳过起服务和查档位，不许在任务里禁 DSH 写框架。你定的是②和③，①是我按你的流程补的。
- 20:43 你定：**全扫拆出去，由 Codex 跑脚本，DSH 不扫**。做成 `~/.codex/skills/dsh-dialogue/app/scan.mjs`（纯程序、不用模型），first_run 派工前跑，产出 `connection/context/SCAN-<日期>.md` 和 `-清单.md`；DSH 只读结果、从候选来源按需读原文。FRAMEWORK、MANIFEST、CONVERSATION、ROUND、DISCOVERY（新加第 0 节）、README 对应改了。

- 按"现阶段一律 Markdown"，实例清单是 `MANIFEST.md`，结构化内容放在 Markdown 的状态块里，不另存 JSON 文件。
- 框架是给任何用户的，文档里指代用户一律写"用户"。
- 例句全部是学习场景，不含任何个人内容。

## 审完之后

改动直接改文件；改完告诉我一声，我把 `framework_version` 升到 1.0、更新 README 和网页版，然后交 Codex 按 `MIGRATION.md` 的顺序做，第一步是在你的机器上跑 `ACCEPTANCE.md` 的 A、B、F。
