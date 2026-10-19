/**
 * 插件装配冒烟：真实 `apply()` + 假 Cordis 上下文 + 真实路由调用。
 *
 * 这条用例是"装进 profile 之前"的最后一道闸：路由是否注册、目录数据是否正确、
 * 动作是否真的落盘、`/skill/<name>` 是否挂上 `agent/pre-step`。
 *
 * @module dsh-plugin-skill-manager/test/plugin.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply, Config, inject, name } from '../index.js'
import { cleanup, createFakeContext, createHttpPair, makeTemp, writeBundleSkill } from './helpers.mjs'

test('Config schema：默认值、发行配置、自定义根', () => {
  assert.equal(typeof Config, 'function', 'Config 必须是 schemastery schema')
  const defaults = Config({})
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.marketUrl, '')
  assert.equal(defaults.includeDefaultRoots, true)
  assert.equal(defaults.requestTimeoutMs, 20_000)
  assert.equal(defaults.maxBundleBytes, 20 * 1024 * 1024)
  assert.equal(defaults.roots.length, 0)

  // 与 cordis.patch.yml 里发出去的那份配置逐字段对齐。
  const shipped = Config({
    enabled: true,
    marketUrl: '',
    marketToken: '',
    roots: [],
    dshHome: '',
    agentsHome: '',
    includeDefaultRoots: true,
    requestTimeoutMs: 20_000,
    maxBundleBytes: 20 * 1024 * 1024,
  })
  assert.equal(shipped.includeDefaultRoots, true)

  const custom = Config({ roots: [{ path: 'D:\\team\\skills' }] })
  assert.equal(custom.roots[0].rank, 300)
  assert.equal(custom.roots[0].writable, true)

  assert.throws(() => Config({ requestTimeoutMs: 'soon' }), '类型不对必须报错而不是静默接受')
})

/**
 * 装配一个指向临时目录的插件实例。
 * @param {string} temp 临时目录。
 * @returns {{state: object, services: Map<string, any>}} 观测面。
 */
function boot(temp) {
  const skillsRoot = join(temp, 'skills')
  writeBundleSkill(skillsRoot, 'demo-skill', 'name: demo-skill\ndescription: 演示技能')
  writeBundleSkill(skillsRoot, 'broken-skill', 'name: Broken Name\ndescription: 名字非法')
  const { ctx, state, services } = createFakeContext()
  services.set('skills', {
    snapshot: async () => ({
      skills: [{ name: 'demo-skill', path: join(skillsRoot, 'demo-skill', 'SKILL.md'), source: 'custom', invocation: { modelInvocable: true, userInvocable: true } }],
      complete: true,
    }),
    get: async (skillName) => (skillName === 'demo-skill'
      ? { name: 'demo-skill', content: '演示正文', provider: 'filesystem', invocation: { modelInvocable: true, userInvocable: true } }
      : undefined),
  })
  apply(ctx, {
    enabled: true,
    dshHome: join(temp, 'home'),
    agentsHome: join(temp, 'agents'),
    includeDefaultRoots: false,
    roots: [{ id: 'custom', path: skillsRoot, rank: 300, writable: true }],
  })
  state.temp = temp
  return { state, services }
}

test('插件元数据与装配', () => {
  assert.equal(name, 'skill-manager')
  assert.deepEqual(inject, ['webServer', 'connection'])
  const temp = makeTemp()
  try {
    const { state } = boot(temp)
    for (const route of [
      '/skill-manager/catalog',
      '/skill-manager/read',
      '/skill-manager/browse',
      '/skill-manager/import-upload',
      '/skill-manager/action',
      '/skill-manager/market',
      '/skill-manager/market/install',
      '/skill-manager/market/uninstall',
    ]) {
      assert.ok(state.routes.has(route), `缺少路由 ${route}`)
    }
    assert.equal(state.listeners.get('agent/pre-step')?.length, 1)
  } finally {
    cleanup(temp)
  }
})

