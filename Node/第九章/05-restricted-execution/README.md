# 05 受限执行

上一节的 SQL 查询实现不变，这一节把它放入有资源限制的临时 Docker 容器；补充分析代码使用另一容器，只读取查询结果。

## 运行

前置：Node.js 22+、正在运行的本机 Docker Engine / Docker Desktop（Linux 容器）。保持 03、04、05 三个项目相邻，04 已安装依赖并执行 `npm run prepare-data`。本节不需要 API Key，不读写环境变量文件。

在本目录执行：

```bash
npm run build:sandbox
npm run demo -- code
npm test
```

本节宿主代码仅使用 Node 内置模块，没有新 npm 依赖。构建时镜像内用 `runtime/package-lock.json` 安装锁定的 DuckDB Node 依赖。首次构建需要访问 Docker Hub 和 npm；执行任务时禁用外部网络。

`build-image.js` 只复制 `runtime/` 中固定的四个文件和上一节 `query-worker.js` 到临时构建目录，完成后删除目录。不会把整个课程、上传数据或配置文件加入镜像。

## 测试场景

所有场景用固定输入测试真实执行器，不调用模型。分析代码来自 `samples/region-share.mjs`，可以查看、修改后再运行。它模拟模型生成的待执行模块，不代表测试了模型的代码生成能力。

| 命令 | 预期 |
| --- | --- |
| `npm run demo -- sql` | `completed`，华东 1599.00、华南 798.00 |
| `npm run demo -- code` | `completed`，计算金额占比 66.71%、33.29% |
| `npm run demo -- sql-table` | `rejected`，不允许读取 sales_raw |
| `npm run demo -- sql-file` | `rejected`，拒绝读取外部 CSV 的表函数 |
| `npm run demo -- sql-write` | `rejected`，拒绝 DELETE |
| `npm run demo -- read-host` | `failed / ENOENT`，宿主探针未挂载，容器中不可见 |
| `npm run demo -- write-input` | `failed / EROFS`（部分环境为 EACCES），输入只读 |
| `npm run demo -- network` | `failed / ENETUNREACH`，没有外部网络路由 |
| `npm run demo -- timeout` | `timeout`，死循环被终止 |
| `npm run demo -- output` | `output_limit`，输出超过 64 KiB |

负面测试被预期拒绝也算演示成功。具体错误码受操作系统和运行时影响；`npm test` 同时核对 Docker 实际配置与任务结果。测试还包括环境变量未传入、JSON 格式校验、容器清理、数据库未被修改与内存限制。

## 调用链

```text
execution-demo.js main()
→ loadDataset() 取得应用选定的数据集
→ runSandbox(SQL 任务) → 创建只读输入 → Docker → 04 的 SQL 执行器
→ 取得真实 rows
→ makeTask() 读取补充计算代码
→ runSandbox(代码任务) → 仅提供 rows 与代码 → 新 Docker 容器
→ entry.js 加载 analysis.mjs，调用 analyze(rows)
→ 宿主校验输出 → 清理容器与临时输入 → 保存执行报告
```

`runSandbox()` 的模型可控部分只有 SQL 或代码正文；数据库路径、镜像、挂载、资源和超时由应用控制。接入真实 Agent 时，需要先做身份与数据集授权，再调用这一接口，不可让模型提交任意本机文件路径。

`.work/jobs/<jobId>/input/` 临时保存本次输入；结束后删除。SQL 任务复制当前已关闭连接的课程数据库，代码任务只保存 `rows.json`、`analysis.mjs`、`request.json`。生产数据库应使用一致性快照或只读查询服务，不能随意复制正在写入的数据库文件。

宿主只把这一个目录只读挂载成 `/input`，不挂载项目、其他用户数据、主机根目录或 Docker Socket。`outputs/<场景>-<jobId>.json` 保存宿主整理的执行报告。结果文件由宿主在固定目录写入，分析代码不能指定输出路径。

## 限制与边界

- Docker：非 root UID 1000、无外部网络、只读根文件系统、只读输入；移除 Linux capabilities，开启 no-new-privileges；保留默认 seccomp，不加 privileged。
- 每次容器：1 CPU 的计算额度、256 MiB 内存且不额外使用 swap、64 个进程/线程配额、16 MiB 临时 `/tmp`。
- 宿主：默认执行时限 5 秒（从启动/附加容器开始计时），超时演示设为 2 秒；stdout 与 stderr 合计 64 KiB；删除整个容器终止任务。
- SQL：复用上一节单条查询、表和函数范围校验，数据库只读且关闭外部访问；最多 100 行，截断结果不继续分析。
- 代码：最多 16 KiB，输入最多 100 行且 64 KiB；输出必须符合 `rows` 表格格式。格式检查不保证统计口径和算法正确。

这是本机课程样本的受限执行示范，不是可直接对公网开放的任意代码执行服务。容器共享其运行环境的内核；需要持续维护镜像与 Docker，公开多租户场景应采用专门执行服务、更强隔离与配额/审计。镜像当前使用受维护的 Node 22 镜像；发布时应固定审核过的镜像 digest 并安排更新。

Docker CLI 需要管理容器的权限，必须留在受信任的调度程序一侧。清理覆盖正常返回与可捕获异常；宿主进程被强杀、机器断电或 Docker 不可用时，需要独立的过期任务清理机制。本例不会在 Docker 失败时退回宿主执行代码。

如果测试中断，可先只查看本课容器：

```bash
docker ps -a --filter label=agent-course=chapter9-05
```

确认名称以后，使用 `docker rm -f <具体容器名>` 清理。不要用全局 prune，以免影响其他章节。

## 常见问题

- Docker daemon 不可达：启动 Docker Desktop，确认 `docker version` 同时显示 Client 和 Server。
- 镜像不存在：先运行 `npm run build:sandbox`。不自动下载陌生镜像或回退到宿主执行。
- 镜像拉取或 npm 下载失败：检查 Docker 网络或使用所在组织批准的镜像源，不要关闭运行时隔离。
- `请先执行 npm run prepare-data`：在相邻 04 目录完成数据准备。
- `Mounts denied`：确认 Docker Desktop 允许访问本课程所在目录；Windows 使用 Linux 容器。示例要求本机 daemon，远程 Docker 不共享本机路径。
- 原始 SQL 执行器有修改：重跑 `npm run build:sandbox`，镜像中保存的是构建时复制的版本。

官方参考（核验于 2026-10-07）：[Docker 运行参数](https://docs.docker.com/engine/containers/run/)、[文件挂载](https://docs.docker.com/engine/storage/bind-mounts/)、[无网络模式](https://docs.docker.com/engine/network/drivers/none/)、[资源限制](https://docs.docker.com/engine/containers/resource_constraints/)、[Docker 安全边界](https://docs.docker.com/engine/security/)、[DuckDB 安全](https://duckdb.org/docs/current/operations_manual/securing_duckdb/overview)、[Node.js vm](https://nodejs.org/docs/latest-v22.x/api/vm.html)。
