/**
 * 技能的文件级管理动作。
 *
 * 三条硬规则：
 *
 *   1. **只能在根内部写**。每个动作先用 `isInside(root.path, target)` 校验，
 *      目标路径由根 + 技能名推导，绝不接受调用方直接给的目标路径。
 *   2. **删除是软删除**。技能目录/文件被移进 `<dshHome>/skill-manager/trash/<id>/`，
 *      并在同一目录写 `index.json` 台账，界面据此提供撤销；只有用户显式点
 *      "清空回收站"才会真删。
 *   3. **失败不抛**。所有可预期失败（目标已存在、根不可写、技能不存在）都返回
 *      `{ok:false, code, error}`，让界面直接展示；只有编程错误才抛。
 *
 * 禁用/启用走 DSH 原生语义（frontmatter 的 `disable-model-invocation` /
 * `user-invocable`），**不挪文件**——挪文件会改变 rank/优先级，语义完全不同。
 *
 * @module dsh-plugin-skill-manager/lib/actions
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { applyCategories, applyInvocation, applyName, categoriesOfMetadata, isSkillName, readSkillRecord, renderSkillTemplate } from './frontmatter.js'
import { isInside } from './roots.js'

/** 回收站目录名（位于 `<dshHome>/skill-manager/` 下）。 */
export const MANAGER_DIR_NAME = 'skill-manager'

/**
 * 失败结果。
 * @param {string} code 机器可读错误码。
 * @param {string} error 人类可读说明。
 * @returns {{ok: false, code: string, error: string}} 结果。
 */
function fail(code, error) {
  return { ok: false, code, error }
}

/**
 * 读 JSON 文件，坏了就当空。
 *
 * 注意：Windows 上"文件正被别的进程替换"会抛 `EPERM/EBUSY/EACCES`，
 * 那不是"文件坏了"，重试几次就好。**如果不重试就当成坏文件**，读台账的一方会拿到空台账，
 * 紧接着的写回会把别人的条目整片抹掉（并发安装时表现为"台账少了几条"）。
 * @param {string} path 文件路径。
 * @param {unknown} fallback 缺省值。
 * @returns {unknown} 解析结果。
 */
export function readJson(path, fallback) {
  const transient = new Set(['EPERM', 'EBUSY', 'EACCES', 'EMFILE'])
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      if (!transient.has(error?.code)) return fallback
      if (attempt === 5) return fallback
      sleepSync(10 + attempt * 20)
    }
  }
  return fallback
}

/**
 * 同步小睡（用于少数必须同步的重试路径）。
 * @param {number} ms 毫秒。
 * @returns {void}
 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const until = Date.now() + ms
    while (Date.now() < until) {
      /* 退化成自旋 */
    }
  }
}

/** 值得重试的瞬时错误码（Windows 上目录/文件刚被释放、或被监听/杀软咬住时会冒出来）。 */
const TRANSIENT_CODES = ['EPERM', 'EACCES', 'EBUSY', 'EIO', 'ENOTEMPTY']

/**
 * 带重试地执行一个同步文件操作。
 * @param {() => void} operation 操作。
 * @param {{attempts?: number, baseDelayMs?: number}} [options] 选项。
 * @returns {void}
 */
export function retrySync(operation, options = {}) {
  const attempts = options.attempts ?? 6
  const base = options.baseDelayMs ?? 40
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      operation()
      return
    } catch (error) {
      lastError = error
      if (!TRANSIENT_CODES.includes(error?.code) || attempt === attempts - 1) throw error
      sleepSync(base * (attempt + 1))
    }
  }
  throw lastError
}

/**
 * 删除目录/文件（Windows 上带重试）。
 * @param {string} path 目标。
 * @returns {void}
 */
export function removeWithRetry(path) {
  retrySync(() => rmSync(path, { recursive: true, force: true }))
}

/**
 * 移动（跨卷退化成复制 + 删除），带重试。
 * @param {string} from 源。
 * @param {string} to 目标。
 * @returns {void}
 */
