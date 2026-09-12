# 资料输入后端

首版只负责配置来源的输入、缓存和输出健康。支持 Canvas 只读资料与本地目录；学校只是来源示例，不代表学习者学籍。没有学生 profile、学习记录、笔记、教学编排、AI 总结或讲解界面。SMU 登录和资料接入尚未实现。

## 输入到输出的实际合约

1. 根 `.env` 保存 `STUDY_API_TOKEN` 及各 Canvas 凭证；`sources.local.json` 保存非凭证来源配置。`sources.example.json` 提供可编辑样板。
2. `courses` 返回来源内的课程 ID；Canvas 的 `live:true` 通过只读 GET 发现当前可见课程，缓存目录不会伪装成实时响应。
3. `refresh` 对 Canvas 抓取模块、公告、作业说明、页面和文件，或对本地来源导入目录。异步返回 job；持续使用 `status` 查询到 `completed`、`partial` 或 `failed`，进程中断后的任务标为 `interrupted`。
4. `catalog` 返回可用性、错误、来源、更新状态与资料 ID，不返回原始 API 对象、签名下载链接或本机绝对文件路径。
5. `read` 根据目录取得的 ID 返回经过净化的 Canvas 正文，或缓存文件的原始字节。GET `/api/file` 可流式取原文件与单段 Range。

**原件已下载不等于模型已经能读懂。** `representation`、`text_available` 和 `extraction_status` 明确区分表示形式：

| 返回形式 | representation | text_available | extraction_status |
|---|---|---|---|
| Canvas 正文净化后文本 | `canvas_html_text` | 当前片段可解码时为 true | `not_required`；跨 UTF-8 字符边界时 `decode_required` |
| 文件目录中的文本候选 | `utf8_candidate` | false，尚未实际解码 | `decode_required` |
| 实际读取成功的 UTF-8 文件片段 | `utf8_text` | true | `not_required` |
| PDF、Office、图片、音视频等 | `binary` | false | `parser_required` |

PDF/Word 只提供原始文件字节和来源/版本信息，本版不提取其语义文本。后续解析器可消费这些字节；不把 PDF 下载成功宣称成模型理解成功。Canvas 原始 HTML 保存在被忽略的清单内，`read` 返回的是净化后的文本字节，短正文还附 `safe_html`。正文或文件均视为不可信资料，不执行其内容。

`read.offset` / `max_bytes` 的单位是**对应表示的字节**：Canvas 正文是净化后 UTF-8 文本，文件是原始文件。响应含 `offset`、`bytes_returned`、`next_offset`、`truncated` 和精确 `base64`。片段恰好截断中文字符时不制造替换字符，省略 `text` 并标明需拼接字节再解码。未提取文本的文件也能准确分段取回完整原件。

## 配置与运行

Python 3.12+，运行期只有标准库，直接在项目根运行即可。安装为包是可选项。

```powershell
python scripts/init-local.py
python -m dsh_study serve --root C:\Users\Administrator\Documents\Codex\dsh-study --port 8766
python -m dsh_study call sources
python -m dsh_study call import_local --arguments '{"source_id":"personal-example"}'
```

后台由插件启动时可增加 `--parent-pid PID`。后端每 2 秒检查父进程；父进程退出后停止。插件也能连接同根的既有后端，健康接口里的 `project_root` 用于区分其他同端口实例。HTTP 只绑定 `127.0.0.1`；除了 `/health` 的版本/项目根信息外，全部资料接口要求 Bearer `STUDY_API_TOKEN`。CLI 自己读取 `.env`，凭证不进命令参数。HTTP 不记录请求地址、正文或 Authorization。

Canvas 来源的 `base_url_env` / `token_env` 可自定义根 `.env` 的字段名；不从系统环境或旧项目搜索凭证。`course_ids:[]` 代表不选课程；省略 `course_ids` 代表所有当前可见课程。实际调用传 `course_id` 可只刷新一门，其他已缓存课程不会因此变成 stale。课程标识不依赖任何学校的代码格式。

