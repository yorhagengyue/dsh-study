# Codex ↔ DSH 连接层

快速执行、真实调用方审阅及计时口径见 [FAST-REVIEW.md](FAST-REVIEW.md)。

Codex 保留语音或文字对话上下文，只向执行器提供目标、必要背景、边界、验收条件和交付文件。后台连接层调用原版 DSH 的 stdio SDK，让 Flash 自主选择工具和步骤。Codex 查询状态、取回真实文件字节并验收；需要修改时，在同一个存活 DSH 会话继续。

这是一组供 Codex 使用的本地 CLI/HTTP 接口，不包含新的语音录制界面，也不自动接管所有对话。没有全局规则或记忆写入功能。资料插件 PR #1 是本分支的前置依赖。

## 配置与启动

需要 Node 22+、现有官方 DSH npm 安装、Python 3.12+，以及已配置且正在运行的资料后端（默认端口 8766，见根 README）。Bridge 的 SDK profile 复用该后端，不取得现有 Web/后端进程的生命周期控制权。

在仓库根目录执行，`/absolute/path/...` 换成本机路径；Windows 与 macOS 使用同一 Node 入口：

```text
node bridge/cli.mjs init --dsh-root /absolute/path/to/dsh --python /absolute/path/to/python
node bridge/cli.mjs setup
node bridge/cli.mjs start
node bridge/cli.mjs health
```

`init` 保留已有配置和凭证，生成根 `.env` 内的随机 `BRIDGE_API_TOKEN` 以及被忽略的 `bridge.local.json`。根 `.env` 还需有 `DEEPSEEK_API_KEY`。明确复用已有 DSH 凭证时，向 `init` 增加 `--reuse-dsh-credential`；此操作只在新仓库没有该字段时读取指定 DSH 根 `.env`，不打印值。不要把 key 放进命令参数。

本机配置可调整安装路径、Python、workspaceRoots、端口、并发数及超时。默认仅接受 `work/bridge-tasks` 下的工作区，最多一个任务执行，240 秒超时，模型 `deepseek-official / deepseek-flash`，资料来源白名单只有 `personal-example`。更改配置后须停止并重新启动 Bridge，已有会话随停止关闭。

`setup` 读取实际安装的 launcher、SDK、协议和工具版本，创建独立 `study-bridge` profile，不升级依赖或修改 DSH 核心。每个任务有自己的 SDK home 和进程；`start` 在后台隐藏启动，只监听 `127.0.0.1:8767`。不打开浏览器。

## 委派与收回

保存 UTF-8 JSON 请求，例如 `work/task-request.json`；工作区应是该任务独占的绝对目录。请求只写任务意图，不需要预写执行步骤：

```json
{
  "request_id": "example-initial-0001",
  "goal": "根据 personal-example 的合成资料，写一份简短中文说明。",
  "context": "这是连接层验收，不是真实学习记录。",
  "constraints": ["仅使用允许的个人示例资料，保留出处。"],
  "acceptance": ["report.md 可读取，事实可追溯到资料。"],
  "workspace": "/absolute/path/to/dsh-study/work/bridge-tasks/example",
  "deliverables": ["report.md"]
}
```

```text
node bridge/cli.mjs submit --request work/task-request.json
node bridge/cli.mjs status --task TASK_ID
node bridge/cli.mjs wait --task TASK_ID --run RUN_ID --timeout-ms 10000
node bridge/cli.mjs result --task TASK_ID --run RUN_ID
node bridge/cli.mjs artifact --task TASK_ID --run RUN_ID --path report.md --out work/received-report.md
```

`submit` 快速返回 task_id/run_id；模型在后台执行，HTTP 客户端断开不取消任务。`wait` 默认短等 10 秒，最多请求 50 秒，不占据整个长任务的交互时间。`done:true` 仅表示终态，应继续检查 `run.status`、错误和 `review.status`。

`result` 返回模型回复、事件、错误及产物元数据。`artifact` 实际返回 base64 文件字节、UTF-8 文本（适用时）、长度和 SHA-256；指定 `--out` 可保存字节，已有文件拒绝覆盖。产物是每次运行结束后的独立快照，后续修改不覆盖旧快照。默认每文件最多 16 MiB，只有声明过的相对路径可读取。失败或取消时，可读的部分产物仍返回并明确标记。

## 同会话修正与验收

初始结果为 `pending`。调用方读取并核对后，显式记录意见；这个记录不会被冒充为耿越本人已审批：

```text
node bridge/cli.mjs review --task TASK_ID --run RUN_ID --decision changes_requested --notes "内容可追溯，请补一行英文出处。"
node bridge/cli.mjs continue --task TASK_ID --request work/correction.json
```