export function moveWithRetry(from, to) {
  try {
    retrySync(() => renameSync(from, to))
    return
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
  }
  cpSync(from, to, { recursive: true })
  removeWithRetry(from)
}

/**
 * 递归列出目录里的所有文件（相对路径 → 字节数）。
 * @param {string} root 目录。
 * @param {string} [prefix] 前缀。
 * @param {Map<string, number>} [out] 结果。
 * @returns {Map<string, number>} 相对路径 → 字节数。
 */
export function listTree(root, prefix = '', out = new Map()) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      listTree(full, relative, out)
      continue
    }
    out.set(relative, statSync(full).size)
  }
  return out
}

/**
 * 把一个技能目录/文件**安全地**放到目标位置。
 *
 * 分三步，**热路径上一次删除都不做**：
 *   1. 复制到**技能根之外**的暂存目录，逐文件校验（文件集合 + 字节数）；
 *   2. 把旧的**改名挪开**（不是删除）→ 把暂存**改名**成目标名；
 *   3. 两个改名都成功之后，才去删挪开的旧目录（删不掉就留着，不影响结果）。
 *
 * 为什么不用"先删后改名"：Windows 上刚删掉的目录名会被句柄/文件监听咬住一段时间，
 * 紧接着往同一个名字改名会 `EPERM`/`EIO`；而且"先删"一旦后面失败，用户那份技能就没了
 * （**丢过数据**）。改名挪开既不丢数据，也不需要等句柄释放。
 *
 * 任何一步失败都会把旧目录**改回原位**，保证用户手上那份技能还在。
 *
 * @param {{source: string, target: string, rootPath?: string, isDirectory: boolean}} input 输入。
 * @returns {{ok: true, replaced: boolean} | {ok: false, error: string}} 结果。
 */
export function replaceSkillDirectory(input) {
  const { source, target, isDirectory } = input
  if (!existsSync(source)) return { ok: false, error: `来源不存在：${source}` }
  // 暂存必须放在**技能根之外**：放在根里会被技能根的监听当成"新技能"看到一半的内容。
  const rootPath = input.rootPath || dirname(target)
  const outsideRoot = dirname(rootPath)
  const stagingBase = outsideRoot && outsideRoot !== rootPath && existsSync(outsideRoot) ? outsideRoot : rootPath
  const aside = `${target}.replaced-${Date.now()}`
  let temp
  let closedAside = true
  try {
    mkdirSync(stagingBase, { recursive: true })
    temp = mkdtempSync(join(stagingBase, '.skill-manager-import-'))
    const staged = join(temp, isDirectory ? 'payload' : 'payload.md')
    retrySync(() => cpSync(source, staged, { recursive: isDirectory }))

    // 校验：目录比文件集合与大小，单文件比字节数。**校验通过之前绝不碰旧目标。**
    if (isDirectory) {
      const before = listTree(source)
      const after = listTree(staged)
      if (before.size !== after.size) {
        return { ok: false, error: `复制不完整：源 ${before.size} 个文件，暂存 ${after.size} 个` }
      }
      for (const [relative, size] of before) {
        if (after.get(relative) !== size) return { ok: false, error: `复制不完整：${relative} 大小不符` }
      }
    } else if (statSync(staged).size !== statSync(source).size) {
      return { ok: false, error: '复制不完整：单文件大小不符' }
    }

    // ① 把旧的**改名挪开**（不是删除）：既不会丢数据，也不用等句柄释放。
    if (existsSync(target)) {
      closedAside = false
      try {
        retrySync(() => renameSync(target, aside))
      } catch (error) {
        return { ok: false, error: `旧技能正被占用，没能挪开（${error?.code ?? 'error'}）：${String(error?.message || error)}` }
      }
    }

    // ② 把暂存改名成目标名；失败就把旧的改回原位。
    try {
      retrySync(() => renameSync(staged, target))
    } catch (error) {
      if (!closedAside) {
        try {
          retrySync(() => renameSync(aside, target))
        } catch {
          return { ok: false, error: `替换失败（${error?.code ?? 'error'}），旧目录被挪到了 ${aside}，请手工改名回去：${String(error?.message || error)}` }
        }
      }
      return { ok: false, error: `替换失败（${error?.code ?? 'error'}）：${String(error?.message || error)}` }
    }

    // ③ 新内容已经就位，现在才删旧的；删不掉也只是留个 `.replaced-*` 目录。
    if (!closedAside) {
      try {
        removeWithRetry(aside)
      } catch {
        /* 留着也没关系 */
      }
    }
    return { ok: true, replaced: !closedAside }
  } catch (error) {
    return { ok: false, error: `替换失败（${error?.code ?? 'error'}）：${String(error?.message || error)}` }
  } finally {
    if (temp) {
      try {
        rmSync(temp, { recursive: true, force: true })
      } catch {
        /* 暂存清不掉不影响结果 */
      }
    }
  }
}

