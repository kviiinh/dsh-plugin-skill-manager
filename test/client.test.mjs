/**
 * 浏览器半边的装配契约：模块加载形状、注册的插槽、`/` 菜单源的行为。
 *
 * 没有真实浏览器，所以用一个最小的 `window.__ModuleLoader__` + 假 React 把
 * client.js 跑起来——它验证的正是最容易在真机上"整页空白"的那部分：
 * factory 的返回形状、`inject`、`ctx.slots.register` 的参数、斜杠源的数据。
 *
 * @module dsh-plugin-skill-manager/test/client.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

/**
 * 在隔离的 VM 里加载 client.js 并调用 factory。
 * @param {(route: string, options?: object) => Promise<object>} fetchImpl 假 fetch。
 * @returns {Promise<object>} 客户端模块（inject / apply）与观测面。
 */
async function loadClient(fetchImpl) {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let definition
  const listeners = []
  const sandbox = {
    window: {
      __ModuleLoader__: { load(value) { definition = value } },
      localStorage: {
        store: new Map(),
        getItem(key) { return this.store.get(key) ?? null },
        setItem(key, value) { this.store.set(key, value) },
      },
      confirm: () => true,
    },
    fetch: fetchImpl,
    console,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Math,
    Promise,
    Error,
    encodeURIComponent,
    decodeURIComponent,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  assert.ok(definition, 'client.js 必须调用 window.__ModuleLoader__.load')
  assert.equal(definition.id, 'dsh-plugin-skill-manager')

  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol('fragment'),
    Component: class Component {
      constructor(props) { this.props = props }
    },
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
  const require = (id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require(${id})`)
  }
  sandbox.__listeners = listeners
  return { module: definition.factory(require), definition }
}

/**
 * 造一个观测用假 ctx。
 * @returns {object} ctx 与观测面。
 */
function fakeCtx() {
  const state = { slots: [], sources: [], dicts: [] }
  const ctx = {
    get: (key) => (key === 'inputTriggers' ? { registerSource: (source) => { state.sources.push(source); return () => {} } } : undefined),
    effect: (callback) => {
      const dispose = callback()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    locale: {
      bind: () => (key) => key,
      register: (ns, dict) => {
        state.dicts.push({ ns, dict })
        return () => {}
      },
    },
    slots: {
      inject(name, factory) {
        const result = factory()
        // 真实框架支持生成器工厂（「插件」页就是 `function* () { yield register(...) }`），
        // 这里同样把生成器驱动到结束，否则注册语句根本不会执行。
        if (result && typeof result.next === 'function') {
          let step = result.next()
          while (step.done !== true) step = result.next()
          return () => {}
        }
        return () => {
          if (typeof result === 'function') result()
        }
      },
      register(slot, Component) {
        state.slots.push({ slot, Component })
        return () => {}
      },
    },
  }
  return { ctx, state }
}

test('客户端模块装配：主面板 + 侧栏入口 + 斜杠源', async () => {
  const calls = []
  const { module, state } = await (async () => {
    const loaded = await loadClient(async (route, options) => {
      calls.push({ route, options })
      return {
        ok: true,
        json: async () => ({
          ok: true,
          cwd: 'D:\\demo\\project',
          roots: [{ id: 'custom', label: 'custom', rank: 300, path: 'D:\\skills', writable: true }],
          skills: [
            { name: 'demo-skill', rootId: 'custom', description: '演示技能', valid: true, effective: true, invocation: { modelInvocable: true, userInvocable: true } },
            { name: 'user-only-skill', rootId: 'custom', description: '只给用户', valid: true, invocation: { modelInvocable: false, userInvocable: true } },
            { name: 'forbidden', rootId: 'custom', description: '不允许用户调用', valid: true, invocation: { modelInvocable: true, userInvocable: false } },
            { name: 'broken', rootId: 'custom', description: '无效技能', valid: false, issues: ['缺少 description'] },
          ],
          providerOnly: [],
          trash: [],
          warnings: [],
          scopeState: 'unknown',
          marketConfigured: false,
        }),
      }
    })
    return loaded
  })()

  // 注意：client.js 跑在另一个 VM realm 里，跨 realm 的对象不能直接 deepStrictEqual，
  // 所以比较用原始值 / JSON 形态。
  assert.equal(JSON.stringify(module.inject), JSON.stringify(['slots', 'locale']))
  const { ctx, state: observed } = fakeCtx()
  module.apply(ctx)

  const panelSlot = observed.slots.find((entry) => entry.slot.name === 'main')
  const sidebarSlot = observed.slots.find((entry) => entry.slot.name === 'sidebar.panellist')
  assert.ok(panelSlot, '必须注册 main 面板')
  assert.equal(panelSlot.slot.key, 'skills')
  assert.ok(sidebarSlot, '必须注册侧栏入口')
  assert.equal(sidebarSlot.slot.id, 'skills')
  assert.equal(typeof sidebarSlot.slot.label, 'function')
  assert.deepEqual(observed.dicts.map((entry) => entry.ns), ['skillManager'])
  const source = observed.sources.find((item) => item.name === 'skill-path')
  assert.ok(source, '必须注册 / 菜单源')
  assert.equal(source.trigger, '/')
  assert.notEqual(source.name, 'skill', '不能和内置的 skill 源撞 (trigger,name)')

  // 两级提示：`/` → skill/ → 技能目录 → 该目录下的技能。
  const guide = await source.candidates({ sessionId: 's1' }, { query: '' })
  assert.equal(JSON.stringify(guide.map((item) => item.name)), JSON.stringify(['skill']))
  assert.equal(source.onPick({ candidate: guide[0] }).text, '/skill/')

  const rootsStep = await source.candidates({ sessionId: 's1' }, { query: 'skill/' })
  assert.equal(JSON.stringify(rootsStep.map((item) => item.name)), JSON.stringify(['custom/']))
  assert.equal(rootsStep[0].description, 'custom')

  const skillsStep = await source.candidates({ sessionId: 's1' }, { query: 'skill/custom/' })
  assert.equal(JSON.stringify(skillsStep.map((item) => item.name)), JSON.stringify(['demo-skill', 'user-only-skill']))
  assert.equal(skillsStep.some((item) => item.name === 'forbidden'), false, 'user-invocable:false 不进菜单')
  assert.equal(skillsStep.some((item) => item.name === 'broken'), false, '无效技能不进菜单')
  assert.equal(source.onPick({ candidate: skillsStep[0] }).text, '/skill/custom/demo-skill ')

  const filtered = await source.candidates({ sessionId: 's1' }, { query: 'skill/custom/demo' })
  assert.equal(JSON.stringify(filtered.map((item) => item.name)), JSON.stringify(['demo-skill']))
  assert.equal(filtered[0].description, '演示技能')

  const rootPrefix = await source.candidates({ sessionId: 's1' }, { query: 'skill/cu' })
  assert.equal(JSON.stringify(rootPrefix.map((item) => item.name)), JSON.stringify(['custom/']))

  assert.ok(calls.length >= 1)
  assert.match(calls[0].route, /^\/skill-manager\/catalog/)
})
