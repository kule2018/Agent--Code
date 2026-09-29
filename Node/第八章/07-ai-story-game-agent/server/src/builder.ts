import { Inject, Injectable } from '@nestjs/common'
import { readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { build } from 'esbuild'
import type { Game } from '../../shared/engine.js'
import type { Project } from './project.js'
import { validateGame } from './contracts.js'
import { WorkspaceService } from './workspace.js'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/** 普通代码构建游戏；AI 不生成可执行 HTML 或脚本。 */
@Injectable()
export class GameBuilderService {
  constructor(@Inject(WorkspaceService) private readonly workspace: WorkspaceService) {}

  async release(project: Project, game: Game, sources: string[]): Promise<{ id: string; paths: Record<string, string[]> }> {
    const paths = validateGame(game)
    const id = randomUUID()
    const base = `/releases/${id}`
    const gameText = JSON.stringify(game, null, 2)
    const html = await this.offlineHtml(game)
    await this.workspace.writeText(project.id, `${base}/game.json`, gameText)
    await this.workspace.writeText(project.id, `${base}/index.html`, html)
    const hashes: Record<string, string> = {}
    for (const path of sources) hashes[path] = digest(await this.workspace.readText(project.id, path))
    await this.workspace.writeJson(project.id, `${base}/manifest.json`, {
      releaseId: id, revision: project.revision, outlineVersion: project.approvedOutlineVersion,
      createdAt: new Date().toISOString(), paths, sources: hashes,
      gameHash: digest(gameText), htmlHash: digest(html)
    })
    return { id, paths }
  }

  private async offlineHtml(game: Game): Promise<string> {
    const entry = join(process.cwd(), 'shared', 'engine.ts')
    const result = await build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', globalName: 'StoryEngine', platform: 'browser' })
    const image = await readFile(join(process.cwd(), 'web', 'public', 'station.jpg'))
    const background = `data:image/jpeg;base64,${image.toString('base64')}`
    const data = JSON.stringify(game).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
    return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(game.title)}</title><style>
*{box-sizing:border-box}body{margin:0;color:#f7f4e9;font-family:system-ui,"PingFang SC",sans-serif;background:#091319 url("${background}") center/cover fixed}body:before{content:"";position:fixed;inset:0;background:linear-gradient(90deg,rgba(4,12,17,.92),rgba(4,12,17,.43));pointer-events:none}main{position:relative;min-height:100dvh;display:flex;flex-direction:column;justify-content:center;max-width:780px;padding:40px clamp(24px,6vw,80px)}small{color:#d1b679;text-transform:uppercase;font-weight:700}h1{font-size:clamp(32px,5vw,58px);line-height:1.1;margin:18px 0}p{font-size:19px;line-height:1.95;white-space:pre-wrap}button{display:block;width:100%;text-align:left;background:rgba(245,247,243,.11);border:1px solid rgba(245,247,243,.3);border-radius:6px;color:inherit;padding:16px 20px;font:inherit;cursor:pointer;margin:10px 0}button:hover,button:focus{background:rgba(178,211,178,.24);outline-color:#b9d7b2}#history{font-size:13px;color:#c0c9c8;margin:18px 0}#restart{width:auto;background:none;border:0;padding:8px 0;color:#c8dfcf;text-decoration:underline}#choices{margin-top:18px}
    </style></head><body><main><small id="progress"></small><h1 id="title"></h1><p id="content"></p><div id="choices"></div><div id="history"></div><button id="restart" type="button">重新开始</button></main><script>${result.outputFiles[0].text}</script><script>
const game=${data};let session=StoryEngine.startGame(game);const byId=id=>document.getElementById(id);function render(){const scene=StoryEngine.currentScene(game,session);byId('progress').textContent=scene.ending?'结局 / '+scene.id:'场景 / '+scene.id;byId('title').textContent=scene.title;byId('content').textContent=scene.content;byId('history').textContent=session.history.length?'已作出 '+session.history.length+' 次选择':'';const root=byId('choices');root.replaceChildren();for(const choice of StoryEngine.availableChoices(scene,session.flags)){const button=document.createElement('button');button.textContent=choice.text;button.onclick=()=>{session=StoryEngine.choose(game,session,choice.id);render()};root.append(button)}}byId('restart').onclick=()=>{session=StoryEngine.startGame(game);render()};render();
    </script></body></html>`
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}
