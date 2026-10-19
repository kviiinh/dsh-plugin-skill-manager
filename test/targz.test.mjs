/**
 * tar(.gz) 读写与安全子集（路径穿越 / 链接条目必须被拒）。
 *
 * @module dsh-plugin-skill-manager/test/targz.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { createTarGz, extractTar, safeEntryPath } from '../lib/targz.js'
import { cleanup, makeTemp } from './helpers.mjs'

/**
 * 手写一个带任意 typeflag 的 tar 头（用于构造恶意归档）。
 * @param {{name: string, size: number, typeflag: string, linkname?: string}} input 条目。
 * @returns {Buffer} 头。
 */
function rawHeader(input) {
  const header = Buffer.alloc(512)
  Buffer.from(input.name, 'utf8').copy(header, 0)
  header.write('0000644\0', 100, 'utf8')
  header.write('0000000\0', 108, 'utf8')
  header.write('0000000\0', 116, 'utf8')
  header.write(`${input.size.toString(8).padStart(11, '0')}\0`, 124, 'utf8')
  header.write('00000000000\0', 136, 'utf8')
  header.write('        ', 148, 'utf8')
  header.write(input.typeflag, 156, 'utf8')
  if (input.linkname) Buffer.from(input.linkname, 'utf8').copy(header, 157)
  header.write('ustar\0', 257, 'utf8')
  header.write('00', 263, 'utf8')
  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8')
  return header
}

test('safeEntryPath 只放行干净的相对路径', () => {
  assert.deepEqual(safeEntryPath('./SKILL.md'), { ok: true, path: 'SKILL.md', directory: false })
  assert.deepEqual(safeEntryPath('references/a.md'), { ok: true, path: 'references/a.md', directory: false })
  // 归一化必须是语义层面的：多种写法指向同一份文件，否则"校验 A、落盘 B"会重新成立。
  assert.deepEqual(safeEntryPath('././SKILL.md'), { ok: true, path: 'SKILL.md', directory: false })
  // 含 `..` 的路径一律拒绝（fail-closed），即使归一化后会落回根内。
  assert.equal(safeEntryPath('a/./b/../b/c.md').ok, false)
  // 目录条目（BSD/GNU tar 必带尾斜杠）要放行，且归一化后不带尾斜杠。
  assert.deepEqual(safeEntryPath('skill/'), { ok: true, path: 'skill', directory: true })
  assert.deepEqual(safeEntryPath('./'), { ok: true, path: '', directory: true })
  assert.equal(safeEntryPath('../evil').ok, false)
  assert.equal(safeEntryPath('a/../../evil').ok, false)
  assert.equal(safeEntryPath('/etc/passwd').ok, false)
  assert.equal(safeEntryPath('C:\\Windows\\evil').ok, false)
  assert.equal(safeEntryPath('').ok, false)
})

test('归档条目：目录条目与多种归一化写法', () => {
  // 目录条目 + `./` 前缀的文件：必须能解出来，且路径统一。
  const tgz = createTarGz([
    { path: 'demo/', data: '' },
    { path: './demo/SKILL.md', data: '正文' },
  ])
  const result = extractTar(tgz)
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.files.map((file) => file.path), ['demo/SKILL.md'])
  assert.deepEqual(result.directories, ['demo'])

  // `././SKILL.md` 与 `SKILL.md` 归一化后同名，必须当重复拒绝。
  const collision = Buffer.concat([
    rawHeader({ name: 'SKILL.md', size: 4, typeflag: '0' }),
    Buffer.from('AAAA'),
    Buffer.alloc(512 - 4),
    rawHeader({ name: '././SKILL.md', size: 4, typeflag: '0' }),
    Buffer.from('BBBB'),
    Buffer.alloc(512 - 4),
    Buffer.alloc(1024),
  ])
  const rejected = extractTar(gzipSync(collision))
  assert.equal(rejected.ok, false)
  assert.match(rejected.error, /重复路径/)
})

test('真实 tar（bsdtar / GNU tar）产生的包必须能解', (t) => {
  // 这是"误拒"防线：真实 tar 会写目录条目、`./` 前缀、pax 扩展头，
  // 只用自己的 writer 测是测不出来的。
  const temp = makeTemp()
  try {
    const source = join(temp, 'demo')
    mkdirSync(join(source, 'references'), { recursive: true })
    writeFileSync(join(source, 'SKILL.md'), '---\nname: demo\ndescription: 中文描述\n---\n正文\n', 'utf8')
    writeFileSync(join(source, 'references', '中文笔记.md'), '笔记\n', 'utf8')
    const archive = join(temp, 'demo.tgz')
    const tar = spawnSync('tar', ['-czf', archive, '-C', temp, 'demo'], { encoding: 'utf8' })
    if (tar.status !== 0 || !existsSync(archive)) {
      t.skip(`本机没有可用的 tar（${tar.error?.message ?? tar.status}）`)
      return
    }
    const result = extractTar(readFileSync(archive))
    assert.equal(result.ok, true, result.error)
    const paths = result.files.map((file) => file.path).sort()
    assert.deepEqual(paths, ['demo/SKILL.md', 'demo/references/中文笔记.md'])
    const skill = result.files.find((file) => file.path.endsWith('SKILL.md'))
    assert.match(skill.data.toString('utf8'), /中文描述/)
  } finally {
    cleanup(temp)
  }
})

