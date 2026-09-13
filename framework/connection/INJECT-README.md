# 注入层 · 现状与怎么试（2026-09-13 20:10 更新）

## 注入是自动的

框架的注入层是 Cordis 插件 `@yorhagengyue/dsh-study-framework` 0.1.2（源码 `connection/framework-plugin/`，说明见那里的 README），装在 DSH 的 web profile 里。DSH 一启动就：

1. 读框架文件，算出 `MANIFEST.md` 的 `stage` 并回写（profile `profile-8b13564623d0`）；
2. 按 `connection/templates/opening.md` 渲染开场（宪法全文 + 状态 + 已填槽位 + 机器 + 工程 + 文件位置，约 17 KB）；
3. 写到 `C:\Users\Administrator\dsh\home\AGENTS.md`，DSH 原生 `dsh-agent-instructions` 在**每个新会话第一步**把它折进模型上下文；同时写一份 `connection/OPENING.md` 给人看；
4. 框架文件一改，1.5 秒后自动重渲染；
5. 收到 `POST /framework/api/open` 就在用户默认浏览器里打开自己的界面（入口 Agent 在用户发话时调用）。

## 已验证

- 16:49 冒烟：会话日志出现 `Instructions from: $DSH_HOME/AGENTS.md`，模型回复"学习系统 · 开场，当前档 first_run"，3.1 秒。
- 19:40 实测（Codex 入口，旧 v0.3 Skill）：开场同样注入了，但 DSH 照做了 Codex 的任务、没提状态；Codex 自己抽了课件、刷了学校平台、登记了来源；一个任务轮把档位推成了 filling。这次实测导出了三处改动：档位规则（任务轮不算）、first_run 带任务来同一轮接着做、Codex Skill v0.4。
- 20:24 实测（Codex 入口，v0.4）：流程对了（起服务 5 秒、查到 first_run、原话原样派、无 BRIEF），DSH 扫了 1.2 万文件后要写 `connection/context/SCAN-…md`，因会话根是 run 目录而等批准两分半；Codex 取消后叮嘱 DSH 不写框架。三轮对话质量好但慢：第一轮 5 分 51 秒、第二轮 52 秒、第三轮 3 分 8 秒，慢在 Codex 的重复检查和对讲解轮的多次打回。随后改：启动器起服务即开浏览器；连接插件 0.3.1 会话根=工作区根；Skill 讲解轮只核事实、最多打回一次。

## 从 Codex 开始的完整流程（v0.4）

你在 Codex 说一句话（例如"我现在需要使用dsh来学习IS210"），Codex 按 `~/.codex/skills/dsh-dialogue/SKILL.md`：

1. `node app/launch.mjs --config connection.local.json`：DSH 没起就起（起来时 DSH 自己在你的默认浏览器里打开界面，`connection.local.json` 里 `open_browser: true`；20:24 实测 Codex 会回避主动开窗，所以改成起服务就开），起了就直接返回。
2. `node app/framework.mjs open`：服务本来就在跑时，让 DSH 进程把界面再开到前面；同时打印档位、空槽、见面状态。
3. 按档位派工：`first_run` 先 `node app/scan.mjs`（几秒，写 `connection/context/SCAN-<日期>.md`，DSH 不扫电脑），再把你的原话原样发给 DSH（DSH 读 SCAN、摆坐标、接着做任务、只问一道题）；`filling` / `complete` 正常派工。任务文件一律 `use_context: false`。
4. 把 DSH 的回复原样转给你；你回话，它带 `continue_run_id` 续同一个会话。
5. 有交付物才验收。

Codex 不抽课件、不读课件全文、不刷学校平台、不 `onboard`、不起子代理干活；资料给真实路径让 DSH 自己读。

## 看什么

- 记录：`connection/runs/<id>/`（INPUT、output、EVENTS、METRICS、STATUS、REVIEW）和 `connection/client-requests/<id>.result.md`。
- 通过标准：`protocols/ACCEPTANCE.md` A 的第 0、1 条——回复先说判到了第一次；摆坐标；**只问一个问题**；带任务来的同一轮接着做。
- 状态：`node app/framework.mjs state` 或工具 `study_framework_state`。第一次见面完成后 DSH 应把 `MANIFEST.md` 的 `first_meeting_done` 改成 true（或填一个必填槽），档位才从 `first_run` 走到 `filling`；任务轮不算。
- 不算通过：复述开场；一轮问两个以上问题；把 09-12 旧 BRIEF 的内容当已知事实说出来；Codex 自己动手抽资料。

## 要改注入的样子

改 `connection/templates/opening.md`（占位符见插件 README），保存即生效于**新会话**；已开着的会话要等它下一次读写文件才收到"Updated instructions"。改分流规则改 `MANIFEST.md` 的表和插件配置 `requiredSlots`（`~/dsh/home/profiles/web/cordis.patch.yml`）。

## 复位到第一次

`MANIFEST.md` 状态块里把 `first_meeting_done` 改回 false，把 `USER/*.md` 的必填槽清回"（空）"，删掉 `connection/runs/` 里 `mode: talk` 的记录目录和 `client-requests/` 对应文件，然后 `POST /framework/api/render`（或改一下任意框架文件触发重渲染）。任务轮留着不影响档位。
