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

独立 `study-bridge` profile，官方 stdio JSON-RPC；serverInfo 为 `deepseek-harness-sdk-runtime / 0.0.1`。使用 `deepseek-official / deepseek-flash`、low reasoning、每步骤 maxTokens 2048。[DeepSeek 2026-09-10 官方公告](https://www.deepseek.com/en/news/deepseek-v4-1-flash/) 明确 V4.1 Flash 的 API 模型 ID 为 `deepseek-flash`。Windows 与 Mac 实机均使用上述实际组件版本，不以 launcher 版本代替所有组件版本。

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

Windows 本机最终运行：`DSH_TEST_INSTALL` 指向现有官方安装，`node --test bridge/tests/*.test.mjs` **36/36 通过**。其中两项实际加载官方 registry 与 Loader/request extension，但不发送模型请求。其他测试使用受控 adapter，证明 HTTP、持久化、队列和产物行为，不能代替真实模型验收。新增 SSH/stdin 检查覆盖中文字节、请求大小、主机认证、远端参数引用、调用端文件导出及真实 CLI 对 HTTP artifact envelope 的处理。

覆盖：接受不等于完成、错误会话/消息归属、部分或中断回答、error/blocked/aborted/max-tokens、失败码脱敏、凭证仅根 .env、源白名单、目录读写边界、符号链接、产物缺失/超限/部分内容、幂等、并发任务、工作区占用、明确验收、客户端不再连接时继续执行、取消等待退出、超时、重启不重放、旧快照可读、重复 Broker 不破坏已有状态。

另有无模型真实 initialize → close 验证，观测 exitCode=0，关闭后初始化被 SESSION_CLOSED 拒绝。

[Windows/macOS GitHub Actions 34689031958](https://github.com/yorhagengyue/dsh-study/actions/runs/34689031958) 在代码提交 `8148605` 实际成功，Node 22.23.2，两个平台各 34 通过、0 失败，明确跳过 2 项本机官方安装检查。CI 不持有任何模型或学校凭证。Mac Mini 本机还实际通过 16/16 runtime+stdin 检查，包含官方 registry 和完整 Loader，无模型调用。

## Windows → Mac 实机往返

追加授权后，当前 Windows 安装了签名有效的官方 Tailscale 1.102.4，用户完成 tailnet 登录。实测 MagicDNS、目标身份、TCP/22、普通 OpenSSH 无交互登录均成功，直连延迟约 5 ms。使用既有 tailnet SSH 授权，主机键正常核验；没有猜密码或关闭主机密钥检查。

Mac 实机为 Darwin 24.6.0 arm64，Node 25.1.0、Python 3.12.12。新项目与 profile 完全独立；原 0.1.2-rc.1 源仓及 `~/.dsh` 保留。独立后端只含 personal-example，监听 loopback 18766；独立 Bridge 监听 loopback 18767。凭证仅目标项目被忽略的根 `.env`（0600），通过 SSH stdin 安全配置，没有复制学校缓存或学生记录。

调用端使用 `bridge/ssh-cli.mjs`：本地 UTF-8 JSON 经 SSH stdin 交给远端 CLI，后者调用认证的 loopback API；artifact 的真实 base64 字节经 SSH 回到 Windows，再核验长度/SHA 后写入本地文件。服务没有对全部网卡公开。

| 观察项 | Mac 首轮 | Mac 同会话修正 |
| --- | --- | --- |
| task_id | 8b7d2c5f-f5af-4c5c-9b64-8cf1d36b11a8 | 相同 |
| session_id | 591966a0-a6fd-477f-81c0-53352a36c127 | 相同 |
| run_id | 951fe3ca-77ef-4b43-b34a-dcbde920893b | b4853686-e268-41ae-8031-99f62959be76 |
| 接收 → DSH receipt | 172 ms | 6 ms |
| 接收 → 完整模型响应 | 1,233 ms | 1,123 ms |
| 接收 → 文件完成 | 7,933 ms | 5,431 ms |
| 实际模型步骤 | 6 | 4 |
| 回到 Windows 的 report.md | 735 字节 | 851 字节 |
| 修改完成时/核验后 | pending → changes_requested | pending → accepted |

Mac 首轮的 study_read 与 write、修正轮的 read/edit/read 均有对应成功结果，完整模型响应与 completed 终态齐全。CLI submit 含 SSH 的观测耗时均约 0.40 秒，迅速返回 queued。初始目标没有提供算术数字或具体步骤。文件事实与 323 字节合成课件一致；修正新增正确英文说明，原文件完整保留为新版前缀。Windows 上再次读取旧快照仍为相同 735 字节。重复提交首轮幂等键没有增加运行。

Mac 首轮 SHA-256：`e1a3caf9bce6496b43b722daf4f4ea9c43b4438eee48fe8b5ac1d68d86bad407`。

Mac 修正版 SHA-256：`ebf96521f4cb3cc76d865a7b0801623fed414e43f8bca8ba501295f0ec43f0c1`。

Windows 调用端证据：被忽略的 `runtime/bridge-mac-live-validation.json`、`work/received-mac-v1.md`、`work/received-mac-v2.md`；最终显式 caller review 保存在 Mac 的任务状态中。网络、SSH、依赖、模型执行与文件往返均已实际验证。

## 未验证边界

当前 SDK 不提供重启恢复会话，只有仍存活的任务进程支持同会话修改。文件与工具约束属于应用层，未宣称 VM/OS 隔离。没有自动开机启动与长期负载保证，机器重启后应重新启动服务并明确创建新任务。未做模型质量、大规模资料任务或真实学生学习评估。原 StudyOS 工作区状态与开始时一致，未改变既有学习日志。
