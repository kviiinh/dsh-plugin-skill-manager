/**
 * SKILL.md 的 frontmatter 读写与校验。
 *
 * 这里刻意**不**引入 YAML 依赖：DSH 只读 `name` / `description` / `whenToUse` /
 * `disable-model-invocation` / `user-invocable` 五个键（外加不解释、只透传的
 * `metadata`），而这台机器上真正在跑的技能（钉钉那 16 个、office 三个）用的都是
 * 很规矩的子集。于是我们实现一个够用且**可预测**的解析器：
 *
 *   - 支持 `key: value`、`key:` + 缩进块（嵌套 map / `- item` 列表）、行内 `[a, b]`；
 *   - 支持单双引号（含转义）、`#` 注释；
 *   - 不支持的语法（多行块标量 `|` / `>`、锚点 `&` / 别名 `*`、非字符串键）一律
 *     记进 `issues`，由界面显式提示，**绝不猜**。
 *
 * 校验规则与 `@deepseek-ai/dsh-skill` / `dsh-skill-filesystem` 对齐：
 * name 必须 kebab-case，description 必填，两个 invocation 键走严格布尔文法，
 * 非法值会让 DSH 静默丢弃整个技能（模型侧连诊断都看不到）——管理器界面正是
 * 用来把这类"看不见的丢弃"暴露出来的地方。
 *
 * @module dsh-plugin-skill-manager/lib/frontmatter
 */

/** DSH 认的技能名文法（`@deepseek-ai/dsh-skill` 的 isSkillName）。 */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 受严格布尔文法约束的两个 frontmatter 键。 */
export const INVOCATION_KEYS = Object.freeze({
  model: 'disable-model-invocation',
  user: 'user-invocable',
})

/** 分类上限（界面与宿主共用同一条规则）。 */
export const MAX_CATEGORIES = 5

/** frontmatter 里分类的键名（位于 `metadata` 下）。 */
export const CATEGORY_KEY = 'category'

const TRUE_TOKENS = new Set(['true', 'yes', 'on', '1'])
const FALSE_TOKENS = new Set(['false', 'no', 'off', '0'])

/**
 * 是否为合法技能名。
 * @param {unknown} value 待判定值。
 * @returns {boolean} 合法返回 true。
 */
export function isSkillName(value) {
  return typeof value === 'string' && SKILL_NAME_RE.test(value)
}

/**
 * 把严格布尔文法的原始标量解析成布尔。
 * @param {unknown} raw 原始值（bool 或字符串）。
 * @returns {{present: boolean, value?: boolean, valid: boolean}} 解析结果。
 */
export function parseStrictBoolean(raw) {
  if (raw === undefined) return { present: false, valid: true }
  if (typeof raw === 'boolean') return { present: true, value: raw, valid: true }
  if (typeof raw === 'string') {
    const token = raw.trim().toLowerCase()
    if (TRUE_TOKENS.has(token)) return { present: true, value: true, valid: true }
    if (FALSE_TOKENS.has(token)) return { present: true, value: false, valid: true }
  }
  return { present: true, valid: false }
}

/**
 * 切出 frontmatter 块与正文。
 * @param {string} text 文件内容。
 * @returns {{frontmatter: string, body: string, lines: string[], error?: string}} 切分结果。
 */
export function splitFrontmatter(text) {
  const source = String(text ?? '')
  const lines = source.split(/\r?\n/)
  let index = 0
  // 允许文件开头的 BOM 与空行；DSH 要求 frontmatter 出现在最前面。
  if (lines.length > 0 && lines[0].charCodeAt(0) === 0xfeff) lines[0] = lines[0].slice(1)
  while (index < lines.length && lines[index].trim() === '') index += 1
  if (index >= lines.length || lines[index].trim() !== '---') {
    return { frontmatter: '', body: source, lines: [], error: '第 1 行不是 `---`：没有 YAML frontmatter' }
  }
  const start = index + 1
  let end = -1
  for (let at = start; at < lines.length; at += 1) {
    const trimmed = lines[at].trim()
    if (trimmed === '---' || trimmed === '...') {
      end = at
      break
    }
  }
  if (end === -1) {
    return { frontmatter: '', body: source, lines: [], error: 'frontmatter 没有结束的 `---`' }
  }
  return {
    frontmatter: lines.slice(start, end).join('\n'),
    body: lines.slice(end + 1).join('\n'),
    lines: lines.slice(start, end),
  }
}

