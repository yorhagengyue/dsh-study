# 记忆追加区

生长层。装机时空。按时间记"什么时候、因为什么变了"，以及不属于任何槽位的经验和工程笔记。当前状态在 `USER/` 和 `PROJECT.md`；每一次写入的机器记录在 `connection/AUDIT.md`；这里只记值得回头看的条目。

只追加，不覆盖；每条带类型、日期、来源、适用范围、状态、记录号；撤回的条目标 `retracted` 并保留。

类型：`preference`（偏好变了，指向 `USER/style.md` 的条目）、`correction`（用户纠正了什么）、`insight`（验证过的经验：什么讲法对这个用户有效或无效）、`project`（工程笔记）、`decision`（只放指针，正文在 `PROJECT.md`）。

一次失败不写成长期规则；同类问题在验收里出现两次以上，先进抽屉，谈话里确认后才写到这里。

<!-- dsh-state -->
```json
{"entries": 0, "by_type": {"preference": 0, "correction": 0, "insight": 0, "project": 0, "decision": 0}, "retracted": 0, "user_version": 0, "updated_at": null}
```
<!-- /dsh-state -->

## 条目格式

```markdown
### [YYYY-MM-DD] 类型: 一句话标题
正文一到三句。
来源：用户明说 / 用户纠正 / 验收记录 runs/<id> / 扫描 SCAN-<日期>
适用范围：全局 / 某课程 / 某类任务 / 到某日期为止
状态：active / retracted（被 [记录号] 撤回，YYYY-MM-DD）
记录：[f-…] 或 [d-…]
```

## 条目

（空）
