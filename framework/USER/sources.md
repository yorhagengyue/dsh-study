# 资料在哪

槽位层。装机时空；主要由全扫填，谈话补充。**凭证不写在这里**——只写凭证的种类和存放位置的名字（例如"自签只读 token，存 DSH 项目根 .env"），不写值。详细的来源元数据（哈希、版本、读取记录）在 `connection/context/CATALOG.md`。

<!-- dsh-state -->
```json
{"slot": "sources", "status": "empty", "required": [], "optional": ["学校平台", "本地资料", "笔记与记忆", "导出包"], "filled": [], "disabled": 0, "unreachable": 0, "coverage": "none", "user_version": 0, "updated_at": null}
```
<!-- /dsh-state -->

## 来源表

| source_id | 类型 | 位置或路径 | 机器 | 访问方式（不含凭证） | 更新频率 | 状态 | 最后核验 | 记录 |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |

类型取值：`school_platform`（Canvas、Brightspace 等）、`local_folder`（课件目录）、`notes`（Obsidian 等）、`ai_memory`（Claude、Codex 等的规则与记忆文件）、`export`（ChatGPT、Claude 导出包）、`calendar`、`other`。
状态取值：`enabled`、`disabled`（用户停用）、`unreachable`（路径或登录失效）、`listed_only`（只列了，没读）。

## 覆盖说明

扫了哪些范围、没扫哪些、用户停用了哪些。覆盖状态永远如实：`none / partial / user_confirmed_enough`。

（空）
