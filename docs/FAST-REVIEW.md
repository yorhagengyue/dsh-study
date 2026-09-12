# 快速执行与真实调用方验收

`fast` 合并一次提交、短间隔状态查询和产物取回；它只报告执行状态，**不自动接受产物**。可选 `fast_review` 必须使用普通 `goal` 字段，只表示同会话模型自检。执行失败、超时或自检失败会保留 receipt、已有结果及错误，便于继续查询，不应自动重放任务。

`evidence-cycle.mjs` 把资料预检、公开工具日志、产物完整性检查和调用方审阅分成两个紧邻调用。它面向已授权的 SSH 目标，使用项目的 `bridge.ssh.local.json`。Mac 工作区必须事先放好 UTF-8 `source.md`；入口会真实回读并与 `source_text` 比较，缺失或不一致时在模型提交前失败。

准备 bundle JSON（路径、输入和任务由调用者提供，不预填计算答案）：

```json
{
  "target": "mac-mini",
  "source_text": "与远端 source.md 完全一致的原文",
  "request": {
    "request_id": "caller-unique-id-001",
    "workspace": "/absolute/authorized/workspace",
    "goal": "读取 source.md，写 report.md，解释原文要求的内容。",
    "context": "source.md 已在工作区，是唯一来源。",
    "constraints": ["只读 source.md，不调用无关来源。"],
    "acceptance": ["计算与解释均有来源依据。"],
    "deliverables": ["report.md"]
  }
}
```

```powershell
node bridge/evidence-cycle.mjs dispatch OUTPUT_DIRECTORY bundle.json
```

此命令保存原始请求、远端源校验、fast 完整响应、实际 artifact 字节、脱敏公开工具 I/O，以及待审输入，并向 Codex 返回实际原文和产物正文。系统提示、内部思考与凭证不导出。任一步失败都不会生成自动 accepted。

**调用者必须现在真正阅读返回内容**，核对事实、算术、解释、边界和验收条件，不先批量处理别的任务。审阅者身份应写实际模型/人员，理由必须针对实际内容。将判决保存为 JSON 后立即调用 review：

```json
{
  "run_id": "刚返回的实际 run_id",
  "reviewer": "实际审阅者身份",
  "decision": "changes_requested",
  "reasoning": "审阅实际正文后发现的具体问题及依据。"
}
```

```powershell
node bridge/evidence-cycle.mjs review OUTPUT_DIRECTORY verdict.json
```

没有独立审阅就保留待审，不能只因文件存在、固定词出现或模型自称完成而接受。通过时才把 decision 写成 `accepted`。此入口记录判决及 broker 回执，`timing.json` 计入从 dispatch 开始到审阅回执持久化的全部墙钟时间，包括调用方思考和工具间隔；事先准备资料不在该计时内。

若需修正，先持久化 `changes_requested`。新 bundle 添加已返回的 `task_id`，使用新的 `request_id`、同一 workspace 和源原文，将实际发现的问题写入 `goal`，再对新的输出目录执行 dispatch。入口通过 continue 复用存活会话；重新阅读改后正文后再 review。完整纠错时间应从第一轮 dispatch 算到最后一次 accepted，不只计算最后一轮。

2026-09-12 纠正后的实测：两个新案例完整调用方验收为 17.550 秒和 16.180 秒；显式植入错误解释后，拒绝、同会话修正、重新验收为 39.511 秒。公开原始运行日志当时已在 Mac 持久化；前两个样本的本地日志导出在验收后完成，后续入口已改为在展示待审输入前导出。样本少，不能据此声称稳定 SLA。此前 12.196 秒自动接受缺源报告的探针无效，已撤回，不能用作性能数据。
