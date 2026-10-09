import { readFile } from 'node:fs/promises'
import { runReadOnlyQuery } from './query-worker.js'
try {
  const { sql } = JSON.parse(await readFile('/input/request.json', 'utf8'))
  const result = await runReadOnlyQuery({ databasePath: '/input/data.duckdb', sql })
  process.stdout.write(JSON.stringify({ ok: true, ...result }))
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, message: error.message.slice(0, 1600) }))
  process.exitCode = 1
}
