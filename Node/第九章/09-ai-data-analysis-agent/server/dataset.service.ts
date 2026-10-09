import { Inject, Injectable } from '@nestjs/common'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { DuckDBInstance } from '@duckdb/node-api'
import { Storage } from './storage.js'
import { parseFile, previewSheet, normalize } from './table-parser.js'
import type { ColumnMap, Dataset, UploadPreview } from '../shared/types.js'

/** 保存上传原件、导入不可变数据版本；存在质量问题时关闭查询入口。 */
@Injectable()
export class DatasetService {
  constructor(@Inject(Storage) readonly storage: Storage) {}
  async list(): Promise<Dataset[]> {
    const directory = join(this.storage.directory, 'datasets')
    const names = await readdir(directory).catch(() => [] as string[])
    const datasets = await Promise.all(names.map(id => this.storage.dataset(id).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })))
    return datasets.filter((d): d is Dataset => d !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async upload(bytes: Buffer, filename: string): Promise<UploadPreview> {
    const sheets = await parseFile(bytes, filename)
    const id = randomUUID()
    const directory = join(this.storage.directory, 'uploads', id)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'source'), bytes)
    const result = { id, filename: basename(filename), sheets: sheets.map(previewSheet) }
    await this.storage.save(join(directory, 'preview.json'), result)
    return result
  }
  async import(id: string, sheetName: string, mapping: ColumnMap) {
    // 上传 ID 先校验，再组成服务端路径；客户端不能指定数据库文件位置。
    const { checkedId } = await import('./storage.js')
    const directory = join(this.storage.directory, 'uploads', checkedId(id))
    const preview = await this.storage.load<UploadPreview>(join(directory, 'preview.json'))
    const bytes = await readFile(join(directory, 'source'))
    const sheets = await parseFile(bytes, preview.filename)
    const sheet = sheets.find(item => item.name === sheetName)
    if (!sheet) throw new Error('所选工作表不存在')
    const { rows, issues } = normalize(sheet, mapping)
    const checksum = createHash('sha256').update(bytes).update(JSON.stringify([sheetName, mapping])).digest('hex')
    const existing = await this.list()
    const repeated = existing.find(item => item.checksum === checksum)
    if (repeated) return { dataset: repeated, repeated: true }
    const dates = rows.map(row => row.sold_at).filter((v): v is string => typeof v === 'string').sort()
    const dataset: Dataset = {
      id: randomUUID(), name: preview.filename, sheet: sheetName, checksum,
      version: 1 + Math.max(0, ...existing.filter(d => d.name === preview.filename && d.sheet === sheetName).map(d => d.version)),
      createdAt: new Date().toISOString(), rowCount: rows.length,
      status: issues.length ? 'needs_review' : 'ready', issues,
      start: dates[0] || null, end: dates.at(-1) || null,
      regions: [...new Set(rows.map(r => String(r.region || '')).filter(Boolean))],
      products: [...new Set(rows.map(r => String(r.product_name || '')).filter(Boolean))], mapping
    }
    const target = this.storage.datasetDir(dataset.id)
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'source' + (preview.filename.toLowerCase().endsWith('.csv') ? '.csv' : '.xlsx')), bytes)
    await this.storage.save(join(target, 'rows.json'), rows)
    if (!issues.length) {
      const db = await DuckDBInstance.create(join(target, 'data.duckdb'))
      const connection = await db.connect()
      try {
        await connection.run('CREATE TABLE sales (source_row INTEGER, sold_at DATE, region VARCHAR, product_name VARCHAR, paid_amount DECIMAL(18,2), refund_amount DECIMAL(18,2))')
        await connection.run('BEGIN TRANSACTION')
        for (const row of rows) {
          await connection.run('INSERT INTO sales VALUES ($1,$2,$3,$4,$5,$6)', [row.source_row, row.sold_at, row.region, row.product_name, row.paid_amount, row.refund_amount] as any)
        }
        await connection.run('COMMIT')
      } finally { connection.closeSync(); db.closeSync() }
    }
    // 元数据最后落盘，未完成的导入不会被页面列为可查询版本。
    await this.storage.save(join(target, 'metadata.json'), dataset)
    return { dataset, repeated: false }
  }
}