修正请求使用新的 request_id，只需 `goal` 和可选的 `context/constraints/acceptance`，例如：

```json
{
  "request_id": "example-correction-0002",
  "goal": "保留原说明，在 report.md 末尾增加一行英文出处。",
  "acceptance": ["正文事实保持一致，新增出处可追溯。"]
}
```

返回同一 task_id/session_id 和新的 run_id。再查询、读取新快照并验证后：

```text
node bridge/cli.mjs review --task TASK_ID --run NEW_RUN_ID --decision accepted --notes "调用方已核对正文、出处和实际文件。"
```

同 request_id + 同输入返回原 receipt，不重复模型调用；同 request_id + 不同输入返回 409。每个任务同一时刻只有一个 prompt，不依赖官方 SDK 未提供的服务端幂等功能。

## 状态与边界

独立记录 `acceptedAt`（后台接收）、`receiptAt`（DSH 接收）、`modelStartedAt`（步骤调度）、`modelRespondedAt`（完整模型响应）、`artifactObservedAt`（实际文件）、`finishedAt`（终态）。步骤调度不证明请求已经发出；HTTP 前错误也可能有 modelStartedAt。产物区分本次新建、本次修改和未变化的旧文件；`review` 单独记录调用方的意见。

只有相同 session、已接收 message 的完整 turn、完整模型响应证据、成功 stop reason 和全部声明产物同时存在，才给出 `completed`。接收成功或 idle 均不够。失败、超时、中断和取消不会变成成功。取消期间保持 cancelling，等待进程退出和部分产物收集；runtime_process_exited、runtime_closed_at 和 runtime_close_error 单独公开退出确认。

```text
node bridge/cli.mjs cancel --task TASK_ID
node bridge/cli.mjs stop
```

取消关闭本任务 runtime。正常 stop 在有活动任务时拒绝；明确中断全部任务才使用 `stop --force`。停掉进程或重启 Broker 后，旧结果和快照仍可读，但官方当前 SDK 没有 resume 接口，旧任务不能冒充同会话续接，也不会自动重放。应由调用方明确提交新任务和必要背景。

HTTP 除健康检查外需要根 `.env` 的 Bearer token，拒绝浏览器 Origin。任务只暴露官方资料工具及 read/write/edit；shell、浏览器和其他工具被禁用。文件工具限制读写到任务工作区，资料工具限制来源，拒绝读取 `.env`。产物接口还校验 realpath、符号链接和相对路径。该限制是应用层策略，不是操作系统沙箱，不能抵御有本机文件权限的恶意进程并发替换路径。

目前 Windows 的真实 Flash 与同会话修正结果、macOS 受控 CI 范围和剩余限制，见 [实际验证记录](BRIDGE-VALIDATION.md)。

## 通过已有 SSH 连接使用远端 Bridge

先在目标机器独立配置并启动同一 Bridge，再使用已授权且主机密钥已核验的 SSH 连接。复制 `bridge.ssh.example.json` 为被忽略的 `bridge.ssh.local.json`，填写 SSH 别名或已确认的 user@host，以及远端 Node/CLI 的实际绝对路径。

```text
node bridge/ssh-cli.mjs health --target mac-mini
node bridge/ssh-cli.mjs submit --target mac-mini --request work/mac-task.json
node bridge/ssh-cli.mjs wait --target mac-mini --task TASK_ID --timeout-ms 10000
node bridge/ssh-cli.mjs artifact --target mac-mini --task TASK_ID --run RUN_ID --path report.md --out work/received-from-mac.md
node bridge/ssh-cli.mjs continue --target mac-mini --task TASK_ID --request work/mac-correction.json
```

请求中的 workspace 是远端任务目录；`--request` 和 `--out` 是调用端文件。请求以 UTF-8 stdin 传输，远端 CLI 的 `--request -` 接收，避免 PowerShell 管道编码问题。产物通过 SSH 返回字节，在调用端核验长度和 SHA 后保存。远端模型和 Bridge 凭证始终留在远端根 `.env`，服务仍仅监听 loopback。入口强制 BatchMode 和 StrictHostKeyChecking，不处理账号登录、自动接受未知主机密钥或自动重放失败任务。
# Fast path

`node bridge/ssh-cli.mjs fast --target mac-mini --request .\\request.json` performs one remote submit, 100 ms event poll, result and artifact retrieval. The JSON response retains every run, event list, result and artifact envelope. An optional `fast_review` triggers one same-session DSH self-check; caller acceptance still requires the explicit `review` endpoint.