test('小于一个 tar 块的输入、空归档要明确报错而不是当空包', () => {
  assert.equal(extractTar(Buffer.from('not a tar at all')).ok, false)
  assert.match(extractTar(Buffer.from('not a tar at all')).error, /没有任何条目|不是合法/)
  const empty = extractTar(gzipSync(Buffer.alloc(1024)))
  assert.equal(empty.ok, false)
  assert.match(empty.error, /没有任何条目/)
})

test('打包 → 解包 往返一致', () => {
  const tgz = createTarGz([
    { path: 'SKILL.md', data: '---\nname: demo\ndescription: d\n---\n正文' },
    { path: 'references/notes.md', data: '笔记' },
    { path: 'scripts/tool.py', data: 'print(1)\n' },
  ])
  const result = extractTar(tgz)
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.files.map((file) => file.path).sort(), ['SKILL.md', 'references/notes.md', 'scripts/tool.py'])
  const skill = result.files.find((file) => file.path === 'SKILL.md')
  assert.match(skill.data.toString('utf8'), /正文/)
})

test('解包拒绝路径穿越条目', () => {
  const evil = Buffer.concat([
    rawHeader({ name: '../outside.txt', size: 4, typeflag: '0' }),
    Buffer.from('pwnd'),
    Buffer.alloc(512 - 4),
    Buffer.alloc(1024),
  ])
  const result = extractTar(gzipSync(evil))
  assert.equal(result.ok, false)
  assert.match(result.error, /路径穿越|不安全/)
})

test('解包拒绝符号链接 / 硬链接条目', () => {
  const link = Buffer.concat([
    rawHeader({ name: 'link', size: 0, typeflag: '2', linkname: '/etc/passwd' }),
    Buffer.alloc(1024),
  ])
  const result = extractTar(gzipSync(link))
  assert.equal(result.ok, false)
  assert.match(result.error, /链接/)

  for (const typeflag of ['1', 'l']) {
    const other = Buffer.concat([rawHeader({ name: 'x', size: 0, typeflag }), Buffer.alloc(1024)])
    assert.equal(extractTar(gzipSync(other)).ok, false)
  }
})

test('解包拒绝重复路径条目（后者覆盖前者是典型的校验绕过）', () => {
  const benign = Buffer.from('---\nname: demo\ndescription: d\n---\n良性\n', 'utf8')
  const evil = Buffer.from('---\nname: demo\ndescription: d\n---\nEVIL\n', 'utf8')
  const archive = Buffer.concat([
    rawHeader({ name: 'SKILL.md', size: benign.length, typeflag: '0' }),
    benign,
    Buffer.alloc((512 - (benign.length % 512)) % 512),
    rawHeader({ name: 'SKILL.md', size: evil.length, typeflag: '0' }),
    evil,
    Buffer.alloc((512 - (evil.length % 512)) % 512),
    Buffer.alloc(1024),
  ])
  const result = extractTar(gzipSync(archive))
  assert.equal(result.ok, false)
  assert.match(result.error, /重复路径/)
})

test('解包拒绝 tar 头校验和不合法（含全零校验和）的条目', () => {
  const header = rawHeader({ name: 'SKILL.md', size: 4, typeflag: '0' })
  header.write('000000\0 ', 148, 'utf8') // 故意写坏 checksum
  const archive = Buffer.concat([header, Buffer.from('data'), Buffer.alloc(1024)])
  const result = extractTar(gzipSync(archive))
  assert.equal(result.ok, false)
  assert.match(result.error, /校验和/)
})

test('解包拒绝被截断的归档与超限归档', () => {
  const truncated = Buffer.concat([rawHeader({ name: 'a.txt', size: 100, typeflag: '0' }), Buffer.from('short')])
  assert.equal(extractTar(gzipSync(truncated)).ok, false)

  const big = createTarGz([{ path: 'a.txt', data: 'x'.repeat(2048) }])
  const limited = extractTar(big, { maxBytes: 100 })
  assert.equal(limited.ok, false)
  assert.match(limited.error, /上限/)
})
