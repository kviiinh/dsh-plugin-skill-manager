/**
 * 技能根的解析、扫描与"是否真的生效"的对账。
 *
 * 根的顺序与来源标签**照抄** `@deepseek-ai/dsh-skill-filesystem`（rank 100→600），
 * 因为保持一致才不会出现「管理器说生效、DSH 说没有」这种自相矛盾：
 *
 *   | rank | 来源            | 路径                              |
 *   |-----:|-----------------|-----------------------------------|
 *   |  100 | project-dsh     | `<项目根>/.dsh/skills`            |
 *   |  200 | project-agents  | `<项目根>/.agents/skills`         |
 *   |  300 | custom          | 配置里的 `roots[]`                |
 *   |  400 | user-dsh        | `$DSH_HOME/skills`                |
 *   |  500 | user-agents     | `$DSH_AGENTS_HOME/skills`         |
 *   |  600 | bundled         | 配置里的 `bundledSkillDirs[]`     |
 *
 * 项目根 = 最近的含 `.git` 的祖先目录，没有就用 cwd。
 *
 * 扫描**只认一层**（`<root>/<name>/SKILL.md` 或 `<root>/<name>.md`），与 DSH 一致；
 * 与 DSH 不同的是：无效技能在这里**照列不误**并带上原因——DSH 会静默丢弃它们，
 * 模型侧完全看不到，管理器最大的价值就是把这类技能摆出来。
 *
 * @module dsh-plugin-skill-manager/lib/roots
 */

import { existsSync, readdirSync, readFileSync, statSync, accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { readSkillRecord } from './frontmatter.js'

/** 各来源的固定 rank，与 dsh-skill-filesystem 对齐。 */
export const RANK = Object.freeze({
  'project-dsh': 100,
  'project-agents': 200,
  custom: 300,
  'user-dsh': 400,
  'user-agents': 500,
  bundled: 600,
})

/**
 * 展开 `~` 与 `%VAR%` / `$VAR`。
 * @param {string} value 原始路径。
 * @param {NodeJS.ProcessEnv} [env] 环境变量。
 * @returns {string} 展开后的路径。
 */
export function expandPath(value, env = process.env) {
  let out = String(value ?? '').trim()
  if (!out) return ''
  const home = env.USERPROFILE || env.HOME || homedir()
  if (out === '~') out = home
  else if (out.startsWith('~/') || out.startsWith('~\\')) out = join(home, out.slice(2))
  out = out.replace(/%(?:([^%]+))%/g, (whole, key) => env[key] ?? whole)
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, a, b) => env[a ?? b] ?? whole)
  return out
}

/**
 * 解析 DSH home 与 agents home。
 * @param {{dshHome?: string, agentsHome?: string, env?: NodeJS.ProcessEnv}} [input] 输入。
 * @returns {{dshHome: string, agentsHome: string}} 两个根。
 */
export function resolveHomes(input = {}) {
  const env = input.env ?? process.env
  const home = env.USERPROFILE || env.HOME || homedir()
  const dshHome = expandPath(input.dshHome, env) || expandPath(env.DSH_HOME, env) || join(home, '.dsh')
  const agentsHome = expandPath(input.agentsHome, env) || expandPath(env.DSH_AGENTS_HOME, env) || join(home, '.agents')
  return { dshHome: resolve(dshHome), agentsHome: resolve(agentsHome) }
}

/**
 * 找项目根：最近的含 `.git` 的祖先目录。
 * @param {string} cwd 起始目录。
 * @returns {string} 项目根（找不到时返回起始目录本身）。
 */
