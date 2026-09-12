# Codex 直接调用 DSH

标准本地 stdio MCP 适配位于 `bridge/mcp/server.mjs`，使用固定版本 `@modelcontextprotocol/sdk` 1.30.0 与 zod 4.6.2。它复用 quick/evidence-cycle，不另建模型代理或平台，也不是 DSH 原生插件的包装格式。

## 两个决策阶段

- `start({source_text, goal})`：自动分配隔离源文件和工作区，执行 Flash，保存公开工具日志及产物，返回实际源/正文、handle 和 pending_review。
- `review({handle, decision, reviewer, reasoning})`：当前 Codex 真正读完后提交独立判决。身份和具体依据必填，不自动接受，不以 Flash self-check 替代。
- `continue({handle, goal})`：只在 changes_requested 后，按实际发现的问题继续同一 DSH 会话。返回修订正文，仍待当前 Codex 审阅。

调用者不需要另开 Codex 项目任务转述，也不必创建 JSON 文件或挑选路径。文件只写在安装时指定的用户 outputs 目录；handle 限定在该目录，不能传任意文件路径。每轮判决、源文、产物版本与公开 I/O 持久化；系统提示、隐藏思考和密钥不导出。MCP 源参数本身也是不可信资料，不当作指令执行。

## 安装与验证

```powershell
npm ci --prefix bridge/mcp --ignore-scripts
codex mcp add dsh-study -- ABSOLUTE_NODE ABSOLUTE_SERVER_MJS --output-root ABSOLUTE_USER_OUTPUTS
```

用户级 `config.toml` 的该服务器设置还需 `tool_timeout_sec = 120`、`startup_timeout_sec = 20`。Windows 配置 `env_vars = ["PROGRAMDATA"]`：实际标准 SDK 客户端的默认安全环境遗漏此项，导致本机 OpenSSH 退出255；仅补该系统变量后已实际恢复。不得把 API 密钥放入 MCP 配置，执行端继续只读项目根 ignored .env。

用标准 SDK 客户端验证，无需模型假装 MCP 工具已载入：

```powershell
node bridge/mcp/probe.mjs OUTPUT_ROOT REQUEST_JSON
```

REQUEST_JSON 使用 MCP 的 `{ "name": "start", "arguments": { "source_text": "...", "goal": "..." } }`。probe 每次执行 initialize、listTools、callTool，保留原始协议结果。review/continue 可由新 MCP 客户端进程接续同一持久化 handle；Flash 会话仍由原后台 bridge 维护。

## 当前桌面加载边界（2026-09-12）

已配置用户级服务器并保留配置备份；标准 SDK 的真实 start→changes_requested→continue→accepted 已通过，但当前活跃 Codex 对话的 ALL_TOOLS 尚无 DSH 工具。不能据此声称当前入口已可直接派工或已达到30秒。

官方 app-server 文档和桌面 0.153.4 的本机协议均有 `config/mcpServer/reload`，用于重读配置并排队刷新已有任务；但本机官方 proxy 连接控制 socket 返回 Windows 10050，当前工具表没有可调用的 reload 接口。没有另开临时 app-server 伪装刷新当前任务，没有重启桌面或中断任务。

最小用户步骤：在 Codex 的 MCP 服务器设置中重启/重新加载 dsh-study，然后回任务发送一条消息，核对 start/review/continue 是否实际出现；若仍未出现，再打开新任务。操作后的实际加载状态尚待验证。官方依据：[MCP配置](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[app-server reload方法](https://learn.chatgpt.com/docs/app-server)。

来源端到端实测仍是55.954秒和44.830秒；后者内部20.118秒不能替代来源总时间。新适配只证明协议与执行链路，当前会话热加载后的真实延迟需要再测。