本地来源配置 `path`（相对于新项目根或绝对目录）、`course_id`、`course_name`。Agent 的 `import_local` 仅接受 `source_id`，不能注入任意文件路径；文件名以来源内相对路径显示。导入跳过隐藏文件/目录、符号链接及显式凭证文件名；应把普通课件放在专用目录。项目根及其祖先目录不允许作为过宽的导入范围。

## API

POST `/api/call`，`Content-Type: application/json`：

```json
{"operation":"catalog","arguments":{"source_id":"personal-example","course_id":"personal","offset":0,"limit":100}}
```

成功：`{"ok":true,"result":...}`。失败：`{"ok":false,"error":{"code":"...","message":"..."}}`，同步对应 HTTP 4xx/5xx。异步 job 的 `partial` 表示仍有来源限制，`failed` 表示本次运行没有完成；不能只看 HTTP 200。

| operation | arguments | 主要返回 |
|---|---|---|
| `sources` | `{}` | `sources[].source_id/name/type/operations` |
| `courses` | `source_id`, 可选 `live:boolean` | `courses[].course_id/name/status/resource_count` |
| `catalog` | `source_id`, 可选 `course_id,offset,limit` | `courses`（含模块）、分页 `resources`、`errors,changes,total,next_offset` |
| `refresh` | `source_id`, 可选 `course_id` | `job_id,status,started`；同来源运行时返回既有 job |
| `import_local` | `source_id` | 与 refresh 相同的本地导入 job |
| `status` | 可选 `source_id` 或 `job_id` | 单个 job，或来源状态与最近 20 个 job |
| `read` | `source_id,course_id,resource_id`, 可选 `offset,max_bytes` | 元数据、精确 base64 与可解码时的文本 |

`catalog.limit` 默认 100，上限 500。`read.max_bytes` 默认 65536，上限 262144。目录资源都含 `source_id,source_type,course_id,resource_id,source_name,available,stale,new,status,change`；如有则附上 `error,checksum,updated_at,downloaded_at,related_resources`。`status=removed` 的旧缓存仍可读取，但始终标记 stale。

GET `/api/file?source_id=...&course_id=...&resource_id=...` 同样需要凭证，支持 `Range: bytes=0-1023`、后缀范围和 HEAD。越界或多段范围返回 416；全部文件以附件发送，不以内嵌 HTML 执行。

## 迁移与保存边界

`canvas.py`、`material_sync.py` 和 `library.py` 复用源 StudyOS 的运输、同步和正文净化逻辑。保留 GET 分页、同源凭证限制、跨域下载不转发 token、公网目标检查、正文链接递归发现、模块/首页回退、原子替换、SHA-256 摘要、损坏缓存重新下载、文件失败保留与旧来源确认后才标记移除。

移除了学校课程代码筛选，缓存按 source 独立保存在 `state/sources/<source_id>/`。原 `raw/` 历史、student 记录、旧 CHANGELOG、自动 Git 和旧网页接口不在本版输入范围。最早 `sync.py` 的 Markdown 导出与个人进度职责没有迁移；资料抓取由完整的 `material_sync` 内核覆盖。

当页面/文件列表返回 403/404，会保留错误并沿模块、首页或正文合法链接尝试单项 GET；权限被拒绝不等于已删除。无法取得的正文/文件明确显示 error/missing，不要求学校全部内容可取才认为输入连接可用。外部网站、测验、LTI 保留目录入口，不跟进答题、成绩、提交或第三方正文。

本地导入新增内容摘要、更新识别、原子写入、旧版本保留和目录失联后的失败状态。原件、资料清单、raw API 缓存、jobs、`.env` 及 `sources.local.json` 全部留在 Git 忽略范围，Git 仅包含代码和合成示例。

## 受控验证

```powershell
python -m unittest discover -s tests -v
```

测试不访问学校也不读真实 `.env`。覆盖原同步行为、403/404 回退、失败保留、文件和正文更新、缓存摘要、重定向 token 隔离、分页和不可信 HTML；新增真实本地 HTTP 调用覆盖鉴权、范围读取、本地导入与更新、源隔离、精确 UTF-8 分片、表示形式和中断 job 恢复。真实 Canvas 与 DSH 运行路径的验收证据由集成验收单独记录，不混同这些受控测试。
