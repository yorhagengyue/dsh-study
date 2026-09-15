# dsh-study-framework · 注入层插件

把学习系统的框架（`FRAMEWORK.md` 加状态、槽位、机器、工程）渲染成一份开场 Markdown，写到 DSH 原生 `dsh-agent-instructions` 会读的位置（默认 `$DSH_HOME/AGENTS.md`）。DSH 的每个新会话第一步都会把它折进模型上下文，不管会话的工作目录在哪。插件不改 DSH 核心，不改 Codex 的 v0.3 插件。

## 它做什么

1. **算状态**：读 `MANIFEST.md`、`USER/*.md`、`DRAWER.md`、`USER/facts.md`、`MACHINE.md`、`connection/runs/`，按 `MANIFEST.md` 的表算出 `stage`（first_run / filling / complete），回写 `MANIFEST.md` 的状态块（第一次会生成 `profile_id` 和 `created_at`）。
2. **渲染开场**：按 `connection/templates/opening.md` 拼：宪法全文（四个变量已填、草案说明去掉）+ 状态 + 已填槽位 + 机器 + 工程阶段与最近决定 + 文件位置。超过预算先省略工程、机器、槽位、位置，宪法永远不省。
3. **写到位**：`targets` 里的每个目标（`dshHome` → `$DSH_HOME/AGENTS.md`；`workspace` → 工作区 `AGENTS.md`）。另外总是写一份 `connection/OPENING.md` 给人和 Codex 看。系统提示段通道（`systemPrompt`）预留，这版没接。
4. **留接口**：HTTP `GET /framework/api/health | state | opening?role=…&format=json`、`POST /framework/api/render`、`POST /framework/api/open`（DSH 进程在用户默认浏览器里打开自己的界面；只放行回环地址；body 可带 `{"path": "/?token=…"}`，不带就从 `.env` 读启动令牌；令牌不回显）（都要 DSH 登录 cookie）；原生工具 `study_framework_state`、`study_framework_opening`、`study_framework_render`。
5. **盯文件**：工作区根、`USER/`、`connection/runs/`、模板目录有变化就重算重渲染（1.5 秒防抖，自己写的文件不触发）。

## 配置（web profile 的 `cordis.patch.yml`，改完热加载）

```yaml
- id: dsh-study-framework
  config:
    workspace: C:\Users\Administrator\Desktop\DSH-Study
    dshHome: C:\Users\Administrator\dsh\home
    userName: 耿越
    machine: ''            # 空 = 自动填系统、主机名、DSH_HOME
    role: DSH（执行 Agent）
    targets: [dshHome]     # 可加 workspace
    templatePath: ''       # 空 = <workspace>/connection/templates/opening.md
    maxBytes: 60000        # 低于 dsh-agent-instructions 的 65536 预算
    watch: true
    watchDebounceMs: 1500
    openBrowser: true      # false 则 /framework/api/open 返回 403
    uiPath: /              # 读不到令牌时打开的路径
    envPath: ''            # 空 = <dshHome>/../.env（launch.mjs 写 STUDY_LAUNCH_TOKEN 的地方）
    requiredSlots:         # 必填槽位，决定 first_run → filling → complete
      - {file: USER/identity.md, slot: 称呼}
      - {file: USER/identity.md, slot: 语言}
      - {file: USER/learning.md, slot: 学校与学期}
```

要改开场的样子，改 `connection/templates/opening.md`（占位符：`{{framework}} {{state}} {{user}} {{machine}} {{project}} {{index}} {{rendered_at}} {{stage}} {{framework_version}} {{workspace_path}}` 和四个变量 `{{用户称呼}} {{机器}} {{工作区}} {{当前角色}}`），保存即重渲染。要改分流规则，改 `MANIFEST.md` 的表和 `requiredSlots`。

## 安装与卸载

```
npm pack            # 在本目录生成 tgz
node C:\Users\Administrator\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js plugin --profile web add <tgz 路径>
（在 web profile 的 cordis.patch.yml 里加上面那段 config）
重启 DSH：node ~/.codex/skills/dsh-dialogue/app/launch.mjs --config ~/.codex/skills/dsh-dialogue/connection.local.json --restart-owned
```

卸载：`plugin --profile web remove @yorhagengyue/dsh-study-framework`，删掉 patch 里那段，重启。`$DSH_HOME/AGENTS.md` 是它写的，卸载后可删。

## 边界

- `dsh-agent-instructions` 没有文件监听：开场文件更新后，**已经开着的会话**要等下一次 `read` / `write` / `edit` 工具调用或会话恢复才看到"Updated instructions"；新会话立刻是新的。
- 它只负责"开场"，不负责每轮 `INPUT.md`（那是派工方按 `protocols/ROUND.md` 写的）。
- `first_run` 只能由"第一次见面做过"退出：`MANIFEST.md` 的 `first_meeting_done`、或 INPUT 含 `mode: talk` 且 STATUS 为 completed 的轮、或任一必填槽已填。任务轮不算（0.1.2 起；之前任何一轮都算，Codex 派的一个任务就把档位推成了 filling）。旧的 v0.3 记录（早于 `created_at`）不计。
- 开浏览器是系统行为（入口 Agent 在用户发话时调用），不是 DSH 自己的决定；没有给 DSH 留对应的原生工具。
- 测试：`node --test tests/`（会从桌面工作区复制框架文件到临时目录，不动原文件）。
- 0.1.4 起 `MANIFEST.md` 多一个 `scan` 字段（最新一份 `connection/context/SCAN-<日期>.md` 的时间、文件数、禁区数、候选来源条数），开场的"状态"里写"全扫：做过/没做过"，"文件位置"里给出路径；DSH 不再需要自己找有没有扫过。
