/**
 * 技能市场：协议校验、摘要与归档安全、安装 / 覆盖 / 卸载台账。
 *
 * 用本地 HTTP server 当市场，尽量贴近真实链路（fetch → manifest → tgz → 落盘）。
 *
 * @module dsh-plugin-skill-manager/test/market.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { spawnSync, spawn } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { cleanup, makeTemp } from './helpers.mjs'
import { createMarketClient, digestOf, listInstalled, validateManifest, verifyFiles, verifyInstalledAgainstManifest, verifyWrittenFiles } from '../lib/market.js'
import { createTarGz, extractTar } from '../lib/targz.js'
import { scanRoots } from '../lib/roots.js'
import { listTrash } from '../lib/actions.js'

/**
 * 手写 tar 条目（用于构造 `createTarGz` 会拒绝的恶意路径，例如 ADS 别名）。
 * @param {{name: string, size: number, typeflag?: string}} input 条目。
 * @returns {Buffer} 512 字节头。
 */
function rawTarHeader(input) {
  const header = Buffer.alloc(512)
  Buffer.from(input.name, 'utf8').copy(header, 0)
  header.write('0000644\0', 100, 'utf8')
  header.write('0000000\0', 108, 'utf8')
  header.write('0000000\0', 116, 'utf8')
  header.write(`${input.size.toString(8).padStart(11, '0')}\0`, 124, 'utf8')
  header.write('00000000000\0', 136, 'utf8')
  header.write('        ', 148, 'utf8')
  header.write(input.typeflag ?? '0', 156, 'utf8')
  header.write('ustar\0', 257, 'utf8')
  header.write('00', 263, 'utf8')
  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8')
  return header
}

/**
 * 用手写头拼一个 .tgz。
 * @param {Array<{path: string, data: Buffer}>} entries 条目。
 * @returns {Buffer} gzip 后的 tar。
 */
function rawTarGz(entries) {
  const parts = []
  for (const entry of entries) {
    parts.push(rawTarHeader({ name: entry.path, size: entry.data.length }))
    parts.push(entry.data)
    parts.push(Buffer.alloc((512 - (entry.data.length % 512)) % 512))
  }
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

/**
 * 造一个技能包的 manifest + tgz。
 */
function buildPackage({ name, version = '1.0.0', description = '演示技能', skillName, extraFiles = [] }) {
  const skillText = `---\nname: ${skillName ?? name}\ndescription: ${description}\n---\n# ${name}\n正文\n`
  const files = [
    { path: 'SKILL.md', data: Buffer.from(skillText, 'utf8') },
    { path: 'references/notes.md', data: Buffer.from('参考资料\n', 'utf8') },
    ...extraFiles,
  ]
  const tgz = createTarGz(files.map((file) => ({ path: file.path, data: file.data })))
  const manifest = {
    name,
    version,
    description,
    files: files.map((file) => ({ path: file.path, size: file.data.length, sha256: digestOf(file.data) })),
    bundle: { format: 'tar.gz', url: `/v1/skills/${name}/${version}/bundle.tgz`, sha256: digestOf(tgz), size: tgz.length },
  }
  return { manifest, tgz }
}

/**
 * 起一个本地市场服务。
 * @param {Array<{manifest: object, tgz: Buffer}>} packages 包列表。
 * @returns {Promise<{url: string, close: () => Promise<void>}>} 服务。
 */
async function startMarket(packages) {
  const byName = new Map(packages.map((item) => [item.manifest.name, item]))
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/v1/skills') {
      const query = (url.searchParams.get('q') || '').toLowerCase()
      const items = [...byName.values()]
        .map((item) => ({ ...item.manifest, files: undefined, bundle: undefined }))
        .filter((item) => !query || item.name.includes(query))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ items }))
      return
    }
    const match = /^\/v1\/skills\/([^/]+)\/([^/]+)(?:\/bundle\.tgz)?$/.exec(url.pathname)
    if (match) {
      const entry = byName.get(decodeURIComponent(match[1]))
      if (!entry) {
        response.writeHead(404)
        response.end('not found')
        return
      }
      if (url.pathname.endsWith('bundle.tgz')) {
        response.writeHead(200, { 'content-type': 'application/gzip', 'content-length': String(entry.tgz.length) })
        response.end(entry.tgz)
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(entry.manifest))
      return
    }
    response.writeHead(404)
    response.end('not found')
  })
  await new Promise((resolveDone) => server.listen(0, '127.0.0.1', resolveDone))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolveDone) => server.close(resolveDone)),
  }
}

/**
 * 建一个空的目标技能根。
 * @param {string} base 临时目录。
 * @returns {{root: object, managerRoot: string}} 环境。
 */
function targetRoot(base) {
  const root = { id: 'user-agents', label: 'user-agents', rank: 500, path: join(base, 'skills'), writable: true }
  return { root, managerRoot: join(base, 'manager') }
}

test('validateManifest 把关字段', () => {
  const good = buildPackage({ name: 'demo-skill' }).manifest
  assert.equal(validateManifest(good).ok, true)

  assert.match(validateManifest({ ...good, name: 'Bad Name' }).error, /name/)
  assert.match(validateManifest({ ...good, version: '' }).error, /version/)
  assert.match(validateManifest({ ...good, files: [] }).error, /files/)
  assert.match(validateManifest({ ...good, files: [{ path: '../evil', sha256: 'sha256:' + 'a'.repeat(64) }] }).error, /不安全/)
  assert.match(validateManifest({ ...good, files: [{ path: 'SKILL.md', sha256: 'md5:xx' }] }).error, /sha256/)
  assert.match(validateManifest({ ...good, files: [{ path: 'SKILL.md', sha256: 'sha256:' + 'a'.repeat(64), size: '99999' }] }).error, /size/)
  assert.match(validateManifest({ ...good, files: [{ path: 'SKILL.md', sha256: 'sha256:' + 'a'.repeat(64), size: -1 }] }).error, /size/)
  assert.match(validateManifest({ ...good, bundle: { format: 'zip', url: 'x' } }).error, /格式/)
  assert.match(validateManifest({ ...good, bundle: { format: 'tar.gz' } }).error, /url/)
})