/**
 * 原子写 JSON（同目录临时文件 + 重命名）。
 *
 * Windows 上并发改名同一目标会偶发 `EPERM`/`EBUSY`（另一进程刚打开过这个文件），
 * 所以这里：临时文件名带 pid + 随机串避免互相踩，改名失败短暂重试，
 * 彻底失败也要把临时文件清掉。
 *
 * @param {string} path 目标路径。
 * @param {unknown} value 内容。
 * @returns {void}
 */
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  let lastError
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      renameSync(temp, path)
      return
    } catch (error) {
      lastError = error
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) break
      sleepSync(20 + attempt * 40)
    }
  }
  try {
    rmSync(temp, { force: true })
  } catch {
    /* 清不掉就算了 */
  }
  throw lastError
}

/** 命中就说明"目标被别的程序占着/没权限"，而不是路径或参数写错了。 */
const BUSY_CODES = ['EPERM', 'EBUSY', 'EACCES']

/**
 * 把"目标被占用/没权限"的文件系统错误翻成用户能看懂的一句话。
 *
 * Windows 上"删除技能"其实是把目录 `rename` 进回收站：只要有程序打开着那个目录
 * （最常见的是**文件资源管理器正显示着它**，包括它下面的子目录），`rename` 就会
 * 失败，而原始错误只有一句 `EPERM: operation not permitted, rename '...'`——
 * 用户看不出该关什么，只能以为插件坏了。
 *
 * @param {unknown} error 捕获到的错误。
 * @returns {string} 面向用户的说明。
 */
function describeMoveError(error) {
  const code = String(error?.code ?? '')
  if (BUSY_CODES.includes(code)) {
    return `该技能目录正被其他程序占用（常见原因：文件资源管理器打开了这个目录），或没有访问权限，请关闭后重试（${code}）`
  }
  return String(error?.message || error)
}

/**
 * 跨设备安全的移动（`rename` 失败时退回复制 + 删除）。
 * @param {string} from 源。
 * @param {string} to 目标。
 * @returns {void}
 */
function movePath(from, to) {
  mkdirSync(dirname(to), { recursive: true })
  try {
    renameSync(from, to)
    return
  } catch (error) {
    // 保留原始错误作为 cause 方便排查，只把 message 换成用户能看懂的一句话。
    if (error?.code !== 'EXDEV') throw new Error(describeMoveError(error), { cause: error })
  }
  cpSync(from, to, { recursive: true, errorOnExist: true, force: false })
  rmSync(from, { recursive: true, force: true })
}

/**
 * 校验技能记录确实来自它声称的根，并算出真实路径。
 *
 * 三层校验：
 *   1. 词法层：**真正会被操作的那个路径**必须落在根内——技能包操作的是
 *      `dirname(SKILL.md)`，只校验文件路径会让"文件的父目录 = 根本身甚至根外"
 *      这类输入变成合法的越权移动；
 *   2. 形状层：技能包的文件名必须是 `SKILL.md`，且操作对象不能是技能根本身；
 *   3. 物理层：`realpath` 之后仍必须落在根的 `realpath` 内——技能根里可能有
 *      指向根外的符号链接或 junction，只做词法校验会让写入穿过链接改到根外文件。
 *
 * @param {object} skill 技能记录。
 * @param {object} root 根描述。
 * @returns {{ok: true, source: string, directory: string} | {ok: false, code: string, error: string}} 校验结果。
 */
