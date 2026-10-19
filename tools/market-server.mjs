#!/usr/bin/env node
/**
 * 参考技能市场服务器（自定轻协议的服务端实现）。
 *
 * 管理器那一半只认协议（README「市场协议」），这个文件是一个**最小可用实现**，
 * 用来把"技能目录 → manifest → .tgz"这条链路跑通，也充当端到端测试的服务端。
 *
 * 用法：
 *
 *   node tools/market-server.mjs --dir ./skills --port 8787
 *
 * 目录约定：`<dir>/<技能名>/` 就是一个技能包（必须含 `SKILL.md`），
 * 技能名取自 frontmatter 的 `name`；每个技能的版本固定为 `1.0.0`
 * （真实市场应该在 manifest 里带上自己的版本与发布信息）。
 *
 * 端点：
 *   GET /v1/skills?q=&limit=          搜索
 *   GET /v1/skills/<name>/<version>   取 manifest
 *   GET /v1/skills/<name>/<version>/bundle.tgz   取包体
 *
 * 注意：这是**示例**，没有鉴权、没有持久化、没有签名；生产环境要自己加。
 *
 * @module dsh-plugin-skill-manager/tools/market-server
 */

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { mkdtempSync } from 'node:fs'

/** 这个示例统一使用的版本号。 */
const VERSION = '1.0.0'

/**
 * 解析命令行参数。
 * @param {string[]} argv 参数。
 * @returns {{dir: string, port: number, host: string}} 选项。
 */
function parseArgs(argv) {
  const options = { dir: '', port: 8787, host: '127.0.0.1' }
  for (let at = 0; at < argv.length; at += 1) {
    const token = argv[at]
    if (token === '--dir') {
      options.dir = argv[at + 1] ?? ''
      at += 1
    } else if (token === '--port') {
      options.port = Number(argv[at + 1]) || 8787
      at += 1
    } else if (token === '--host') {
      options.host = argv[at + 1] ?? '127.0.0.1'
      at += 1
    } else if (token === '--help' || token === '-h') {
      console.log('用法：node tools/market-server.mjs --dir <技能目录> [--port 8787] [--host 127.0.0.1]')
      process.exit(0)
    }
  }
  if (!options.dir) {
    console.error('必须提供 --dir <技能目录>')
    process.exit(2)
  }
  return options
}

/**
 * 计算摘要。
 * @param {Buffer} buffer 数据。
 * @returns {string} `sha256:<hex>`。
 */
