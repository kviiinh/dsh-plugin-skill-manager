/**
 * 最小 tar(.gz) 读写。
 *
 * 技能市场把技能包发成 `.tgz`：这是唯一需要处理归档的地方，为此引入一个 tar 依赖
 * 不划算（也要给 profile 装依赖），所以这里自己实现，并**只实现安全的子集**：
 *
 *   - 读：ustar 名称 / `prefix` 字段 / GNU `L` 长名 / POSIX pax `x` 的 `path`；
 *   - 拒绝：绝对路径、含 `..` 的路径、符号链接 / 硬链接 / 字符设备等一切非普通条目；
 *   - 写（供测试与"打包技能"用）：ustar 头 + gzip。
 *
 * 安全注释：tar 的路径穿越是这类安装器最典型的漏洞，`safeEntryPath()` 是唯一的
 * 把关点，**任何**绕过它写文件的路径都是 bug。
 *
 * @module dsh-plugin-skill-manager/lib/targz
 */

import { gunzipSync, gzipSync } from 'node:zlib'

const BLOCK = 512

/**
 * 一律禁止的字符：`:`（Windows 上能拼出 ADS 别名，且跨平台传输时必炸）与控制字符。
 */
const ALWAYS_ILLEGAL = /[:\u0000-\u001f]/
/** 仅 Windows 禁止的字符（Linux 上它们是合法文件名，不该误拒）。 */
const WINDOWS_ILLEGAL = /[<>"|?*]/

/**
 * 归一化并校验归档内的相对路径。
 *
 * 归一化是**语义**层面的：`././SKILL.md`、`SKILL.md`、`./SKILL.md` 必须归到同一个键，
 * 否则"校验 A、落盘 B"（重复路径 last-write-wins）这类绕过就会重新成立。
 * 目录条目允许尾斜杠（BSD/GNU tar 的目录条目天然带 `/`），归一化后不带。
 *
 * 段内字符要按平台把关，因为**字符串相等不等于文件相同**：
 *   - `SKILL.md::$DATA` 在 NTFS 上是 `SKILL.md` 的默认数据流（Alternate Data Stream），
 *     字符串不同却写同一份文件——`:` 因此在所有平台一律拒绝；
 *   - `< > " | ? *` 只在 Windows 上非法，Linux 上照旧放行，避免无谓误拒；
 *   - 控制字符与首尾空白一律拒绝。
 *
 * @param {string} raw 归档中的原始路径。
 * @returns {{ok: true, path: string, directory: boolean} | {ok: false, error: string}} 校验结果。
 */
export function safeEntryPath(raw) {
  const original = String(raw ?? '').replace(/\\/g, '/').trim()
  if (!original) return { ok: false, error: '空路径' }
  if (original.includes('\0')) return { ok: false, error: '路径含 NUL' }
  if (original.startsWith('/') || /^[A-Za-z]:/.test(original)) return { ok: false, error: `绝对路径：${original}` }
  const directory = original.endsWith('/')
  const parts = original.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.some((part) => part === '..')) return { ok: false, error: `路径穿越：${original}` }
  if (parts.some((part) => part !== part.trim())) {
    return { ok: false, error: `路径段首尾有空白：${original}` }
  }
  const alwaysIllegal = parts.find((part) => ALWAYS_ILLEGAL.test(part))
  if (alwaysIllegal !== undefined) {
    return { ok: false, error: `路径含非法字符（\`:\` 可拼出 NTFS ADS 别名）：${original}` }
  }
  if (process.platform === 'win32') {
    const windowsIllegal = parts.find((part) => WINDOWS_ILLEGAL.test(part))
    if (windowsIllegal !== undefined) {
      return { ok: false, error: `路径含 Windows 非法字符：${original}` }
    }
  }
  if (parts.length === 0) {
    // `./` 这种"归档根"目录条目可以安全忽略；其它情况视为非法。
    if (directory) return { ok: true, path: '', directory: true }
    return { ok: false, error: `空路径：${original}` }
  }
  return { ok: true, path: parts.join('/'), directory }
}

