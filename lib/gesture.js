/**
 * `/skill/<技能名>` 手势的实现（Host 半边）。
 *
 * 为什么不用内置的那条路：`@deepseek-ai/dsh-tool-skill` 只在 `agent/pre-step`
 * 里用 `SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g` 认
 * `/name`，第二个斜杠会让 `/skill/name` 整个失配。用户要的是 `/skill/<技能>`，
 * 于是我们自己挂一个同样形状的 listener，用自己的正则匹配，然后把技能正文
 * 作为一条 user 角色的 instructions 消息追加进这一步。
 *
 * 关键点（都是照抄上游语义，避免和内置手势打架）：
 *
 *   - 只扫 `message.source.kind === 'user'` 的**直接用户输入**，别的来源不能伪造；
 *   - 同名去重、按出现顺序注入；
 *   - 只注入 `userInvocable !== false` 的技能，与内置手势一致；
 *   - 渲染成与 `renderSkillContent` **逐字节相同**的 `<skill_content>` 包裹，
 *     这样无论走哪条入口，模型看到的都是同一个形状。
 *
 * `@deepseek-ai/dsh-skill` / `@deepseek-ai/dsh-llm` 若在当前解析路径里可用就
 * 直接用它们的实现（渲染/建消息），否则用这里的等价实现——插件装在 profile 里
 * 时两者都在，但开发态（直接跑测试、符号链接安装）不一定解析得到。
 *
 * @module dsh-plugin-skill-manager/lib/gesture
 */

import { randomUUID } from 'node:crypto'
import { SKILL_NAME_RE } from './frontmatter.js'

/** 我们自己的手势正则：`/skill/<技能>` 与两级 `/skill/<技能目录>/<技能>`。 */
export const SKILL_PATH_GESTURE = /(^|\s)\/skill\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/([a-z0-9]+(?:-[a-z0-9]+)*))?(?=\s|$)/g

/**
 * 转义 XML 属性值（与上游 escapeAttr 一致）。
 * @param {string} value 原始值。
 * @returns {string} 转义结果。
 */