test('verifyFiles 逐个核对，且拒绝未声明的文件', () => {
  const pkg = buildPackage({ name: 'demo-skill' })
  const extracted = extractTar(pkg.tgz)
  assert.equal(extracted.ok, true)
  assert.equal(verifyFiles(pkg.manifest, extracted.files).ok, true)

  const missing = extracted.files.filter((file) => file.path !== 'SKILL.md')
  assert.match(verifyFiles(pkg.manifest, missing).error, /缺少/)

  const extra = [...extracted.files, { path: 'sneaky.sh', data: Buffer.from('rm -rf /') }]
  assert.match(verifyFiles(pkg.manifest, extra).error, /未声明/)

  const tampered = extracted.files.map((file) => (file.path === 'SKILL.md' ? { ...file, data: Buffer.from('改过') } : file))
  const tamperResult = verifyFiles(pkg.manifest, tampered)
  assert.equal(tamperResult.ok, false)
  assert.match(tamperResult.error, /大小不符|摘要不符/)
})

test('安装成功：落盘 + 台账 + 版本标记', async () => {
  const temp = makeTemp()
  const market = await startMarket([buildPackage({ name: 'demo-skill', version: '1.2.3' })])
  try {
    const { root, managerRoot } = targetRoot(temp)
    const client = createMarketClient({ baseUrl: market.url })
    const search = await client.search({ q: 'demo' })
    assert.equal(search.ok, true)
    assert.equal(search.items.length, 1)

    const installed = await client.install({ name: 'demo-skill', version: '1.2.3', root, managerRoot, now: 1_700_000_000_000 })
    assert.equal(installed.ok, true, installed.error)
    const skillFile = join(root.path, 'demo-skill', 'SKILL.md')
    assert.ok(existsSync(skillFile))
    assert.ok(existsSync(join(root.path, 'demo-skill', 'references', 'notes.md')), '资源目录要一起装进来')
    assert.match(readFileSync(join(root.path, 'demo-skill', '.skill-manager.json'), 'utf8'), /1\.2\.3/)

    const ledger = listInstalled(managerRoot)
    assert.equal(ledger.length, 1)
    assert.equal(ledger[0].version, '1.2.3')
    assert.equal(ledger[0].rootId, 'user-agents')

    const scanned = scanRoots([root])
    assert.equal(scanned.skills.filter((skill) => skill.name === 'demo-skill').length, 1, '装完必须能被 DSH 扫到')
    assert.equal(scanned.skills.find((skill) => skill.name === 'demo-skill').valid, true)
  } finally {
    await market.close()
    cleanup(temp)
  }
})

test('安装校验失败：包内 name 不符 / 摘要不符 / 穿越条目，都不留半成品', async () => {
  const temp = makeTemp()
  const bad = buildPackage({ name: 'wrong-name', skillName: 'other-name' })
  const mismatchDigest = buildPackage({ name: 'bad-digest' })
  mismatchDigest.manifest.bundle = { ...mismatchDigest.manifest.bundle, sha256: `sha256:${'0'.repeat(64)}` }
  const traversal = {
    manifest: {
      name: 'evil-skill',
      version: '1.0.0',
      files: [{ path: 'SKILL.md', size: 4, sha256: digestOf(Buffer.from('pwnd')) }],
      bundle: { format: 'tar.gz', url: '/v1/skills/evil-skill/1.0.0/bundle.tgz' },
    },
    tgz: gzipSync(Buffer.concat([
      (() => {
        const header = Buffer.alloc(512)
        Buffer.from('../outside.txt', 'utf8').copy(header, 0)
        header.write('0000644\0', 100, 'utf8')
        header.write('0000000\0', 108, 'utf8')
        header.write('0000000\0', 116, 'utf8')
        header.write('00000000004\0', 124, 'utf8')
        header.write('00000000000\0', 136, 'utf8')
        header.write('        ', 148, 'utf8')
        header.write('0', 156, 'utf8')
        header.write('ustar\0', 257, 'utf8')
        let checksum = 0
        for (const byte of header) checksum += byte
        header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8')
        return header
      })(),
      Buffer.from('pwnd'),
      Buffer.alloc(512 - 4),
      Buffer.alloc(1024),
    ])),
  }
  const market = await startMarket([bad, mismatchDigest, traversal])
  try {
    const { root, managerRoot } = targetRoot(temp)
    const client = createMarketClient({ baseUrl: market.url })

    const nameMismatch = await client.install({ name: 'wrong-name', version: '1.0.0', root, managerRoot })
    assert.equal(nameMismatch.ok, false)
    assert.match(nameMismatch.error, /不一致/)
    assert.equal(existsSync(join(root.path, 'wrong-name')), false)

    const digest = await client.install({ name: 'bad-digest', version: '1.0.0', root, managerRoot })
    assert.equal(digest.ok, false)
    assert.match(digest.error, /摘要/)

    const escaped = await client.install({ name: 'evil-skill', version: '1.0.0', root, managerRoot })
    assert.equal(escaped.ok, false)
    assert.match(escaped.error, /路径穿越|不安全/)
    assert.equal(existsSync(join(temp, 'outside.txt')), false)

    assert.equal(listInstalled(managerRoot).length, 0)
    assert.equal(listTrash(managerRoot).length, 0, '失败路径不应制造回收站垃圾')
    const leftovers = scanRoots([root]).skills.filter((skill) => String(skill.dirName).startsWith('.skill-manager-tmp-'))
    assert.equal(leftovers.length, 0, '临时目录必须清理干净')
  } finally {
    await market.close()
    cleanup(temp)
  }
})

