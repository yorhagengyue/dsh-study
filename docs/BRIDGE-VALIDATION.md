# 连接层验证记录

2026-09-12。验证对象为独立功能分支 `feat/codex-dsh-bridge`，基于尚未合并的资料插件提交 `3f35340`。无 UI 控制、无 DSH 核心修改、无学校同步、无规则或记忆自动写入。

## 实际官方环境

| 组件 | 实际解析版本 |
| --- | --- |
| @deepseek-ai/dsh launcher | 0.1.5-rc.1 |
| @deepseek-ai/dsh-sdk-minimal | 0.1.5-rc.2 |
| @deepseek-ai/dsh-sdk-jsonrpc-server | 0.1.5-rc.2 |
| @deepseek-ai/dsh-sdk-protocol | 0.1.5-rc.2 |
| @deepseek-ai/dsh-tools | 0.1.5-rc.2 |

独立 `study-bridge` profile，官方 stdio JSON-RPC；serverInfo 为 `deepseek-harness-sdk-runtime / 0.0.1`。使用 `deepseek-official / deepseek-flash`、low reasoning、每步骤 maxTokens 2048。[DeepSeek 2026-09-10 官方公告](https://www.deepseek.com/en/news/deepseek-v4-1-flash/) 明确 V4.1 Flash 的 API 模型 ID 为 `deepseek-flash`。模型与产物验收实际在 Windows 运行，不以 launcher 版本代替所有组件版本。

## 真实两轮任务

输入只给简短目标、必要背景、边界、完成条件，未提供算术答案或详细执行步骤。使用仓库自带合成课件 `examples/personal/welcome.md`；source_id=`personal-example`，course_id=`personal`，resource_id=`local:44bc5613e1b412a3f8bd9317`。

任务 `d52cac07-dbe0-49be-8c52-2547cec9f6b5`，两轮共用 session `c2339600-e65b-4e19-a7e8-e4991d47fce3`。

| 观察项 | 第一轮：读取资料并交付 | 第二轮：保留正文，追加英文 |
| --- | --- | --- |
| run_id | 842efd97-fbd9-4ac2-9153-226067edf80b | bae47dac-7752-465b-baa4-38091355ee07 |
| 接收 → DSH receipt | 571 ms | 6 ms |
| 接收 → 首个完整模型响应 | 1,233 ms | 1,042 ms |
| 接收 → 文件快照/完成 | 7,263 ms | 4,496 ms |
| 实际模型步骤 | 6 | 4 |
| 成功工具调用 | study_sources, study_courses, study_status, study_catalog, study_read, write | read, edit, read |
| 文件 | report.md，243 字节，新建 | report.md，365 字节，修改 |
| 完成时验收状态 | pending | pending |
| 调用方检查后 | changes_requested | accepted |

CLI submit 含 Node 启动的本机观测耗时分别约 0.17 秒和 0.19 秒，立即返回 queued；这是单次观测，不是性能承诺。两轮共 10 个真实模型步骤；工具选择来自 Flash 自主执行。每个工具都有可对应 callId 的成功 result，turn/end.reason.kind=completed，且出现完整模型响应后才判执行成功。

第一轮实际返回内容是“12 个苹果平均放进 3 个篮子，每篮 4 个”，含准确 source_id/resource_id。Codex 通过 artifact 接口导出字节并与原课件核对。第二轮在同一会话追加正确英文说明；代码校验原文件字节完整保留为新版前缀、来源不变、新版 SHA 与实际字节一致。再次读取第一轮 artifact 得到相同 243 字节，证明快照未被新文件覆盖。

首轮 SHA-256：`b83ef4c9343fe3e8b264f5d9d9612ea1a9fcc40fbfbe644e6865a6f4c71c97db`。

修正版 SHA-256：`5bf48a7902ebea931da0c71def8d34cefe9e0940d73def51d4b4d62794a7e89a`。

重复提交同一首轮请求实际返回相同 task/run、duplicate=true，任务没有增加第三轮。验收为显式 caller 记录，表示 Codex 已核对本次合成样例，不表示 owner 已批准 PR。默认结果不会自行变成 accepted。

本机证据存于被忽略的 `runtime/bridge/tasks.json`、`runtime/bridge-live-validation.json`、任务 SDK home 日志与 `work/received-bridge-v1.md` / `work/received-bridge-v2.md`。仓库只保留本记录的非敏感摘要。

## 已发现并修复的真实失败

最初真实提交 `cc042b2e-0f06-4b8e-ac72-a344c2cae00b` 在官方请求扩展准备阶段报 REQUEST_EXTENSION，未发送模型 HTTP 请求、未生成文件，保持 failed。根因是两个新薄插件包缺少 version，官方 plugin-package-inventory-deepseek 严格检查活动包身份。已补齐 version，并新增完整官方 Loader 的 request extension prepare 回归，无需修改官方安装或关闭扩展。

该失败同时证明 step/start 只是调度证据。因此单列 modelRespondedAt；失败原因只保留安全的稳定 code/stopReason/providerFailureCode，不暴露任意异常正文。之后使用新的幂等键重新提交，完成上述两轮实测；旧失败记录没有被覆盖成成功。

## 受控验证

Windows 本机最终运行：`DSH_TEST_INSTALL` 指向现有官方安装，`node --test bridge/tests/*.test.mjs` **28/28 通过**。其中两项实际加载官方 registry 与 Loader/request extension，但不发送模型请求。其他测试使用受控 adapter，证明 HTTP、持久化、队列和产物行为，不能代替真实模型验收。

覆盖：接受不等于完成、错误会话/消息归属、部分或中断回答、error/blocked/aborted/max-tokens、失败码脱敏、凭证仅根 .env、源白名单、目录读写边界、符号链接、产物缺失/超限/部分内容、幂等、并发任务、工作区占用、明确验收、客户端不再连接时继续执行、取消等待退出、超时、重启不重放、旧快照可读、重复 Broker 不破坏已有状态。

另有无模型真实 initialize → close 验证，观测 exitCode=0，关闭后初始化被 SESSION_CLOSED 拒绝。

Windows/macOS GitHub Actions 的最终运行结果在提交后的交付记录中列出；CI 不持有任何模型或学校凭证。无 `DSH_TEST_INSTALL` 时运行 26 项、明确跳过上述两项本机官方安装检查。

## 未验证边界

macOS 完整官方 DSH + 真实模型 + 本地资料链路未运行，不能以跨平台受控测试替代。当前 SDK 不提供重启恢复会话，只有仍存活的任务进程支持同会话修改。文件与工具约束属于应用层，未宣称 VM/OS 隔离。未做模型质量、长期负载、大规模资料任务或真实学生学习评估。原 StudyOS 工作区状态与开始时一致，未改变既有学习日志。
