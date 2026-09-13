# 契约 v2 · 记录格式、状态与版本

写死层。所有进入账本 `USER/facts.md` 的东西按这里的格式记；`USER/*.md`、`PROJECT.md`、`DRAWER.md`、`MEMORY.md` 是人读的视图，引用记录号。这一版在 Codex 09-12 契约 v1 的基础上改：分开了事实、决定、建议和推测，加了撤回、场合、敏感级别、掌握三态和审计。

## 0. 存放

现阶段一律 Markdown，不另存 JSON 文件。结构化内容放在 Markdown 里的状态块：视图文件顶部一个 `dsh-state` 块，账本里每条记录一个 `dsh-record` 块。块的写法：一行 HTML 注释 `<!-- dsh-record -->`，接一个 `json` 代码块，再接一行 `<!-- /dsh-record -->`。

## 1. 记录种类 `kind`

| kind | 是什么 | 谁能产生 | 视图 |
|---|---|---|---|
| `fact` | 关于用户或环境的一条事实 | 谈话、扫描、用户手改视图 | `USER/*.md`、`MACHINE.md`、`MEMORY.md` |
| `decision` | 用户明说的决定，带理由和适用范围 | 只有用户 | `PROJECT.md` |
| `proposal` | Agent 提的建议、用户说先放着的想法 | Agent、用户 | `DRAWER.md` |
| `judgement` | Agent 对用户的推测，等确认 | Agent | `DRAWER.md` |
| `source` | 一个来源的元数据 | 扫描、谈话 | `USER/sources.md`、`connection/context/CATALOG.md` |

## 2. 公共字段

| 字段 | 取值 | 说明 |
|---|---|---|
| `id` | `f-` / `d-` / `p-` / `j-` / `s-` 加 8 位十六进制 | 全局唯一，不复用 |
| `kind` | 见第 1 节 | |
| `subject_id` | profile id | 说的是谁；朋友、示例学生用各自的 id，不混 |
| `statement` | 一句话 | 整理后的表述 |
| `verbatim` | 字符串或 null | 用户原话摘录；关键条目必填，不超过 300 字 |
| `origin_context` | `learning` / `work` / `health` / `other` | 在什么场合说的；不跨场合自动注入 |
| `sensitivity` | `normal` / `private` / `third_party` | `private`、`third_party` 永不注入学习任务 |
| `status` | 按种类，见第 8 节 | |
| `scope` | 字符串 | 适用范围：全局、某课程、某类任务、某段时间 |
| `source_ids` | `s-…` 列表 | 出处；空列表的记录不能是 `supported` |
| `supersedes` | id 列表 | 替代了哪些旧记录 |
| `retracted_by` | id 或 null | 被哪条纠正撤回 |
| `conflicted` | 布尔 | 与其他记录的出处互相矛盾时为 true；是标记，不是状态 |
| `created_at` / `created_by` | ISO 时间 / `user` 或 Agent 名 | |
| `last_checked_at` | ISO 时间 | 最近一次核对出处的时间 |
| `machine_id` | 字符串或 null | 只对路径相关的记录填 |
| `notes` | 字符串 | 冲突、未知项、压缩说明 |

## 3. `fact` 专有字段

| 字段 | 取值 |
|---|---|
| `category` | `identity` / `education` / `course` / `assessment` / `blocker` / `style` / `rule` / `insight` / `project` / `machine` / `other` |
| `basis` | 来源强度，从强到弱：`user_stated` / `user_corrected` / `user_rule_file` / `assistant_summary` / `inferred_from_behavior` |
| `effective_from` / `effective_until` | 日期或 null；跟学期、课程、截止日绑定的必填 `effective_until` |
| `mastery_state` | 只 `blocker` 用：`explained` / `self_reported` / `demonstrated` |
| `evidence` | 只 `demonstrated` 用：指向 runs 或文件 |
| `stated_by_user_as_number` | 布尔；时间、节奏、数量类必填，只有用户自己说出的数才为 true |

`user_rule_file` 指用户自己维护的规则文件里、用户明确写下或认可的段落。规则文件里明确是 AI 记忆日志的段落（例如"记忆追加区"、自动记忆条目），以及 AI 工具各自的记忆目录，一律算 `assistant_summary`。

## 4. `decision` 专有字段

| 字段 | 说明 |
|---|---|
| `reason` | 必填。用户说的理由，原话优先 |
| `applies_to` | 适用范围，比 `scope` 更具体，例如"当前连接阶段" |
| `revisit_when` | 什么情况下要复议，例如"进入展示阶段时" |
| `decided_at` / `decided_in` | 时间 / 谈话或运行的 id |