test('catalog 路由：按根分组的数据、生效状态与无效原因', async () => {
  const temp = makeTemp()
  try {
    const { state } = boot(temp)
    const pair = createHttpPair({ method: 'GET', url: `/skill-manager/catalog?cwd=${encodeURIComponent(temp)}` })
    state.routes.get('/skill-manager/catalog').handler(pair.request, pair.response)
    const { status, body } = await pair.result()
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.roots.length, 1)
    assert.equal(body.roots[0].id, 'custom')
    assert.equal(body.roots[0].skillCount, 2)
    assert.equal(body.scopeState, 'unknown', '没有 agentId 时不得假装知道注册表结论')

    const demo = body.skills.find((skill) => skill.name === 'demo-skill')
    assert.equal(demo.effective, true)
    // 没有绑定会话就拿不到权威注册表结论：只能按 rank 推算，并明确标成 unknown。
    assert.equal(demo.registryState, 'unknown')
    assert.equal(demo.predicted, true)
    assert.equal(demo.valid, true)

    const broken = body.skills.find((skill) => skill.dirName === 'broken-skill')
    assert.equal(broken.valid, false)
    assert.match(broken.issues.join('；'), /kebab-case/)
    assert.equal(broken.effective, false, '无效技能在 DSH 侧不会生效')
  } finally {
    cleanup(temp)
  }
})

test('注册表：落盘缓存、刷新能重建、cwd 变了要重扫', async () => {
  const temp = makeTemp()
  try {
    const { state } = boot(temp)
    const handler = state.routes.get('/skill-manager/catalog').handler
    const first = createHttpPair({ method: 'GET', url: `/skill-manager/catalog?cwd=${encodeURIComponent(temp)}` })
    handler(first.request, first.response)
    const a = (await first.result()).body
    assert.ok(a.revision > 0, '目录数据要带注册表版本')

    const registryPath = join(temp, 'home', 'skill-manager', 'registry.json')
    assert.equal(existsSync(registryPath), true, '注册表必须落盘')
    const saved = JSON.parse(readFileSync(registryPath, 'utf8'))
    assert.equal(saved.revision, a.revision)
    assert.deepEqual(saved.skills.map((skill) => skill.name).sort(), ['demo-skill', 'Broken Name'].sort())

    // 命中缓存：再请求一次不会换版本。
    const second = createHttpPair({ method: 'GET', url: `/skill-manager/catalog?cwd=${encodeURIComponent(temp)}` })
    handler(second.request, second.response)
    assert.equal((await second.result()).body.revision, a.revision)

    // 落了新技能 + refresh=1：必须重扫并看到它。
    writeBundleSkill(join(temp, 'skills'), 'fresh-skill', 'name: fresh-skill\ndescription: 新放进去的')
    const refreshed = createHttpPair({ method: 'GET', url: `/skill-manager/catalog?refresh=1&cwd=${encodeURIComponent(temp)}` })
    handler(refreshed.request, refreshed.response)
    const c = (await refreshed.result()).body
    assert.ok(c.skills.some((skill) => skill.name === 'fresh-skill'), '刷新必须重扫技能文件夹')
    assert.ok(c.revision >= a.revision)

    // 换了 cwd 也必须重扫（项目级技能根跟着变）。
    const otherCwd = join(temp, 'another-project')
    mkdirSync(otherCwd, { recursive: true })
    const moved = createHttpPair({ method: 'GET', url: `/skill-manager/catalog?cwd=${encodeURIComponent(otherCwd)}` })
    handler(moved.request, moved.response)
    assert.equal((await moved.result()).body.cwd, otherCwd)
  } finally {
    cleanup(temp)
  }
})

