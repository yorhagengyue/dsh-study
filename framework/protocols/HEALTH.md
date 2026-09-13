# 健康协议

写死层。健康分四类，分开报，不合成一个"正常"。完整报告写在 `connection/HEALTH.md`，摘要进 `MACHINE.md` 和 `MANIFEST.md`。每项带检查时间和依据；缺证据的项标 `not_verified`，不估填。

## 1. 服务健康（沿用 Codex v0.3）

| 项 | 通过的定义 | 不算通过 |
|---|---|---|
| 环境 | 系统受支持，Node、Python 版本满足，工作区可读写 | 只检查了目录存在 |
| 入口 | 入口 Agent 能找到框架、知道任务交给哪个 DSH、能收回结果 | Skill 文件存在 |
| 通道 | 两端认证成功；任务可发送、查询、收回；断线后按原 id 找回，不重跑 | HTTP 200 |
| 模型 | 配置的模型真实完成过一次生成，记录 provider、model、推理档 | 列出了模型名 |
| 展示 | 用户要求看窗口时，截图核验内容确实可见 | 后台完成、文件已生成 |
| 资料来源 | 每个启用的来源能列出，并实际读到一份内容 | 文件已下载 |

状态：`ok` / `degraded` / `down` / `not_verified`。

## 2. 背景健康（沿用 Codex 契约 v1 五项）

| 项 | 检查 |
|---|---|
| 来源覆盖 | 已识别、已读、未读、无法读分别列出；覆盖状态 `none` / `partial` / `user_confirmed_enough` |
| 主体归属 | 本人、第三人、示例记录分开；当前课程与旧学期分开 |
| 时效与冲突 | `stale` 几条、`conflicted` 几条；关键冲突有没有在谈话里问 |
| 可读与注入 | 文件存在且完整读到；本轮实际发送的内容里包含正确的槽位内容、正确的 profile 与版本 |
| 实际使用 | 真实回答里身份、课程的使用与派工一致；一次正确不等于全部正确 |

状态：`ready` / `partial` / `needs_clarification` / `unavailable`；另记 `actual_injection`：`verified` / `not_verified`。

## 3. 框架健康（新增）

| 指标 | 从哪来 |
|---|---|
| 必填槽位空了几个（`identity` 的称呼、语言；`learning` 的学校与学期） | 各视图的状态块 |
| `stale` 几条、`conflicted` 几条 | 账本 |
| 抽屉里 `open` 几条，其中提过两次还没回应的几条 | `DRAWER.md` |
| 上次谈话日期、上次新知条数 | `connection/runs/` |
| 用户上次手改视图的日期 | `connection/AUDIT.md` |
| 写死层与产品版本一致 | `framework_version`；两台机器 diff 为空 |

状态：`empty`（还没谈过，槽位全空）/ `growing`（在谈，必填未满）/ `healthy`（必填槽位全满，没有未解决的关键冲突）/ `stalled`（超过 14 天没有谈话也没有新知）。抽屉条数照报，不影响状态。

和 `MANIFEST.md` 的 `stage` 的关系：`stage` 回答"第一次吗、填过了吗、完整吗"，是 Agent 开工前的分流（`first_run` / `filling` / `complete`）；这里的框架健康多一档 `stalled`，是给用户看的提醒。对应关系：`empty` 对 `first_run`，`growing` 对 `filling`，`healthy` 对 `complete`；`stalled` 可以叠在 `filling` 或 `complete` 上。

## 4. 谈话健康（新增）

每段谈话结束时记：

| 指标 | 说明 |
|---|---|
| 新知条数与来源比例 | 本次新记录里 `user_stated`、`user_corrected` 的占比 |
| 撤回条数 | 用户纠正导致的 `retracted` |
| 抽屉进出 | 进了几条，`accepted`、`confirmed`、`declined`、`retracted` 各几条 |
| 一轮多问 | 有没有一轮问了两个以上问题，应为 0 |
| 建议冒充计划 | 有没有未点头的建议被写成决定或注入任务，应为 0 |
| 重复追问 | 用户没答的问题有没有被重复问，应为 0 |

## 5. 报告格式

`connection/HEALTH.md`：

```markdown
# 健康 · <日期时间>
服务：<状态>　背景：<状态>　框架：<状态>　谈话：<最近一次日期>
（四张表，每行：项、状态、依据、检查时间）
```

`MANIFEST.md` 状态块里的 `health`：`service`、`context`、`framework`、`conversation`（最近一次谈话日期）、`checked_at`。

## 6. 三句硬话

信息不足不阻止普通聊天，但不能假称背景完整。"已接收、执行完成、已显示、已验收"是四个不同的状态，说哪个就是哪个。健康报告不写用户的私密内容，只写计数和状态。