function digestOf(buffer) {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`
}

/**
 * 读技能的 frontmatter（只取 name/description/whenToUse 三个键）。
 * @param {string} skillFile SKILL.md 路径。
 * @returns {{name: string, description: string, whenToUse?: string} | undefined} 结果。
 */
function readFrontmatter(skillFile) {
  const text = readFileSync(skillFile, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return undefined
  const lines = match[1].split(/\r?\n/)
  const pick = (key) => {
    const line = lines.find((item) => item.startsWith(`${key}:`))
    if (!line) return ''
    return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '')
  }
  const name = pick('name')
  const description = pick('description')
  if (!name || !description) return undefined
  return { name, description, whenToUse: pick('whenToUse') || undefined }
}

/**
 * 把一个技能目录打成 `.tgz`（顶层直接是 SKILL.md，用系统 tar）。
 * @param {string} skillDir 技能目录。
 * @returns {Buffer} gzip 后的 tar。
 */
function packSkill(skillDir) {
  const temp = mkdtempSync(join(tmpdir(), 'skill-market-pack-'))
  const archive = join(temp, 'bundle.tgz')
  try {
    const result = spawnSync('tar', ['-czf', archive, '-C', skillDir, '.'], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`tar 失败：${result.stderr || result.status}`)
    return readFileSync(archive)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

/**
 * 扫描技能目录，组装市场条目与 manifest。
 * @param {string} root 技能根目录。
 * @returns {Map<string, {manifest: object, tgz: Buffer, description: string}>} 条目表。
 */
function collect(root) {
  const entries = new Map()
  if (!existsSync(root)) return entries
  for (const name of readdirSync(root)) {
    const dir = join(root, name)
    if (!statSync(dir).isDirectory()) continue
    const skillFile = join(dir, 'SKILL.md')
    if (!existsSync(skillFile)) continue
    const meta = readFrontmatter(skillFile)
    if (!meta) {
      console.warn(`跳过 ${name}：frontmatter 不完整`)
      continue
    }
    const tgz = packSkill(dir)
    const files = []
    const walk = (current, prefix) => {
      for (const item of readdirSync(current)) {
        const full = join(current, item)
        const relative = prefix ? `${prefix}/${item}` : item
        if (statSync(full).isDirectory()) {
          walk(full, relative)
          continue
        }
        const data = readFileSync(full)
        files.push({ path: relative, size: data.length, sha256: digestOf(data) })
      }
    }
    walk(dir, '')
    entries.set(meta.name, {
      description: meta.description,
      tgz,
      manifest: {
        name: meta.name,
        version: VERSION,
        description: meta.description,
        whenToUse: meta.whenToUse,
        files,
        bundle: {
          format: 'tar.gz',
          url: `/v1/skills/${meta.name}/${VERSION}/bundle.tgz`,
          sha256: digestOf(tgz),
          size: tgz.length,
        },
      },
    })
  }
  return entries
}

/**
 * 起一个市场服务。
 * @param {{dir: string, port?: number, host?: string}} input 配置。
 * @returns {{server: import('node:http').Server, url: () => string, close: () => Promise<void>}} 句柄。
 */
export function createMarketServer(input) {
  const root = resolve(input.dir)
  // **必须缓存**：`collect()` 每次都重新用系统 `tar` 打包，而 gzip 头里带 mtime，
  // 同一份目录两次打包的字节可以不同。如果每个请求各自重新打包，
  // "搜索时拿到的 manifest.sha256" 和 "随后下载到的包体" 就会对不上，
  // 客户端正确地判定为"技能包摘要与 manifest 不符"并拒绝安装——表现为随机装不上。
  // 市场内容在进程生命周期内视为静态；目录变了就重启服务（或用 refresh() 主动失效）。
  let cache
  const entriesOf = () => {
    if (cache === undefined) cache = collect(root)
    return cache
  }
  const server = createServer((request, response) => {
    const entries = entriesOf()
    const url = new URL(request.url ?? '/', 'http://localhost')
    const json = (status, payload) => {
      const body = JSON.stringify(payload)
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(body)
    }

    if (url.pathname === '/v1/skills') {
      const query = (url.searchParams.get('q') ?? '').toLowerCase()
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50))
      const items = [...entries.values()]
        .filter((entry) => query === ''
          || entry.manifest.name.toLowerCase().includes(query)
          || entry.description.toLowerCase().includes(query))
        .slice(0, limit)
        .map((entry) => ({
          name: entry.manifest.name,
          description: entry.manifest.description,
          version: entry.manifest.version,
          whenToUse: entry.manifest.whenToUse,
        }))
      json(200, { items })
      return
    }

    const match = /^\/v1\/skills\/([^/]+)\/([^/]+)(\/bundle\.tgz)?$/.exec(url.pathname)
    if (match) {
      const entry = entries.get(decodeURIComponent(match[1]))
      if (!entry || decodeURIComponent(match[2]) !== VERSION) {
        json(404, { error: 'skill not found' })
        return
      }
      if (match[3]) {
        response.writeHead(200, { 'content-type': 'application/gzip', 'content-length': String(entry.tgz.length) })
        response.end(entry.tgz)
        return
      }
      json(200, entry.manifest)
      return
    }
    json(404, { error: `no route for ${url.pathname}` })
  })

  return {
    server,
    url: () => {
      const address = server.address()
      return `http://${input.host ?? '127.0.0.1'}:${address.port}`
    },
    /** 让下一次请求重新扫描技能目录（改了发布内容后用）。 */
    refresh: () => {
      cache = undefined
    },
    close: () => new Promise((resolveDone) => server.close(() => resolveDone())),
  }
}

// 直接运行时才起服务（被测试 import 时不启动）。
if (process.argv[1] && basename(process.argv[1]) === 'market-server.mjs') {
  const options = parseArgs(process.argv.slice(2))
  const market = createMarketServer(options)
  market.server.listen(options.port, options.host, () => {
    const entries = collect(resolve(options.dir))
    console.log(`技能市场已启动：${market.url()}`)
    console.log(`技能目录：${resolve(options.dir)}（${entries.size} 个技能）`)
  })
}