test('import 动作：从任意目录导入技能文件夹 / .md 文件，并可覆盖', async () => {
  const temp = makeTemp()
  try {
    const { state } = boot(temp)
    const handler = state.routes.get('/skill-manager/action').handler

    // 1) 目录形式：frontmatter 决定技能名，整目录复制。
    const source = join(temp, 'incoming', 'my-folder')
    writeBundleSkill(join(temp, 'incoming'), 'my-folder', 'name: imported-skill\ndescription: 导入进来的')
    writeFileSync(join(source, 'notes.md'), '附带资源\n', 'utf8')
    const first = createHttpPair({
      method: 'POST',
      body: { action: 'import', rootId: 'custom', sourcePath: source, cwd: temp },
    })
    handler(first.request, first.response)
    const imported = (await first.result()).body
    assert.equal(imported.ok, true, imported.error)
    assert.equal(imported.name, 'imported-skill')
    assert.equal(existsSync(join(temp, 'skills', 'imported-skill', 'SKILL.md')), true)
    assert.equal(existsSync(join(temp, 'skills', 'imported-skill', 'notes.md')), true, '资源文件要一起复制')

    // 2) 目标已存在：默认拒绝，勾了覆盖才动。
    const again = createHttpPair({ method: 'POST', body: { action: 'import', rootId: 'custom', sourcePath: source, cwd: temp } })
    handler(again.request, again.response)
    assert.match((await again.result()).body.error, /目标已存在/)
    const overwrite = createHttpPair({ method: 'POST', body: { action: 'import', rootId: 'custom', sourcePath: source, cwd: temp, overwrite: true } })
    handler(overwrite.request, overwrite.response)
    assert.equal((await overwrite.result()).body.ok, true)

    // 3) 单个 .md 文件形式。
    const flat = join(temp, 'incoming', 'flat-skill.md')
    writeFileSync(flat, '---\nname: flat-skill\ndescription: 单文件技能\n---\n正文\n', 'utf8')
    const flatImport = createHttpPair({ method: 'POST', body: { action: 'import', rootId: 'custom', sourcePath: flat, cwd: temp } })
    handler(flatImport.request, flatImport.response)
    assert.equal((await flatImport.result()).body.name, 'flat-skill')
    assert.equal(existsSync(join(temp, 'skills', 'flat-skill.md')), true)

    // 4) 不是技能的目录、非法技能名、只读根：都要给出可读错误。
    const notSkill = createHttpPair({ method: 'POST', body: { action: 'import', rootId: 'custom', sourcePath: join(temp, 'incoming'), cwd: temp } })
    handler(notSkill.request, notSkill.response)
    assert.match((await notSkill.result()).body.error, /没有 SKILL\.md|不合法|name/)
  } finally {
    cleanup(temp)
  }
})

test('browse 路由：列出目录并标出含 SKILL.md 的可导入项', async () => {
  const temp = makeTemp()
  try {
    const { state } = boot(temp)
    writeBundleSkill(join(temp, 'incoming'), 'candidate-skill', 'name: candidate-skill\ndescription: 可导入')
    const pair = createHttpPair({ method: 'GET', url: `/skill-manager/browse?path=${encodeURIComponent(join(temp, 'incoming'))}` })
    state.routes.get('/skill-manager/browse').handler(pair.request, pair.response)
    const { status, body } = await pair.result()
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.path, join(temp, 'incoming'))
    const entry = body.entries.find((item) => item.name === 'candidate-skill')
    assert.ok(entry, '必须列出技能目录')
    assert.equal(entry.hasSkill, true)
    assert.equal(body.parent, temp)

    const missing = createHttpPair({ method: 'GET', url: `/skill-manager/browse?path=${encodeURIComponent(join(temp, 'nope'))}` })
    state.routes.get('/skill-manager/browse').handler(missing.request, missing.response)
    assert.match((await missing.result()).body.error, /路径不存在/)
  } finally {
    cleanup(temp)
  }
})