/**
 * "是否同一个文件"的比较键：Windows 与 macOS（默认 APFS）大小写不敏感，
 * 归档里出现仅大小写不同的两条路径时会落到同一个文件上；Linux 上按原样比较，
 * 不去误拒合法的大小写差异。
 *
 * 注意它**只用于判重**：声明路径与归档路径之间的匹配必须是逐字节相等，
 * 否则 Unicode 折叠（例如 `S\u212AILL.md` 的 `toLowerCase()` 是 `skill.md`）
 * 会造出"键相同、文件名不同"的假匹配。
 *
 * @param {string} path 归一化后的路径。
 * @returns {string} 比较键。
 */
export function fileKey(path) {
  return process.platform === 'linux' ? path : path.toLowerCase()
}

/**
 * 解析八进制 / base-256 数值字段。
 * @param {Buffer} buffer 字段字节。
 * @returns {number} 数值。
 */
function readNumber(buffer) {
  if (buffer.length === 0) return 0
  // GNU base-256 编码：最高位为 1。
  if ((buffer[0] & 0x80) !== 0) {
    let value = buffer[0] & 0x7f
    for (let at = 1; at < buffer.length; at += 1) value = value * 256 + buffer[at]
    return value
  }
  const text = buffer.toString('utf8').replace(/\0.*$/, '').trim()
  if (text === '') return 0
  const value = Number.parseInt(text, 8)
  return Number.isFinite(value) ? value : 0
}

/**
 * 读一个以 NUL 结尾的字符串字段。
 * @param {Buffer} buffer 字段字节。
 * @returns {string} 文本。
 */
function readString(buffer) {
  const end = buffer.indexOf(0)
  return buffer.toString('utf8', 0, end === -1 ? buffer.length : end)
}

/**
 * 校验 tar 头的 checksum 字段（坏校验和说明归档本身不可信）。
 * @param {Buffer} header 512 字节头。
 * @returns {boolean} 合法返回 true。
 */
function hasValidChecksum(header) {
  const stored = readNumber(header.subarray(148, 156))
  if (stored === 0) return false
  let sum = 0
  for (let at = 0; at < BLOCK; at += 1) sum += at >= 148 && at < 156 ? 0x20 : header[at]
  return sum === stored
}

/**
 * 解出归档里的普通文件。
 *
 * 除了路径安全，这里还做两件事：
 *   - 校验 tar 头 checksum，坏头直接拒绝；
 *   - pax `x` 扩展头按**声明长度**解析（不按行猜），并拒绝重复路径条目——
 *     重复条目在"先校验、后写盘"的流程里是典型的绕过手法（后者覆盖前者）。
 *
 * @param {Buffer} buffer tar 或 tar.gz 内容。
 * @param {{maxBytes?: number, maxEntries?: number}} [limits] 上限。
 * @returns {{ok: true, files: Array<{path: string, data: Buffer}>, directories: string[]} | {ok: false, error: string}} 结果。
 */