## 5. `proposal` 专有字段

| 字段 | 说明 |
|---|---|
| `proposed_by` | Agent 名，或 `user`（用户说先放着的想法） |
| `mentioned_count` | 在谈话里提过几次 |
| `expires_when` | 适用范围结束的条件，例如"本学期结束""这次作业交完"；不用天数 |
| `accepted_as` | 接受后变成的 `d-` id |

## 6. `judgement` 专有字段

| 字段 | 说明 |
|---|---|
| `confidence` | `low` / `medium` / `high` |
| `basis_ids` | 依据的记录 |
| `must_confirm` | 布尔；为 true 的推测在确认前不得影响任务 |
| `expires_when` | 同上 |
| `confirmed_as` | 确认后新建的 `f-` id |

## 7. `source` 专有字段

| 字段 | 说明 |
|---|---|
| `type` | `school_platform` / `local_folder` / `notes` / `ai_memory` / `export` / `calendar` / `conversation` / `other` |
| `locator` | 路径、平台名、URL 种类或 runs id；不含凭证 |
| `sha256` / `modified_at` / `read_at` | 文件来源必填 |
| `excerpt` | 不超过 300 字的摘录，或 null |
| `coverage` | `full` / `partial` / `listed_only` |

`conversation` 类来源指一段谈话或一轮运行，是用户明说类事实的出处；它不进 `USER/sources.md` 视图。

## 8. 状态

| kind | 状态 |
|---|---|
| `fact` | `candidate` → `supported` 或 `inferred`；之后可到 `superseded` / `retracted` / `stale` / `disabled` |
| `decision` | `supported` → `superseded` / `retracted` |
| `proposal` | `open` → `accepted` / `declined` / `expired` |
| `judgement` | `open` → `confirmed` / `retracted` / `expired` |
| `source` | `enabled` / `disabled` / `unreachable` / `listed_only` |

转移规则：

- 新事实：`basis` 是前三档（`user_stated`、`user_corrected`、`user_rule_file`）的标 `supported`；后两档的标 `inferred`，同时在抽屉放一条候选。
- 在谈话里确认：新建一条 `basis = user_stated` 的事实，`verbatim` 是用户的确认原话；被确认的 `inferred` 事实标 `superseded`，被确认的推测标 `confirmed` 并填 `confirmed_as`。
- 用户纠正：被纠正的记录标 `retracted`，`retracted_by` 指向新记录（`basis = user_corrected`）。
- 新陈述替代旧陈述（不是纠正，是情况变了）：旧的标 `superseded`。
- `effective_until` 已过：`stale`。
- 用户停用某条记录或某个来源：`disabled`。
- 出处互相矛盾：`conflicted = true`，不靠多数投票解决，谈话里问。关键身份、学籍冲突在确认前不注入。

不注入：`candidate`、`inferred`（除非本轮就是讨论它）、`superseded`、`retracted`、`disabled`，以及所有 `proposal` 和 `judgement`；`stale` 只在明确问历史时用。

## 9. 写入与审计

Agent 在环境内有完整写权限，不需要事前审批；换来的是每批写入在 `connection/AUDIT.md` 追加一行：

```
| 时间 | 谁 | 动作 | 记录号 | 为什么（一句话，引用谈话或运行 id） | 怎么撤（反向动作） |
```

动作取值：`add` / `update` / `confirm` / `retract` / `supersede` / `expire` / `disable`。

用户手改视图不经过 Agent。Agent 下次运行时发现视图与账本不一致，以视图为准登记（`basis = user_rule_file`），审计里注明"来自用户手改"。

## 10. 版本与实例清单

- `framework_version`：写死层版本，写在 `README.md` 和 `MANIFEST.md`；两台机器必须相同。
- `user_version`：整数，从 0 起，每批写入加一；写在每个视图的 `dsh-state` 和 `MANIFEST.md`。
- `MANIFEST.md`（工作区根）的状态块：`profile_id`、`framework_version`、`user_version`、`machine_id`、`workspace`、`coverage`、`health`（见 `protocols/HEALTH.md`）、`created_at`、`updated_at`。同一台机器同一用户只有一个活动 profile；切换用户即切换工作区。

## 11. 注入规则

每轮注入什么由 `protocols/ROUND.md` 定。这里只定边界：`sensitivity` 为 `private`、`third_party` 的不注入学习任务；`origin_context` 与本轮不同的不注入，除非用户在本场合再说一遍；第 8 节列出的不注入状态不注入；`must_confirm = true` 的推测确认前不影响任务。

## 12. 示例

