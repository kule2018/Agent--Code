import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Injectable } from '@nestjs/common'
import type { Dataset, Session } from '../shared/types.js'

export const root = dirname(dirname(fileURLToPath(import.meta.url)))
export const dataRoot = join(root, 'data')
export function checkedId(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('记录 ID 无效')
  return id
}

/** 数据集和会话保存为本地文件；写入完成后再替换，避免半份 JSON。 */
@Injectable()
export class Storage {
  constructor(readonly directory = dataRoot) {}
  datasetDir(id: string) { return join(this.directory, 'datasets', checkedId(id)) }
  async save(path: string, value: unknown) {
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.${crypto.randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(value, null, 2))
    await rename(temp, path)
  }
  async load<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, 'utf8')) }
  async dataset(id: string) { return this.load<Dataset>(join(this.datasetDir(id), 'metadata.json')) }
  async session(id: string) { return this.load<Session>(join(this.directory, 'sessions', `${checkedId(id)}.json`)) }
  async saveSession(session: Session) { await this.save(join(this.directory, 'sessions', `${session.id}.json`), session) }
}
