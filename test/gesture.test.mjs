/**
 * `/skill/<技能>` 手势：命名收集、渲染一致性、注入行为。
 *
 * @module dsh-plugin-skill-manager/test/gesture.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  collectSkillPaths,
  createSkillPathGesture,
  createUserMessageMirror,
  escapeAttr,
  renderSkillContent,
} from '../lib/gesture.js'

/** 造一条 source.kind === 'user' 的文本消息。 */
function userMessage(text) {
  return { source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

test('只认直接用户输入里的 /skill/<技能>，支持两级写法并去重', () => {
  const found = collectSkillPaths([
    userMessage('/skill/dingtalk-calendar 帮我看看今天的日程'),
    userMessage('/skill/dingtalk-calendar /skill/office-xlsx 再来一个'),
    userMessage('/skill/user-agents/dingtalk-calendar 指定目录'),
    { source: { kind: 'system' }, content: [{ type: 'text', text: '/skill/evil-skill' }] },
    { source: { kind: 'user' }, content: [{ type: 'tool_call', text: '/skill/also-ignored' }] },
  ])
  assert.deepEqual(found, [
    { name: 'dingtalk-calendar', raw: '/skill/dingtalk-calendar' },
    { name: 'office-xlsx', raw: '/skill/office-xlsx' },
    { root: 'user-agents', name: 'dingtalk-calendar', raw: '/skill/user-agents/dingtalk-calendar' },
  ])
})

test('内置的 /name 手势与其它斜杠写法都不匹配', () => {
  assert.deepEqual(collectSkillPaths([userMessage('/dingtalk-calendar')]), [])
  assert.deepEqual(collectSkillPaths([userMessage('/skill/')]), [])
  assert.deepEqual(collectSkillPaths([userMessage('/skill/Bad_Name')]), [])
  assert.deepEqual(collectSkillPaths([userMessage('看 /usr/bin 和 5/8')]), [])
  // 与内置手势一致：前面必须有空白或位于行首，否则不算手势（避免路径误伤）。
  assert.deepEqual(collectSkillPaths([userMessage('前缀/skill/demo-skill')]), [])
  assert.deepEqual(collectSkillPaths([userMessage('  /skill/demo-skill')]), [{ name: 'demo-skill', raw: '/skill/demo-skill' }])
  // 三级路径不是合法技能地址：整条不匹配，而不是猜成前两级。
  assert.deepEqual(collectSkillPaths([userMessage('/skill/a-b/c-d/e-f')]), [])
})

test('渲染与上游 <skill_content> 模板逐字一致', () => {
  const managed = renderSkillContent({ name: 'demo-skill', provider: 'filesystem', content: '正文' })
  assert.equal(
    managed,
    [
      '<skill_content name="demo-skill">',
      '<skill_resources>',
      'Resources for this skill are managed by provider "filesystem".',
      'Load referenced resources only as needed.',
      '</skill_resources>',
      '',
      '<skill_instructions>',
      '正文',
      '</skill_instructions>',
      '</skill_content>',
    ].join('\n'),
  )

  const directory = renderSkillContent({
    name: 'demo-skill',
    provider: 'filesystem',
    content: '正文',
    resourceBase: { kind: 'directory', path: 'D:\\skills\\demo-skill' },
  })
  assert.match(directory, /Base directory for this skill: D:\\skills\\demo-skill/)
  assert.match(directory, /Resolve relative paths mentioned by this skill against the base directory/)

  assert.equal(escapeAttr('a"b<c&d'), 'a&quot;b&lt;c&amp;d')
})

test('镜像的建消息函数形状与上游一致（role/id/冻结）', () => {
  const message = createUserMessageMirror({
    content: [{ type: 'text', text: 'x' }],
    source: { kind: 'skill-invocation', name: 'demo-skill', form: 'instructions' },
  })
  assert.equal(message.role, 'user')
  assert.match(message.id, /^[0-9a-f-]{36}$/)
  assert.equal(Object.isFrozen(message), true)
  assert.equal(Object.isFrozen(message.content[0]), true)
})

test('手势注入：命中技能 / 未知技能 / 不允许用户调用', async () => {
  const skills = {
    'demo-skill': { name: 'demo-skill', content: '技能正文', provider: 'filesystem', invocation: { modelInvocable: true, userInvocable: true } },
    'model-only': { name: 'model-only', content: '只有模型能用', provider: 'filesystem', invocation: { modelInvocable: true, userInvocable: false } },
  }
  const warnings = []
  const gesture = createSkillPathGesture({
    getSkill: async (name) => skills[name],
    warn: (message) => warnings.push(message),
  })
  const next = async () => ({ kind: 'enter', messages: [userMessage('/skill/demo-skill')] })

  const decision = await gesture({ agent: { session: { header: { cwd: 'D:\\w' } } }, messages: [userMessage('/skill/demo-skill')], signal: undefined }, next)
  assert.equal(decision.messages.length, 2)
  const injected = decision.messages[1]
  assert.equal(injected.role, 'user')
  assert.match(injected.content[0].text, /<skill_content name="demo-skill">/)
  assert.match(injected.content[0].text, /技能正文/)
  assert.deepEqual(injected.source, { kind: 'skill-invocation', name: 'demo-skill', form: 'instructions' })

  const unknown = await gesture({ agent: { session: { header: { cwd: 'D:\\w' } } }, messages: [userMessage('/skill/nope-skill')], signal: undefined }, next)
  assert.match(unknown.messages[1].content[0].text, /No skill named "nope-skill"/)

  const modelOnly = await gesture({ agent: { session: { header: { cwd: 'D:\\w' } } }, messages: [userMessage('/skill/model-only')], signal: undefined }, next)
  assert.equal(modelOnly.messages.length, 1, '不允许用户调用的技能不注入')
  assert.ok(warnings.some((warning) => warning.includes('model-only')))
})

test('两级写法：直接读指定技能根那一份，不受同名遮蔽影响', async () => {
  const rooted = []
  const gesture = createSkillPathGesture({
    getSkill: async () => ({ name: 'demo-skill', content: '注册表里的版本', provider: 'filesystem', invocation: { modelInvocable: true, userInvocable: true } }),
    getRootedSkill: async (root, name) => {
      rooted.push(`${root}/${name}`)
      if (root !== 'project-dsh') return undefined
      return {
        name,
        content: `项目根里的 ${name}`,
        provider: 'filesystem:project-dsh',
        resourceBase: { kind: 'directory', path: 'D:\\proj\\.dsh\\skills\\demo-skill' },
        invocation: { modelInvocable: true, userInvocable: true },
      }
    },
    warn: () => {},
  })
  const next = async () => ({ kind: 'enter', messages: [] })

  const hit = await gesture({ agent: {}, messages: [userMessage('/skill/project-dsh/demo-skill')], signal: undefined }, next)
  assert.deepEqual(rooted, ['project-dsh/demo-skill'])
  assert.match(hit.messages[0].content[0].text, /项目根里的 demo-skill/)

  const miss = await gesture({ agent: {}, messages: [userMessage('/skill/user-agents/demo-skill')], signal: undefined }, next)
  assert.match(miss.messages[0].content[0].text, /exists in skill root "user-agents"/)

  // 不允许用户调用的技能，两级写法也要跳过。
  const refused = createSkillPathGesture({
    getSkill: async () => undefined,
    getRootedSkill: async () => ({ name: 'model-only', content: 'x', provider: 'filesystem', invocation: { modelInvocable: true, userInvocable: false } }),
    warn: () => {},
  })
  const decision = await refused({ agent: {}, messages: [userMessage('/skill/user-agents/model-only')], signal: undefined }, next)
  assert.equal(decision.messages.length, 0)
})

test('手势不动别人的决定：reject 直通、无手势原样返回', async () => {
  const gesture = createSkillPathGesture({ getSkill: async () => undefined })
  const rejected = { kind: 'reject', reason: 'busy' }
  assert.equal(await gesture({ messages: [userMessage('/skill/x')] }, async () => rejected), rejected)

  const decision = { kind: 'enter', messages: [userMessage('普通消息')] }
  const untouched = await gesture({ messages: [userMessage('普通消息')] }, async () => decision)
  assert.equal(untouched, decision)
})

test('注册表抛错不会把这一步搞挂', async () => {
  const gesture = createSkillPathGesture({
    getSkill: async () => {
      throw new Error('registry exploded')
    },
    warn: () => {},
  })
  const decision = await gesture(
    { agent: { session: { header: { cwd: 'D:\\w' } } }, messages: [userMessage('/skill/demo-skill')] },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 0)
})
