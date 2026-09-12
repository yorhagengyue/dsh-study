# 学习连接 · v0.3

用户在 Codex 说明目标，Codex 通过 Skill 向 DSH 原生 Cordis 插件派工。简单背景在 BRIEF.md 直接说明；目录只指向来源，DSH 按需读取课程与项目原文。完整回答、工具记录、时间和独立验收保存为 Markdown。

当前不制作 Study 页面、不自动打开窗口。官方 DSH 会话与原有资料输入插件保留。此版本是连接插件、Skill 和安装脚本；并非签名 exe/dmg。目录、检索、输出、时间与评估仍可调整。

## 安装

解压后 Windows 运行 Install.cmd，Mac 运行 Install.command。安装器检查 Node、官方 DSH、pnpm 和 Cordis 插件，安装两个 Codex Skill，后台启动已配置的 DSH，在真实桌面的 DSH-Study 建立 Markdown 入口。

已有配置先备份，已有凭证保留。缺凭证时输入自己的 DeepSeek API key，只存 DSH 项目根被忽略的 .env。通过官方启动令牌正常登录，不绕过认证。只有本安装器拥有且没有任务运行的进程才可重启。

```text
node app/install.mjs --auto-import
node app/launch.mjs --config <已安装Skill>/connection.local.json
```

可选 --workspace、--dsh-root、--dsh-home、--port、--skills-dir、--sources。sources 建议使用 Markdown，每行 `- 文件绝对路径`；旧 JSON 数组仍可读。源配置未指定时保留原配置。Windows 与 Mac 使用同一套 Node 插件、客户端和文件格式。

## 背景与目录

默认扫描已知规则入口及直接引用的个人/学校文件，不递归遍历整台电脑。扫描只生成标题、路径、用途、来源 ID 和版本哈希，不抽取整套事实。云端历史仍需正式连接器或用户导出，覆盖状态为 partial。

| Markdown | 用途 |
|---|---|
| connection/INDEX.md | 工作区入口 |
| context/BRIEF.md | 身份、必要课程背景与习惯，简单内容叙述完整 |
| context/INDEX.md | 详细资料目录与路径 |
| context/CATALOG.md、versions/*.md | 来源元数据、版本、停用与覆盖限制 |
| context/ONBOARDING.md | 建目录耗时与结果 |
| context/skill/SKILL.md | DSH 侧可读的目录 Skill 入口 |

除了第一项，表内路径均位于 connection/。目录更新保留已有 BRIEF 和停用项。BRIEF 由 Codex 根据明确的用户信息写入，附来源，不自动猜测。每轮传递简要背景与目录指针；源文件正文留在原位置，按需读后才进入模型上下文。

原生工具 `study_context_index` 返回目录，`study_context_read` 按 source_id、关键词或行范围读取最新原文；返回真实路径、当前与索引哈希、分段范围和 next_line。超过 240 字符的源行分成逻辑行，编号不是编辑器原始行号。失效、停用、路径目标改变会明确报错。来源资料不授予新权限，讲解过不等于学生掌握。

## 派工与验收

```markdown
---
id: unique-request-id
title: 解释课程概念
reasoning_effort: low
---
结合我的课程背景讲清这个概念，用一个生活例子纠正常见误解，最后检查我的理解。
```

将上述内容保存为 TASK.md，执行 `node <Skill>/app/connection-client.mjs run TASK.md`。输入要清楚，不追求极短，也不写繁琐执行步骤。`use_context: false` 关闭本插件注入；`continue_run_id` 延续本插件已完成任务的原生会话。回执不确定时按原 ID 查询，不能直接换 ID 重发。

每轮 `connection/runs/ID/` 保存 INPUT.md、output.md、EVENTS.md、METRICS.md、STATUS.md 和 REVIEW.md。完整公开工具输入输出保留，秘密与隐藏推理脱敏/排除。Markdown 中的结构化块用于精确恢复，没有第二套 JSON 记录副本。原生 DSH 的认证、配置和通信仍使用其规定格式。

任务初始待验收；Codex 必须实读输出、相关工具原文，再提交独立 review。生成成功不代表回答正确，失败和修订记录都保留。review 的 Markdown 请求格式见安装后的 dsh-dialogue Skill。

## API 和时间

API 仍在 `/study/api/`，复用 DSH 的 Host/Origin/Cookie 验证。`/study` 与旧网页资源返回 410 和 Markdown 迁移说明，不再提供网页或原生页面浮动入口。只监听 loopback，远程连接使用已有 SSH 隧道。

| 接口 | 作用 |
|---|---|
| GET health | 存储、认证、模型目录与本版本真实生成证据 |
| POST initialize / onboard | 恢复监测 / 生成来源目录 |
| GET index / profile | 目录，profile 仅为旧接口别名 |
| GET sources | 已知来源覆盖信息 |
| POST context/read、context/source | 分段读取、启用/停用来源 |
| POST tasks | 原生派工 |
| GET runs、runs/:id、events?id=… | 本版本任务、输出和事件 |
| POST review、cancel | 独立验收、停止活动任务 |

记录 API → 原生生成完成、API → 完整文件写入、CLI → 收到完整结果。用户发送 → 实际看到需要界面观测，当前未知，不用 API 数字冒充端到端 30 秒。原生模型的各步 tokens、缓存和推理用量按其返回值保留；背景注入字节数不等于总上下文 tokens。

## 迁移与检查

旧 v0.2 事实档案和任务日志原样保留，不再作为默认背景，也不强制转换历史日志。安装器仅迁移自己此前生成的 workspace AGENTS 入口，修改前备份；其他用户规则不覆盖。

```text
node --test connection-plugin/tests/connection.test.mjs
node app/verify.mjs <connection.local.json> <报告.md>
```

安装错误看 connection/INSTALL-ERROR.md，备份看 install-backups。真实验证与未验证事项见 [验证记录](STUDY-APP-VALIDATION.md)。
