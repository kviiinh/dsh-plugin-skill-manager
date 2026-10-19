/**
 * DSH 技能管理器（Host 半边）。
 *
 * 三件事：
 *
 *   1. **目录视图**：按 `@deepseek-ai/dsh-skill-filesystem` 的六个扫描根
 *      （rank 100→600）扫描本地技能，连同「DSH 会不会真的用它」一起呈现；
 *      DSH 对无效技能是静默丢弃的，模型侧看不到任何诊断，这里把它摆出来。
 *   2. **管理动作**：改 DSH 原生的 `disable-model-invocation` / `user-invocable`
 *      开关、重命名、复制到别的根、软删除到回收站（可撤销）、新建骨架。
 *   3. **技能市场**：连一个我们自定的轻协议服务，搜索 → 校验（manifest /
 *      摘要 / 归档安全）→ 安装到**用户选定的技能根**；卸载只动台账里记过的技能。
 *
 * 另外提供一个 `/skill/<技能名>` 手势（见 `lib/gesture.js`）：内置手势只认
 * `/name`，第二个斜杠会失配，所以这里自己挂一条 `agent/pre-step`。
 *
 * 浏览器半边只通过本文件注册的 HTTP 路由通信——第三方插件**不能**新增 typert
 * Remote（客户端命名空间由内置程序集预挂载，且需要 codegen），而 `webServer`
 * 路由 + 同源 fetch 是这套客户端里第三方插件的既定通道（钉钉那两个插件同样如此）。
 *
 * @module dsh-plugin-skill-manager
 */

import { mkdirSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import {
  createSkill,
  copySkill,
  listTrash,
  moveSkill,
  purgeTrash,
  renameSkill,
  restoreTrash,
  setCategories,
  setInvocation,
  trashSkill,
} from './lib/actions.js'
import { createSkillPathGesture, createUserMessageMirror, loadUpstreamRuntime, renderSkillContent } from './lib/gesture.js'
import { createMarketClient, digestOf, readLedger, verifyInstalledAgainstManifest, verifyWrittenFiles } from './lib/market.js'
import { isInside, reconcile, resolveHomes, resolveRoots, scanRoots } from './lib/roots.js'
import { readJson, moveWithRetry, removeWithRetry, replaceSkillDirectory, writeJson } from './lib/actions.js'
import { isSkillName, readSkillRecord } from './lib/frontmatter.js'
import { safeEntryPath } from './lib/targz.js'

/** Cordis 函数插件名。 */
export const name = 'skill-manager'

/**
 * 硬依赖：`webServer` 用于注册 HTTP 路由，`connection` 用于同源围栏。
 *
 * 与钉钉插件同样的经验：把**不存在**的服务写进 inject 会让插件彻底不加载，
 * 而 Cordis 的 Context 是 Proxy——读一个没 inject 过的服务属性会直接抛错，
 * 所以其它服务（`skills` / `agents`）一律走 `ctx.get()` 运行时探测。
 */
export const inject = ['webServer', 'connection']

/** 路由前缀。 */
const ROUTE_PREFIX = '/skill-manager'

/**
 * 宿主半边的构建标记，必须与 `client.js` 里的 `CLIENT_BUILD` 保持一致。
 *
 * 为什么要这个东西：客户端 bundle 会被重新扫描，**宿主半边不会热更新**，于是很容易
 * 出现"新界面 + 旧路由"——表现是某个动作报出莫名其妙的错（旧代码路径产生的错误）。
 * 两边标记不一致时界面会直接提示"请完整重启 DSH Desktop"，不用再靠猜。
 */
const HOST_BUILD = 'build-2026-10-16-17'

/**
 * 插件配置。
 *
 * `@deepseek-ai/schemastery` 走**静态**导入：它是 package.json 里声明的依赖，
 * 由 pnpm 装在插件自己的 `node_modules` 下（`link:` 安装的插件不会自动装依赖，
 * 所以本仓库里已随 `pnpm install` 落盘一份）。刻意不用顶层 await 动态导入——
 * 不是所有插件加载器都支持 TLA，一旦不支持就是"整个插件静默不加载"。
 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  marketUrl: z.string().default(''),
  marketToken: z.string().default(''),
  roots: z.array(z.object({
    id: z.string().default(''),
    path: z.string(),
    rank: z.number().default(300),
    writable: z.boolean().default(true),
  })).default([]),
  dshHome: z.string().default(''),
  agentsHome: z.string().default(''),
  includeDefaultRoots: z.boolean().default(true),
  requestTimeoutMs: z.number().default(20_000),
  maxBundleBytes: z.number().default(20 * 1024 * 1024),
  // 包体默认只允许从 marketUrl 自己的 origin 下载（防 SSRF）；跨源分发才需要显式列出来。
  marketAllowedOrigins: z.array(z.string()).default([]),
})

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx Host 上下文。
 * @param {object} config 解析后的配置。
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false
  const log = (message) => ctx.logger?.info?.(`skill-manager: ${message}`)
  const warn = (message) => ctx.logger?.warn?.(`skill-manager: ${message}`)

  /**
   * 读服务：**没 inject 过的**只能走 `ctx.get()`。
   * @param {string} key 服务名。
   * @returns {any} 服务实例或 undefined。
   */
  const getService = (key) => {
    try {
      return ctx.get?.(key)
    } catch {
      return undefined
    }
  }
  const webServer = getService('webServer')
  const connection = getService('connection')
  const skills = getService('skills')
  const agents = getService('agents')

  const homes = resolveHomes({ dshHome: config.dshHome, agentsHome: config.agentsHome })
  const managerRoot = join(homes.dshHome, 'skill-manager')
  const market = createMarketClient({
    baseUrl: config.marketUrl,
    token: config.marketToken,
    timeoutMs: config.requestTimeoutMs,
    maxBundleBytes: config.maxBundleBytes,
    allowedBundleOrigins: config.marketAllowedOrigins,
  })

  /**
   * 计算某个工作目录下的技能根。
   * @param {string} cwd 工作目录。
   * @returns {Array<object>} 根列表。
   */
  const rootsFor = (cwd) => resolveRoots({
    cwd: cwd || process.cwd(),
    dshHome: homes.dshHome,
    agentsHome: homes.agentsHome,
    customRoots: Array.isArray(config.roots) ? config.roots : [],
    includeDefaultRoots: config.includeDefaultRoots !== false,
    bundledDirs: [],
  })

  /**
   * 在某个根里定位一个技能（按 frontmatter 名或目录名匹配，无效技能也能定位）。
   * @param {Array<object>} roots 根列表。
   * @param {{rootId: string, name: string}} query 查询。
   * @returns {{root: object, skill: object} | {error: string}} 结果。
   */
  const locate = (roots, query) => {
    const root = roots.find((item) => item.id === query.rootId)
    if (!root) return { error: `技能根不存在：${query.rootId}` }
    const scanned = scanRoots([root]).skills
    const skill = scanned.find((item) => item.name === query.name || item.dirName === query.name)
    if (!skill) return { error: `在 ${root.label} 里找不到技能 ${query.name}` }
    return { root, skill }
  }

  /* ─────────────────────── 技能注册表（落盘） ─────────────────────── */

  /** 注册表文件：扫描结果的缓存，`/` 菜单、下拉框、卡片网格都读它。 */
  const registryPath = join(managerRoot, 'registry.json')
  /** 没有文件事件时的兜底重建间隔（毫秒）；「刷新」按钮与文件监听都能立刻让它变脏。 */
  const REGISTRY_TTL_MS = 60_000
  /** 曾被文件监听判定为"变过"的最小间隔，避免同一批事件反复重扫。 */
  const REGISTRY_MIN_REBUILD_MS = 1_000
  let registryDirty = true
  let lastRegistryBuildAt = 0
  const watchedRoots = new Set()
  const watchers = []

  /**
   * 扫一遍技能根并组装注册表。
   * @param {{cwd?: string, agentId?: string}} query 查询。
   * @returns {Promise<object>} 注册表。
   */
  async function buildRegistry(query) {
    const cwd = query.cwd ? resolve(query.cwd) : process.cwd()
    const roots = rootsFor(cwd)
    const scanned = scanRoots(roots)

    // 注册表快照能给出"谁真的生效"，但它按会话/预设作用域分层：
    // 拿得到 agent 就用 agent 当 scope，拿不到就标记为 unknown，绝不假装知道。
    let snapshot
    let scopeState = 'unknown'
    const agent = query.agentId && typeof agents?.get === 'function' ? agents.get(query.agentId) : undefined
    if (agent && typeof skills?.snapshot === 'function') {
      try {
        snapshot = await skills.snapshot({ cwd, scope: agent })
        scopeState = 'agent'
      } catch (error) {
        warn(`读取技能注册表失败：${String(error?.message || error)}`)
      }
    }
    const reconciled = reconcile({
      skills: scanned.skills,
      snapshot,
      registryKnown: scopeState === 'agent',
    })
    lastRegistryBuildAt = Date.now()
    registryDirty = false
    observeRoots(roots)
    return {
      revision: lastRegistryBuildAt,
      generatedAt: new Date().toISOString(),
      cwd,
      homes,
      scopeState,
      skillsService: typeof skills?.snapshot === 'function',
      roots: scanned.roots,
      skills: reconciled.skills,
      providerOnly: reconciled.providerOnly,
      warnings: [...scanned.warnings, ...reconciled.warnings],
    }
  }

  /**
   * 取注册表：优先用落盘缓存，缓存过期或文件变过才重扫并写回。
   * @param {{cwd?: string, agentId?: string, refresh?: boolean}} query 查询。
   * @returns {Promise<object>} 注册表。
   */
  async function loadRegistry(query) {
    const cwd = query.cwd ? resolve(query.cwd) : process.cwd()
    const cached = readJson(registryPath, undefined)
    const usable = query.refresh !== true
      && cached && typeof cached === 'object'
      && Array.isArray(cached.skills)
      && cached.cwd === cwd
      && Date.now() - Number(cached.revision ?? 0) < REGISTRY_TTL_MS
      && !(registryDirty && Date.now() - lastRegistryBuildAt > REGISTRY_MIN_REBUILD_MS)
    if (usable) return cached
    const built = await buildRegistry({ ...query, cwd })
    try {
      writeJson(registryPath, built)
    } catch (error) {
      warn(`注册表写盘失败：${String(error?.message || error)}`)
    }
    return built
  }

  /**
   * 给技能根装文件监听：技能文件夹被直接拖进来时，下一步就能看到。
   * @param {Array<object>} roots 根列表。
   * @returns {void}
   */
  function observeRoots(roots) {
    for (const root of roots) {
      if (!root.writable || watchedRoots.has(root.path)) continue
      watchedRoots.add(root.path)
      try {
        if (!existsSync(root.path)) continue
        const handle = watch(root.path, { persistent: false }, () => {
          registryDirty = true
        })
        handle.on('error', () => {})
        watchers.push(handle)
      } catch {
        /* 监不起来就算了，靠 TTL 与「刷新」兜底 */
      }
    }
  }

  /* ─────────────────────────── 目录视图 ─────────────────────────── */

  /**
   * 组装目录视图数据（注册表 + 市场/回收站等运行时状态）。
   * @param {{cwd?: string, agentId?: string, refresh?: boolean}} query 查询。
   * @returns {Promise<object>} 目录数据。
   */
  async function buildCatalog(query) {
    const registry = await loadRegistry(query)
    const ledger = readLedger(managerRoot)
    if (ledger.corrupt) {
      warn(`市场台账损坏，已备份到 ${ledger.backup ?? '(备份失败)'}；本次以空台账继续`)
    }

    return {
      ...registry,
      ok: true,
      build: HOST_BUILD,
      marketUrl: market.baseUrl,
      marketConfigured: market.configured,
      warnings: [
        ...(registry.warnings ?? []),
        ...ledger.corrupt ? [`市场台账损坏，已备份到 ${ledger.backup ?? '（备份失败）'}，历史安装记录需要手工核对`] : [],
      ],
      trash: listTrash(managerRoot),
      installed: ledger.entries,
      ledgerCorrupt: ledger.corrupt,
    }
  }

  /* ─────────────────────── 导入本地 / 目录浏览 ─────────────────────── */

  /** 目录浏览一次最多返回多少条目（避免在超大目录上卡住）。 */
  const BROWSE_LIMIT = 500
  /** 「查看 SKILL.md」一次最多回多少字符。 */
  const MAX_READ_CHARS = 400_000
  /** 拖拽/粘贴导入：最多多少个文件、单文件与总量上限。 */
  const MAX_UPLOAD_FILES = 2_000
  const MAX_UPLOAD_FILE_BYTES = 5 * 1024 * 1024
  const MAX_UPLOAD_TOTAL_BYTES = 20 * 1024 * 1024

  /**
   * 搬进最终位置（跨卷时退化成复制 + 删除，Windows 上带重试）。
   * @param {string} from 源。
   * @param {string} to 目标。
   * @returns {void}
   */
  function movePath(from, to) {
    moveWithRetry(from, to)
  }

  /**
   * 拖文件夹时浏览器给的是 `文件夹/SKILL.md`：把唯一的一层公共前缀剥掉。
   * 只在"剥掉之后顶层就是 SKILL.md"时才剥，避免误改本来就分层存放的技能包。
   * @param {Array<{path: string, data: Buffer}>} files 文件列表。
   * @returns {Array<{path: string, data: Buffer}>} 处理后的列表。
   */
  function stripCommonPrefix(files) {
    if (files.length === 0) return files
    const [prefix, ...rest] = files[0].path.split('/')
    if (rest.length === 0) return files
    if (!files.every((file) => file.path.startsWith(`${prefix}/`))) return files
    if (!files.some((file) => file.path === `${prefix}/SKILL.md`)) return files
    return files.map((file) => ({ ...file, path: file.path.slice(prefix.length + 1) }))
  }

  /**
   * 拖拽/粘贴导入：界面把文件读成 base64 传上来，Host 落盘成技能。
   *
   * 为什么走这条路：浏览器里拖进来的文件**拿不到本地绝对路径**（Electron 32+ 也移除了
   * `File.path`），所以只能把内容传上来由 Host 写盘。能调用系统选择框时优先用那条路。
   *
   * @param {{target: object, files: Array<{path: string, data: string}>, overwrite?: boolean}} input 输入。
   * @returns {object} 结果。
   */
  function importUploadedSkill(input) {
    const target = input.target
    if (target.writable === false) return { ok: false, error: `技能根 ${target.label} 不可写` }
    const incoming = Array.isArray(input.files) ? input.files : []
    if (incoming.length === 0) return { ok: false, error: '没有收到文件' }
    if (incoming.length > MAX_UPLOAD_FILES) return { ok: false, error: `文件数超过上限（${MAX_UPLOAD_FILES}）` }

    const decoded = []
    let total = 0
    for (const item of incoming) {
      const safe = safeEntryPath(item?.path)
      if (!safe.ok) return { ok: false, error: `路径不安全：${safe.error}` }
      if (safe.directory || safe.path === '') return { ok: false, error: `路径不是文件：${item?.path}` }
      const data = Buffer.from(String(item?.data ?? ''), 'base64')
      if (data.length > MAX_UPLOAD_FILE_BYTES) return { ok: false, error: `${safe.path} 超过单文件上限（${MAX_UPLOAD_FILE_BYTES} 字节）` }
      total += data.length
      if (total > MAX_UPLOAD_TOTAL_BYTES) return { ok: false, error: `总大小超过上限（${MAX_UPLOAD_TOTAL_BYTES} 字节）` }
      decoded.push({ path: safe.path, data })
    }
    const files = stripCommonPrefix(decoded)

    // 形态一：技能目录（顶层有 SKILL.md）。
    const skillFile = files.find((file) => file.path === 'SKILL.md')
    if (skillFile) {
      const record = readSkillRecord({ text: skillFile.data.toString('utf8') })
      if (!record.name || !isSkillName(record.name)) {
        return { ok: false, error: `技能名不合法（frontmatter 的 name 必须是 kebab-case）：${record.name ?? '缺失'}` }
      }
      if (record.valid === false) return { ok: false, error: `技能文件不合法：${record.issues.join('；')}` }
      const targetDir = join(target.path, record.name)
      if (!isInside(target.path, targetDir)) return { ok: false, error: '导入目标越界' }
      if (existsSync(targetDir) && input.overwrite !== true) {
        return { ok: false, error: `目标已存在：${record.name}` }
      }
      let temp
      try {
        mkdirSync(target.path, { recursive: true })
        const parent = dirname(target.path)
        const stagingBase = existsSync(parent) ? parent : target.path
        temp = mkdtempSync(join(stagingBase, '.skill-manager-upload-'))
        for (const file of files) {
          const destination = join(temp, ...file.path.split('/'))
          if (!isInside(temp, destination)) return { ok: false, error: `路径越界：${file.path}` }
          mkdirSync(dirname(destination), { recursive: true })
          writeFileSync(destination, file.data)
        }
        const written = verifyWrittenFiles(temp, files)
        if (!written.ok) {
          rmSync(temp, { recursive: true, force: true })
          return { ok: false, error: written.error }
        }
        if (existsSync(targetDir)) removeWithRetry(targetDir)
        movePath(temp, targetDir)
        temp = undefined
        const settled = verifyInstalledAgainstManifest(targetDir, {
          name: record.name,
          version: '0.0.0',
          files: files.map((file) => ({ path: file.path, size: file.data.length, sha256: digestOf(file.data) })),
          bundle: {},
        })
        if (!settled.ok) {
          removeWithRetry(targetDir)
          return { ok: false, error: settled.error }
        }
        registryDirty = true
        return { ok: true, name: record.name, path: join(targetDir, 'SKILL.md'), rootId: target.id }
      } catch (error) {
        if (temp) rmSync(temp, { recursive: true, force: true })
        return { ok: false, error: `导入失败：${String(error?.message || error)}` }
      }
    }

    // 形态二：单个 .md 技能文件。
    if (files.length === 1 && /\.md$/i.test(files[0].path)) {
      const record = readSkillRecord({ text: files[0].data.toString('utf8') })
      if (!record.name || !isSkillName(record.name)) {
        return { ok: false, error: `技能名不合法（frontmatter 的 name 必须是 kebab-case）：${record.name ?? '缺失'}` }
      }
      if (record.valid === false) return { ok: false, error: `技能文件不合法：${record.issues.join('；')}` }
      const destination = join(target.path, `${record.name}.md`)
      if (!isInside(target.path, destination)) return { ok: false, error: '导入目标越界' }
      if (existsSync(destination) && input.overwrite !== true) {
        return { ok: false, error: `目标已存在：${record.name}.md` }
      }
      try {
        mkdirSync(target.path, { recursive: true })
        writeFileSync(destination, files[0].data)
        if (readFileSync(destination).length !== files[0].data.length) {
          rmSync(destination, { force: true })
          return { ok: false, error: '落盘后复读校验失败，已放弃导入' }
        }
        registryDirty = true
        return { ok: true, name: record.name, path: destination, rootId: target.id }
      } catch (error) {
        return { ok: false, error: `导入失败：${String(error?.message || error)}` }
      }
    }
    return { ok: false, error: '拖进来的内容里找不到 SKILL.md（技能目录或单个 .md 技能文件都行）' }
  }

  /**
   * 列出目录内容（只列子目录 + 能直接导入的 SKILL.md），供"导入本地"的点选界面用。
   * @param {string} inputPath 目录路径，留空用用户主目录。
   * @returns {object} 结果。
   */
  function browseDirectory(inputPath) {
    const target = inputPath ? resolve(inputPath) : homedir()
    if (!existsSync(target)) return { ok: false, error: `路径不存在：${target}` }
    if (!statSync(target).isDirectory()) return { ok: false, error: `不是目录：${target}` }
    const entries = []
    try {
      for (const entry of readdirSync(target, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue
        const full = join(target, entry.name)
        let isDirectory = entry.isDirectory()
        try {
          if (entry.isSymbolicLink()) isDirectory = statSync(full).isDirectory()
        } catch {
          continue
        }
        if (isDirectory) {
          entries.push({
            kind: 'directory',
            name: entry.name,
            path: full,
            hasSkill: existsSync(join(full, 'SKILL.md')),
          })
        } else if (entry.name.toLowerCase().endsWith('.md')) {
          entries.push({ kind: 'file', name: entry.name, path: full, hasSkill: true })
        }
      }
    } catch (error) {
      return { ok: false, error: `读不到目录：${String(error?.message || error)}` }
    }
    entries.sort((left, right) => (left.hasSkill === right.hasSkill ? left.name.localeCompare(right.name) : left.hasSkill ? -1 : 1))
    const parent = dirname(target)
    return {
      ok: true,
      path: target,
      parent: parent === target ? '' : parent,
      entries: entries.slice(0, BROWSE_LIMIT),
      truncated: entries.length > BROWSE_LIMIT,
    }
  }

  /**
   * 把一个已有的技能目录/文件导入到选定的技能根。
   * @param {{source: string, target: object, overwrite?: boolean}} input 输入。
   * @returns {object} 结果。
   */
  function importLocalSkill(input) {
    if (!input.source) return { ok: false, error: '请选择要导入的技能目录或 .md 文件' }
    if (input.target.writable === false) return { ok: false, error: `技能根 ${input.target.label} 不可写` }
    const source = resolve(input.source)
    if (!existsSync(source)) return { ok: false, error: `路径不存在：${source}` }
    const stat = statSync(source)
    const isDirectory = stat.isDirectory()
    const skillFile = isDirectory ? join(source, 'SKILL.md') : source
    if (!existsSync(skillFile)) {
      return { ok: false, error: '这个目录里没有 SKILL.md（导入的必须是技能目录或 .md 技能文件）' }
    }
    const record = readSkillRecord({ text: readFileSync(skillFile, 'utf8'), path: skillFile })
    if (!record.name || !isSkillName(record.name)) {
      return { ok: false, error: `技能名不合法（frontmatter 的 name 必须是 kebab-case）：${record.name ?? '缺失'}` }
    }
    if (record.valid === false) return { ok: false, error: `技能文件不合法：${record.issues.join('；')}` }

    const target = isDirectory ? join(input.target.path, record.name) : join(input.target.path, `${record.name}.md`)
    if (!isInside(input.target.path, target)) return { ok: false, error: '导入目标越界' }
    // 源就在目标位置时不必复制。
    if (resolve(source) === resolve(target)) return { ok: true, name: record.name, path: target, unchanged: true }
    if (existsSync(target) && input.overwrite !== true) {
      return { ok: false, error: `目标已存在：${basename(target)}` }
    }
    // **先在技能根外复制并校验，再"改名挪开旧的 → 改名进来"**：热路径上一次删除都不做，
    // 也不依赖"刚删掉的名字能立刻复用"（Windows 上会被句柄/监听咬住，出 EPERM/EIO）。
    mkdirSync(input.target.path, { recursive: true })
    const placed = replaceSkillDirectory({ source, target, rootPath: input.target.path, isDirectory })
    if (!placed.ok) return { ok: false, error: placed.error }
    registryDirty = true
    return { ok: true, name: record.name, path: isDirectory ? join(target, 'SKILL.md') : target, rootId: input.target.id }
  }

  /* ─────────────────────────── 管理动作 ─────────────────────────── */

  /**
   * 执行一个管理动作。
   * @param {object} body 请求体。
   * @returns {Promise<object>} 结果。
   */
  async function runAction(body) {
    const cwd = body.cwd ? resolve(String(body.cwd)) : process.cwd()
    const roots = rootsFor(cwd)
    const action = String(body.action ?? '')
    if (action === 'restore') return restoreTrash({ managerRoot, id: String(body.id ?? ''), roots })
    if (action === 'purge') {
      if (body.confirm !== true) return { ok: false, error: '清空回收站需要 confirm: true' }
      return purgeTrash({ managerRoot, id: body.id ? String(body.id) : undefined })
    }
    // 「刷新」：重扫技能文件夹并重建注册表。
    if (action === 'refresh') {
      registryDirty = true
      return buildCatalog({ cwd, agentId: body.agentId ? String(body.agentId) : undefined, refresh: true })
    }
    // 「导入本地」：把一个已有的技能文件夹/文件复制进选定的技能根。
    if (action === 'import') {
      const target = roots.find((item) => item.id === String(body.rootId ?? ''))
      if (!target) return { ok: false, error: `技能根不存在：${body.rootId}` }
      return importLocalSkill({ source: String(body.sourcePath ?? ''), target, overwrite: body.overwrite === true })
    }
    // `create` 的目标技能还不存在，必须走在前面的 locate 之前。
    if (action === 'create') {
      const target = roots.find((item) => item.id === String(body.rootId ?? ''))
      if (!target) return { ok: false, error: `技能根不存在：${body.rootId}` }
      if (!target.writable) return { ok: false, error: `技能根 ${target.label} 不可写` }
      return createSkill({
        root: target,
        name: String(body.name ?? ''),
        description: String(body.description ?? ''),
        whenToUse: body.whenToUse ? String(body.whenToUse) : undefined,
      })
    }

    const found = locate(roots, { rootId: String(body.rootId ?? ''), name: String(body.name ?? '') })
    if (found.error) return { ok: false, error: found.error }
    // 写/删类动作一律要求根可写——只读根（例如随包分发的 bundled）只能看。
    const needsWrite = ['set-invocation', 'rename', 'trash', 'set-categories', 'move-root'].includes(action)
    if (needsWrite && found.root.writable === false) {
      return { ok: false, error: `技能根 ${found.root.label} 不可写` }
    }

    switch (action) {
      case 'set-invocation':
        return setInvocation({
          root: found.root,
          skill: found.skill,
          invocation: {
            modelInvocable: body.modelInvocable !== false,
            userInvocable: body.userInvocable !== false,
          },
        })
      case 'set-categories': {
        const result = setCategories({
          root: found.root,
          skill: found.skill,
          categories: body.categories,
        })
        if (result.ok) registryDirty = true
        return result
      }
      case 'move-root': {
        const target = roots.find((item) => item.id === String(body.targetRootId ?? ''))
        if (!target) return { ok: false, error: `目标技能根不存在：${body.targetRootId}` }
        if (target.id === found.root.id) return { ok: true, changed: false, rootId: target.id }
        const result = moveSkill({ root: found.root, skill: found.skill, targetRoot: target })
        if (result.ok) registryDirty = true
        return result
      }
      case 'rename':
        return renameSkill({ root: found.root, skill: found.skill, newName: String(body.newName ?? '') })
      case 'trash':
        return trashSkill({ root: found.root, skill: found.skill, managerRoot })
      case 'copy': {
        const target = roots.find((item) => item.id === String(body.targetRootId ?? ''))
        if (!target) return { ok: false, error: `目标技能根不存在：${body.targetRootId}` }
        if (target.writable === false) return { ok: false, error: `目标技能根 ${target.label} 不可写` }
        return copySkill({ skill: found.skill, targetRoot: target, overwrite: body.overwrite === true })
      }
      default:
        return { ok: false, error: `未知动作：${action}` }
    }
  }

  /* ─────────────────────────── 市场 ─────────────────────────── */

  /**
   * 市场搜索。
   * @param {{q?: string, limit?: string}} query 查询。
   * @returns {Promise<object>} 结果。
   */
  async function searchMarket(query) {
    if (!market.configured) return { ok: false, configured: false, error: '未配置市场地址（marketUrl）' }
    const result = await market.search({ q: query.q, limit: Number(query.limit) || 50 })
    if (!result.ok) return { ...result, configured: true, url: market.baseUrl }
    const installed = new Map(readLedger(managerRoot).entries.map((entry) => [entry.name, entry]))
    return {
      ok: true,
      configured: true,
      url: market.baseUrl,
      items: result.items.map((item) => ({
        ...item,
        installedVersion: installed.get(item.name)?.version,
      })),
    }
  }

  /**
   * 市场安装 / 卸载。
   * @param {string} action 动作名。
   * @param {object} body 请求体。
   * @returns {Promise<object>} 结果。
   */
  async function runMarketAction(action, body) {
    const cwd = body.cwd ? resolve(String(body.cwd)) : process.cwd()
    const roots = rootsFor(cwd)
    if (action === 'uninstall') {
      return market.uninstall({ name: String(body.name ?? ''), roots, managerRoot })
    }
    if (action === 'install') {
      const target = roots.find((item) => item.id === String(body.rootId ?? ''))
      if (!target) return { ok: false, error: `技能根不存在：${body.rootId}` }
      if (!target.writable) return { ok: false, error: `技能根 ${target.label} 不可写，换一个位置` }
      const verified = await market.manifest({ name: String(body.name ?? ''), version: body.version ? String(body.version) : 'latest' })
      if (!verified.ok) return verified
      // 界面上要"看得见的同意"：manifest 里的文件清单先回给前端确认，再真正落盘。
      if (body.confirm !== true) {
        return { ok: false, needsConfirmation: true, manifest: verified.manifest, target: { id: target.id, label: target.label, path: target.path } }
      }
      return market.install({ name: String(body.name ?? ''), version: body.version ? String(body.version) : undefined, root: target, managerRoot })
    }
    return { ok: false, error: `未知市场动作：${action}` }
  }

  /* ─────────────────────────── HTTP 路由 ─────────────────────────── */

  if (!enabled) {
    log('disabled by config，未注册任何路由')
    return
  }
  if (!webServer?.register) {
    warn('webServer 不可用，界面将无法读取技能目录')
    return
  }

  /**
   * 写 JSON 响应。
   * @param {import('node:http').ServerResponse} response 响应。
   * @param {number} status 状态码。
   * @param {unknown} payload 内容。
   * @returns {void}
   */
  const sendJson = (response, status, payload) => {
    const body = JSON.stringify(payload ?? null)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    response.end(body)
  }

  /**
   * 同源围栏 + 方法校验。
   * @param {import('node:http').IncomingMessage} request 请求。
   * @param {import('node:http').ServerResponse} response 响应。
   * @param {string} method 期望方法。
   * @returns {boolean} 是否继续。
   */
  const guard = (request, response, method) => {
    const rejection = connection?.requestRejection?.({ headers: request.headers })
    if (rejection) {
      response.writeHead(rejection)
      response.end()
      return false
    }
    if (request.method !== method) {
      sendJson(response, 405, { ok: false, error: `请用 ${method}` })
      return false
    }
    return true
  }

  /**
   * 读 JSON 请求体（限制大小）。
   * @param {import('node:http').IncomingMessage} request 请求。
   * @param {number} [limit] 允许的最大字节数。
   * @returns {Promise<object>} 请求体。
   */
  const readBody = async (request, limit = 256 * 1024) => {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > limit) throw new Error('请求体过大')
      chunks.push(chunk)
    }
    if (size === 0) return {}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  ctx.effect(() => {
    const disposers = [
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/catalog`,
        handler: (request, response) => {
          if (!guard(request, response, 'GET')) return
          void (async () => {
            try {
              const url = new URL(request.url || '/', 'http://localhost')
              const data = await buildCatalog({
                cwd: url.searchParams.get('cwd') || undefined,
                agentId: url.searchParams.get('agentId') || undefined,
                refresh: url.searchParams.get('refresh') === '1',
              })
              sendJson(response, 200, data)
            } catch (error) {
              sendJson(response, 200, { ok: false, error: String(error?.message || error) })
            }
          })()
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/read`,
        handler: (request, response) => {
          if (!guard(request, response, 'GET')) return
          try {
            const url = new URL(request.url || '/', 'http://localhost')
            const roots = rootsFor(url.searchParams.get('cwd') || undefined)
            const found = locate(roots, {
              rootId: url.searchParams.get('rootId') || '',
              name: url.searchParams.get('name') || '',
            })
            if (found.error) return sendJson(response, 404, { ok: false, error: found.error })
            // 只读技能自己的 SKILL.md（locate 已把范围限制在被扫出来的技能根里）。
            const text = readFileSync(found.skill.path, 'utf8')
            const truncated = text.length > MAX_READ_CHARS
            sendJson(response, 200, {
              ok: true,
              path: found.skill.path,
              text: truncated ? `${text.slice(0, MAX_READ_CHARS)}\n\n…（已截断）` : text,
              truncated,
            })
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error?.message || error) })
          }
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/import-upload`,
        handler: (request, response) => {
          if (!guard(request, response, 'POST')) return
          void (async () => {
            try {
              const body = await readBody(request, MAX_UPLOAD_TOTAL_BYTES * 2)
              const roots = rootsFor(body.cwd ? resolve(String(body.cwd)) : process.cwd())
              const target = roots.find((item) => item.id === String(body.rootId ?? ''))
              if (!target) {
                sendJson(response, 200, { ok: false, error: `技能根不存在：${body.rootId}` })
                return
              }
              sendJson(response, 200, importUploadedSkill({
                target,
                files: body.files,
                overwrite: body.overwrite === true,
              }))
            } catch (error) {
              sendJson(response, 200, { ok: false, error: String(error?.message || error) })
            }
          })()
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/browse`,
        handler: (request, response) => {
          if (!guard(request, response, 'GET')) return
          try {
            const url = new URL(request.url || '/', 'http://localhost')
            sendJson(response, 200, browseDirectory(url.searchParams.get('path') || ''))
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error?.message || error) })
          }
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/action`,
        handler: (request, response) => {
          if (!guard(request, response, 'POST')) return
          void (async () => {
            try {
              const body = await readBody(request)
              sendJson(response, 200, await runAction(body))
            } catch (error) {
              sendJson(response, 400, { ok: false, error: String(error?.message || error) })
            }
          })()
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/market`,
        handler: (request, response) => {
          if (!guard(request, response, 'GET')) return
          void (async () => {
            const url = new URL(request.url || '/', 'http://localhost')
            sendJson(response, 200, await searchMarket({
              q: url.searchParams.get('q') || undefined,
              limit: url.searchParams.get('limit') || undefined,
            }))
          })()
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/market/install`,
        handler: (request, response) => {
          if (!guard(request, response, 'POST')) return
          void (async () => {
            try {
              sendJson(response, 200, await runMarketAction('install', await readBody(request)))
            } catch (error) {
              sendJson(response, 400, { ok: false, error: String(error?.message || error) })
            }
          })()
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/market/uninstall`,
        handler: (request, response) => {
          if (!guard(request, response, 'POST')) return
          void (async () => {
            try {
              sendJson(response, 200, await runMarketAction('uninstall', await readBody(request)))
            } catch (error) {
              sendJson(response, 400, { ok: false, error: String(error?.message || error) })
            }
          })()
        },
      }),
    ]
    try {
      mkdirSync(managerRoot, { recursive: true })
    } catch (error) {
      warn(`建不出数据目录 ${managerRoot}：${String(error?.message || error)}`)
    }
    log(`已注册 ${disposers.length} 条路由：${ROUTE_PREFIX}/*`)
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'skill-manager: routes')

  /* ───────────────────── /skill/<技能> 手势 ───────────────────── */

  const runtime = { render: undefined, createMessage: undefined }
  void loadUpstreamRuntime().then((loaded) => {
    Object.assign(runtime, loaded)
  }).catch(() => {})

  ctx.on('agent/pre-step', createSkillPathGesture({
    getSkill: (skillName, options) => {
      if (typeof skills?.get !== 'function') return Promise.resolve(undefined)
      return skills.get(skillName, options)
    },
    // 两级写法 `/skill/<技能目录>/<技能>`：直接读该根下的那一份，
    // 不拿"同名遮蔽"规则覆盖用户明确指定的选择。
    getRootedSkill: async (rootKey, skillName) => {
      const root = rootsFor(process.cwd()).find((item) => item.id === rootKey || item.label === rootKey)
      if (!root) return undefined
      const bundle = join(root.path, skillName, 'SKILL.md')
      const flat = join(root.path, `${skillName}.md`)
      const file = existsSync(bundle) ? bundle : existsSync(flat) ? flat : undefined
      if (!file) return undefined
      try {
        const record = readSkillRecord({ text: readFileSync(file, 'utf8'), path: file })
        if (!record.name || record.valid === false) return undefined
        return {
          name: record.name,
          content: record.body,
          provider: `filesystem:${root.id}`,
          resourceBase: { kind: 'directory', path: file === bundle ? dirname(file) : root.path },
          invocation: record.invocation,
          path: file,
        }
      } catch (error) {
        warn(`读取 ${root.id}/${skillName} 失败：${String(error?.message || error)}`)
        return undefined
      }
    },
    render: (skill) => (runtime.render ?? renderSkillContent)(skill),
    createMessage: (input) => (runtime.createMessage ?? createUserMessageMirror)(input),
    warn,
  }))
  log('已注册 /skill/<技能> 与 /skill/<技能目录>/<技能> 手势')
}
