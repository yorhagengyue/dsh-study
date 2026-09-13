# 写入审计

生长层。每批写入一行，只追加。Agent 在环境内有完整写权限，不需要事前审批；这份审计让用户看得见写了什么、能撤。格式见 `protocols/CONTRACT.md` 第 9 节。

动作取值：`add`、`update`、`confirm`、`retract`、`supersede`、`expire`、`disable`。

| 时间 | 谁 | 动作 | 记录号 | 为什么 | 怎么撤 |
|---|---|---|---|---|---|
| | | | | | |
