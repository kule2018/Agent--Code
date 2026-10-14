import { readFile } from 'node:fs/promises'
import { printReport, type Report } from './report.js'

try {
  const path = process.argv[2] ?? new URL('../outputs/latest.json', import.meta.url)
  const report = JSON.parse(await readFile(path, 'utf8')) as Report
  if (report.schemaVersion !== 1 || !Array.isArray(report.spans) || !report.evaluation || !report.run) {
    throw new Error('请传入本节生成的 Trace JSON 文件。')
  }
  printReport(report)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
