/**
 * `/skill` 提示源的注册时机：`inputTriggers` 可能比本插件晚就绪。
 *
 * 这条用例盯着一个**真实踩过的坑**：apply 时只 `get` 一次服务，拿不到就永远不注册、
 * 而且没有任何报错——表现就是"/ 菜单里连 /skill/ 都没有"。
 *
 * @module dsh-plugin-skill-manager/test/slash-source.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/**
 * 在一个最小沙箱里加载客户端模块并 apply。
 * @param {{delayMs?: number, fail?: boolean, never?: boolean}} [input]
 *   `delayMs`：服务晚到多少毫秒（默认 0 = 当场就有）；`fail`：registerSource 抛错；
 *   `never`：服务永远不出现。
 * @returns {{sources: Array<object>, warnings: string[], calls: {get: number, register: number}}} 结果。
 */
function boot(input = {}) {
  const sources = []
  const warnings = []
  const calls = { get: 0, register: 0 }
  const readyAt = Date.now() + (input.delayMs || 0)
  const makeService = () => ({
    registerSource(spec) {
      calls.register += 1
      if (input.fail) throw new Error('(trigger, name) 冲突')
      sources.push(spec)
      return () => {}
    },
  })
  let service = input.never ? undefined : makeService()

  const sandbox = {
    window: { __ModuleLoader__: { load(definition) { sandbox.definition = definition } } },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, skills: [], roots: [] }) }),
    console: {
      log: () => {},
      info: () => {},
      warn: (...args) => { warnings.push(args.map(String).join(' ')) },
      error: () => {},
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
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
    Symbol,
    encodeURIComponent,
    decodeURIComponent,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)

  const React = {
    createElement: () => null,
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: () => ({ current: null }),
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    Component: class {},
    Fragment: 'fragment',
  }
  const client = sandbox.definition.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require(${id})`)
  })

  client.apply({
    get: (key) => {
      if (key !== 'inputTriggers') return undefined
      calls.get += 1
      if (!service) return undefined
      if (Date.now() < readyAt) return undefined
      return service
    },
    effect: (cb) => {
      const dispose = cb()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    locale: { bind: () => () => undefined, register: () => () => {} },
    slots: {
      inject: () => () => {},
      register: () => () => {},
    },
  })
  return { sources, warnings, calls }
}

test('inputTriggers 就绪时：apply 当场注册 /skill 提示源', () => {
  const { sources, calls } = boot()
  assert.equal(sources.length, 1, '要注册一个斜杠源')
  assert.equal(sources[0].trigger, '/')
  assert.equal(sources[0].name, 'skill-path')
  assert.equal(calls.register, 1)
})

test('inputTriggers 晚就绪：轮询等到服务再注册（不能静默放弃）', async () => {
  const { sources, calls } = boot({ delayMs: 120 })
  assert.equal(sources.length, 0, 'apply 当场还没服务，不该注册')
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.equal(sources.length, 1, '服务就绪后必须补注册上')
  assert.equal(sources[0].name, 'skill-path')
  assert.ok(calls.get > 1, '应该重试过 get')
})

test('registerSource 抛错：不崩、只试一次、并打出可诊断的告警', async () => {
  const { warnings, calls } = boot({ fail: true })
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.equal(calls.register, 1, '失败后不要反复重试')
  assert.match(warnings.join(' | '), /\/skill 提示源注册失败/,
    '必须明确告警，否则用户只会看到"提示不见了"')
})

test('服务一直不出现：apply 本身不报错', async () => {
  const { sources } = boot({ never: true })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(sources.length, 0)
})
