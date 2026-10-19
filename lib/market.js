/**
 * 技能市场客户端与安装器。
 *
 * DSH 本身没有"插件/技能服务器"：`dsh-plugin-manager` 只会用 pnpm 从 npm registry
 * 拉**插件包**，没有搜索、也没有"装到哪个位置"的概念（目标永远是当前 profile）。
 * 于是这里的技能市场是一条独立的、我们自己定的轻协议（见 README「市场协议」）：
 *
 *   GET  {base}/v1/skills?q=&limit=
 *        → { items: [{ name, description, version, whenToUse?, tags?, author? }] }
 *   GET  {base}/v1/skills/{name}/{version}
 *        → { name, version, description?, whenToUse?,
 *            files:  [{ path, sha256, size }],
 *            bundle: { format: 'tar.gz', url, sha256?, size? } }
 *
 * 安装的每一条都按下面的顺序把关，任一步失败都不会落地半个技能：
 *
 *   1. manifest 字段校验（name 必须 kebab-case、路径必须安全、bundle 必须是 tar.gz）；
 *   2. bundle 体积上限；
 *   3. bundle 摘要（若 manifest 声明）；
 *   4. 归档只接受普通文件/目录（`safeEntryPath` + 拒绝链接）；
 *   5. **逐个文件**核对 manifest 里的 sha256 与 size，多一个文件也拒绝；
 *   6. 包内 SKILL.md 必须存在，且 frontmatter 的 name 必须与 manifest 一致；
 *   7. 先在目标根里建临时目录写盘，校验通过后再原子改名进去；
 *      目标已存在时先移进回收站（可撤销），绝不静默覆盖。
 *
 * 装完写台账 `<dshHome>/skill-manager/market.json`；卸载只认台账里记过的路径，
 * 因此"市场装的"和"用户自己的"技能永远不会混淆。
 *
 * @module dsh-plugin-skill-manager/lib/market
 */

import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isSkillName, readSkillRecord } from './frontmatter.js'
import { isInside } from './roots.js'
import { extractTar, fileKey, safeEntryPath } from './targz.js'
import { readJson, trashSkill, writeJson } from './actions.js'
import { withFileLock } from './lock.js'

/** 默认请求超时。 */
const DEFAULT_TIMEOUT_MS = 20_000

/**
 * 计算缓冲区摘要。
 * @param {Buffer} buffer 数据。
 * @returns {string} `sha256:<hex>`。
 */