/**
 * 去掉值后面的行内注释（引号内的 `#` 不算注释）。
 * @param {string} value 原始值文本。
 * @returns {string} 去注释后的文本。
 */
function stripComment(value) {
  let quote = ''
  for (let at = 0; at < value.length; at += 1) {
    const ch = value[at]
    if (quote) {
      if (ch === '\\' && quote === '"') at += 1
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '#' && (at === 0 || /\s/.test(value[at - 1]))) return value.slice(0, at)
  }
  return value
}

/**
 * 解析一个标量（引号 / 布尔 / 数字 / 行内数组 / 裸字符串）。
 * @param {string} raw 原始文本。
 * @returns {unknown} 解析后的值。
 */
function parseScalar(raw) {
  const text = stripComment(String(raw ?? '')).trim()
  if (text === '') return ''
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      return JSON.parse(text)
    } catch {
      return text.slice(1, -1)
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replace(/''/g, "'")
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    return splitInlineList(text.slice(1, -1)).map((item) => parseScalar(item))
  }
  if (text === '{}') return {}
  const lowered = text.toLowerCase()
  if (TRUE_TOKENS.has(lowered) && /^(true|yes|on)$/.test(lowered)) return true
  if (FALSE_TOKENS.has(lowered) && /^(false|no|off)$/.test(lowered)) return false
  return text
}

/**
 * 按顶层逗号切分行内数组（尊重引号）。
 * @param {string} inner 括号内的文本。
 * @returns {string[]} 元素文本。
 */