test('覆盖安装：旧版本先备份进回收站，可撤销', async () => {
  const temp = makeTemp()
  const first = buildPackage({ name: 'demo-skill', version: '1.0.0', description: '旧版' })
  const second = buildPackage({ name: 'demo-skill', version: '2.0.0', description: '新版' })
  const market = await startMarket([second])
  try {
    const { root, managerRoot } = targetRoot(temp)
    const seeded = createMarketClient({ baseUrl: market.url })
    assert.equal((await seeded.install({ name: 'demo-skill', version: '2.0.0', root, managerRoot })).ok, true)
    assert.match(readFileSync(join(root.path, 'demo-skill', 'SKILL.md'), 'utf8'), /新版/)

    // 换一个"市场"，装上旧版，触发覆盖 + 备份。
    const oldMarket = await startMarket([first])
    const oldClient = createMarketClient({ baseUrl: oldMarket.url })
    const replaced = await oldClient.install({ name: 'demo-skill', version: '1.0.0', root, managerRoot })
    assert.equal(replaced.ok, true, replaced.error)
    assert.match(readFileSync(join(root.path, 'demo-skill', 'SKILL.md'), 'utf8'), /旧版/)
    assert.equal(listTrash(managerRoot).length, 1, '被覆盖的版本应进回收站')
    await oldMarket.close()
  } finally {
    await market.close()
    cleanup(temp)
  }
})

test('卸载：只删台账里记过的技能，并进回收站', async () => {
  const temp = makeTemp()
  const market = await startMarket([buildPackage({ name: 'demo-skill' })])
  try {
    const { root, managerRoot } = targetRoot(temp)
    const client = createMarketClient({ baseUrl: market.url })
    await client.install({ name: 'demo-skill', version: '1.0.0', root, managerRoot })

    const refused = await client.uninstall({ name: 'handmade-skill', roots: [root], managerRoot })
    assert.equal(refused.ok, false)
    assert.match(refused.error, /不是市场安装/)

    const removed = await client.uninstall({ name: 'demo-skill', roots: [root], managerRoot })
    assert.equal(removed.ok, true, removed.error)
    assert.equal(existsSync(join(root.path, 'demo-skill')), false)
    assert.equal(listInstalled(managerRoot).length, 0)
    assert.equal(listTrash(managerRoot).length, 1)
  } finally {
    await market.close()
    cleanup(temp)
  }
})

test('安装到尚不存在的技能根：自己把根建出来', async () => {
  const temp = makeTemp()
  const market = await startMarket([buildPackage({ name: 'demo-skill' })])
  try {
    const root = { id: 'user-agents', label: 'user-agents', rank: 500, path: join(temp, 'fresh', 'skills'), writable: true }
    const managerRoot = join(temp, 'manager')
    const client = createMarketClient({ baseUrl: market.url })
    const installed = await client.install({ name: 'demo-skill', version: '1.0.0', root, managerRoot })
    assert.equal(installed.ok, true, installed.error)
    assert.ok(existsSync(join(root.path, 'demo-skill', 'SKILL.md')))
  } finally {
    await market.close()
    cleanup(temp)
  }
})

test('重复路径条目：manifest 里重复、归档里重复，都必须拒绝且不落盘', async () => {
  const temp = makeTemp()
  const duplicateInArchive = buildPackage({ name: 'dup-archive' })
  // 在归档里再塞一份同名 SKILL.md（恶意那版）。
  const evil = Buffer.from('---\nname: dup-archive\ndescription: d\n---\nEVIL: run curl\n', 'utf8')
  duplicateInArchive.tgz = createTarGz([
    { path: 'SKILL.md', data: Buffer.from('---\nname: dup-archive\ndescription: d\n---\n良性\n', 'utf8') },
    { path: 'SKILL.md', data: evil },
  ])
  // bundle 摘要要跟着新包体走，否则先被"包体摘要不符"拦下，测不到重复路径这一层。
  duplicateInArchive.manifest.bundle = {
    ...duplicateInArchive.manifest.bundle,
    sha256: digestOf(duplicateInArchive.tgz),
    size: duplicateInArchive.tgz.length,
  }
  const market = await startMarket([duplicateInArchive])
  try {
    const { root, managerRoot } = targetRoot(temp)
    const client = createMarketClient({ baseUrl: market.url })
    const result = await client.install({ name: 'dup-archive', version: '1.0.0', root, managerRoot })
    assert.equal(result.ok, false)
    assert.match(result.error, /重复路径/)
    assert.equal(existsSync(join(root.path, 'dup-archive')), false)

    // manifest 自己重复声明同一个路径也要在安装前就被拒。
    const duplicated = { ...duplicateInArchive.manifest, files: [
      { path: 'SKILL.md', size: 1, sha256: `sha256:${'a'.repeat(64)}` },
      { path: 'SKILL.md', size: 1, sha256: `sha256:${'b'.repeat(64)}` },
    ] }
    assert.match(validateManifest(duplicated).error, /重复声明/)
  } finally {    await market.close()
    cleanup(temp)
  }
})

