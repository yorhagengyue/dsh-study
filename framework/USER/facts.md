# 账本

所有记录的真源：事实、决定、建议、推测、来源。格式与状态见 `protocols/CONTRACT.md`。`USER/*.md`、`PROJECT.md`、`DRAWER.md`、`MEMORY.md` 是人读的视图，引用这里的记录号；用户直接改了视图，Agent 下次运行时登记进这里（`basis = user_rule_file`）。

只追加，不删除。撤回、替代、过期、停用都是改状态，记录本身保留。每批写入在 `connection/AUDIT.md` 留一行。

<!-- dsh-state -->
```json
{"ledger": "facts", "records": 0, "by_kind": {"fact": 0, "decision": 0, "proposal": 0, "judgement": 0, "source": 0}, "user_version": 0, "updated_at": null}
```
<!-- /dsh-state -->

## 记录

每条记录一个 `dsh-record` 状态块，写法见 `protocols/CONTRACT.md` 第 0 节，示例在同一文件第 12 节。装机时这里为空。