function splitInlineList(inner) {
  const parts = []
  let quote = ''
  let current = ''
  for (let at = 0; at < inner.length; at += 1) {
    const ch = inner[at]
    if (quote) {
      current += ch
      if (ch === '\\' && quote === '"') {
        current += inner[at + 1] ?? ''
        at += 1
      } else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === ',') {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim() !== '' || parts.length > 0) parts.push(current)
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

/** 明显不是我们子集语法的行（块标量、锚点、别名、非字符串键）。 */
function detectUnsupported(line) {
  const text = line.trim()
  if (text === '' || text.startsWith('#')) return undefined
  if (/^[^:\s]+:\s*[|>][-+]?\s*$/.test(text)) return '不支持块标量（| / >）'
  if (/^[&*]/.test(text)) return '不支持 YAML 锚点 / 别名'
  if (/^\?\s/.test(text)) return '不支持复杂键'
  return undefined
}

/**
 * 解析 frontmatter 行集合。
 * @param {string[]} lines frontmatter 内容行。
 * @returns {{data: Record<string, unknown>, issues: string[]}} 解析结果。
 */
export function parseFrontmatterLines(lines) {
  const issues = []
  /** 归一化后的条目：{ indent, kind: 'key' | 'item', key?, value? } */
  const entries = []

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const unsupported = detectUnsupported(rawLine)
    if (unsupported) {
      issues.push(`${unsupported}：${trimmed.slice(0, 60)}`)
      continue
    }
    const indent = rawLine.length - rawLine.replace(/^[ \t]+/, '').length
    if (trimmed === '-' || trimmed.startsWith('- ')) {
      entries.push({ indent, kind: 'item', value: parseScalar(trimmed.slice(1)) })
      continue
    }
    const match = /^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/.exec(trimmed)
    if (!match) {
      issues.push(`无法解析的行：${trimmed.slice(0, 60)}`)
      continue
    }
    entries.push({ indent, kind: 'key', key: match[1], value: parseScalar(match[2] ?? '') })
  }

  if (entries.length === 0) return { data: {}, issues }

  let cursor = 0
  /**
   * 按缩进递归建块：同一层的「列表项」建成数组，否则建成对象。
   * @param {number} indent 本层缩进宽度。
   * @returns {unknown} 本层容器。
   */
  const buildBlock = (indent) => {
    const isList = entries[cursor]?.kind === 'item'
    const container = isList ? [] : {}
    while (cursor < entries.length) {
      const entry = entries[cursor]
      if (entry.indent < indent) break
      if (entry.indent > indent) {
        // 上一轮已经消费过嵌套块；这里只可能是非法回缩，跳过并记账。
        issues.push(`缩进异常，已忽略：${entry.key ?? String(entry.value).slice(0, 40)}`)
        cursor += 1
        continue
      }
      if (isList) {
        if (entry.kind !== 'item') break
        cursor += 1
        container.push(entry.value)
        continue
      }
      if (entry.kind !== 'key') break
      cursor += 1
      const next = entries[cursor]
      container[entry.key] = next && next.indent > entry.indent ? buildBlock(next.indent) : entry.value
    }
    return container
  }

  const data = buildBlock(entries[0].indent)
  return { data: data && typeof data === 'object' && !Array.isArray(data) ? data : {}, issues }
}

/**
 * 从文件内容解析出技能记录（含校验结果）。
 * @param {{text: string, path?: string, rootId?: string}} input 输入。
 * @returns {object} 技能记录。
 */
export function readSkillRecord(input) {
  const text = String(input.text ?? '')
  const split = splitFrontmatter(text)
  if (split.error) {
    return {
      valid: false,
      issues: [split.error],
      data: {},
      body: text,
    }
  }
  const { data, issues } = parseFrontmatterLines(split.lines)
  const name = typeof data.name === 'string' ? data.name.trim() : ''
  const description = typeof data.description === 'string' ? data.description.trim() : ''

  if (!name) issues.push('缺少 `name`')
  else if (!isSkillName(name)) issues.push(`\`name\` 不是 kebab-case：${name}`)
  if (!description) issues.push('缺少 `description`')

  const modelFlag = parseStrictBoolean(data[INVOCATION_KEYS.model])
  const userFlag = parseStrictBoolean(data[INVOCATION_KEYS.user])
  if (!modelFlag.valid) issues.push(`\`${INVOCATION_KEYS.model}\` 不是合法布尔值`)
  if (!userFlag.valid) issues.push(`\`${INVOCATION_KEYS.user}\` 不是合法布尔值`)

  const whenToUse = typeof data.whenToUse === 'string' ? data.whenToUse.trim() : ''
  return {
    valid: issues.length === 0,
    issues,
    name: name || undefined,
    description,
    whenToUse: whenToUse || undefined,
    metadata: data.metadata && typeof data.metadata === 'object' ? data.metadata : undefined,
    // 注意语义方向：`disable-model-invocation: true` 表示**不许**模型调用，
    // 而 `user-invocable: false` 也表示不许（两者都是"负面"键）。
    invocation: {
      modelInvocable: modelFlag.present ? modelFlag.value !== true : true,
      userInvocable: userFlag.present ? userFlag.value !== false : true,
    },
    rawKeys: Object.keys(data),
    data,
    body: split.body,
  }
}

/**
 * 覆写 frontmatter 里某个标量键，保留其余内容与正文。
 * @param {string} text 原文件内容。
 * @param {Record<string, string | undefined>} values 键 → 新值；值为 undefined 表示删除该键。
 * @returns {{text: string, changed: boolean, error?: string}} 结果。
 */
export function rewriteFrontmatter(text, values) {
  const split = splitFrontmatter(text)
  if (split.error) return { text, changed: false, error: split.error }
  // 保留原文件的换行风格（Windows 上大多是 CRLF），别因为改一个键就把整个文件重写一遍。
  const eol = String(text).includes('\r\n') ? '\r\n' : '\n'
  const removed = new Set(Object.keys(values))
  const kept = split.lines.filter((line) => {
    const match = /^([A-Za-z0-9_.-]+):/.exec(line.trim())
    if (!match) return true
    return !removed.has(match[1])
  })
  const appended = []
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue
    appended.push(`${key}: ${value}`)
  }
  const lines = [...kept, ...appended]
  const head = ['---', ...lines, '---'].join(eol)
  const body = eol === '\n' ? split.body : split.body.replace(/\n/g, eol)
  const next = body === '' ? `${head}${eol}` : `${head}${eol}${body}`
  return { text: next, changed: next !== text }
}