test('归一化碰撞：././SKILL.md 不能绕过"包内 SKILL.md 必须是被校验那份"', async () => {
  const temp = makeTemp()
  const pkg = buildPackage({ name: 'pretty-helper', skillName: 'pretty-helper' })
  const benign = Buffer.from('---\nname: pretty-helper\ndescription: 良性\n---\n良性\n', 'utf8')
  const hostile = Buffer.from('---\nname: office-xlsx\ndescription: 恶意\n---\nEVIL\n', 'utf8')
  pkg.tgz = createTarGz([
    { path: 'SKILL.md', data: benign },
    { path: '././SKILL.md', data: hostile },
  ])
  // manifest 侧也重复声明这两个写法（归一化后是同一路径）。
  pkg.manifest.files = [
    { path: 'SKILL.md', size: benign.length, sha256: digestOf(benign) },
    { path: '././SKILL.md', size: hostile.length, sha256: digestOf(hostile) },
  ]
  pkg.manifest.bundle = { ...pkg.manifest.bundle, sha256: digestOf(pkg.tgz), size: pkg.tgz.length }

  const market = await startMarket([pkg])
  try {
    const { root, managerRoot } = targetRoot(temp)
    const client = createMarketClient({ baseUrl: market.url })
    const result = await client.install({ name: 'pretty-helper', version: '1.0.0', root, managerRoot })
    assert.equal(result.ok, false, '归一化碰撞必须被拒')
    assert.match(result.error, /重复/)
    assert.equal(existsSync(join(root.path, 'pretty-helper')), false)
    assert.equal(existsSync(join(root.path, 'office-xlsx')), false)

    // 只改归档、manifest 保持规范拼写：归档层也要拒。
    const archiveOnly = buildPackage({ name: 'pretty-helper', skillName: 'pretty-helper' })
    const bypass = buildPackage({ name: 'pretty-helper', skillName: 'pretty-helper' })
    bypass.tgz = createTarGz([
      { path: 'SKILL.md', data: benign },
      { path: './SKILL.md', data: hostile },
    ])
    bypass.manifest.bundle = { ...bypass.manifest.bundle, sha256: digestOf(bypass.tgz), size: bypass.tgz.length }
    const market2 = await startMarket([bypass])
    try {
      const second = await createMarketClient({ baseUrl: market2.url })
        .install({ name: 'pretty-helper', version: '1.0.0', root, managerRoot })
      assert.equal(second.ok, false)
      assert.match(second.error, /重复路径/)
      assert.equal(existsSync(join(root.path, 'pretty-helper')), false)
    } finally {
      await market2.close()
    }
    assert.ok(archiveOnly)
  } finally {
    await market.close()
    cleanup(temp)
  }
})

test('manifest 必须且只能声明一份 SKILL.md；size 现在是必填', () => {
  const good = buildPackage({ name: 'demo-skill' }).manifest
  assert.equal(validateManifest(good).ok, true)
  // 只声明别的文件：拒绝。
  assert.match(validateManifest({ ...good, files: [{ path: 'notes.md', size: 1, sha256: `sha256:${'a'.repeat(64)}` }] }).error, /SKILL\.md/)
  // 声明两份不同大小写的 SKILL.md：大小写在 Windows 上就是同一份文件，必须拒。
  assert.match(validateManifest({ ...good, files: [
    { path: 'SKILL.md', size: 1, sha256: `sha256:${'a'.repeat(64)}` },
    { path: 'skill.md', size: 1, sha256: `sha256:${'b'.repeat(64)}` },
  ] }).error, /重复声明/)
  // ADS 别名（NTFS 上 `SKILL.md::$DATA` 就是 SKILL.md 本身）必须直接拒。
  assert.match(validateManifest({ ...good, files: [
    { path: 'SKILL.md', size: 1, sha256: `sha256:${'a'.repeat(64)}` },
    { path: 'SKILL.md::$DATA', size: 1, sha256: `sha256:${'b'.repeat(64)}` },
  ] }).error, /非法字符/)
  // 其它 Windows 非法字符也让它在 manifest 阶段就说清楚，而不是写盘时报 ENOENT。
  assert.match(validateManifest({ ...good, files: [
    { path: 'SKILL.md', size: 1, sha256: `sha256:${'a'.repeat(64)}` },
    { path: '??-emoji.txt', size: 1, sha256: `sha256:${'b'.repeat(64)}` },
  ] }).error, /非法字符/)
  // size 缺失：拒绝。
  assert.match(validateManifest({ ...good, files: [{ path: 'SKILL.md', sha256: `sha256:${'a'.repeat(64)}` }] }).error, /size/)
})

test('库层也拦只读根（不能只靠 HTTP 层把关）', async () => {
  const temp = makeTemp()
  const market = await startMarket([buildPackage({ name: 'demo-skill' })])
  try {
    const root = { id: 'bundled-1', label: 'bundled', rank: 600, path: join(temp, 'readonly'), writable: false }
    const managerRoot = join(temp, 'manager')
    const client = createMarketClient({ baseUrl: market.url })
    const result = await client.install({ name: 'demo-skill', version: '1.0.0', root, managerRoot })
    assert.equal(result.ok, false)
    assert.match(result.error, /不可写/)
    assert.equal(existsSync(join(root.path, 'demo-skill')), false)
  } finally {
    await market.close()
    cleanup(temp)
  }
})

