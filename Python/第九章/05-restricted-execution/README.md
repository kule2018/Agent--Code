# 05 受限执行（Python 版）

复用 Python 04 的 SQL 检查，把查询放入受限临时 Docker 容器；补充分析在另一个容器运行，只读取有限查询结果。本节不调用模型、不需要 API Key，也不读写环境文件。

## 运行

前置：Python 3.11+、uv、正在运行的本机 Docker Engine / Docker Desktop（Linux 容器）。保留 **Python** 03、04、05 的相邻关系，先在 Python 04 完成数据准备：

```bash
cd ../04-text-to-sql
uv sync --locked
uv run python text_to_sql.py prepare
cd ../05-restricted-execution
uv sync --locked
uv run python build_image.py
uv run python execution_demo.py code
```

宿主使用标准库调度 Docker，导入数据时依赖 DuckDB 和 openpyxl；本节已声明依赖，不需要再安装相邻小节的虚拟环境。镜像只安装 DuckDB 1.5.6，使用带 Hash 的 `runtime/requirements.lock`。首次构建需要访问 Docker Hub 和 PyPI，**执行任务时禁用外部网络**。

Python 镜像为 `agent-course-analysis-python:chapter9-05`，不会覆盖 Node 镜像。构建上下文只有固定的 Dockerfile、依赖锁、入口、长度助手，以及从 Python 04 复制的 `query_worker.py`；不打包整个课程、数据集或配置文件。

## 演示场景

在本节目录使用 `uv run python execution_demo.py <场景>`：

| 场景 | 预期结果 |
| --- | --- |
| sql | `completed`：华东 1599.00 元、华南 798.00 元 |
| code | `completed`：金额占比 66.71%、33.29% |
| sql-table / sql-file / sql-write | `rejected`：拒绝越权表、外部文件函数和 DELETE |
| read-host | `failed / ENOENT`：宿主课程探针没有挂载，容器中不可见 |
| write-input | `failed / EROFS` 或 `EACCES`：不能修改只读输入 |
| network | `failed / ENETUNREACH` 或 `EHOSTUNREACH`：没有外部网络路由 |
| timeout | `timeout`：死循环超过 2 秒后删除整个容器 |
| output | `output_limit`：输出超过 64 KiB 后终止容器 |

负面测试按预期被拦截也算演示成功。错误码可能受操作系统影响，不能只看错误文案判断隔离是否生效。

`samples/region_share.py` 是固定、可查看的教学分析代码，定义 `analyze(rows)`。它把金额转换为整数分再计算占比，避免浮点误差；仅处理本例非负、两位小数金额。这些场景验证执行器，不代表验证了模型生成代码的能力。

## 文件与数据流

- `execution_demo.py`：命令入口，先查询、再分析，核对预期状态并保存报告。
- `sandbox.py`：输入校验、Docker 参数、实时输出限制、结果校验和任务清理。
- `build_image.py`：只复制固定文件到临时构建目录，结束后删除该目录。
- `runtime/entry.py`：容器内执行 SQL 或动态加载 `analysis.py`，返回一份 JSON。
- `runtime/model.py`：仅提供 SQL 执行器使用的 UTF-16 长度助手，不携带模型客户端。
- `test_execution.py`：离线协议、Mock、可信算法夹具测试；不证明容器隔离。
- `test_docker_execution.py`：真实 Docker 集成验证，包括只读、禁网、超时、OOM 和清理。

`code` 场景先加载 Python 04 的已授权数据集，在查询容器里执行 SQL；宿主拿到两行金额以后，再创建分析容器，调用 `analyze(rows)`。同步与异步函数都支持。宿主不加载或执行提交的分析源码，也不会在 Docker 失败时回退到宿主执行。

每次任务输入保存在 `.work/jobs/<jobId>/input/`：SQL 任务只有 `request.json` 和数据库副本；代码任务只有 `request.json`、`rows.json`、`analysis.py`，没有数据库。这个目录只读挂载为 `/input`，不挂载项目、其他数据、主机根目录或 Docker Socket。

结束后清理本次容器和输入目录，宿主把报告写入 `outputs/<场景>-<jobId>.json`。报告保留数据版本、状态、错误、Docker 实际限制和清理结果；分析代码不能指定宿主报告路径。原始数据库不变。生产数据库需要一致性快照或只读查询服务，不能直接复制正在写入的文件。

## 验证

无需 Docker 的离线验证：

```bash
uv run python -m unittest -v test_execution
```

构建镜像后进行真实集成验证：

```bash
uv run python -m unittest -v test_docker_execution
```

真实测试使用临时课程数据和本次任务容器，不调用模型，不操作其他服务。环境或镜像缺失时明确失败，不用 Mock 冒充集成成功。

## 限制和常见问题

与原案例一致：非 root UID 1000、只读根文件系统和输入、禁网、移除 capabilities、开启 no-new-privileges，保留 Docker 默认 seccomp；1 CPU、256 MiB 内存且不额外使用 swap、64 个进程/线程、16 MiB 临时 `/tmp`。

宿主执行时限默认 5 秒，允许应用设置 100～30000 毫秒；stdout 与 stderr 合计 64 KiB。SQL 延续 04 的表和函数范围，最多返回 100 行，截断结果不继续分析。代码最多 16 KiB，输入最多 100 行、64 KiB；输出最多 100 行，每行最多 20 个简单类型字段。格式正确不等于计算口径正确。

这是本机课程样本的受限执行示范，不是公网任意代码执行服务。容器共享内核，生产多租户还需要更强隔离、授权、配额与审计。发布时应固定审核过的基础镜像 digest，并持续更新。

- Docker 不可达：自行启动 Docker Desktop，确认 `docker version` 有 Server 信息。
- 基础镜像或依赖下载超时：检查 Docker Hub / PyPI 连通性及组织批准的镜像源，再重试构建；不要关闭运行时隔离。
- 镜像不存在：先执行 `uv run python build_image.py`。
- 提示没有当前数据版本：在 Python 04 执行 `prepare`。
- `Mounts denied`：确认 Docker Desktop 允许访问课程目录。本例要求本机 daemon，远程 Docker 不共享本机路径。
- Python 04 的查询实现变更：重新构建镜像，容器使用的是构建时复制的版本。

清理覆盖正常结果和可捕获异常；宿主强杀、断电或 Docker 不可达时，仍需独立的过期任务清理机制。可用 `docker ps -a --filter label=agent-course=chapter9-05` 查看本课容器，确认具体名称后再删除，不使用全局 prune。

参考：[Docker 运行参数](https://docs.docker.com/engine/containers/run/)、[只读挂载](https://docs.docker.com/engine/storage/bind-mounts/)、[禁网模式](https://docs.docker.com/engine/network/drivers/none/)、[资源限制](https://docs.docker.com/engine/containers/resource_constraints/)、[Python 动态模块加载](https://docs.python.org/3.12/library/importlib.html#importing-a-source-file-directly)。