export function extractTar(buffer, limits = {}) {
  const maxBytes = limits.maxBytes ?? 64 * 1024 * 1024
  const maxEntries = limits.maxEntries ?? 4096
  let raw = buffer
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    try {
      raw = gunzipSync(raw, { maxOutputLength: maxBytes })
    } catch (error) {
      const message = String(error?.message || error)
      // `maxOutputLength` 触发的是 Node 的通用 Buffer 上限错误，这里翻译成上限语义。
      if (/larger than/i.test(message)) return { ok: false, error: `归档解压后超过上限 ${maxBytes} 字节` }
      return { ok: false, error: `gzip 解压失败：${message}` }
    }
  }

  const files = []
  const seen = new Set()
  const directories = new Set()
  let offset = 0
  let pendingLongName = ''
  let pendingPaxPath = ''
  let total = 0
  let entries = 0

  while (offset + BLOCK <= raw.length) {
    const header = raw.subarray(offset, offset + BLOCK)
    if (header.every((byte) => byte === 0)) break
    if (!hasValidChecksum(header)) return { ok: false, error: '归档条目头校验和不合法' }
    const size = readNumber(header.subarray(124, 136))
    const typeflag = String.fromCharCode(header[156] || 0x30)
    const name = readString(header.subarray(0, 100))
    const prefix = readString(header.subarray(345, 500))
    const linkName = readString(header.subarray(157, 257))
    const dataStart = offset + BLOCK
    const dataEnd = dataStart + size
    if (dataEnd > raw.length) return { ok: false, error: '归档被截断' }

    if (typeflag === 'L') {
      pendingLongName = readString(raw.subarray(dataStart, dataEnd))
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK
      continue
    }
    if (typeflag === 'x' || typeflag === 'X') {
      // POSIX pax：记录形如 `<字节长度> <key>=<value>\n`，长度是**字节**数，
      // 所以必须在 Buffer 上按下标切，不能拿字符下标去切字符串（非 ASCII 会错位）。
      const body = raw.subarray(dataStart, dataEnd)
      let cursor = 0
      while (cursor < body.length) {
        const space = body.indexOf(0x20, cursor)
        if (space < 0) break
        const length = Number.parseInt(body.toString('utf8', cursor, space), 10)
        if (!Number.isFinite(length) || length <= 0 || cursor + length > body.length) break
        const record = body.toString('utf8', space + 1, cursor + length)
        const equals = record.indexOf('=')
        if (equals > 0) {
          const key = record.slice(0, equals).trim()
          const value = record.slice(equals + 1).replace(/\n$/, '')
          if (key === 'path') pendingPaxPath = value
        }
        cursor += length
      }
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK
      continue
    }
    if (typeflag === 'g') {
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK
      continue
    }
    if (typeflag === 'l' || typeflag === '1' || typeflag === '2') {
      return { ok: false, error: `归档里有链接条目（${linkName}），为安全起见拒绝安装` }
    }
    if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '5' && typeflag !== '7') {
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK
      continue
    }

    const rawPath = pendingPaxPath || pendingLongName || (prefix ? `${prefix}/${name}` : name)
    pendingPaxPath = ''
    pendingLongName = ''
    const safe = safeEntryPath(rawPath)
    if (!safe.ok) return { ok: false, error: safe.error }
    entries += 1
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK

    // `./` 这类归档根目录条目：忽略。
    if (safe.path === '') continue

    // 目录条目（BSD/GNU tar 都带尾斜杠）：归一化后记账，不当文件。
    if (typeflag === '5' || safe.directory) {
      directories.add(safe.path)
      continue
    }

    if (seen.has(fileKey(safe.path))) {
      return { ok: false, error: `归档里有重复路径：${safe.path}（拒绝安装，避免后者覆盖前者）` }
    }
    seen.add(fileKey(safe.path))
    total += size
    if (total > maxBytes) return { ok: false, error: `归档解压后超过上限 ${maxBytes} 字节` }
    if (files.length >= maxEntries) return { ok: false, error: `归档条目超过上限 ${maxEntries}` }
    files.push({ path: safe.path, data: Buffer.from(raw.subarray(dataStart, dataEnd)) })
  }

  if (entries === 0) return { ok: false, error: '归档里没有任何条目（不是合法的 tar.gz）' }
  return { ok: true, files, directories: [...directories] }
}

/**
 * 写 ustar 头。
 * @param {{path: string, size: number, typeflag?: string}} input 条目。
 * @returns {Buffer} 512 字节头。
 */
function writeHeader(input) {
  const header = Buffer.alloc(BLOCK)
  const name = Buffer.from(input.path, 'utf8')
  if (name.length > 100) throw new Error(`tar 路径过长（>100）：${input.path}`)
  name.copy(header, 0)
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
 * 打包成 `.tgz`。
 * @param {Array<{path: string, data: string | Buffer}>} files 文件列表。
 * @returns {Buffer} gzip 后的 tar。
 */
export function createTarGz(files) {
  const chunks = []
  for (const file of files) {
    const safe = safeEntryPath(file.path)
    if (!safe.ok) throw new Error(safe.error)
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data ?? ''), 'utf8')
    if (safe.directory) {
      chunks.push(writeHeader({ path: `${safe.path}/`, size: 0, typeflag: '5' }))
      continue
    }
    chunks.push(writeHeader({ path: safe.path, size: data.length }))
    chunks.push(data)
    const padding = (BLOCK - (data.length % BLOCK)) % BLOCK
    if (padding > 0) chunks.push(Buffer.alloc(padding))
  }
  chunks.push(Buffer.alloc(BLOCK * 2))
  return gzipSync(Buffer.concat(chunks))
}
