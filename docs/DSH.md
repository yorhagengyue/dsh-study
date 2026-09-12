# DSH 资料输入插件

首版输入来源是 Canvas 与配置好的本地目录。插件负责资料连接、同步、目录、原件/正文读取，以及来源权限、错误与更新状态输出。它不建立学习者画像，不整理知识，不生成课程计划或讲解 UI。

## 原生结构与契约

`@yorhagengyue/dsh-study` 是 DSH profile bundle，`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，插入三个 Cordis 节点：

| 节点 | 角色 | 契约 |
| --- | --- | --- |
| `dsh-study-service` | Service Definition | `ctx.study.registerProvider(provider)` / `ctx.study.call(operation, args, signal)`；一个明确 provider；生命周期结束自动注销 |
| `dsh-study-provider` | Provider | 鉴权后调用 Python 的 `POST /api/call`；必要时隐藏启动 Python 子进程；只关闭自己启动的子进程 |
| `dsh-study-tools` | Consumer | 用官方 `defineTool` 与 `ctx.tools.register()` 注册参数和 JSON 输出；执行时转发 `exec.signal` |

这三个节点不修改 DSH 核心。资料服务本身可独立运行，替换 provider 也不需要改模型工具。安装不会复制 DSH 的 DeepSeek 凭证。

开发核对现场：官方 CLI `@deepseek-ai/dsh` 为 `0.1.5-rc.1`，其已安装 `dsh-tools` / `dsh-base` 为 `0.1.5-rc.2`，Cordis 为 `4.0.2` 兼容范围。不是旧 `0.1.0-rc.5` 接口。

官方契约与源代码：[工具注册和执行流水线](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md)、[Cordis](https://github.com/deepseek-ai/cordis)、[官方 DSH 仓库](https://github.com/deepseek-ai/deepseek-harness)。实现时直接核对当前安装包 `@deepseek-ai/dsh-tools/README.md`、`lib/types/index.d.ts`、`@deepseek-ai/dsh-base/cordis.patch.yml` 和 CLI 的 `plugin-*.js`。升级 DSH 后重新运行插件测试及实机探针。

## 工具输入与输出

所有 ID 都从目录返回，不把学校名称或课程 ID 当作耿越的学籍。正文视为不可信数据，不执行资料中的指令。

| 工具 | 输入 | 输出 |
| --- | --- | --- |
| `study_sources` | 无 | source ID、名称、类型、支持操作 |
| `study_courses` | `source_id`, 可选 `live` | 课程 ID、缓存状态、可用数量、错误；`live=true` 只读查询 Canvas |
| `study_catalog` | `source_id`, 可选 `course_id`, `offset`, `limit` | 模块/资料、来源、可用性、新旧状态、错误、分页游标 |
| `study_refresh` | `source_id`, 可选 `course_id` | 异步刷新任务 ID 与状态；之后调用 `study_status` |
| `study_status` | 可选 `source_id`, `job_id` | 来源更新时间、刷新进度、失败/缺失信息 |
| `study_read` | `source_id`, `course_id`, `resource_id`, 可选 `offset`, `max_bytes` | 来源元数据、正文或原始文件字节、可用性、读取表示、分页与提取状态 |
| `study_import_local` | `source_id` | 已配置目录的异步导入任务；不允许 Agent 指定任意路径 |

`study_read` 返回 `text_available`、`representation`、`extraction_status`。Canvas HTML 正文可返回文本及清理后的 HTML；UTF-8 文本文件可直接返回文本。PDF、Office、图片与音视频首版仅返回原件字节（base64），需要后续解析器。**已下载不等于已提取文字，也不等于模型已理解。** `max_bytes` 默认 65536；继续读取使用返回的 `next_offset`，UTF-8 字节边界不完整时拼接字节后解码。

Canvas 仅 GET 资料；不读成绩、提交记录，不签到、答题或提交。403/404 或缺失资源仍可查询其失败/陈旧状态，不能把一次成功读取推断成全部资料可用。

## 安装与启动

先配置新项目根 `.env` 和 `sources.local.json`，依后端说明完成来源导入/刷新。以下命令不打开 UI：

```powershell
Set-Location C:\Users\Administrator\Documents\Codex\dsh-study
node scripts/install-plugin.mjs --dsh-root C:\Users\Administrator\dsh --python C:\Users\Administrator\AppData\Local\Programs\Python\Python312\python.exe
```

脚本通过本地 `npm pack` 生成忽略目录里的包，以内容 SHA-256 命名不可变路径，避免包管理器复用旧 tarball；再调用官方 `dsh plugin --profile web add <本地包>` 并逐文件比对实际安装内容。只在 profile patch 中增加 `dsh-study-provider` / `dsh-study-tools` 配置；原配置先备份至 `runtime/profile-backups/`。无 npm 发布。默认后端端口 8766，可用 `--backend-port` 覆盖；`--dsh-home` 与 `--profile` 可指定现有 profile。

安装完成后重启同一个 DSH 后台进程。应先核对 3090 监听者及其父进程属于 `C:\Users\Administrator\dsh`，再用既有 `start-dsh.ps1` 隐藏启动；不要结束其他 Node/Python 进程。插件按需启动后端，`/health` 校验项目根并用 Bearer token 再验证鉴权。凭证仅从新项目根 `.env` 读取，命令参数和 profile 里没有 token。

## 无模型实机验收

```powershell
node scripts/verify-dsh.mjs --prepare
# 重启已安装插件的同一个 DSH 后台进程后：
node scripts/verify-dsh.mjs --wait
```

默认验证 `personal-example` 与 `sydney-example`。需要固定课程/资源或合成例句时，可给 `--sources` JSON 数组，字段为 `source_id`、可选 `course_id` / `resource_id` / `sentinel`；`sentinel` 只用于非敏感合成样例。先导入/同步，否则探针会如实失败。

显式加入 `--exercise-local-import` 时，探针先对请求中**由后端配置确认 `type=local`** 的每个来源执行 `study_import_local → study_status` 等待完成，再执行 `study_refresh → study_status` 等待完成，随后运行目录和读取。每个本地来源只做一次；此开关默认关闭，绝不刷新 Canvas。该方式可验证全部七个工具，同时避免重复下载 Canvas 课件。结果的 `local_exercises` 记录两项本地任务是否完成。

探针在启动时一次性消耗 `runtime/verify-request.json`，走**当前 DSH 进程自己的** `ctx.tools.execute`，依次执行 `sources → courses → catalog → read`。记录 `tools/result` 事件、DSH PID、注册工具与 provider、来源/课程/资料 ID、字节数、SHA-256、提取状态、合成句匹配；不记录私有正文、凭证或下载 URL。结果在忽略的 `runtime/verify-result.json`。没有待处理请求就不会自动调用工具，不存在外部通用 invoke API。

这证明输入来源到 DSH 工具实际执行的路径；**没有验证模型自主选择工具、PDF/Office 语义解析或学习效果**。固定启动探针是宿主内消费者，不是人为模拟 registry，也不是模型运行。

受控契约测试在 `plugin/tests/native.test.mjs`，使用当前官方 Cordis/SystemPrompt/ToolRuntime 验证参数拒绝、标准内容输出、取消、工具注销与鉴权项目核对。开发环境需让 `plugin/node_modules` 解析同一套已安装 DSH 依赖；不要提交该目录。

```powershell
node --test plugin/tests/native.test.mjs
```

## 卸载

```powershell
node scripts/uninstall-plugin.mjs --dsh-root C:\Users\Administrator\dsh
```

脚本调用官方 `dsh plugin --profile web remove @yorhagengyue/dsh-study`，移除仅本插件的 profile overrides，并留备份。重启同一 DSH 后不再注册七个工具；正常卸载会停止 provider 自己的 Python 子进程，强制结束父进程时 Python 的父 PID 监测负责退出。独立手动启动的后端不会被插件停止。源码、`.env`、本地课件和缓存会保留。