export function escapeAttr(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

/**
 * 转义正文（与上游 escapeText 一致）。
 * @param {string} value 原始值。
 * @returns {string} 转义结果。
 */
export function escapeText(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * 渲染资源提示（与上游 renderResourceHint 逐字一致）。
 * @param {object} skill 技能定义。
 * @returns {string[]} 提示行。
 */
export function renderResourceHint(skill) {
  const base = skill?.resourceBase
  if (base === undefined || base === null) {
    return [
      `Resources for this skill are managed by provider "${escapeText(skill?.provider ?? 'unknown')}".`,
      'Load referenced resources only as needed.',
    ]
  }
  if (base.kind === 'directory') {
    return [
      `Base directory for this skill: ${escapeText(base.path)}`,
      'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
    ]
  }
  if (base.kind === 'url') {
    return [
      `Base URL for this skill: ${escapeText(base.url)}`,
      'Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.',
    ]
  }
  return [
    `Resources for this skill: ${escapeText(base.description ?? '')}`,
    'Load referenced resources only as needed.',
  ]
}

/**
 * 渲染 `<skill_content>`（与上游 renderSkillContent 逐字一致）。
 * @param {object} skill 技能定义（含 name/content/provider/resourceBase）。
 * @returns {string} 完整文本块。
 */
export function renderSkillContent(skill) {
  return [
    `<skill_content name="${escapeAttr(skill.name)}">`,
    '<skill_resources>',
    ...renderResourceHint(skill),
    '</skill_resources>',
    '',
    '<skill_instructions>',
    skill.content,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}

/**
 * 建一条 user 角色消息（与上游 createUserMessage 的运行时形状一致：冻结 + uuid）。
 * @param {{content: Array<object>, source: object}} input 输入。
 * @returns {object} 冻结后的消息。
 */
export function createUserMessageMirror(input) {
  const message = { ...input, role: 'user', id: randomUUID() }
  const frozen = structuredClone(message)
  const freeze = (node) => {
    if (!node || typeof node !== 'object' || Object.isFrozen(node)) return node
    for (const value of Object.values(node)) freeze(value)
    return Object.freeze(node)
  }
  return freeze(frozen)
}

/**
 * 尝试加载上游实现（渲染函数与建消息函数）。
 * @returns {Promise<{render?: Function, createMessage?: Function}>} 可用的上游实现。
 */
export async function loadUpstreamRuntime() {
  const runtime = {}
  try {
    const skillPkg = await import('@deepseek-ai/dsh-skill')
    if (typeof skillPkg.renderSkillContent === 'function') runtime.render = skillPkg.renderSkillContent
  } catch {
    /* 开发态解析不到是正常的，用本地等价实现 */
  }
  try {
    const llmPkg = await import('@deepseek-ai/dsh-llm')
    if (typeof llmPkg.createUserMessage === 'function') runtime.createMessage = llmPkg.createUserMessage
  } catch {
    /* 同上 */
  }
  return runtime
}

/**
 * 从这一步的 claimed 消息里收集 `/skill/...` 手势。
 *
 * 支持两种写法：
 *   - `/skill/<技能>`            —— 走注册表（含插件内嵌技能）；
 *   - `/skill/<技能目录>/<技能>`  —— 明确指定扫描根，直接读该根下那一份（两级路径的意义
 *     就是"我就要这个根里的版本"，所以不拿被遮蔽规则覆盖掉用户的选择）。
 *
 * @param {Array<object>} messages 消息批次。
 * @returns {Array<{root?: string, name: string, raw: string}>} 去重后的手势（按出现顺序）。
 */
export function collectSkillPaths(messages) {
  const found = []
  const seen = new Set()
  for (const message of messages ?? []) {
    if (message?.source?.kind !== 'user') continue
    for (const block of message.content ?? []) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue
      for (const match of block.text.matchAll(SKILL_PATH_GESTURE)) {
        const first = match[2]
        const second = match[3]
        const entry = second ? { root: first, name: second, raw: `/skill/${first}/${second}` } : { name: first, raw: `/skill/${first}` }
        const key = `${entry.root ?? ''}/${entry.name}`
        if (seen.has(key)) continue
        seen.add(key)
        found.push(entry)
      }
    }
  }
  return found
}

/**
 * 造一个 `agent/pre-step` 监听器。
 *
 * @param {object} input 依赖。
 * @param {(name: string, options: object) => Promise<object | undefined>} input.getSkill 取技能定义（`ctx.skills.get`）。
 * @param {(root: string, name: string) => Promise<object | undefined>} [input.getRootedSkill] 两级写法：直接取某个技能根下的那一份。
 * @param {Function} [input.render] 渲染函数，缺省用本地实现。
 * @param {Function} [input.createMessage] 建消息函数，缺省用本地实现。
 * @param {(message: string) => void} [input.warn] 诊断输出。
 * @returns {(event: object, next: Function) => Promise<object>} Cordis 监听器。
 */
export function createSkillPathGesture(input) {
  const render = input.render ?? renderSkillContent
  const createMessage = input.createMessage ?? createUserMessageMirror

  /**
   * 造一条"技能不可用"的说明消息（不伪造内容）。
   * @param {string} label 展示用的写法。
   * @param {string} reason 原因。
   * @returns {object} 消息。
   */
  const unavailable = (label, reason) => createMessage({
    content: [{
      type: 'text',
      text: `<skill_content name="${escapeAttr(label)}">\n<skill_error>\n${escapeText(reason)} Do not invent its instructions; tell the user it is unavailable.\n</skill_error>\n</skill_content>`,
    }],
    source: { kind: 'skill-invocation', name: label, form: 'instructions' },
  })

  return async function skillPathGesture(event, next) {
    const decision = await next()
    if (decision?.kind === 'reject') return decision
    const requests = collectSkillPaths(event?.messages)
    if (requests.length === 0) return decision

    const agent = event.agent
    const signal = event.signal
    signal?.throwIfAborted?.()
    const injections = []
    for (const request of requests) {
      if (!SKILL_NAME_RE.test(request.name)) continue
      if (request.root && SKILL_NAME_RE.test(request.root) && typeof input.getRootedSkill === 'function') {
        let rooted
        try {
          rooted = await input.getRootedSkill(request.root, request.name)
        } catch (error) {
          input.warn?.(`读取 ${request.raw} 失败：${String(error?.message || error)}`)
          continue
        }
        signal?.throwIfAborted?.()
        if (!rooted) {
          injections.push(unavailable(request.raw, `No skill named "${request.name}" exists in skill root "${request.root}".`))
          continue
        }
        if (rooted.invocation?.userInvocable === false) {
          input.warn?.(`技能 ${request.raw} 不允许用户直接调用，已跳过`)
          continue
        }
        injections.push(createMessage({
          content: [{ type: 'text', text: render(rooted) }],
          source: { kind: 'skill-invocation', name: request.name, form: 'instructions' },
        }))
        continue
      }

      let skill
      try {
        skill = await input.getSkill(request.name, { cwd: agent?.session?.header?.cwd, signal, scope: agent })
      } catch (error) {
        input.warn?.(`读取技能 ${request.name} 失败：${String(error?.message || error)}`)
        continue
      }
      signal?.throwIfAborted?.()
      if (!skill) {
        // 明确告知模型：这条手势没命中，别自己编技能内容。
        injections.push(unavailable(request.raw, `No skill named "${request.name}" is currently available.`))
        continue
      }
      if (skill.invocation?.userInvocable === false) {
        input.warn?.(`技能 ${request.name} 不允许用户直接调用，已跳过`)
        continue
      }
      injections.push(createMessage({
        content: [{ type: 'text', text: render(skill) }],
        source: { kind: 'skill-invocation', name: request.name, form: 'instructions' },
      }))
    }
    if (injections.length === 0) return decision
    return { ...decision, messages: [...decision.messages, ...injections] }
  }
}