/** 把布尔渲染成 YAML 标量。 */
function boolText(value) {
  return value === true ? 'true' : 'false'
}

/**
 * 用 DSH 原生语义表达禁用：`disable-model-invocation` / `user-invocable`。
 * 值为「默认许可」时删除该键，避免在文件里堆冗余。
 * @param {string} text 原文件内容。
 * @param {{modelInvocable: boolean, userInvocable: boolean}} invocation 目标策略。
 * @returns {{text: string, changed: boolean, error?: string}} 结果。
 */
export function applyInvocation(text, invocation) {
  return rewriteFrontmatter(text, {
    [INVOCATION_KEYS.model]: invocation.modelInvocable === false ? boolText(true) : undefined,
    [INVOCATION_KEYS.user]: invocation.userInvocable === false ? boolText(false) : undefined,
  })
}

/**
 * 改写技能名（目录名不动；界面会在目录名等于旧名时同时改目录）。
 * @param {string} text 原文件内容。
 * @param {string} newName 新名字。
 * @returns {{text: string, changed: boolean, error?: string}} 结果。
 */
export function applyName(text, newName) {
  return rewriteFrontmatter(text, { name: newName })
}

/**
 * 从 `metadata` 里取分类列表。
 *
 * 兼容三种写法（都出现在真实技能里）：
 *   - `category: a, b`（逗号分隔的标量 —— 管理器自己写出去的就是这种）
 *   - `category: [a, b]`（行内数组）
 *   - `category:` + `- a` 列表块（解析后就是数组）
 * @param {unknown} metadata frontmatter 的 metadata。
 * @returns {string[]} 分类列表（去重、去空白）。
 */
export function categoriesOfMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return []
  const raw = metadata[CATEGORY_KEY]
  if (raw === undefined || raw === null) return []
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string' ? raw.split(',') : typeof raw === 'number' ? [raw] : []
  const out = []
  for (const item of list) {
    const value = String(item ?? '').trim()
    if (value === '' || out.includes(value)) continue
    out.push(value)
  }
  return out
}

/**
 * 规范化"要写入的分类列表"：去空白、去重、校验数量与字符。
 * @param {unknown} input 界面传上来的分类。
 * @returns {{ok: true, categories: string[]} | {ok: false, error: string}} 结果。
 */
function normalizeCategories(input) {
  const list = Array.isArray(input) ? input : []
  const out = []
  for (const item of list) {
    const value = String(item ?? '').trim()
    if (value === '') continue
    // 落盘用逗号分隔，所以分类名里不能有逗号/换行，否则读回来会被拆成两个。
    if (/[,\r\n]/.test(value)) return { ok: false, error: `分类名不能包含逗号或换行：${value}` }
    if (!out.includes(value)) out.push(value)
  }
  if (out.length > MAX_CATEGORIES) return { ok: false, error: `分类最多 ${MAX_CATEGORIES} 个` }
  return { ok: true, categories: out }
}

/** 一行的缩进宽度。 */
function indentOf(line) {
  return line.length - line.replace(/^[ \t]+/, '').length
}

/**
 * 写 `metadata.category`（**只动这一个键**，其余 frontmatter 与正文原样保留）。
 *
 * 分类以逗号分隔的标量落盘：`metadata:` 块里的 `  category: a, b`。
 * 没有分类时删掉这一行；连 `metadata:` 块都没有时才新建。
 * @param {string} text 原文件内容。
 * @param {unknown} categories 目标分类列表。
 * @returns {{text: string, changed: boolean, categories?: string[], error?: string}} 结果。
 */