function assertInsideRoot(skill, root) {
  if (!skill || !skill.path) return fail('missing-skill', '技能记录缺少文件路径')
  if (!root?.path) return fail('bad-root', '技能根无效')
  if (root.id !== skill.rootId) return fail('root-mismatch', `技能不属于根 ${skill.rootId}`)
  if (!isInside(root.path, skill.path)) return fail('outside-root', '技能路径不在该技能根内部，拒绝操作')
  if (!existsSync(skill.path)) return fail('not-found', '技能文件已不存在')

  const isFlat = skill.kind === 'flat'
  const directory = isFlat ? skill.path : dirname(skill.path)
  if (!isInside(root.path, directory)) return fail('outside-root', '技能所在目录不在该技能根内部，拒绝操作')
  if (resolve(directory).toLowerCase() === resolve(root.path).toLowerCase()) {
    return fail('outside-root', '操作对象就是技能根本身，拒绝执行')
  }
  if (!isFlat && basename(skill.path).toLowerCase() !== 'skill.md') {
    return fail('bad-target', '技能包的目标文件必须是 SKILL.md')
  }

  try {
    const realRoot = realpathSync(root.path)
    if (!isInside(realRoot, realpathSync(directory))) {
      return fail('outside-root', '技能目录通过符号链接指向技能根之外，拒绝操作')
    }
    if (!isInside(realRoot, realpathSync(skill.path))) {
      return fail('outside-root', '技能文件通过符号链接指向技能根之外，拒绝操作')
    }
  } catch (error) {
    return fail('outside-root', `解析真实路径失败：${String(error?.message || error)}`)
  }
  return { ok: true, source: skill.path, directory }
}

/**
 * 保存一份被修改的 SKILL.md（先备份成 .bak 再写）。
 * @param {string} path 文件路径。
 * @param {string} text 新内容。
 * @returns {void}
 */
function writeSkillFile(path, text) {
  writeFileSync(`${path}.bak`, readFileSync(path, 'utf8'), 'utf8')
  writeFileSync(path, text, 'utf8')
}

/**
 * 回收站目录。
 * @param {string} managerRoot 管理器数据目录（`<dshHome>/skill-manager`）。
 * @returns {string} 回收站路径。
 */
export function trashDirectory(managerRoot) {
  return join(managerRoot, 'trash')
}

/**
 * 回收站索引文件。
 * @param {string} managerRoot 管理器数据目录。
 * @returns {string} 索引路径。
 */
function trashIndexPath(managerRoot) {
  return join(trashDirectory(managerRoot), 'index.json')
}

/**
 * 读取回收站台账。
 * @param {string} managerRoot 管理器数据目录。
 * @returns {Array<object>} 台账条目。
 */
export function listTrash(managerRoot) {
  const entries = readJson(trashIndexPath(managerRoot), [])
  return Array.isArray(entries) ? entries : []
}

/**
 * 写回收站台账。
 * @param {string} managerRoot 管理器数据目录。
 * @param {Array<object>} entries 条目。
 * @returns {void}
 */
function writeTrash(managerRoot, entries) {
  writeJson(trashIndexPath(managerRoot), entries)
}

/**
 * 改启用/禁用状态。
 * @param {{root: object, skill: object, invocation: {modelInvocable: boolean, userInvocable: boolean}}} input 输入。
 * @returns {object} 结果。
 */
export function setInvocation(input) {
  const checked = assertInsideRoot(input.skill, input.root)
  if (!checked.ok) return checked
  try {
    const text = readFileSync(input.skill.path, 'utf8')
    const next = applyInvocation(text, input.invocation)
    if (next.error) return fail('invalid-frontmatter', next.error)
    if (!next.changed) return { ok: true, changed: false }
    writeSkillFile(input.skill.path, next.text)
    return { ok: true, changed: true }
  } catch (error) {
    return fail('write-failed', String(error?.message || error))
  }
}

