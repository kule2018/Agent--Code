# 企业售后 MCP Server（Python）

这是第三章第 08 节的独立 Python 实战项目。它保留 Node 版本的多租户售后业务、角色权限、Human-in-the-Loop、幂等退款、批量审核长任务、审计记录和 MCP App，并且不依赖 Node 目录或 npm 构建。

## 代码结构

- `src/after_sales_service.py`：【本章重点】多租户业务规则、幂等退款、长任务与审计状态。
- `src/mcp_server.py`：【本章重点】Tools、Resources、Prompt、角色权限、签名 `requestState` 与 MCP App。
- `src/http_server.py`：【本章重点】Bearer Token 鉴权和 Streamable HTTP Server。
- `src/mcp_client.py`：【本章重点】带认证与 Elicitation 的公共 MCP Client。
- `src/agent_host.py`：【本章重点】调用 DeepSeek 的连续对话命令行 Host。
- `src/web_host_server.py`：【本章重点】浏览器 Web Host、模型代理与独立 Sandbox。
- `src/verify_client.py`：不经过大模型的完整验证 Client。
- `src/data.py`、`src/auth.py`、`src/deepseek_client.py`：演示数据、身份认证与模型 API 配套代码。
- `src/app/`：由 MCP Server 通过 `ui://` Resource 返回的报告 App。
- `src/web_host/`：浏览器 Host 和独立 Sandbox 的静态资源。

## 安装

在当前小节目录执行：

```bash
uv sync
```

本节固定使用支持 `input_required` 的 `mcp==2.0.0b1`。Python 版的 MCP App 不需要执行 npm 或前端构建命令。

## 启动 MCP Server 与离线验证

终端一：

```bash
uv run python src/http_server.py
```

终端二：

```bash
uv run python src/verify_client.py
```

验证 Client 不调用 DeepSeek，也不需要模型 API Key。正常情况下最后会输出：

```text
全部验证通过。
```

## 运行连续对话 Host

命令行 Host 会读取进程环境中的 `DEEPSEEK_API_KEY`，并可选读取 `DEEPSEEK_MODEL`、`DEEPSEEK_BASE_URL`、`MCP_TOKEN` 和 `MCP_SERVER_URL`。

如果当前目录已经有你自己的 `.env`，可以直接让 `uv` 在启动时加载：

```bash
uv run --env-file .env python src/agent_host.py
```

也可以把第一个问题直接写在命令后面：

```bash
uv run --env-file .env python src/agent_host.py "订单 A1024 可以退款吗？"
```

回答完成后 Host 不会退出，可以继续输入“确认退款，因为产品质量不行”。输入 `/exit`、`/quit` 或“退出”结束对话。

## 运行 MCP Apps Web Host

保持 MCP Server 运行，再打开一个终端：

```bash
uv run --env-file .env python src/web_host_server.py
```

访问：

```text
http://127.0.0.1:3200
```

点击“一键演示 MCP App”会自动切换为财务身份，弹出人工确认，轮询批量任务，并在对话中渲染审核报告。这条固定演示链路不调用 DeepSeek；只有在输入框中进行自然语言对话时才需要模型 API Key。

本地地址：

- MCP Server：`http://127.0.0.1:3100/mcp`
- Web Host：`http://127.0.0.1:3200`
- Sandbox：`http://127.0.0.1:3201`

`/mcp` 是协议端点，不是普通网页；浏览器直接访问时因没有 Bearer Token 而返回未授权。`3201` 只供 Web Host 的 iframe 加载，单独打开没有演示界面。

## 演示身份

| Token | 企业 | 角色 | 可发现 Tools |
| --- | --- | --- | ---: |
| `token-blue-service` | 蓝鲸科技 | 客服 | 5 |
| `token-blue-finance` | 蓝鲸科技 | 财务 | 9 |
| `token-star-service` | 星河零售 | 客服 | 5 |

这些 Token 只用于本地课程演示，不能直接用于生产环境。生产环境还应设置独立的 `REQUEST_STATE_SECRET`。