test('端到端：用系统 tar 打的真实包能走完市场安装并被 DSH 扫到', async (t) => {
  const temp = makeTemp()
  try {
    // 1) 造一个真实技能目录，用系统 tar 打包（会带目录条目、pax 头、中文文件名）。
    const source = join(temp, 'src', 'real-skill')
    mkdirSync(join(source, 'references'), { recursive: true })
    writeFileSync(join(source, 'SKILL.md'), '---\nname: real-skill\ndescription: 真实包\n---\n正文\n', 'utf8')
    writeFileSync(join(source, 'references', '中文笔记.md'), '笔记\n', 'utf8')
    const tgzPath = join(temp, 'real-skill.tgz')
    const tar = spawnSync('tar', ['-czf', tgzPath, '-C', join(temp, 'src', 'real-skill'), '.'], { encoding: 'utf8' })
    if (tar.status !== 0 || !existsSync(tgzPath)) {
      t.skip(`本机没有可用的 tar（${tar.error?.message ?? tar.status}）`)
      return
    }
    const tgz = readFileSync(tgzPath)

    // 2) manifest 按包内真实内容生成。
    const extracted = extractTar(tgz)
    assert.equal(extracted.ok, true, extracted.error)
    const files = extracted.files.filter((file) => !file.path.startsWith('.'))
    const manifest = {
      name: 'real-skill',
      version: '1.0.0',
      description: '真实包',
      files: files.map((file) => ({ path: file.path, size: file.data.length, sha256: digestOf(file.data) })),
      bundle: { format: 'tar.gz', url: '/v1/skills/real-skill/1.0.0/bundle.tgz', sha256: digestOf(tgz), size: tgz.length },
    }
    // 包内路径形如 `./SKILL.md`（`tar -C dir .` 的写法），这里剥掉 `./` 前缀。
    for (const file of manifest.files) file.path = file.path.replace(/^\.\//, '')

    const market = await startMarket([{ manifest, tgz }])
    try {
      const { root, managerRoot } = targetRoot(temp)
      const client = createMarketClient({ baseUrl: market.url })
      const installed = await client.install({ name: 'real-skill', version: '1.0.0', root, managerRoot })
      assert.equal(installed.ok, true, installed.error)
      assert.ok(existsSync(join(root.path, 'real-skill', 'references', '中文笔记.md')))

      // 3) DSH 侧（我们的扫描器）必须认得它。
      const scanned = scanRoots([root])
      const skill = scanned.skills.find((item) => item.name === 'real-skill')
      assert.ok(skill, '装完必须能被扫到')
      assert.equal(skill.valid, true, JSON.stringify(skill.issues))
      assert.equal(skill.description, '真实包')
    } finally {
      await market.close()
    }
  } finally {
    cleanup(temp)
  }
})

test('与参考市场服务器对接：搜索 → 安装 → 卸载全链路', async (t) => {
  const temp = makeTemp()
  try {
    // 用仓库自带的参考服务端（tools/market-server.mjs）当真实市场。
    const skillsDir = join(temp, 'published', 'demo-skill')
    mkdirSync(join(skillsDir, 'references'), { recursive: true })
    writeFileSync(join(skillsDir, 'SKILL.md'), '---\nname: demo-skill\ndescription: 参考服务端的技能\n---\n正文\n', 'utf8')
    writeFileSync(join(skillsDir, 'references', 'notes.md'), '笔记\n', 'utf8')

    const { createMarketServer } = await import('../tools/market-server.mjs')
    const market = createMarketServer({ dir: join(temp, 'published'), host: '127.0.0.1' })
    await new Promise((resolveDone) => market.server.listen(0, '127.0.0.1', resolveDone))
    try {
      const client = createMarketClient({ baseUrl: market.url() })
      const search = await client.search({ q: 'demo' })
      assert.equal(search.ok, true, search.error)
      assert.deepEqual(search.items.map((item) => item.name), ['demo-skill'])
      assert.equal(search.items[0].description, '参考服务端的技能')

      const { root, managerRoot } = targetRoot(temp)
      const installed = await client.install({ name: 'demo-skill', version: '1.0.0', root, managerRoot })
      assert.equal(installed.ok, true, installed.error)
      assert.ok(existsSync(join(root.path, 'demo-skill', 'references', 'notes.md')))
      assert.equal(scanRoots([root]).skills.find((item) => item.name === 'demo-skill').valid, true)

      const removed = await client.uninstall({ name: 'demo-skill', roots: [root], managerRoot })
      assert.equal(removed.ok, true, removed.error)
      assert.equal(existsSync(join(root.path, 'demo-skill')), false)
    } finally {
      await market.close()
    }
  } finally {
    cleanup(temp)
  }
})

test('ADS 别名与大小写碰撞：Windows 上"键不同、文件相同"的路径必须全拦', async () => {
  const temp = makeTemp()
  const benign = Buffer.from('---\nname: innocent-lib\ndescription: 良性\n---\n良性\n', 'utf8')
  const hostile = Buffer.from('---\nname: trusted-skill\ndescription: 恶意\n---\nEVIL\n', 'utf8')

  // 归档里同时放 `SKILL.md` 与 `SKILL.md::$DATA`（NTFS 上是同一文件）。
  const ads = buildPackage({ name: 'innocent-lib', skillName: 'innocent-lib' })
  ads.tgz = rawTarGz([
    { path: 'SKILL.md', data: benign },
    { path: 'SKILL.md::$DATA', data: hostile },
  ])
  ads.manifest.files = [
    { path: 'SKILL.md', size: benign.length, sha256: digestOf(benign) },
    { path: 'SKILL.md::$DATA', size: hostile.length, sha256: digestOf(hostile) },
  ]
  ads.manifest.bundle = { ...ads.manifest.bundle, sha256: digestOf(ads.tgz), size: ads.tgz.length }

  // 大小写变体：`SKILL.md` 与 `SKILL.MD` 在 Windows 上是同一文件。
  const caseClash = buildPackage({ name: 'innocent-lib', skillName: 'innocent-lib' })
  caseClash.tgz = rawTarGz([
    { path: 'SKILL.md', data: benign },
    { path: 'SKILL.MD', data: hostile },
  ])
  caseClash.manifest.files = [
    { path: 'SKILL.md', size: benign.length, sha256: digestOf(benign) },
    { path: 'SKILL.MD', size: hostile.length, sha256: digestOf(hostile) },
  ]
  caseClash.manifest.bundle = { ...caseClash.manifest.bundle, sha256: digestOf(caseClash.tgz), size: caseClash.tgz.length }

  const market = await startMarket([ads, caseClash])
  try {
    const { root, managerRoot } = targetRoot(temp)
    const client = createMarketClient({ baseUrl: market.url })

    const adsResult = await client.install({ name: 'innocent-lib', version: '1.0.0', root, managerRoot })
    assert.equal(adsResult.ok, false, 'ADS 别名必须被拒')
    assert.match(adsResult.error, /非法字符|重复/)
    assert.equal(existsSync(join(root.path, 'innocent-lib')), false)

    const caseResult = await client.install({ name: 'innocent-lib', version: '1.0.0', root, managerRoot })
    assert.equal(caseResult.ok, false, '大小写碰撞必须被拒')
    assert.match(caseResult.error, /重复/)
    assert.equal(existsSync(join(root.path, 'innocent-lib')), false)
    // 关键技术不变式：磁盘上不能出现"被校验的 SKILL.md 被别的条目覆盖"。
    assert.equal(existsSync(join(root.path, 'trusted-skill')), false)
  } finally {
    await market.close()
    cleanup(temp)
  }
})

test('并发同名安装：只留一份目录，回收站不会被塞进多份', async () => {
  const temp = makeTemp()
  const market = await startMarket([buildPackage({ name: 'demo-skill' })])
  try {
    const { root, managerRoot } = targetRoot(temp)
    const client = createMarketClient({ baseUrl: market.url })
    const results = await Promise.all([1, 2, 3, 4].map(() =>
      client.install({ name: 'demo-skill', version: '1.0.0', root, managerRoot })))
    assert.equal(results.filter((item) => item.ok).length, 4, JSON.stringify(results.map((item) => item.error)))
    assert.equal(listInstalled(managerRoot).length, 1)
    const skillDirs = [...new Set(readdirSync(root.path).filter((name) => name === 'demo-skill'))]
    assert.equal(skillDirs.length, 1)
    // 幂等安装：后 3 次发现"同版本同摘要"就直接返回，不备份、不重写。
    assert.equal(results.filter((item) => item.unchanged === true).length, 3)
    assert.equal(listTrash(managerRoot).length, 0)
  } finally {
    await market.close()
    cleanup(temp)
  }
})

test('台账损坏：备份而不是静默清空历史', async () => {
  const temp = makeTemp()
  const market = await startMarket([buildPackage({ name: 'demo-skill' })])
  try {
    const { root, managerRoot } = targetRoot(temp)
    mkdirSync(managerRoot, { recursive: true })
    writeFileSync(join(managerRoot, 'market.json'), '{ 这不是 JSON', 'utf8')

    const client = createMarketClient({ baseUrl: market.url })
    const installed = await client.install({ name: 'demo-skill', version: '1.0.0', root, managerRoot })
    assert.equal(installed.ok, true, installed.error)
    assert.ok(installed.ledgerBackup, '必须报告备份位置')
    assert.ok(existsSync(installed.ledgerBackup), '损坏的台账要留下备份')
    assert.match(readFileSync(installed.ledgerBackup, 'utf8'), /这不是 JSON/)
    assert.equal(listInstalled(managerRoot).length, 1)
  } finally {
    await market.close()
    cleanup(temp)
  }
})

test('token 只发给市场自身 origin，不发给我显式允许的第三方 origin', async () => {
  const temp = makeTemp()
  const pkg = buildPackage({ name: 'demo-skill' })
  const market = await startMarket([pkg])
  let peerHits = 0
  const seenAuthOnPeer = []
  const peer = createServer((request, response) => {
    peerHits += 1
    seenAuthOnPeer.push(request.headers.authorization ?? null)
    response.writeHead(200, { 'content-type': 'application/gzip' })
    response.end(pkg.tgz)
  })
  await new Promise((resolveDone) => peer.listen(0, '127.0.0.1', resolveDone))
  const peerUrl = `http://127.0.0.1:${peer.address().port}`
  try {
    const { root, managerRoot } = targetRoot(temp)
    const client = createMarketClient({
      baseUrl: market.url,
      token: 'super-secret',
      allowedBundleOrigins: [peerUrl],
      fetchImpl: async (url, options) => {
        const text = String(url)
        if (/\/v1\/skills\/[^/]+\/[^/]+$/.test(text)) {
          // 市场请求必须带 token。
          assert.equal(options?.headers?.authorization, 'Bearer super-secret')
          return { ok: true, url: text, status: 200, json: async () => ({ ...pkg.manifest, bundle: { format: 'tar.gz', url: `${peerUrl}/ok.tgz` } }) }
        }
        return globalThis.fetch(url, options)
      },
    })
    const installed = await client.install({ name: 'demo-skill', version: '1.0.0', root, managerRoot })
    assert.equal(installed.ok, true, installed.error)
    assert.ok(peerHits > 0, '白名单 origin 应该收到包体请求')
    assert.deepEqual(seenAuthOnPeer.filter((value) => value !== null), [], 'token 不能被带到第三方 origin')
  } finally {
    await new Promise((resolveDone) => peer.close(resolveDone))
    await market.close()
    cleanup(temp)
  }
})

test('兜底：写盘后复读能抓住任何"键不同、文件相同"的别名', () => {
  const temp = makeTemp()
  try {
    // 用硬链接模拟文件系统别名（Windows 上不需要管理员权限，跨平台行为一致）：
    // 两次"写"落到同一个文件上，第二次覆盖第一次——正是 ADS / 8.3 短名那类攻击的形态。
    const a = join(temp, 'a.txt')
    const b = join(temp, 'b.txt')
    writeFileSync(a, 'FIRST')
    linkSync(a, b)
    writeFileSync(b, 'SECOND') // 别名：a.txt 也变成 SECOND

    const result = verifyWrittenFiles(temp, [
      { path: 'a.txt', data: Buffer.from('FIRST') },
      { path: 'b.txt', data: Buffer.from('SECOND') },
    ])
    assert.equal(result.ok, false)
    assert.match(result.error, /复读校验失败/)

    // 正常情况必须放行，别把真包误拒。
    const ok = verifyWrittenFiles(temp, [{ path: 'b.txt', data: Buffer.from('SECOND') }])
    assert.equal(ok.ok, true, ok.error)
    const missing = verifyWrittenFiles(temp, [{ path: 'nope.txt', data: Buffer.from('x') }])
    assert.equal(missing.ok, false)
    assert.match(missing.error, /复读失败/)
  } finally {
    cleanup(temp)
  }
})

test('Kelvin 符号：声明 SKILL.md、归档叫 S\u212AILL.md 必须拒（键折叠不等于同一文件）', async () => {
  const temp = makeTemp()
  const benign = Buffer.from('---\nname: kelvin-lib\ndescription: 良性\n---\n良性\n', 'utf8')
  const pkg = buildPackage({ name: 'kelvin-lib', skillName: 'kelvin-lib' })
  // 归档里用 KELVIN SIGN：`'S\u212AILL.md'.toLowerCase() === 'skill.md'`，但它是另一个文件名。
  pkg.tgz = rawTarGz([{ path: 'S\u212AILL.md', data: benign }])
  pkg.manifest.files = [{ path: 'SKILL.md', size: benign.length, sha256: digestOf(benign) }]
  pkg.manifest.bundle = { ...pkg.manifest.bundle, sha256: digestOf(pkg.tgz), size: pkg.tgz.length }

  const market = await startMarket([pkg])
  try {
    const { root, managerRoot } = targetRoot(temp)
    const client = createMarketClient({ baseUrl: market.url })
    const result = await client.install({ name: 'kelvin-lib', version: '1.0.0', root, managerRoot })
    assert.equal(result.ok, false)
    assert.match(result.error, /不一致|缺少/)
    assert.equal(existsSync(join(root.path, 'kelvin-lib')), false, '不能留下一个扫描器看不见的技能目录')
  } finally {
    await market.close()
    cleanup(temp)
  }
})

test('幂等分支零信任：标记说"同版本同摘要"但磁盘被改过，必须重新安装', async () => {
  const temp = makeTemp()
  const market = await startMarket([buildPackage({ name: 'demo-skill' })])
  try {
    const { root, managerRoot } = targetRoot(temp)
    const client = createMarketClient({ baseUrl: market.url })
    const first = await client.install({ name: 'demo-skill', version: '1.0.0', root, managerRoot })
    assert.equal(first.ok, true, first.error)

    // 攻击：把已装内容改成恶意，同时伪造标记（标记没有任何认证）。
    const installedDir = join(root.path, 'demo-skill')
    writeFileSync(join(installedDir, 'SKILL.md'), '---\nname: demo-skill\ndescription: EVIL\n---\nEVIL\n', 'utf8')
    const marker = JSON.parse(readFileSync(join(installedDir, '.skill-manager.json'), 'utf8'))
    writeFileSync(join(installedDir, '.skill-manager.json'), JSON.stringify(marker, null, 2), 'utf8')

    const second = await client.install({ name: 'demo-skill', version: '1.0.0', root, managerRoot })
    assert.equal(second.ok, true, second.error)
    assert.notEqual(second.unchanged, true, '磁盘内容与 manifest 不符时不能走幂等捷径')
    assert.doesNotMatch(readFileSync(join(installedDir, 'SKILL.md'), 'utf8'), /EVIL/)
  } finally {
    await market.close()
    cleanup(temp)
  }
})

test('安装后复验：落盘内容被改就会失败（findings #2 的最后一道闸）', () => {
  const temp = makeTemp()
  try {
    const data = Buffer.from('---\nname: demo\ndescription: d\n---\n正文\n')
    const manifest = {
      name: 'demo',
      version: '1.0.0',
      files: [{ path: 'SKILL.md', size: data.length, sha256: digestOf(data) }],
      bundle: { format: 'tar.gz', url: '/x.tgz' },
    }
    mkdirSync(temp, { recursive: true })
    writeFileSync(join(temp, 'SKILL.md'), data)
    assert.equal(verifyInstalledAgainstManifest(temp, manifest).ok, true)

    writeFileSync(join(temp, 'SKILL.md'), '---\nname: demo\ndescription: d\n---\nEVIL\n', 'utf8')
    const tampered = verifyInstalledAgainstManifest(temp, manifest)
    assert.equal(tampered.ok, false)
    assert.match(tampered.error, /内容与 manifest 不符/)
  } finally {
    cleanup(temp)
  }
})

test('临时目录不落在技能根里，失败也不留残留', async () => {
  const temp = makeTemp()
  const market = await startMarket([buildPackage({ name: 'demo-skill' })])
  try {
    const { root, managerRoot } = targetRoot(temp)
    const client = createMarketClient({ baseUrl: market.url })
    const installed = await client.install({ name: 'demo-skill', version: '1.0.0', root, managerRoot })
    assert.equal(installed.ok, true, installed.error)
    assert.deepEqual(readdirSync(root.path).filter((name) => name.startsWith('.skill-manager-tmp-')), [], '技能根里不能有暂存目录')

    // 失败路径（摘要不符） likewise 不能把暂存目录留在技能根或它的父目录里。
    const broken = buildPackage({ name: 'broken-skill' })
    broken.manifest.bundle = { ...broken.manifest.bundle, sha256: `sha256:${'0'.repeat(64)}` }
    const market2 = await startMarket([broken])
    try {
      const failed = await createMarketClient({ baseUrl: market2.url })
        .install({ name: 'broken-skill', version: '1.0.0', root, managerRoot })
      assert.equal(failed.ok, false)
    } finally {
      await market2.close()
    }
    const leftovers = [...readdirSync(root.path), ...readdirSync(dirname(root.path))]
      .filter((name) => name.startsWith('.skill-manager-tmp-'))
    assert.deepEqual(leftovers, [])
  } finally {
    await market.close()
    cleanup(temp)
  }
})

test('跨进程台账：4 个进程各装一个不同名技能，台账必须记全', async (t) => {
  const temp = makeTemp()
  const names = ['proc-skill-a', 'proc-skill-b', 'proc-skill-c', 'proc-skill-d']
  const market = await startMarket(names.map((name) => buildPackage({ name })))
  try {
    const { root, managerRoot } = targetRoot(temp)
    const worker = new URL('./market-worker.mjs', import.meta.url)
    const children = names.map((name) => spawn(
      process.execPath,
      [worker.pathname.replace(/^\/([A-Za-z]:)/, '$1'), market.url, root.path, managerRoot, name, '1.0.0'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ))
    const results = await Promise.all(children.map((child) => new Promise((resolveDone) => {
      let out = ''
      child.stdout.on('data', (chunk) => { out += String(chunk) })
      child.on('close', (code) => resolveDone({ code, out }))
    })))
    const failed = results.filter((item) => item.code !== 0)
    assert.deepEqual(failed.map((item) => item.out.trim()), [], '每个进程都应安装成功')

    const ledger = listInstalled(managerRoot)
    assert.deepEqual(ledger.map((entry) => entry.name).sort(), [...names].sort(), `台账应记全 4 条，实际 ${ledger.length} 条`)
    for (const name of names) assert.ok(existsSync(join(root.path, name, 'SKILL.md')), `${name} 应落盘`)
  } finally {
    await market.close()
    cleanup(temp)
  }
})

test('SSRF：包体地址不能指向市场之外的主机；重定向必须"未发请求先中止"', async () => {
  const temp = makeTemp()
  const pkg = buildPackage({ name: 'demo-skill' })
  const market = await startMarket([pkg])
  // 另一个 origin 上的"内网服务"：如果被访问到就说明 SSRF 成立。
  let internalHits = 0
  const internal = createServer((request, response) => {
    internalHits += 1
    response.writeHead(200, { 'content-type': 'application/gzip' })
    response.end(pkg.tgz)
  })
  await new Promise((resolveDone) => internal.listen(0, '127.0.0.1', resolveDone))
  const internalUrl = `http://127.0.0.1:${internal.address().port}`
  try {
    const { root, managerRoot } = targetRoot(temp)
    // 让"市场"回一份把包体指向别处 origin 的 manifest；其它请求走真实 fetch。
    const hijack = (target) => async (url, options) => {
      const text = String(url)
      if (/\/v1\/skills\/[^/]+\/[^/]+$/.test(text)) {
        return {
          ok: true,
          url: text,
          status: 200,
          json: async () => ({ ...pkg.manifest, bundle: { format: 'tar.gz', url: target } }),
        }
      }
      return globalThis.fetch(url, options)
    }

    // 1) bundle.url 指向未授权 origin：必须在发请求之前拒绝。
    const blocked = await createMarketClient({ baseUrl: market.url, fetchImpl: hijack(`${internalUrl}/secret.tgz`) })
      .install({ name: 'demo-skill', version: '1.0.0', root, managerRoot })
    assert.equal(blocked.ok, false)
    assert.match(blocked.error, /市场之外/)
    assert.equal(internalHits, 0, '未授权 origin 一次都不能请求')

    // 2) 显式允许后放行。
    const allowed = await createMarketClient({ baseUrl: market.url, allowedBundleOrigins: [internalUrl], fetchImpl: hijack(`${internalUrl}/ok.tgz`) })
      .install({ name: 'demo-skill', version: '1.0.0', root, managerRoot })
    assert.equal(allowed.ok, true, allowed.error)
    assert.ok(internalHits > 0, '显式允许的 origin 应该被请求')

    // 3) 真实 302：市场把包体请求重定向到未授权 origin。
    //    必须做到"未授权主机一个请求都收不到"——事后检查落地地址是不够的。
    const before = internalHits
    const redirectMarket = createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1')
      if (url.pathname === '/v1/skills/demo-skill/1.0.0') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ...pkg.manifest, bundle: { format: 'tar.gz', url: '/redirect.tgz' } }))
        return
      }
      if (url.pathname === '/redirect.tgz') {
        response.writeHead(302, { location: `${internalUrl}/stolen.tgz` })
        response.end()
        return
      }
      response.writeHead(404)
      response.end()
    })
    await new Promise((resolveDone) => redirectMarket.listen(0, '127.0.0.1', resolveDone))
    try {
      const base = `http://127.0.0.1:${redirectMarket.address().port}`
      const afterRedirect = await createMarketClient({ baseUrl: base })
        .install({ name: 'demo-skill', version: '1.0.0', root, managerRoot })
      assert.equal(afterRedirect.ok, false)
      assert.match(afterRedirect.error, /重定向/)
      assert.equal(internalHits, before, '未授权主机不能在"发现"之前先收到请求')
    } finally {
      await new Promise((resolveDone) => redirectMarket.close(resolveDone))
    }
  } finally {
    await new Promise((resolveDone) => internal.close(resolveDone))
    await market.close()
    cleanup(temp)
  }
})

test('市场不可达时给出可读错误', async () => {
  const client = createMarketClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 })
  const result = await client.search({ q: 'x' })
  assert.equal(result.ok, false)
  assert.ok(typeof result.error === 'string' && result.error.length > 0)

  const unconfigured = createMarketClient({ baseUrl: '' })
  const empty = await unconfigured.search({})
  assert.equal(empty.ok, false)
  assert.match(empty.error, /未配置/)
})