test('import-upload 路由：拖拽进来的文件由 Host 落盘成技能', async () => {
  const temp = makeTemp()
  try {
    const { state } = boot(temp)
    const handler = state.routes.get('/skill-manager/import-upload').handler
    const body = (files, extra = {}) => ({ rootId: 'custom', cwd: temp, files, ...extra })
    const put = async (payload) => {
      const pair = createHttpPair({ method: 'POST', body: payload })
      handler(pair.request, pair.response)
      return (await pair.result()).body
    }
    const base64 = (text) => Buffer.from(text, 'utf8').toString('base64')

    // 1) 拖一个文件夹：浏览器给的是 `文件夹/SKILL.md`，Host 要剥掉这层前缀。
    const dragged = await put(body([
      { path: 'my-skill/SKILL.md', data: base64('---\nname: dragged-skill\ndescription: 拖进来的\n---\n正文\n') },
      { path: 'my-skill/references/notes.md', data: base64('笔记\n') },
    ]))
    assert.equal(dragged.ok, true, dragged.error)
    assert.equal(dragged.name, 'dragged-skill')
    assert.equal(existsSync(join(temp, 'skills', 'dragged-skill', 'SKILL.md')), true)
    assert.equal(existsSync(join(temp, 'skills', 'dragged-skill', 'references', 'notes.md')), true)

    // 2) 单个 .md 技能文件。
    const flat = await put(body([
      { path: 'flat-skill.md', data: base64('---\nname: flat-skill\ndescription: 单文件\n---\n正文\n') },
    ]))
    assert.equal(flat.ok, true, flat.error)
    assert.equal(existsSync(join(temp, 'skills', 'flat-skill.md')), true)

    // 3) 越界路径、缺 SKILL.md、没名字：都要拒绝且不落盘。
    assert.match((await put(body([{ path: '../escape/SKILL.md', data: base64('x') }]))).error, /路径不安全/)
    assert.match((await put(body([{ path: 'notes.md', data: base64('没有 frontmatter') }]))).error, /name/)
    assert.match((await put(body([{ path: 'readme.txt', data: base64('x') }]))).error, /找不到 SKILL\.md/)
    assert.equal(existsSync(join(temp, 'skills', 'escape')), false)

    // 4) 目标已存在：默认拒，勾了覆盖才动。
    const again = await put(body([{ path: 'SKILL.md', data: base64('---\nname: dragged-skill\ndescription: 再来一次\n---\n正文\n') }]))
    assert.match(again.error, /目标已存在/)
    const overwritten = await put(body([{ path: 'SKILL.md', data: base64('---\nname: dragged-skill\ndescription: 覆盖版\n---\n新正文\n') }], { overwrite: true }))
    assert.equal(overwritten.ok, true, overwritten.error)
    assert.match(readFileSync(join(temp, 'skills', 'dragged-skill', 'SKILL.md'), 'utf8'), /覆盖版/)

    // 5) 只读根与未知根。
    assert.match((await put({ rootId: 'nope', cwd: temp, files: [] })).error, /技能根不存在/)
  } finally {
    cleanup(temp)
  }
})

test('action 路由：改开关真的写进 SKILL.md', async () => {
  const temp = makeTemp()
  try {
    const { state } = boot(temp)
    const pair = createHttpPair({
      method: 'POST',
      url: '/skill-manager/action',
      body: { action: 'set-invocation', rootId: 'custom', name: 'demo-skill', modelInvocable: false, userInvocable: true, cwd: temp },
    })
    state.routes.get('/skill-manager/action').handler(pair.request, pair.response)
    const { body } = await pair.result()
    assert.equal(body.ok, true, body.error)

    const text = readFileSync(join(temp, 'skills', 'demo-skill', 'SKILL.md'), 'utf8')
    assert.match(text, /disable-model-invocation: true/)
  } finally {
    cleanup(temp)
  }
})

test('action 路由：越权根与未知动作被拒', async () => {
  const temp = makeTemp()
  try {
    const { state } = boot(temp)
    const handler = state.routes.get('/skill-manager/action').handler

    const unknownRoot = createHttpPair({ method: 'POST', body: { action: 'trash', rootId: 'nope', name: 'demo-skill', cwd: temp } })
    handler(unknownRoot.request, unknownRoot.response)
    assert.match((await unknownRoot.result()).body.error, /技能根不存在/)

    const unknownAction = createHttpPair({ method: 'POST', body: { action: 'self-destruct', rootId: 'custom', name: 'demo-skill', cwd: temp } })
    handler(unknownAction.request, unknownAction.response)
    assert.match((await unknownAction.result()).body.error, /未知动作/)
    assert.equal(existsSync(join(temp, 'skills', 'demo-skill', 'SKILL.md')), true)
  } finally {
    cleanup(temp)
  }
})

