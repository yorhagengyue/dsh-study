# dsh-study

耿越自己的资料输入插件。独立 Python 后端连接 Canvas 或本地课件，通过原生 DSH service、provider 和工具提供来源、课程目录、刷新、导入、正文/文件读取及错误状态。学校来源不表示学习者学籍。

本版只处理资料输入与输出。Canvas HTML 和 UTF-8 文本可直接读取；PDF/Word 等返回原始字节并标明需要解析器，不能把“已下载”当作“已理解”。不生成 AI 总结，不做知识整理、学生 profile 或新网页。SMU adapter 尚未实现。

## 首次配置

需要 Python 3.12+；DSH 插件需要 Node 22+ 与已安装的官方 DSH。后端只用 Python 标准库。

```powershell
python scripts/init-local.py
```

这个命令生成被 Git 忽略的根 `.env` 内部随机凭证及 `sources.local.json`，已有文件原样保留。默认个人合成示例可以直接使用。

Canvas 来源需要在 `.env` 填写 `CANVAS_BASE_URL` 与 `CANVAS_API_TOKEN`，并在 `sources.local.json` 的 `course_ids` 填写允许同步的课程 ID。空数组表示没有选课，删除该字段表示允许当前 token 可见的课程。可以增加不同来源，给它们配置不同的凭证字段名。自己的课件放专用目录，在 local source 的 `path` 配置该目录；Agent 导入时只传来源 ID。

Canvas 仅 GET 资料，不读取成绩或提交记录，不答题、签到或提交。凭证权限仍由学校控制。正文、下载、个人资料和运行日志只保存在本机忽略目录。

## 独立使用

```powershell
python -m dsh_study serve --root . --port 8766
```

后端仅监听 `127.0.0.1`，不打开浏览器。另一个终端可以执行：

```powershell
python -m dsh_study call sources
python -m dsh_study call import_local --arguments '{"source_id":"personal-example"}'
python -m dsh_study call status --arguments '{"source_id":"personal-example"}'
python -m dsh_study call catalog --arguments '{"source_id":"personal-example"}'
```

导入/刷新返回 job_id；status 确认完成或部分失败后，使用目录返回的 source_id/course_id/resource_id 调用 read。CLI 自行读取根 `.env`，不要把 token 放进命令参数。

## 安装到 DSH

```powershell
node scripts/install-plugin.mjs --dsh-root C:\Users\Administrator\dsh --python C:\Users\Administrator\AppData\Local\Programs\Python\Python312\python.exe
```

安装脚本将本地插件打包，再用官方 `dsh plugin --profile web add` 加入第三个 bundle，保留官方 base/web。它备份 profile，只维护自身配置，不修改 DSH 核心。安装后重启现有 DSH；本机已提供的 `C:\Users\Administrator\dsh\start-dsh.ps1` 是隐藏后台启动入口。插件调用时自动启动资料后端，并回收自己创建的子进程。

DSH 工具：`study_sources`、`study_courses`、`study_catalog`、`study_refresh`、`study_status`、`study_read`、`study_import_local`。可让 DSH 先列出来源，再导入 personal-example，查询状态与目录，最后读取示例。工具描述会要求保留来源、权限与新旧状态。

卸载插件：

```powershell
node scripts/uninstall-plugin.mjs --dsh-root C:\Users\Administrator\dsh
```

随后重启 DSH 使卸载生效。该操作保留本机资料和 `.env`，官方 DSH 可独立升级。具体配置和验证方式见 [DSH 接入说明](docs/DSH.md)。

## 验证与范围

```powershell
python -m unittest discover -s tests -v
python scripts/audit-private.py
```

[实际验证结果](docs/VALIDATION.md) 区分受控测试、真实 Canvas 接入、当前 DSH 进程工具执行和未验证边界。真实来源验收脚本为 `scripts/verify-backend.py`，会实际同步配置的来源；DSH 启动探针为 `scripts/verify-dsh.mjs`，仅在明确准备请求后通过原生工具执行固定的目录/读取操作，不调用模型。

[输入输出合约](docs/CONTRACT.md) · [后端 API](docs/BACKEND.md) · [行动规划与迁移清单](docs/PLAN.md)。实质实现保留在功能分支与 draft PR，待耿越审阅后合并。