/**
 * 改技能名（目录名等于旧名时一并改目录）。
 * @param {{root: object, skill: object, newName: string}} input 输入。
 * @returns {object} 结果。
 */
export function renameSkill(input) {
  const checked = assertInsideRoot(input.skill, input.root)
  if (!checked.ok) return checked
  const newName = String(input.newName ?? '').trim()
  if (!isSkillName(newName)) return fail('invalid-name', `新名字必须是 kebab-case：${newName}`)
  const oldName = input.skill.name
  if (newName === oldName) return { ok: true, changed: false, path: input.skill.path }

  // 先把目标位置全部算清并校验，再动文件：否则"写了 frontmatter 才发现目录被占"会留下
  // 名字与目录不一致的半成品。
  const willRenameDir = input.skill.kind === 'bundle' && input.skill.dirName === oldName
  const targetDir = willRenameDir ? join(input.root.path, newName) : undefined
  const targetFile = input.skill.kind === 'flat' ? join(input.root.path, `${newName}.md`) : undefined
  for (const target of [targetDir, targetFile]) {
    if (!target) continue
    if (!isInside(input.root.path, target)) return fail('outside-root', '目标路径越界')
    if (existsSync(target)) return fail('target-exists', `目标已存在：${target}`)
  }

  try {
    const text = readFileSync(input.skill.path, 'utf8')
    const next = applyName(text, newName)
    if (next.error) return fail('invalid-frontmatter', next.error)
    writeFileSync(input.skill.path, next.text, 'utf8')

    let path = input.skill.path
    if (targetDir) {
      movePath(dirname(input.skill.path), targetDir)
      path = join(targetDir, 'SKILL.md')
    } else if (targetFile) {
      movePath(input.skill.path, targetFile)
      path = targetFile
    }
    return { ok: true, changed: true, path }
  } catch (error) {
    return fail('write-failed', String(error?.message || error))
  }
}

/**
 * 软删除：移进回收站并记账。
 * @param {{root: object, skill: object, managerRoot: string, now?: number}} input 输入。
 * @returns {object} 结果。
 */
export function trashSkill(input) {
  const checked = assertInsideRoot(input.skill, input.root)
  if (!checked.ok) return checked
  const stamp = new Date(input.now ?? Date.now()).toISOString().replace(/[:.]/g, '-')
  const id = `${stamp}-${Math.random().toString(36).slice(2, 8)}`
  const target = join(trashDirectory(input.managerRoot), id)
  try {
    if (!isInside(trashDirectory(input.managerRoot), target)) return fail('outside-root', '回收站路径越界')
    movePath(checked.directory, target)
    const entries = listTrash(input.managerRoot)
    entries.push({
      id,
      name: input.skill.name,
      dirName: input.skill.dirName,
      kind: input.skill.kind,
      from: input.skill.path,
      rootId: input.skill.rootId,
      at: new Date(input.now ?? Date.now()).toISOString(),
    })
    writeTrash(input.managerRoot, entries)
    return { ok: true, id }
  } catch (error) {
    return fail('move-failed', String(error?.message || error))
  }
}

/**
 * 从回收站还原。
 * @param {{managerRoot: string, id: string, roots: Array<object>}} input 输入。
 * @returns {object} 结果。
 */
