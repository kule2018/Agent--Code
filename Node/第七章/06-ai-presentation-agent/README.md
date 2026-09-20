# 06 AI 演示文稿制作 Agent

本项目是第七章综合实战，包含以下完整链路：

```text
资料与制作要求
→ 生成大纲
→ 持久化人工审核
→ 逐页制作
→ 失败页面续做
→ 单页 Revision
→ 自然语言修改内容、视觉主题或指定页面
→ 版本校验
→ 导出可编辑 PPTX
```

## 环境要求

- Node.js 20.19 或更高版本
- Docker Desktop

先检查当前 Node.js：

```bash
node -v
```

## 启动项目

```bash
npm install
docker compose up -d --wait
npm run setup
npm run doctor
npm run dev
```

访问地址：

- Web：`http://localhost:5182`
- API：`http://localhost:4310/api`

## Replay 和 AI 模式

创建任务时可以直接选择 Replay 或 AI。Replay 不需要模型密钥，只提供固定的大纲和页面内容，并在第三页第一次生成时注入一次失败；PostgreSQL、LangGraph、人工审核、失败续做、版本校验与文件导出都是真实执行。

需要调用真实模型时，在项目根目录创建自己的 `.env`：

```text
MODEL_MODE=ai
DEEPSEEK_API_KEY=你的 DeepSeek API Key
DEEPSEEK_MODEL=deepseek-v4-flash
POSTGRES_URI=postgresql://presentation_course:presentation_course@localhost:5436/presentation_agent
```

重新启动服务后，创建任务时就可以切换到 AI 模式。`MODEL_MODE=ai` 仍可作为页面第一次打开时的默认选项，但不会覆盖用户为具体任务选择的模式。已有任务会继续使用创建时保存的模式。

## 自然语言修改

任务创建以后，可以在右侧输入一条修改要求：

```text
主题改成企业 Agent 落地方案，并增加一页介绍实施成本
整体改成深色科技风，使用蓝色作为主色
第二页使用绿色背景
第 2 页减少技术术语，重点突出业务收益
```

全局内容变化会生成新的 Outline 版本，并让旧页面失效；视觉主题变化只更新 Theme 配置和导出文件；指定页变化只生成该页的新 Revision。

Replay 使用确定性规则识别修改范围，并从四套预设主题中选择结果。AI 模式会让 DeepSeek 根据自然语言生成结构化 Theme，包括配色、字体、标题对齐、内容密度和装饰布局。带有明确页码的视觉要求会生成单页样式覆盖，不会重新生成页面正文。服务端会校验颜色格式与文字对比度，Web 预览和 PPTX 导出共同读取校验后的主题快照。

## 验证命令

```bash
npm run check
npm test
npm run build
```

生成的 `.pptx` 文件会保存在 `data/exports`。