export function applyCategories(text, categories) {
  const split = splitFrontmatter(text)
  if (split.error) return { text, changed: false, error: split.error }
  const normalized = normalizeCategories(categories)
  if (!normalized.ok) return { text, changed: false, error: normalized.error }
  const wanted = normalized.categories
  // 按用户要求：逗号后**不留空格**（`category: a,b`），读回来时按逗号切分并 trim。
  // `category:` 的缩进跟随 metadata 块的子缩进（YAML 合法缩进不一定是 2 空格）。
  const lineAt = (indent) => (wanted.length ? `${' '.repeat(indent)}${CATEGORY_KEY}: ${wanted.join(',')}` : undefined)
  const nextLine = lineAt(2)
  /** 取 metadata 块的子缩进（块内第一行的缩进）；空块按 2 空格。 */
  const childIndentOf = (from, to) => {
    for (let index = from; index < to; index += 1) {
      if (lines[index].trim() !== '') return indentOf(lines[index])
    }
    return 2
  }

  const eol = String(text).includes('\r\n') ? '\r\n' : '\n'
  const lines = [...split.lines]
  const isTopLevel = (line) => line.trim() !== '' && indentOf(line) === 0
  let metaAt = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (isTopLevel(lines[index]) && /^metadata:\s*/.test(lines[index])) {
      metaAt = index
      break
    }
  }

  if (metaAt === -1) {
    // 没有 metadata 块：要写分类就新建一个，不写就什么都不做。
    if (!nextLine) return { text, changed: false, categories: wanted }
    lines.push('metadata:', nextLine)
  } else {
    const inline = String(lines[metaAt].slice(lines[metaAt].indexOf(':') + 1)).trim()
    // `metadata: {}` 视作空块；其它行内写法（`metadata: {category: x}`）不猜，直接报错。
    if (inline !== '' && inline !== '{}') {
      return { text, changed: false, error: 'metadata 是行内写法，管理器不会改写它（请改成缩进块后再试）' }
    }
    if (inline === '{}') lines[metaAt] = 'metadata:'
    // metadata 块的范围：紧随其后、缩进更深的行。
    let blockEnd = metaAt + 1
    while (blockEnd < lines.length && (lines[blockEnd].trim() === '' || indentOf(lines[blockEnd]) > 0)) blockEnd += 1
    // 只认 metadata 的**直接子项** `category:`：更深层的同名键（例如
    // `metadata:\n  requires:\n    category: x`）不是分类，不能被改写或误删。
    const childIndent = childIndentOf(metaAt + 1, blockEnd)
    const nextLine = lineAt(childIndent)
    let categoryAt = -1
    for (let index = metaAt + 1; index < blockEnd; index += 1) {
      if (indentOf(lines[index]) === childIndent && /^\s*category:\s*/.test(lines[index])) {
        categoryAt = index
        break
      }
    }
    if (categoryAt === -1) {
      if (nextLine) {
        // 插在块内最后一行之后（别插到块尾的空行后面）。
        let insertAt = blockEnd
        while (insertAt > metaAt + 1 && lines[insertAt - 1].trim() === '') insertAt -= 1
        lines.splice(insertAt, 0, nextLine)
      }
    } else {
      let removeEnd = categoryAt + 1
      const categoryIndent = indentOf(lines[categoryAt])
      while (removeEnd < blockEnd && lines[removeEnd].trim() !== '' && indentOf(lines[removeEnd]) > categoryIndent) removeEnd += 1
      lines.splice(categoryAt, removeEnd - categoryAt, ...nextLine ? [nextLine] : [])
    }
  }

  const head = ['---', ...lines, '---'].join(eol)
  const body = eol === '\n' ? split.body : split.body.replace(/\n/g, eol)
  const next = body === '' ? `${head}${eol}` : `${head}${eol}${body}`
  return { text: next, changed: next !== text, categories: wanted }
}

/**
 * 生成一个新技能的最小 SKILL.md。
 * @param {{name: string, description: string, whenToUse?: string}} input 输入。
 * @returns {string} 文件内容。
 */
export function renderSkillTemplate(input) {
  return [
    '---',
    `name: ${input.name}`,
    `description: ${input.description}`,
    ...input.whenToUse ? [`whenToUse: ${input.whenToUse}`] : [],
    '---',
    '',
    `# ${input.name}`,
    '',
    '在这里写技能的执行指令。引用的 `references/`、`scripts/`、`assets/` 资源',
    '请用相对于本文件所在目录的路径。',
    '',
  ].join('\n')
}
