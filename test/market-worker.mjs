/**
 * 市场安装的**子进程** worker：给 `test/market.test.mjs` 的跨进程台账用例用。
 *
 * 用法：node test/market-worker.mjs <baseUrl> <rootPath> <managerRoot> <name> [version]
 *
 * 之所以要真的起进程：台账 `market.json` 是"读-改-写"，同进程内的 `withInstallLock`
 * 只能防同进程竞态，跨进程必须靠文件锁——只有在真进程上才能验证。
 *
 * @module dsh-plugin-skill-manager/test/market-worker
 */

import { createMarketClient } from '../lib/market.js'

const [baseUrl, rootPath, managerRoot, name, version = '1.0.0'] = process.argv.slice(2)
const client = createMarketClient({ baseUrl })

const result = await client.install({
  name,
  version,
  root: { id: 'user-agents', label: 'user-agents', rank: 500, path: rootPath, writable: true },
  managerRoot,
})

process.stdout.write(`${JSON.stringify({ name, ok: result.ok === true, error: result.error ?? null })}\n`)
process.exit(result.ok === true ? 0 : 1)