export function findProjectRoot(cwd) {
  let current = resolve(cwd || process.cwd())
  let guard = 0
  while (guard < 64) {
    guard += 1
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return resolve(cwd || process.cwd())
}

/**
 * 组装有序技能根列表。
 * @param {object} input 输入。
 * @param {string} input.cwd 工作目录。
 * @param {string} input.dshHome DSH home。
 * @param {string} input.agentsHome agents home。
 * @param {Array<{id?: string, path: string, rank?: number, writable?: boolean}>} [input.customRoots] 额外根。
 * @param {string[]} [input.bundledDirs] 随包分发的根（只读）。
 * @param {boolean} [input.includeDefaultRoots] 是否包含项目根与用户根。
 * @returns {Array<object>} 根列表。
 */
export function resolveRoots(input) {
  const includeDefaults = input.includeDefaultRoots !== false
  const projectRoot = findProjectRoot(input.cwd)
  const roots = []

  if (includeDefaults) {
    roots.push({
      id: 'project-dsh',
      label: 'project-dsh',
      rank: RANK['project-dsh'],
      path: join(projectRoot, '.dsh', 'skills'),
      writable: true,
    })
    roots.push({
      id: 'project-agents',
      label: 'project-agents',
      rank: RANK['project-agents'],
      path: join(projectRoot, '.agents', 'skills'),
      writable: true,
    })
  }

  const custom = Array.isArray(input.customRoots) ? input.customRoots : []
  custom.forEach((entry, index) => {
    const path = expandPath(entry?.path)
    if (!path) return
    roots.push({
      id: String(entry?.id || `custom-${index + 1}`),
      label: 'custom',
      rank: Number.isFinite(entry?.rank) ? Number(entry.rank) : RANK.custom,
      path: resolve(path),
      writable: entry?.writable !== false,
    })
  })

  if (includeDefaults) {
    roots.push({
      id: 'user-dsh',
      label: 'user-dsh',
      rank: RANK['user-dsh'],
      path: join(input.dshHome, 'skills'),
      writable: true,
    })
    roots.push({
      id: 'user-agents',
      label: 'user-agents',
      rank: RANK['user-agents'],
      path: join(input.agentsHome, 'skills'),
      writable: true,
    })
  }

  const bundled = Array.isArray(input.bundledDirs) ? input.bundledDirs : []
  bundled.forEach((entry, index) => {
    const path = expandPath(entry)
    if (!path) return
    roots.push({
      id: `bundled-${index + 1}`,
      label: 'bundled',
      rank: RANK.bundled,
      path: resolve(path),
      writable: false,
    })
  })

  const seen = new Set()
  return roots
    .filter((root) => {
      const key = root.path.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((left, right) => left.rank - right.rank || left.path.localeCompare(right.path))
}

/**
 * 判断路径是否可写。
 * @param {string} path 目标路径。
 * @returns {boolean} 可写返回 true。
 */
export function isWritable(path) {
  try {
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 判断"能不能在这里创建"：目录不存在时，向上找最近的已存在祖先看它是否可写。
 *
 * 这一条很重要：`~/.agents/skills` 这类用户根在多数机器上**一开始并不存在**，
 * 如果只按"存在且可写"判断，市场页会一个可安装位置都列不出来。
 *
 * @param {string} path 目标路径。
 * @returns {boolean} 可创建返回 true。
 */
export function isCreatable(path) {
  if (existsSync(path)) return isWritable(path)
  let current = resolve(path)
  for (let guard = 0; guard < 64; guard += 1) {
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
    if (existsSync(current)) return isWritable(current)
  }
  return false
}

/**
 * 路径是否落在某个根内部（防越权写）。
 * @param {string} rootPath 根路径。
 * @param {string} target 目标路径。
 * @returns {boolean} 在内部返回 true。
 */
export function isInside(rootPath, target) {
  const base = resolve(rootPath)
  const full = resolve(target)
  return full === base || full.startsWith(base.endsWith(sep) ? base : base + sep)
}

/**
 * 扫描一个根下的一层技能。
 * @param {object} root 根描述。
 * @returns {{skills: Array<object>, warnings: string[]}} 扫描结果。
 */
export function scanRoot(root) {
  const skills = []
  const warnings = []
  if (!existsSync(root.path)) return { skills, warnings }

  let entries
  try {
    entries = readdirSync(root.path, { withFileTypes: true })
  } catch (error) {
    warnings.push(`读不到 ${root.path}：${String(error?.message || error)}`)
    return { skills, warnings }
  }

  for (const entry of entries) {
    const name = entry.name
    if (name.startsWith('.') || name === 'node_modules') continue
    const full = join(root.path, name)
    let isDirectory = entry.isDirectory()
    let isFile = entry.isFile()
    if (entry.isSymbolicLink()) {
      try {
        const target = statSync(full)
        isDirectory = target.isDirectory()
        isFile = target.isFile()
      } catch {
        warnings.push(`符号链接失效，已跳过：${full}`)
        continue
      }
    }

    if (isDirectory) {
      const skillFile = join(full, 'SKILL.md')
      if (!existsSync(skillFile)) {
        if (existsSync(join(full, 'skill.md'))) warnings.push(`目录 ${name} 里是 skill.md（大小写不符，DSH 不认）`)
        continue
      }
      skills.push(describeSkill({ root, kind: 'bundle', dirName: name, path: skillFile }))
      continue
    }

    if (isFile && name.toLowerCase().endsWith('.md') && name !== 'SKILL.md') {
      skills.push(describeSkill({ root, kind: 'flat', dirName: name.slice(0, -3), path: full }))
    }
  }
  return { skills, warnings }
}

/**
 * 读一个技能文件并组装记录。
 * @param {{root: object, kind: 'bundle' | 'flat', dirName: string, path: string}} input 输入。
 * @returns {object} 技能记录。
 */
function describeSkill(input) {
  const base = {
    rootId: input.root.id,
    rootLabel: input.root.label,
    rank: input.root.rank,
    rootPath: input.root.path,
    kind: input.kind,
    dirName: input.dirName,
    path: input.path,
    effective: true,
    shadowedBy: undefined,
    issues: [],
  }
  let text = ''
  let bytes = 0
  let mtime = ''
  try {
    const stat = statSync(input.path)
    bytes = stat.size
    mtime = new Date(stat.mtimeMs).toISOString()
    text = readFileSync(input.path, 'utf8')
  } catch (error) {
    return { ...base, valid: false, issues: [`读不到文件：${String(error?.message || error)}`], bytes, mtime }
  }
  const record = readSkillRecord({ text, path: input.path, rootId: input.root.id })
  const fallbackName = input.kind === 'flat' ? input.dirName : input.dirName
  return {
    ...base,
    ...record,
    name: record.name ?? fallbackName,
    bytes,
    mtime,
    resources: describeResources({ path: input.path, kind: input.kind }),
    issues: record.issues ?? [],
  }
}

/**
 * 统计一个技能目录的资源（供界面展示）。
 * @param {{path: string, kind: string}} skill 技能记录。
 * @returns {{files: number, directories: string[], bytes: number}} 统计。
 */
export function describeResources(skill) {
  const root = skill.kind === 'flat' ? undefined : dirname(skill.path)
  const result = { files: 0, directories: [], bytes: 0 }
  if (!root || !existsSync(root)) return result
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth === 0 && !entry.name.startsWith('.')) result.directories.push(entry.name)
        walk(full, depth + 1)
        continue
      }
      try {
        result.files += 1
        result.bytes += statSync(full).size
      } catch {
        /* 忽略读不到的条目 */
      }
    }
  }
  walk(root, 0)
  return result
}

/**
 * 扫描全部根。
 * @param {Array<object>} roots 根列表。
 * @returns {{skills: Array<object>, warnings: string[], roots: Array<object>}} 扫描结果。
 */
export function scanRoots(roots) {
  const skills = []
  const warnings = []
  const described = roots.map((root) => {
    const exists = existsSync(root.path)
    const scanned = exists ? scanRoot(root) : { skills: [], warnings: [] }
    skills.push(...scanned.skills)
    warnings.push(...scanned.warnings)
    return {
      ...root,
      exists,
      // 目录还不存在也算"可写"（能创建），否则市场页在干净的机器上一个位置都列不出来。
      writable: root.writable !== false && isCreatable(root.path),
      skillCount: scanned.skills.length,
    }
  })
  return { skills, warnings, roots: described }
}

/**
 * 与 `ctx.skills` 的快照对账：决定谁真的生效、谁被遮蔽、谁是 provider 提供的。
 *
 * DSH 自己按「层 → rank → provider 注册顺序」选胜者，且**不暴露**被遮蔽的候选；
 * 这里用同样的规则在扫描结果上复算一遍，再用注册表快照做权威校验。
 *
 * `registryKnown` 很重要：注册表按会话/预设作用域分层，管理页面在没有绑定会话时
 * **拿不到**权威结论。这时我们只按 rank 给出"推算"结果并标明 `registryState:
 * 'unknown'`——绝不能把"不知道"显示成"不生效"。
 *
 * @param {{skills: Array<object>, snapshot?: {skills?: Array<object>}, registryKnown?: boolean}} input 输入。
 * @returns {{skills: Array<object>, providerOnly: Array<object>, warnings: string[]}} 对账结果。
 */
export function reconcile(input) {
  const scanned = [...input.skills]
  const registryKnown = input.registryKnown !== false
  const registry = new Map()
  for (const summary of input.snapshot?.skills ?? []) {
    if (summary?.name) registry.set(summary.name, summary)
  }

  const byName = new Map()
  for (const skill of scanned) {
    if (!skill.name) continue
    const bucket = byName.get(skill.name) ?? []
    bucket.push(skill)
    byName.set(skill.name, bucket)
  }

  const warnings = []
  for (const [name, bucket] of byName) {
    const ordered = [...bucket].sort((left, right) => {
      const leftValid = left.valid ? 0 : 1
      const rightValid = right.valid ? 0 : 1
      return leftValid - rightValid || left.rank - right.rank || String(left.path).localeCompare(String(right.path))
    })
    const winner = ordered[0]
    const summary = registry.get(name)
    for (const skill of ordered) {
      const isWinner = skill === winner
      skill.effective = isWinner && skill.valid !== false
      if (!isWinner) {
        skill.shadowedBy = { name: winner.name, path: winner.path, rootLabel: winner.rootLabel }
        skill.registryState = registryKnown ? 'shadowed' : 'unknown'
        continue
      }
      if (!registryKnown) {
        skill.registryState = 'unknown'
        skill.predicted = true
        continue
      }
      if (summary === undefined) {
        skill.effective = false
        skill.shadowedBy = undefined
        skill.registryState = 'absent'
        continue
      }
      skill.registryState = 'present'
      const registryPath = typeof summary.path === 'string' ? resolve(summary.path) : ''
      if (registryPath && skill.path && registryPath !== resolve(skill.path)) {
        skill.effective = false
        skill.registryState = 'other-provider'
        skill.shadowedBy = { name, path: summary.path, rootLabel: summary.source || 'provider' }
      }
    }
    if (ordered.length > 1) warnings.push(`技能名冲突：${name} 由 ${ordered.length} 个根提供，DSH 只会用 rank 最小的那个`)
  }

  const providerOnly = []
  if (registryKnown) {
    for (const [name, summary] of registry) {
      if (byName.has(name)) continue
      providerOnly.push({
        name,
        description: summary.description ?? '',
        whenToUse: summary.whenToUse,
        path: summary.path,
        source: summary.source ?? 'provider',
        provider: summary.provider,
        invocation: summary.invocation,
        origin: 'provider',
        valid: true,
        issues: [],
        effective: true,
      })
    }
    providerOnly.sort((left, right) => String(left.name).localeCompare(String(right.name)))
  }

  scanned.sort((left, right) => {
    const leftName = String(left.name ?? '')
    const rightName = String(right.name ?? '')
    return left.rank - right.rank || leftName.localeCompare(rightName)
  })
  return { skills: scanned, providerOnly, warnings }
}

/**
 * 由技能记录定位它所在的目录（资源根）。
 * @param {object} skill 技能记录。
 * @returns {string} 目录路径。
 */
export function skillDirectory(skill) {
  return skill.kind === 'flat' ? skill.rootPath : dirname(skill.path)
}