export function restoreTrash(input) {
  const entries = listTrash(input.managerRoot)
  const entry = entries.find((item) => item.id === input.id)
  if (!entry) return fail('not-found', '回收站里没有这条记录')
  const source = join(trashDirectory(input.managerRoot), entry.id)
  if (!existsSync(source)) return fail('not-found', '回收站里的文件已经不在了')
  const root = (input.roots ?? []).find((item) => item.id === entry.rootId)
  if (!root) return fail('root-missing', `原技能根 ${entry.rootId} 已不在配置里`)
  if (!isInside(root.path, entry.from)) return fail('outside-root', '还原目标越界')
  if (existsSync(entry.from)) return fail('target-exists', `原位置已有同名技能：${entry.from}`)
  try {
    movePath(source, entry.kind === 'flat' ? entry.from : dirname(entry.from))
    writeTrash(input.managerRoot, entries.filter((item) => item.id !== input.id))
    return { ok: true, path: entry.from }
  } catch (error) {
    return fail('move-failed', String(error?.message || error))
  }
}

/**
 * 清空回收站（真删）。
 * @param {{managerRoot: string, id?: string}} input 输入。
 * @returns {object} 结果。
 */
export function purgeTrash(input) {
  const entries = listTrash(input.managerRoot)
  const doomed = input.id ? entries.filter((item) => item.id === input.id) : entries
  if (input.id && doomed.length === 0) return fail('not-found', '回收站里没有这条记录')
  try {
    for (const entry of doomed) {
      const target = join(trashDirectory(input.managerRoot), entry.id)
      if (!isInside(trashDirectory(input.managerRoot), target)) continue
      rmSync(target, { recursive: true, force: true })
    }
    writeTrash(input.managerRoot, input.id ? entries.filter((item) => item.id !== input.id) : [])
    return { ok: true, purged: doomed.length }
  } catch (error) {
    return fail('delete-failed', String(error?.message || error))
  }
}

/**
 * 把技能复制到另一个根（"提升/降低优先级"）。
 * @param {{skill: object, targetRoot: object, overwrite?: boolean}} input 输入。
 * @returns {object} 结果。
 */
export function copySkill(input) {
  if (!input.targetRoot?.path) return fail('bad-root', '目标根无效')
  if (!input.skill?.path || !existsSync(input.skill.path)) return fail('not-found', '源技能不存在')
  const dirName = input.skill.dirName || input.skill.name
  const target = input.skill.kind === 'flat'
    ? join(input.targetRoot.path, `${dirName}.md`)
    : join(input.targetRoot.path, dirName)
  if (!isInside(input.targetRoot.path, target)) return fail('outside-root', '目标路径越界')
  if (existsSync(target) && input.overwrite !== true) return fail('target-exists', `目标已存在：${target}`)
  try {
    mkdirSync(input.targetRoot.path, { recursive: true })
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    cpSync(input.skill.kind === 'flat' ? input.skill.path : dirname(input.skill.path), target, { recursive: true })
    if (input.skill.kind === 'flat') return { ok: true, path: join(target, `${dirName}.md`) }
    return { ok: true, path: join(target, 'SKILL.md') }
  } catch (error) {
    return fail('copy-failed', String(error?.message || error))
  }
}

/**
 * 改技能的分类（`metadata.category`，逗号分隔）。
 *
 * 只动这一个键：其余 frontmatter 与正文原样保留；写盘后**复读校验**
 * （分类真的落进去了、文件仍可解析），不一致就报错，不把半成品留给用户。
 * @param {{root: object, skill: object, categories: unknown}} input 输入。
 * @returns {object} 结果。
 */
export function setCategories(input) {
  const checked = assertInsideRoot(input.skill, input.root)
  if (!checked.ok) return checked
  try {
    const before = readFileSync(input.skill.path, 'utf8')
    const next = applyCategories(before, input.categories)
    if (next.error) return fail('invalid-categories', next.error)
    if (!next.changed) return { ok: true, changed: false, categories: categoriesOfMetadata(readSkillRecord({ text: before }).metadata) }
    writeSkillFile(input.skill.path, next.text)
    // 复读校验：分类必须真的写进去了，而且文件还得能解析出同一个技能名。
    const after = readSkillRecord({ text: readFileSync(input.skill.path, 'utf8') })
    const actual = categoriesOfMetadata(after.metadata)
    const wanted = next.categories ?? []
    if (actual.length !== wanted.length || actual.some((item, index) => item !== wanted[index])) {
      writeSkillFile(input.skill.path, before)
      return fail('verify-failed', `写入后复读不一致（期望 ${wanted.join(', ') || '空'}，实际 ${actual.join(', ') || '空'}），已还原`)
    }
    if (after.name !== readSkillRecord({ text: before }).name) {
      writeSkillFile(input.skill.path, before)
      return fail('verify-failed', '写入后技能名解析异常，已还原')
    }
    return { ok: true, changed: true, categories: actual }
  } catch (error) {
    return fail('write-failed', String(error?.message || error))
  }
}