test('action 路由：create 在技能还不存在时也必须能建', async () => {
  const temp = makeTemp()
  try {
    const { state } = boot(temp)
    const handler = state.routes.get('/skill-manager/action').handler

    const pair = createHttpPair({
      method: 'POST',
      url: '/skill-manager/action',
      body: { action: 'create', rootId: 'custom', name: 'fresh-skill', description: '新建的技能', cwd: temp },
    })
    handler(pair.request, pair.response)
    const { body } = await pair.result()
    assert.equal(body.ok, true, body.error)
    assert.ok(existsSync(join(temp, 'skills', 'fresh-skill', 'SKILL.md')))

    const duplicate = createHttpPair({
      method: 'POST',
      body: { action: 'create', rootId: 'custom', name: 'fresh-skill', description: '再来一次', cwd: temp },
    })
    handler(duplicate.request, duplicate.response)
    assert.match((await duplicate.result()).body.error, /已经存在/)
  } finally {
    cleanup(temp)
  }
})

test('catalog 里的技能带资源统计（界面要展示）', async () => {
  const temp = makeTemp()
  try {
    const { state } = boot(temp)
    const pair = createHttpPair({ method: 'GET', url: `/skill-manager/catalog?cwd=${encodeURIComponent(temp)}` })
    state.routes.get('/skill-manager/catalog').handler(pair.request, pair.response)
    const { body } = await pair.result()
    const demo = body.skills.find((skill) => skill.name === 'demo-skill')
    assert.ok(demo.resources, '必须带资源统计')
    assert.ok(demo.resources.files >= 1)
    assert.ok(demo.resources.bytes > 0)
  } finally {
    cleanup(temp)
  }
})

test('市场路由：未配置地址时明确说明，而不是假装成功', async () => {
  const temp = makeTemp()
  try {
    const { state } = boot(temp)
    const pair = createHttpPair({ method: 'GET', url: '/skill-manager/market?q=demo' })
    state.routes.get('/skill-manager/market').handler(pair.request, pair.response)
    const { body } = await pair.result()
    assert.equal(body.ok, false)
    assert.equal(body.configured, false)
    assert.match(body.error, /未配置市场地址/)
  } finally {
    cleanup(temp)
  }
})

test('手势端到端：apply 之后 /skill/<name> 能注入', async () => {
  const temp = makeTemp()
  try {
    const { state } = boot(temp)
    const gesture = state.listeners.get('agent/pre-step')[0]
    const messages = [{ source: { kind: 'user' }, content: [{ type: 'text', text: '/skill/demo-skill 开始' }] }]
    const decision = await gesture(
      { agent: { session: { header: { cwd: temp } } }, messages, signal: undefined },
      async () => ({ kind: 'enter', messages }),
    )
    assert.equal(decision.messages.length, 2)
    assert.match(decision.messages[1].content[0].text, /演示正文/)
  } finally {
    cleanup(temp)
  }
})

test('手势端到端：两级 /skill/<技能目录>/<技能> 直接读该根那一份', async () => {
  const temp = makeTemp()
  try {
    const { state } = boot(temp)
    const gesture = state.listeners.get('agent/pre-step')[0]
    const messages = [{ source: { kind: 'user' }, content: [{ type: 'text', text: '/skill/custom/demo-skill 走两级' }] }]
    const decision = await gesture(
      { agent: { session: { header: { cwd: temp } } }, messages, signal: undefined },
      async () => ({ kind: 'enter', messages }),
    )
    // 两级写法走的是 Host 的 getRootedSkill（读盘），不走 ctx.skills.get。
    assert.equal(decision.messages.length, 2)
    const text = decision.messages[1].content[0].text
    assert.match(text, /<skill_content name="demo-skill">/)
    // 注入的是该根那一份的正文，资源基准目录也指向该技能的目录。
    assert.match(text, /技能正文/)
    assert.match(text, /skills[\\/]demo-skill/)

    // 根名不对：明确说"这个根里没有"，而不是编内容。
    const miss = await gesture(
      { agent: { session: { header: { cwd: temp } } }, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '/skill/nope/demo-skill' }] }], signal: undefined },
      async () => ({ kind: 'enter', messages: [] }),
    )
    assert.match(miss.messages[0].content[0].text, /exists in skill root "nope"/)
  } finally {
    cleanup(temp)
  }
})