export function digestOf(buffer) {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`
}

/**
 * 市场台账路径。
 * @param {string} managerRoot 管理器数据目录。
 * @returns {string} 台账路径。
 */
export function marketLedgerPath(managerRoot) {
  return join(managerRoot, 'market.json')
}

/**
 * 写盘后按已校验的摘要复读一遍。
 *
 * 这是**兜底**：字符串层面的归一化与去重挡不住"键不同、文件相同"的文件系统别名
 * （NTFS ADS、8.3 短名、硬链接、大小写不敏感的卷……）。任何条目的落盘内容与
 * 校验内容不一致就判定安装失败，宁可不装。
 *
 * @param {string} directory 临时目录。
 * @param {Array<{path: string, data: Buffer}>} files 已校验的文件。
 * @returns {{ok: true} | {ok: false, error: string}} 结果。
 */
export function verifyWrittenFiles(directory, files) {
  for (const file of files) {
    const written = join(directory, ...file.path.split('/'))
    let actual
    try {
      actual = readFileSync(written)
    } catch (error) {
      return { ok: false, error: `写盘后复读失败（${file.path}）：${String(error?.message || error)}` }
    }
    if (actual.length !== file.data.length || digestOf(actual) !== digestOf(file.data)) {
      return { ok: false, error: `写盘后复读校验失败（${file.path}）：文件系统别名导致内容被覆盖，已放弃安装` }
    }
  }
  return { ok: true }
}

/**
 * 按 manifest 逐个复核已经落盘的技能目录（安装后复验）。
 *
 * 这是最后一道闸：临时目录写好之后，到改名完成之间，任何本地进程都可能改写文件
 * （技能根的文件监听、编辑器、并发脚本）。这里按最终位置再读一遍，不一致就判定失败。
 *
 * @param {string} target 技能目录。
 * @param {object} manifest 已校验的 manifest。
 * @returns {{ok: true} | {ok: false, error: string}} 结果。
 */
export function verifyInstalledAgainstManifest(target, manifest) {
  for (const entry of manifest.files) {
    const safe = safeEntryPath(entry.path)
    if (!safe.ok) return { ok: false, error: safe.error }
    const file = join(target, ...safe.path.split('/'))
    if (!isInside(target, file)) return { ok: false, error: `落盘路径越界：${safe.path}` }
    let data
    try {
      data = readFileSync(file)
    } catch (error) {
      return { ok: false, error: `安装后复验失败（${safe.path}）：${String(error?.message || error)}` }
    }
    if (data.length !== entry.size || digestOf(data) !== String(entry.sha256).toLowerCase()) {
      return { ok: false, error: `安装后复验失败（${safe.path}）：内容与 manifest 不符` }
    }
  }
  return { ok: true }
}

/**
 * 读台账。
 *
 * 台账损坏时**不静默丢弃历史**：先把它备份成 `market.json.corrupt-<时间>`，
 * 再以空台账继续，并把这件事报给调用方（界面会显示警告）。
 *
 * @param {string} managerRoot 管理器数据目录。
 * @returns {{entries: Array<object>, corrupt: boolean, backup?: string}} 台账内容与状态。
 */
export function readLedger(managerRoot) {
  const path = marketLedgerPath(managerRoot)
  if (!existsSync(path)) return { entries: [], corrupt: false }
  const raw = readJson(path, undefined)
  if (Array.isArray(raw)) return { entries: raw, corrupt: false }
  const backup = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
  try {
    copyFileSync(path, backup)
  } catch {
    /* 备份失败也要让安装继续，但调用方仍会看到 corrupt 标记 */
  }
  return { entries: [], corrupt: true, backup }
}

/**
 * 只取台账条目（兼容旧调用）。
 * @param {string} managerRoot 管理器数据目录。
 * @returns {Array<object>} 已安装条目。
 */
export function listInstalled(managerRoot) {
  return readLedger(managerRoot).entries
}

/**
 * 写台账。
 * @param {string} managerRoot 管理器数据目录。
 * @param {Array<object>} entries 条目。
 * @returns {void}
 */
function writeInstalled(managerRoot, entries) {
  writeJson(marketLedgerPath(managerRoot), entries)
}

/**
 * 建市场客户端。
 * @param {{baseUrl: string, token?: string, fetchImpl?: typeof fetch, timeoutMs?: number, maxBundleBytes?: number}} input 配置。
 * @returns {object} 客户端。
 */
export function createMarketClient(input) {
  const baseUrl = String(input.baseUrl ?? '').replace(/\/+$/, '')
  const token = String(input.token ?? '')
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  const timeoutMs = Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : DEFAULT_TIMEOUT_MS
  const maxBundleBytes = Number(input.maxBundleBytes) > 0 ? Number(input.maxBundleBytes) : 20 * 1024 * 1024

  /** 市场自身的 origin；包体默认只允许从这里下载（防 SSRF）。 */
  const marketOrigin = (() => {
    try {
      return baseUrl ? new URL(baseUrl).origin : ''
    } catch {
      return ''
    }
  })()
  /** 额外允许的包体 origin（显式配置才生效）。 */
  const allowedOrigins = new Set([
    ...(Array.isArray(input.allowedBundleOrigins) ? input.allowedBundleOrigins : []),
  ].map((value) => {
    try {
      return new URL(String(value)).origin
    } catch {
      return ''
    }
  }).filter(Boolean))

  /**
   * 解析包体地址：相对地址按市场拼；绝对地址必须是市场自身 origin 或显式允许的 origin。
   * 这是防 SSRF 的唯一关口——市场内容不可信，不能让它指挥 Host 去打任意主机。
   * @param {string} raw manifest 里的 bundle.url。
   * @returns {{ok: true, url: string} | {ok: false, error: string}} 结果。
   */
  const resolveBundleUrl = (raw) => {
    const value = String(raw ?? '').trim()
    if (value === '') return { ok: false, error: 'bundle.url 为空' }
    if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) {
      if (!baseUrl) return { ok: false, error: '未配置市场地址，无法解析相对包体地址' }
      return { ok: true, url: `${baseUrl}/${value.replace(/^\/+/, '')}` }
    }
    let parsed
    try {
      parsed = new URL(value)
    } catch {
      return { ok: false, error: `bundle.url 不是合法 URL：${value}` }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: `不支持的包体协议：${parsed.protocol}` }
    }
    if (parsed.origin !== marketOrigin && !allowedOrigins.has(parsed.origin)) {
      return {
        ok: false,
        error: `包体地址指向市场之外的主机（${parsed.origin}）；如确需，请把它加进 marketAllowedOrigins`,
      }
    }
    return { ok: true, url: parsed.href }
  }

  /**
   * 请求一个 URL，并在**每一跳**上校验 origin。
   *
   * 关键：用 `redirect: 'manual'` 自己跟跳转，而不是让 fetch 自动跟完再事后检查落地地址——
   * 后者会让未授权主机**先收到请求**（响应体虽然不回传给调用方，但已经构成盲 SSRF）。
   *
   * @param {string} url 起始地址。
   * @param {AbortSignal} signal 取消信号。
   * @param {Record<string, string> | undefined} headers 请求头。
   * @returns {Promise<object>} `{ok, response?, url?, status?}` 或 `{ok:false, error}`。
   */
  const fetchWithHopCheck = async (url, signal) => {
    // Authorization 只在**市场自身 origin** 上发送：允许列表里的第三方 origin
    // 拿到包体就够了，不该顺带拿到我们的 token。
    const headersFor = (target) => {
      if (!token) return undefined
      try {
        return new URL(target).origin === marketOrigin ? { authorization: `Bearer ${token}` } : undefined
      } catch {
        return undefined
      }
    }
    let current = url
    for (let hop = 0; hop <= 5; hop += 1) {
      const response = await fetchImpl(current, { signal, headers: headersFor(current), redirect: 'manual' })
      const status = Number(response?.status ?? 200)
      if (status >= 300 && status < 400) {
        const location = response?.headers?.get?.('location')
        if (typeof location !== 'string' || location === '') {
          return { ok: false, error: `重定向缺少 Location（HTTP ${status}）` }
        }
        let next
        try {
          next = new URL(location, current)
        } catch {
          return { ok: false, error: `重定向地址非法：${location}` }
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          return { ok: false, error: `重定向到不支持的协议：${next.protocol}` }
        }
        if (next.origin !== marketOrigin && !allowedOrigins.has(next.origin)) {
          return { ok: false, error: `重定向到未授权主机（${next.origin}），已中止` }
        }
        current = next.href
        continue
      }
      return { ok: true, response, url: current, status }
    }
    return { ok: false, error: '重定向次数过多，已中止' }
  }

  /**
   * 带超时的请求。
   * @param {string} url 地址。
   * @param {'json' | 'buffer'} mode 期望的响应形态。
   * @returns {Promise<object>} `{ok, ...}` 结果。
   */
  const request = async (url, mode) => {
    if (typeof fetchImpl !== 'function') return { ok: false, error: '当前运行时没有 fetch' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const hopped = await fetchWithHopCheck(url, controller.signal)
      if (!hopped.ok) return hopped
      const { response, status } = hopped
      if (status < 200 || status >= 300) return { ok: false, error: `HTTP ${status} ${response.statusText || ''}`.trim() }
      if (mode === 'buffer') {
        const length = Number(response.headers?.get?.('content-length') ?? 0)
        if (length > maxBundleBytes) return { ok: false, error: `技能包过大：${length} 字节` }
        const array = Buffer.from(await response.arrayBuffer())
        if (array.length > maxBundleBytes) return { ok: false, error: `技能包过大：${array.length} 字节` }
        return { ok: true, buffer: array }
      }
      return { ok: true, value: await response.json() }
    } catch (error) {
      const message = error?.name === 'AbortError' ? `请求超时（${timeoutMs}ms）` : String(error?.message || error)
      return { ok: false, error: message }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 同名安装的串行化闸门：键 → 队尾 promise。 */
  const installChains = new Map()

  /**
   * 让同一个目标名的安装排队执行（不同名互不影响）。
   * @param {string} key 锁键。
   * @param {() => Promise<object>} task 任务。
   * @returns {Promise<object>} 任务结果。
   */
  const withInstallLock = (key, task) => {
    const previous = installChains.get(key) ?? Promise.resolve()
    const run = previous.then(() => task(), () => task())
    const tail = run.then(() => {}, () => {})
    installChains.set(key, tail)
    void tail.then(() => {
      if (installChains.get(key) === tail) installChains.delete(key)
    })
    return run
  }

  /**
   * 取 manifest（`install` 内部用，避免依赖 `this`）。
   * @param {{name: string, version?: string}} input 查询。
   * @returns {Promise<object>} `{ok, manifest}`。
   */
  const requestManifest = async (input) => {
    if (!baseUrl) return { ok: false, error: '未配置市场地址（marketUrl）' }
    if (!isSkillName(input.name)) return { ok: false, error: `非法技能名：${input.name}` }
    const version = String(input.version ?? '').trim() || 'latest'
    const result = await request(`${baseUrl}/v1/skills/${encodeURIComponent(input.name)}/${encodeURIComponent(version)}`, 'json')
    if (!result.ok) return result
    return { ok: true, manifest: result.value }
  }

  /**
   * 暂存目录：优先用技能根的**父目录**（同一卷，可原子改名；且在技能的监听范围之外）。
   * 父目录不存在或不是目录时退回技能根内部。
   * @param {object} root 技能根。
   * @returns {string} 暂存基目录。
   */
  const stagingDirectory = (root) => {
    const parent = dirname(root.path)
    try {
      if (parent && parent !== root.path && existsSync(parent) && statSync(parent).isDirectory()) return parent
    } catch {
      /* 退回根内 */
    }
    return root.path
  }

  /**
   * 搬进最终位置（跨卷时退化成复制 + 删除）。
   * @param {string} from 源。
   * @param {string} to 目标。
   * @returns {void}
   */
  const moveIntoPlace = (from, to) => {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error
    }
    cpSync(from, to, { recursive: true })
    rmSync(from, { recursive: true, force: true })
  }

  /**
   * 目标是否是一个"真实落在技能根内"的目录（挡掉指向根外的 junction / 符号链接）。
   * @param {string} rootPath 技能根。
   * @param {string} target 目标目录。
   * @returns {boolean} 是则 true。
   */
  const realDirectoryInside = (rootPath, target) => {
    try {
      const realRoot = realpathSync(rootPath)
      const realTarget = realpathSync(target)
      return isInside(realRoot, realTarget) && statSync(realTarget).isDirectory()
    } catch {
      return false
    }
  }

  /**
   * 按 manifest 逐个复核已经落盘的技能目录（实现见模块级 `verifyInstalledAgainstManifest`）。
   * @param {string} target 技能目录。
   * @param {object} manifest 已校验的 manifest。
   * @returns {{ok: true} | {ok: false, error: string}} 结果。
   */
  const verifyInstalledFiles = (target, manifest) => verifyInstalledAgainstManifest(target, manifest)

  /**
   * 在跨进程文件锁保护下改台账，并且**写完复读核对**。
   *
   * 为什么要复读：多进程并发安装时，写盘本身可能因为文件被外部占用（杀软/索引器）
   * 或锁被抢占而"看起来成功、实际被覆盖"，表现为台账少一条——技能在磁盘上但管理器不认。
   * 所以每次写完都把台账读回来比一遍，不一致就重来；重试用尽才降级成 `ledgerWarning`。
   *
   * 写台账失败**不能**把一次已经成功的安装判成失败（技能确实在磁盘上了），
   * 所以这里把异常转成 `ledgerWarning` 如实回报。
   *
   * @param {string} managerRoot 管理器数据目录。
   * @param {(entries: Array<object>) => Array<object>} mutate 台账变换。
   * @returns {Promise<object>} 附加字段（`ledgerBackup` 或 `ledgerWarning`）。
   */
  const updateLedger = async (managerRoot, mutate) => {
    // 整个"加锁-读-改-写-复读"最多试 3 轮：并发安装 + 杀软/索引器占用时，
    // 单轮可能因为写盘 EPERM 之类直接降级成 ledgerWarning（台账少一条）。
    // mutate 是幂等的（都是 filter + push），重跑安全。
    let last = { ledgerWarning: '台账写入失败' }
    for (let round = 0; round < 3; round += 1) {
      last = await updateLedgerOnce(managerRoot, mutate)
      if (!last.ledgerWarning) return last
      await new Promise((resolve) => setTimeout(resolve, 60 * (round + 1)))
    }
    return last
  }

  /**
   * 单轮改台账（加锁 + 复读核对）。
   * @param {string} managerRoot 管理器数据目录。
   * @param {(entries: Array<object>) => Array<object>} mutate 台账变换。
   * @returns {Promise<object>} 附加字段。
   */
  const updateLedgerOnce = async (managerRoot, mutate) => {
    const lockPath = `${marketLedgerPath(managerRoot)}.lock`
    try {
      return await withFileLock(lockPath, async () => {
        let backup
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const ledger = readLedger(managerRoot)
          if (ledger.corrupt && ledger.backup) backup = ledger.backup
          const expected = mutate(ledger.entries)
          writeInstalled(managerRoot, expected)
          // 复读核对：名字集合一致才算写成功（条目字段由各自安装流程保证）。
          const actual = readLedger(managerRoot).entries
          const namesOf = (list) => list.map((entry) => `${entry.name}@${entry.version}`).sort().join(',')
          if (namesOf(actual) === namesOf(expected)) {
            return backup === undefined ? {} : { ledgerBackup: backup }
          }
          await new Promise((resolve) => setTimeout(resolve, 20 + attempt * 40))
        }
        return { ledgerWarning: '台账写入后复读不一致：可能被其他进程覆盖，请刷新后重试' }
      })
    } catch (error) {
      return { ledgerWarning: `台账写入失败：${String(error?.message || error)}` }
    }
  }

  /**
   * 安装的实际流程（调用方已做参数与只读根校验，并已排队）。
   * @param {{name: string, version?: string, root: object, managerRoot: string, now?: number}} input 输入。
   * @returns {Promise<object>} `{ok, entry}`。
   */
  const installLocked = async (input) => {
    const root = input.root
    const fetched = await requestManifest({ name: input.name, version: input.version })
    if (!fetched.ok) return fetched
    const checked = validateManifest(fetched.manifest)
    if (!checked.ok) return checked
    const { manifest } = checked

    const bundleTarget = resolveBundleUrl(manifest.bundle.url)
    if (!bundleTarget.ok) return bundleTarget
    const downloaded = await request(bundleTarget.url, 'buffer')
    if (!downloaded.ok) return downloaded
    if (manifest.bundle.sha256 && digestOf(downloaded.buffer) !== String(manifest.bundle.sha256).toLowerCase()) {
      return { ok: false, error: '技能包摘要与 manifest 不符，已拒绝安装' }
    }
    if (Number.isFinite(manifest.bundle.size) && manifest.bundle.size !== downloaded.buffer.length) {
      return { ok: false, error: `技能包大小与 manifest 不符（期望 ${manifest.bundle.size}，实际 ${downloaded.buffer.length}）` }
    }
    const extracted = extractTar(downloaded.buffer, { maxBytes: maxBundleBytes, maxEntries: 4096 })
    if (!extracted.ok) return extracted
    const verified = verifyFiles(manifest, extracted.files)
    if (!verified.ok) return verified
    // 落盘用的就是校验通过的那份映射，杜绝"校验 A、写入 B"。
    const payload = verified.files

    const skillFiles = payload.filter((file) => fileKey(file.path) === 'skill.md')
    if (skillFiles.length !== 1) return { ok: false, error: '技能包里必须且只能有一份 SKILL.md' }
    const record = readSkillRecord({ text: skillFiles[0].data.toString('utf8') })
    if (record.name !== manifest.name) {
      return { ok: false, error: `包内 SKILL.md 的 name（${record.name ?? '缺失'}）与市场条目（${manifest.name}）不一致` }
    }
    if (record.valid === false) return { ok: false, error: `包内 SKILL.md 不合法：${record.issues.join('；')}` }

    const target = join(root.path, manifest.name)
    if (!isInside(root.path, target)) return { ok: false, error: '安装目标越界' }

    let temp
    try {
      mkdirSync(root.path, { recursive: true })
      // 临时目录**放在技能根之外**（根的父目录，同一卷因此可原子改名）：
      // 放在根内会让技能根的文件监听、以及任何盯着根目录的进程看到"半成品"。
      const stagingBase = stagingDirectory(root)
      temp = mkdtempSync(join(stagingBase, '.skill-manager-tmp-'))
      for (const file of payload) {
        const destination = join(temp, ...file.path.split('/'))
        if (!isInside(temp, destination)) return { ok: false, error: `归档路径越界：${file.path}` }
        mkdirSync(dirname(destination), { recursive: true })
        writeFileSync(destination, file.data)
      }
      // **兜底一**：写盘后按已校验的摘要复读一遍（见 verifyWrittenFiles 的注释）。
      const written = verifyWrittenFiles(temp, payload)
      if (!written.ok) {
        rmSync(temp, { recursive: true, force: true })
        return { ok: false, error: written.error }
      }
      if (existsSync(target)) {
        // 幂等：同版本同摘要**且磁盘内容逐文件复核通过**才直接返回。
        // 只比对标记文件是不行的——标记没有认证，谁都能改。
        const marker = join(target, '.skill-manager.json')
        const digest = manifest.bundle.sha256 ?? digestOf(downloaded.buffer)
        if (existsSync(marker) && realDirectoryInside(root.path, target)) {
          try {
            const installed = JSON.parse(readFileSync(marker, 'utf8'))
            if (installed?.version === manifest.version
              && installed?.digest === digest
              && verifyInstalledFiles(target, manifest).ok) {
              rmSync(temp, { recursive: true, force: true })
              return { ok: true, unchanged: true, entry: {
                name: manifest.name,
                version: manifest.version,
                description: manifest.description ?? '',
                rootId: root.id,
                path: join(target, 'SKILL.md'),
                source: bundleTarget.url,
                digest,
                installedAt: installed.installedAt ?? new Date(input.now ?? Date.now()).toISOString(),
              } }
            }
          } catch {
            /* 标记文件坏了：按普通覆盖处理 */
          }
        }
        if (!realDirectoryInside(root.path, target)) {
          rmSync(temp, { recursive: true, force: true })
          return { ok: false, error: '目标已存在但不是技能根内的真实目录（可能是链接），拒绝覆盖' }
        }
        const backup = trashSkill({
          root,
          skill: { name: manifest.name, dirName: manifest.name, kind: 'bundle', path: join(target, 'SKILL.md'), rootId: root.id },
          managerRoot: input.managerRoot,
          now: input.now,
        })
        if (!backup.ok) {
          rmSync(temp, { recursive: true, force: true })
          return { ok: false, error: `覆盖前备份失败：${backup.error}` }
        }
      }
      writeFileSync(join(temp, '.skill-manager.json'), `${JSON.stringify({
        name: manifest.name,
        version: manifest.version,
        installedAt: new Date(input.now ?? Date.now()).toISOString(),
        url: bundleTarget.url,
        digest: manifest.bundle.sha256 ?? digestOf(downloaded.buffer),
      }, null, 2)}\n`, 'utf8')
      moveIntoPlace(temp, target)
      temp = undefined
      // **兜底二**：改名之后再按最终位置复验一次。中间任何一刻被改写都会在这里被抓到。
      const settled = verifyInstalledFiles(target, manifest)
      if (!settled.ok) {
        rmSync(target, { recursive: true, force: true })
        return { ok: false, error: `${settled.error}（已放弃这次安装；被覆盖的旧版本仍可在回收站还原）` }
      }
    } catch (error) {
      if (temp) rmSync(temp, { recursive: true, force: true })
      return { ok: false, error: `写入失败：${String(error?.message || error)}` }
    }

    const entry = {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description ?? '',
      rootId: root.id,
      path: join(target, 'SKILL.md'),
      source: bundleTarget.url,
      digest: manifest.bundle.sha256 ?? digestOf(downloaded.buffer),
      installedAt: new Date(input.now ?? Date.now()).toISOString(),
    }
    const ledgerExtra = await updateLedger(input.managerRoot, (entries) => {
      const next = entries.filter((item) => item.name !== entry.name)
      next.push(entry)
      return next
    })
    return { ok: true, entry, ...ledgerExtra }
  }

  return {
    baseUrl,
    configured: baseUrl !== '',
    /**
     * 搜索技能。
     * @param {{q?: string, limit?: number}} [query] 查询。
     * @returns {Promise<object>} `{ok, items}`。
     */
    async search(query = {}) {
      if (!baseUrl) return { ok: false, error: '未配置市场地址（marketUrl）' }
      const params = new URLSearchParams()
      if (query.q) params.set('q', String(query.q))
      params.set('limit', String(Math.min(200, Math.max(1, Number(query.limit) || 50))))
      const result = await request(`${baseUrl}/v1/skills?${params.toString()}`, 'json')
      if (!result.ok) return result
      const items = Array.isArray(result.value?.items) ? result.value.items : []
      return { ok: true, items }
    },
    /**
     * 取某个版本的 manifest。
     * @param {{name: string, version: string}} input 查询。
     * @returns {Promise<object>} `{ok, manifest}`。
     */
    async manifest(input) {
      if (!baseUrl) return { ok: false, error: '未配置市场地址（marketUrl）' }
      if (!isSkillName(input.name)) return { ok: false, error: `非法技能名：${input.name}` }
      const version = String(input.version ?? '').trim() || 'latest'
      const result = await request(`${baseUrl}/v1/skills/${encodeURIComponent(input.name)}/${encodeURIComponent(version)}`, 'json')
      if (!result.ok) return result
      return { ok: true, manifest: result.value }
    },
    /**
     * 安装一个技能到指定根。
     * @param {{name: string, version?: string, root: object, managerRoot: string, now?: number}} input 输入。
     * @returns {Promise<object>} `{ok, entry}`。
     */
    async install(input) {
      const root = input.root
      if (!root?.path) return { ok: false, error: '目标技能根无效' }
      if (root.writable === false) return { ok: false, error: `技能根 ${root.label ?? root.id ?? ''} 不可写` }
      // 同一目标名的安装串行化：否则并发安装会互相把对方刚写好的目录挪进回收站。
      const key = `${root.id ?? root.path}::${String(input.name ?? '')}`
      return withInstallLock(key, () => installLocked({ ...input, root }))
    },
    /**
     * 卸载一个由市场安装的技能（移进回收站，可撤销）。
     * @param {{name: string, roots: Array<object>, managerRoot: string, now?: number}} input 输入。
     * @returns {Promise<object>} `{ok}`。
     */
    async uninstall(input) {
      const entries = readLedger(input.managerRoot).entries
      const entry = entries.find((item) => item.name === input.name)
      if (!entry) return { ok: false, error: `${input.name} 不是市场安装的技能，管理器不会替你删` }
      const root = (input.roots ?? []).find((item) => item.id === entry.rootId)
      if (!root) return { ok: false, error: `技能根 ${entry.rootId} 已不在配置里` }
      if (!existsSync(entry.path)) {
        const extra = await updateLedger(input.managerRoot, (list) => list.filter((item) => item.name !== input.name))
        return { ok: true, missing: true, ...extra }
      }
      const removed = trashSkill({
        root,
        skill: { name: entry.name, dirName: entry.name, kind: 'bundle', path: entry.path, rootId: root.id },
        managerRoot: input.managerRoot,
        now: input.now,
      })
      if (!removed.ok) return removed
      const extra = await updateLedger(input.managerRoot, (list) => list.filter((item) => item.name !== input.name))
      return { ok: true, trashId: removed.id, ...extra }
    },
  }
}

/**
 * 校验 manifest。
 * @param {unknown} value 原始 manifest。
 * @returns {{ok: true, manifest: object} | {ok: false, error: string}} 结果。
 */
export function validateManifest(value) {
  if (!value || typeof value !== 'object') return { ok: false, error: 'manifest 不是对象' }
  const manifest = value
  if (!isSkillName(manifest.name)) return { ok: false, error: `manifest.name 非法：${manifest.name}` }
  if (typeof manifest.version !== 'string' || manifest.version.trim() === '') {
    return { ok: false, error: 'manifest.version 缺失' }
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    return { ok: false, error: 'manifest.files 必须是非空数组' }
  }
  const seen = new Set()
  for (const file of manifest.files) {
    const safe = safeEntryPath(file?.path)
    if (!safe.ok) return { ok: false, error: `manifest 里的路径不安全：${safe.error}` }
    if (safe.directory || safe.path === '') return { ok: false, error: `manifest 里的路径不是文件：${file?.path}` }
    // 用"文件键"（大小写不敏感）判重：仅大小写不同的两条路径在 Windows 上是同一个文件。
    if (seen.has(fileKey(safe.path))) {
      return { ok: false, error: `manifest 里重复声明了路径：${safe.path}` }
    }
    seen.add(fileKey(safe.path))
    if (typeof file.sha256 !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(file.sha256)) {
      return { ok: false, error: `manifest 里 ${file.path} 缺少合法 sha256` }
    }
    if (!Number.isInteger(file.size) || file.size < 0) {
      return { ok: false, error: `manifest 里 ${file.path} 的 size 必须是非负整数` }
    }
  }
  // 必须并且只能声明一份技能定义；否则"包内 SKILL.md 的 name 校验"就会落在别处。
  const skillFiles = [...seen].filter((path) => path === 'skill.md')
  if (skillFiles.length !== 1) {
    return { ok: false, error: `manifest 必须且只能声明一个 SKILL.md（当前 ${skillFiles.length} 个）` }
  }
  const bundle = manifest.bundle
  if (!bundle || typeof bundle !== 'object') return { ok: false, error: 'manifest.bundle 缺失' }
  if (String(bundle.format ?? '') !== 'tar.gz') return { ok: false, error: `不支持的包格式：${bundle.format}` }
  if (typeof bundle.url !== 'string' || bundle.url.trim() === '') return { ok: false, error: 'manifest.bundle.url 缺失' }
  if (bundle.sha256 !== undefined && !/^sha256:[0-9a-f]{64}$/i.test(String(bundle.sha256))) {
    return { ok: false, error: 'manifest.bundle.sha256 格式不合法' }
  }
  if (bundle.size !== undefined && (!Number.isInteger(bundle.size) || bundle.size < 0)) {
    return { ok: false, error: 'manifest.bundle.size 不是非负整数' }
  }
  return { ok: true, manifest }
}

/**
 * 逐个文件核对摘要与大小，并返回**校验通过的那份文件映射**。
 *
 * 关键点：声明路径必须与归档路径**一一对应**——缺一个、多一个、重复一个都拒绝。
 * 调用方必须用返回的 `files` 落盘，不能再用原始解包结果，否则会出现
 * "校验良性条目、写恶意条目"（重复路径 last-write-wins）的绕过。
 *
 * @param {object} manifest 已校验的 manifest。
 * @param {Array<{path: string, data: Buffer}>} files 归档解出的文件。
 * @returns {{ok: true, files: Array<{path: string, data: Buffer}>} | {ok: false, error: string}} 结果。
 */
export function verifyFiles(manifest, files) {
  const byPath = new Map()
  for (const file of files) {
    const key = fileKey(file.path)
    if (byPath.has(key)) return { ok: false, error: `技能包里有重复路径：${file.path}` }
    byPath.set(key, file)
  }

  const verified = []
  for (const entry of manifest.files) {
    const safe = safeEntryPath(entry.path)
    if (!safe.ok) return { ok: false, error: safe.error }
    // 先用**逐字节相等**匹配：`S\u212AILL.md` 的 `toLowerCase()` 是 `skill.md`，
    // 但它是另一个文件——按折叠键匹配会让"声明 SKILL.md、落盘 SᴀILL.md"成功。
    const found = files.find((file) => file.path === safe.path)
    if (!found) {
      const folded = byPath.get(fileKey(safe.path))
      if (folded) {
        return { ok: false, error: `归档路径与 manifest 声明不一致：声明 ${safe.path}，归档里是 ${folded.path}` }
      }
      return { ok: false, error: `技能包里缺少 ${safe.path}` }
    }
    if (found.data.length !== entry.size) {
      return { ok: false, error: `${safe.path} 大小不符（期望 ${entry.size}，实际 ${found.data.length}）` }
    }
    if (digestOf(found.data) !== String(entry.sha256).toLowerCase()) {
      return { ok: false, error: `${safe.path} 摘要不符` }
    }
    // 落盘路径一律用**声明路径**（不是归档里的原始拼写）。
    verified.push({ path: safe.path, data: found.data })
  }
  if (verified.length !== files.length) {
    const declared = new Set(verified.map((file) => file.path))
    const extra = files.filter((file) => !declared.has(file.path)).map((file) => file.path)
    return { ok: false, error: `技能包里有 manifest 未声明的文件：${extra.join(', ')}` }
  }
  return { ok: true, files: verified }
}
