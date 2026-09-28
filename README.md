# Agent 全栈实战课 · 配套代码

仓库提供 `Node/` 和 `Python/` 两套示例，按章节、小节组织。选择自己使用的语言，进入对应小节目录安装依赖、运行代码即可。

## 准备环境

- Node.js 版本：建议使用 Node.js 22.12 或更高版本，自带 npm。
- Python 版本：使用 Python 3.11 或更高版本。

按需安装对应语言环境，然后下载代码：

```bash
git clone git@git.imooc.com:coding-1040/agent-code.git
cd agent-code
```

下面以第五章的「LangChain 最小 Agent」为例，两套命令都从仓库根目录开始执行。终端命令适用于 macOS / Linux。

## 运行 Node.js 示例

进入小节目录，安装依赖：

```bash
cd Node/第五章/02-langchain-agent
npm install
```

在该小节目录新建 `.env` 文件，填写自己的 DeepSeek API Key：

```dotenv
DEEPSEEK_API_KEY=替换为你的_API_Key
```

启动示例：

```bash
npm start
```

运行后，Agent 会调用订单查询工具，并在终端输出回答。

## 运行 Python 示例

进入对应目录，创建虚拟环境并安装依赖：

```bash
cd Python/第五章/02-langchain-agent
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
```

在这个小节目录新建 `.env`，填入上面的 API Key 配置。Python 示例不会自动读取该文件，需要先加载环境变量，再启动：

```bash
set -a
source .env
set +a
python langchain_agent.py
```

## 运行其他小节

- 优先查看小节目录中的 `README.md`，确认启动命令和需要的配置。
- Node.js 项目可执行 `npm run` 查看可用命令；没有 `package.json` 的简单示例，直接用 `node 文件名.js` 或 `node 文件名.mjs` 运行。
- Python 示例如果没有第三方依赖，直接用 `python3 文件名.py` 运行即可。
- 涉及数据库、向量库或前后端服务的小节，按该小节说明先启动所需服务。