/**
 * 把一个技能**移到另一个技能根**（换"技能目录"）。
 *
 * 顺序：先按 `replaceSkillDirectory` 复制到目标根（暂存 + 逐文件校验），
 * 校验通过之后才删源；删源失败会把目标回滚掉——**永远只留一份**，
 * 不会出现"两个目录各有一份、模型加载了旧的那份"。
 * @param {{root: object, skill: object, targetRoot: object}} input 输入。
 * @returns {object} 结果。
 */
export function moveSkill(input) {
  const checked = assertInsideRoot(input.skill, input.root)
  if (!checked.ok) return checked
  const targetRoot = input.targetRoot
  if (!targetRoot?.path) return fail('bad-root', '目标技能根无效')
  if (targetRoot.writable === false) return fail('readonly-root', `技能根 ${targetRoot.label} 不可写`)
  if (targetRoot.id === input.root.id) return { ok: true, changed: false, path: input.skill.path }
  const isDirectory = input.skill.kind !== 'flat'
  const dirName = input.skill.dirName || input.skill.name
  const target = isDirectory ? join(targetRoot.path, dirName) : join(targetRoot.path, `${dirName}.md`)
  if (!isInside(targetRoot.path, target)) return fail('outside-root', '目标路径越界')
  if (existsSync(target)) return fail('target-exists', `目标技能目录已存在：${basename(target)}`)
  const source = isDirectory ? dirname(input.skill.path) : input.skill.path
  try {
    mkdirSync(targetRoot.path, { recursive: true })
    const placed = replaceSkillDirectory({ source, target, rootPath: targetRoot.path, isDirectory })
    if (!placed.ok) return { ok: false, error: placed.error }
    try {
      removeWithRetry(source)
    } catch (error) {
      // 回滚目标，避免"移动"变成"复制"。
      try {
        removeWithRetry(target)
      } catch {
        return fail('move-failed', `已复制到 ${target}，但删除原位置失败且回滚失败，请手工清理：${String(error?.message || error)}`)
      }
      return fail('move-failed', `删除原位置失败，已回滚：${String(error?.message || error)}`)
    }
    return { ok: true, changed: true, path: isDirectory ? join(target, 'SKILL.md') : target, rootId: targetRoot.id }
  } catch (error) {
    return fail('move-failed', String(error?.message || error))
  }
}

/**
 * 新建一个技能骨架。
 * @param {{root: object, name: string, description: string, whenToUse?: string}} input 输入。
 * @returns {object} 结果。
 */
export function createSkill(input) {
  const name = String(input.name ?? '').trim()
  const description = String(input.description ?? '').trim()
  if (!isSkillName(name)) return fail('invalid-name', '技能名必须是 kebab-case（小写字母/数字/连字符）')
  if (!description) return fail('missing-description', 'description 必填，模型靠它决定是否加载这个技能')
  const dir = join(input.root.path, name)
  if (!isInside(input.root.path, dir)) return fail('outside-root', '目标路径越界')
  if (existsSync(dir) || existsSync(join(input.root.path, `${name}.md`))) {
    return fail('target-exists', `${name} 在这个根里已经存在`)
  }
  try {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'SKILL.md')
    writeFileSync(file, renderSkillTemplate({ name, description, whenToUse: input.whenToUse }), 'utf8')
    return { ok: true, path: file }
  } catch (error) {
    return fail('write-failed', String(error?.message || error))
  }
}
