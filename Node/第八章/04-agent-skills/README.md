# Agent Skills 最小案例

同一个 Deep Agent 分别完成剧情设计和普通问答，观察 Skill 是否按需读取。剧情大纲由真实模型生成，保存到当前项目的 `workspace/game/branch-outline.md`。

## 运行

使用 Node.js 22 或以上版本，在当前目录执行 `npm ci`。在本机 `.env` 中配置：

```dotenv
DEEPSEEK_API_KEY=你的 DeepSeek API Key
DEEPSEEK_MODEL=deepseek-v4-flash
```

```bash
npm run story
npm run chat
```

`story` 会读取 Skill、世界观和大纲模板，生成剧情文件。`chat` 只问一道算术题。以本次工具调用记录为准，不保证模型每次的措辞和调用顺序完全相同。

重复运行 `story` 时允许更新已有大纲；若只读取而未修改，程序会明确提示。世界观与 Skill 文件限制为只读。

## 代码入口

`skill-agent.js` 的 `main()`：选任务、创建模型与 Backend、配置 `skills`、调用 Agent、打印实际轨迹并核对交付文件。

- `workspace/game/world.md`：固定世界观输入，便于独立运行。
- `workspace/skills/branch-story-design/SKILL.md`：技能介绍与设计方法。
- `workspace/skills/branch-story-design/references/outline-template.md`：按需读取的输出模板。

`npm run check` 只做 JavaScript 语法检查。剧情质量需要人工核对，文件生成成功不代表内容一定符合全部要求。

官方用法见 [Deep Agents Skills](https://docs.langchain.com/oss/javascript/deepagents/skills) 与 [Agent Skills 规范](https://agentskills.io/specification)。
