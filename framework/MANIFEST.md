# 实例清单

工作区根，一台机器上一个用户一份：这个实例处在哪一档、是谁、框架版本、用户侧版本、这台机器、覆盖状态、四类健康的最近结果。**Agent 每次会话开始先读这里**（`FRAMEWORK.md` 开头"先查状态"）。结构化内容放在下面的状态块里，不另存 JSON 文件。同一台机器同一用户只有一个活动 profile；切换用户即切换工作区。

`stage` 三档，回答"第一次吗、填过了吗、完整吗"：

| stage | 判定 | Agent 该做什么 |
|---|---|---|
| `first_run` | `profile_id` 为空；或 `first_meeting_done` 为 false 且没有完成的 `mode = talk` 轮且必填槽一个没填（任务轮不算） | 读入口跑好的 SCAN 文件，摆坐标；带任务来的同一轮接着做，空槽标"未知"，只问一个问题 |
| `filling` | 不是第一次，但 `required_slots.filled < required_slots.total`，或 `first_meeting_done` 为 false | 从空着的槽接着谈；接任务时空着的标"未知" |
| `complete` | 必填槽位全满，`first_meeting_done` 为 true，`MACHINE.md` 已填，`health.checked_at` 不为空 | 正常走本轮 |

`stage` 由 Agent 每次开工时按上表重新算并回写；不由人手填。健康里的 `stalled`（14 天没谈话也没新知）是另一个维度，见 `protocols/HEALTH.md`。

<!-- dsh-state -->
```json
{"stage":"first_run","profile_id":null,"framework_version":"0.2","user_version":0,"machine_id":null,"workspace":null,"first_meeting_done":false,"required_slots":{"filled":0,"total":3,"empty":["identity.称呼","identity.语言","learning.学校与学期"]},"runs":0,"last_talk_at":null,"drawer_open":0,"stale":0,"conflicted":0,"coverage":"none","health":{"service":"not_verified","context":"unavailable","framework":"empty","conversation":null,"checked_at":null},"created_at":null,"updated_at":null}
```
<!-- /dsh-state -->