以下四条是格式示例（`example: true`），不属于任何真实用户。

```json
{"id": "s-9e8d7c6b", "kind": "source", "example": true, "subject_id": "profile-example", "type": "conversation", "locator": "runs/example-01", "statement": "第一次见面的谈话", "sha256": null, "modified_at": null, "read_at": "2026-09-13T10:00:00+08:00", "excerpt": null, "coverage": "full", "origin_context": "learning", "sensitivity": "normal", "status": "enabled", "scope": "全局", "source_ids": [], "supersedes": [], "retracted_by": null, "conflicted": false, "created_at": "2026-09-13T10:00:00+08:00", "created_by": "dsh", "last_checked_at": "2026-09-13T10:00:00+08:00", "machine_id": null, "notes": ""}
```

```json
{"id": "f-0a1b2c3d", "kind": "fact", "example": true, "subject_id": "profile-example", "category": "style", "statement": "回复用简体中文，先说结论再给理由", "verbatim": "以后都用中文，先说结论", "basis": "user_stated", "origin_context": "learning", "sensitivity": "normal", "status": "supported", "scope": "全局", "effective_from": "2026-09-13", "effective_until": null, "stated_by_user_as_number": false, "source_ids": ["s-9e8d7c6b"], "supersedes": [], "retracted_by": null, "conflicted": false, "created_at": "2026-09-13T10:00:00+08:00", "created_by": "dsh", "last_checked_at": "2026-09-13T10:00:00+08:00", "machine_id": null, "notes": ""}
```

```json
{"id": "d-1f2e3d4c", "kind": "decision", "example": true, "subject_id": "profile-example", "statement": "现阶段所有产物用 Markdown，不做界面", "verbatim": "先都用 Markdown 存，界面以后再说", "reason": "当前重点是连接，展示以后再谈", "applies_to": "连接阶段", "revisit_when": "进入展示阶段，或用户另说", "decided_at": "2026-09-13T10:05:00+08:00", "decided_in": "runs/example-01", "origin_context": "learning", "sensitivity": "normal", "status": "supported", "scope": "当前阶段", "source_ids": ["s-9e8d7c6b"], "supersedes": [], "retracted_by": null, "conflicted": false, "created_at": "2026-09-13T10:05:00+08:00", "created_by": "user", "last_checked_at": "2026-09-13T10:05:00+08:00", "notes": ""}
```

```json
{"id": "p-5a6b7c8d", "kind": "proposal", "example": true, "subject_id": "profile-example", "statement": "把每周复习固定在周日晚上", "verbatim": null, "proposed_by": "dsh", "mentioned_count": 1, "expires_when": "本学期结束", "accepted_as": null, "origin_context": "learning", "sensitivity": "normal", "status": "open", "scope": "本学期", "source_ids": [], "supersedes": [], "retracted_by": null, "conflicted": false, "created_at": "2026-09-13T10:10:00+08:00", "created_by": "dsh", "last_checked_at": "2026-09-13T10:10:00+08:00", "notes": "用户还没点头，留在抽屉"}
```

## 13. 保留自 Codex 契约 v1 的条款

事实至少一条来源；来源记录含摘录与定位、日期、读取时间、文件哈希；另一 AI 的总结标 `assistant_summary`；同一事实重复出现不算多份证据；当前更正替代旧事实后，旧条目保留替代关系；关键冲突不靠多数投票；未接入对应 tokenizer 时不伪报 token 数；计时缺测留 null，不估填；背景健康状态 `ready` / `partial` / `needs_clarification` / `unavailable` 与 `actual_injection`（`verified` / `not_verified`）保留。

## 14. 相对 v1 的删改

- 删：个人 Skill 打包（`skill/SKILL.md`、`references/person.md` 等）。DSH 是完整 Agent，直接读 `USER/`。
- 删："文件只在有内容时创建"。空槽位存在且标 `empty`，计入框架健康。
- 改：`manifest.json` 改为 `MANIFEST.md`，现阶段一律 Markdown。
- 改："入口 AI 掌握完整上下文，DSH 只收本轮需要的"，改为一套框架，两端都能读全量；每轮注入只带必要部分，缺什么自己去读。
- 改："首次导入结束后展示摘要并提问"，改为按 `protocols/CONVERSATION.md` 谈。
- 加：`kind`、`verbatim`、`reason` / `revisit_when`、各种类的状态、`retracted`、`mastery_state` / `evidence`、`origin_context`、`sensitivity`、`stated_by_user_as_number`、`conflicted` 标记、`conversation` 类来源、`machine_id`、审计与 `user_version`。
