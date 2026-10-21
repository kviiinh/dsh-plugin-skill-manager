/**
 * 真渲染测试：用 jsdom + react-dom 把侧栏页面跑起来。
 *
 * 这一条比"装配契约"重得多——它真的执行每个组件的渲染函数，所以能抓到
 * 拼错的变量、非法的 hook 用法、undefined 的分支等等，也就是"打开页面一片空白"
 * 这类问题。没有装 jsdom 时自动跳过（`pnpm add -D react react-dom jsdom`）。
 *
 * @module dsh-plugin-skill-manager/test/client-render.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(import.meta.url)

/**
 * 尝试加载渲染依赖。
 * @returns {object | undefined} 依赖集合；缺依赖时 undefined。
 */
function loadRenderDeps() {
  try {
    const React = require('react')
    const { createRoot } = require('react-dom/client')
    const { JSDOM } = require('jsdom')
    return { React, createRoot, JSDOM }
  } catch {
    return undefined
  }
}

/** 一份内容丰富的目录数据，覆盖四种状态。 */
const CATALOG = {
  ok: true,
  build: 'build-old-for-test',
  generatedAt: '2026-10-16T07:00:00.000Z',
  cwd: 'D:\\demo\\project',
  homes: { dshHome: 'C:\\Users\\x\\.dsh', agentsHome: 'C:\\Users\\x\\.agents' },
  scopeState: 'unknown',
  skillsService: true,
  marketUrl: '',
  marketConfigured: false,
  roots: [
    { id: 'project-dsh', label: 'project-dsh', rank: 100, path: 'D:\\demo\\project\\.dsh\\skills', exists: false, writable: true, skillCount: 0 },
    { id: 'user-agents', label: 'user-agents', rank: 500, path: 'C:\\Users\\x\\.agents\\skills', exists: true, writable: true, skillCount: 3 },
  ],
  skills: [
    {
      name: 'demo-skill',
      dirName: 'demo-skill',
      rootId: 'user-agents',
      rootLabel: 'user-agents',
      rank: 500,
      kind: 'bundle',
      path: 'C:\\Users\\x\\.agents\\skills\\demo-skill\\SKILL.md',
      valid: true,
      effective: true,
      registryState: 'unknown',
      predicted: true,
      description: '演示技能：说明文字',
      whenToUse: '当用户要做演示时',
      metadata: { category: 'demo', requires: { bins: ['dws'] } },
      invocation: { modelInvocable: true, userInvocable: true },
      resources: { files: 3, directories: ['references'], bytes: 1234 },
      issues: [],
      bytes: 400,
      mtime: '2026-10-16T06:00:00.000Z',
    },
    {
      name: 'shadowed-skill',
      dirName: 'shadowed-skill',
      rootId: 'user-agents',
      rootLabel: 'user-agents',
      rank: 500,
      kind: 'bundle',
      path: 'C:\\Users\\x\\.agents\\skills\\shadowed-skill\\SKILL.md',
      valid: true,
      effective: false,
      registryState: 'unknown',
      shadowedBy: { name: 'shadowed-skill', path: 'D:\\demo\\project\\.dsh\\skills\\shadowed-skill\\SKILL.md', rootLabel: 'project-dsh' },
      description: '被项目根遮蔽',
      invocation: { modelInvocable: true, userInvocable: true },
      issues: [],
    },
    {
      name: 'Broken Name',
      dirName: 'broken',
      rootId: 'user-agents',
      rootLabel: 'user-agents',
      rank: 500,
      kind: 'bundle',
      path: 'C:\\Users\\x\\.agents\\skills\\broken\\SKILL.md',
      valid: false,
      effective: false,
      registryState: 'unknown',
      description: '',
      invocation: { modelInvocable: true, userInvocable: true },
      issues: [],
    },
    {
      // 已被开关停用的技能：两个调用标记都写了 false。
      name: 'off-skill',
      dirName: 'off-skill',
      rootId: 'user-agents',
      rootLabel: 'user-agents',
      rank: 500,
      kind: 'bundle',
      path: 'C:\\Users\\x\\.agents\\skills\\off-skill\\SKILL.md',
      valid: true,
      effective: true,
      registryState: 'unknown',
      description: '被停用的技能',
      invocation: { modelInvocable: false, userInvocable: false },
      issues: [],
    },
  ],
  providerOnly: [
    { name: 'plugin-skill', description: '插件内嵌技能', source: 'bundled', provider: 'runtime', invocation: { modelInvocable: true, userInvocable: true }, valid: true, issues: [], effective: true },
  ],
  warnings: ['技能名冲突：shadowed-skill 由 2 个根提供，DSH 只会用 rank 最小的那个'],
  trash: [{ id: 't1', name: 'deleted-skill', dirName: 'deleted-skill', kind: 'bundle', from: 'C:\\Users\\x\\.agents\\skills\\deleted-skill\\SKILL.md', rootId: 'user-agents', at: '2026-10-16T06:30:00.000Z' }],
  installed: [],
}

/**
 * 在带 DOM 的环境里装配客户端模块，并渲染主面板。
 * @param {{primitives?: boolean, picker?: boolean,
 *   layout?: {client: number, scroll: number, clientHeight?: number, scrollHeight?: number,
 *     rect?: object, viewport?: {width: number, height: number}}}} [options]
 *   `primitives: true` 注入 DSH 组件库替身；
 *   `picker: true` 注入一个可用的 `uiWorkspace`（模拟"系统选目录可用"）；
 *   `layout` 伪造布局（jsdom 没有布局）：`client/scroll` 用于横向省略号，
 *   `clientHeight/scrollHeight` 用于纵向"介绍显示不全"，
 *   `rect` 是 `getBoundingClientRect()` 的返回值，`viewport` 是窗口宽高（测气泡夹边用）。
 * @returns {Promise<object | undefined>} 渲染结果；缺依赖时 undefined。
 */
async function renderPanel(options = {}) {
  const deps = loadRenderDeps()
  if (!deps) return undefined
  const { React, createRoot, JSDOM } = deps

  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'http://localhost/' })
  const { window } = dom
  if (options.layout) {
    // 伪造"元素比容器宽/高"的布局，用来验证省略号与悬浮提示。
    const layout = options.layout
    Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() { return layout.client },
    })
    Object.defineProperty(window.HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get() { return layout.scroll },
    })
    const fakeClientHeight = layout.clientHeight === undefined ? 0 : layout.clientHeight
    const fakeScrollHeight = layout.scrollHeight === undefined ? 0 : layout.scrollHeight
    Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() { return fakeClientHeight },
    })
    Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() { return fakeScrollHeight },
    })
    if (layout.rect) {
      // 所有元素都返回同一块矩形：够用来验证"气泡会不会顶出视口"。
      const rect = {
        left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
        ...layout.rect,
      }
      window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
        return { ...rect, right: rect.left + (rect.width || 0), bottom: rect.top + (rect.height || 0) }
      }
    }
    if (layout.viewport) {
      Object.defineProperty(window, 'innerWidth', { configurable: true, get() { return layout.viewport.width } })
      Object.defineProperty(window, 'innerHeight', { configurable: true, get() { return layout.viewport.height } })
    }
  }
  // 改名/复制会弹 `window.prompt`：测试里给个确定性的回答。
  window.prompt = () => (options.promptAnswer === undefined ? 'renamed-skill' : options.promptAnswer)
  window.confirm = () => true
  // react-dom 走的是宿主 realm 的全局对象，必须把 jsdom 的 window/document 装上去。
  const priorGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }
  globalThis.window = window
  globalThis.document = window.document
  // Node 24 里 `globalThis.navigator` 只有 getter，用 defineProperty 覆盖。
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const consoleErrors = []
  const originalError = console.error
  console.error = (...args) => {
    consoleErrors.push(args.map(String).join(' '))
  }

  const requests = []
  const imports = []
  const actions = []
  const installs = []
  const importConflictEnabled = options.importConflict === true
  // `market: true` 时假装市场已配置（否则市场页显示"未配置"，搜索是禁用的）。
  const baseCatalog = options.market
    ? { ...CATALOG, marketConfigured: true, marketUrl: 'http://market.test' }
    : CATALOG
  // `extraRoots` 用来补几个根（比如两个同名 `bundled` 根），验证筛选下拉能区分它们。
  const catalog = options.extraRoots
    ? { ...baseCatalog, roots: [...baseCatalog.roots, ...options.extraRoots] }
    : baseCatalog
  const fetchImpl = async (route, init) => {
    requests.push(String(route))
    if (String(route).startsWith('/skill-manager/read')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, text: '---\nname: demo-skill\n---\n# demo-skill 正文' }) }
    }
    if (String(route).startsWith('/skill-manager/market/install')) {
      const body = init && init.body ? JSON.parse(init.body) : {}
      installs.push(body)
      // 宿主是两步：第一次只回清单，带 confirm:true 才真的装。
      if (body.confirm !== true) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: false,
            needsConfirmation: true,
            manifest: {
              name: 'demo-skill',
              version: '1.0.0',
              files: [{ path: 'SKILL.md', size: 412, sha256: 'sha256:aa' }],
              bundle: { format: 'tar.gz', url: '/x.tgz', sha256: 'sha256:bb', size: 1234 },
            },
            target: { id: 'user-agents', label: 'user-agents', path: 'C:\\Users\\x\\.agents\\skills' },
          }),
        }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, entry: { name: 'demo-skill' } }) }
    }
    if (String(route).startsWith('/skill-manager/market')) {
      if (options.market) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, items: [{ name: 'demo-skill', version: '1.0.0', description: '远程技能' }] }),
        }
      }
      return { ok: true, status: 200, json: async () => ({ ok: false, configured: false, error: '未配置市场地址（marketUrl）' }) }
    }
    // 模拟"目标已存在"：默认关闭；开了之后第一次导入报冲突，带 overwrite 的重试才成功。
    if (init && init.body && String(route).includes('/skill-manager/action')) {
      const body = JSON.parse(init.body)
      actions.push(body)
      if (body.action === 'import') {
        imports.push(body)
        if (options.importError) {
          // 导入失败（不是同名冲突）：用来验证错误提示要标红。
          return { ok: true, status: 200, json: async () => ({ ok: false, error: '导入失败：源目录里没有 SKILL.md' }) }
        }
        if (importConflictEnabled && body.overwrite !== true) {
          return { ok: true, status: 200, json: async () => ({ ok: false, error: '目标已存在：demo-skill' }) }
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, name: 'demo-skill' }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, name: body.name || body.newName || 'demo-skill' }) }
    }
    return { ok: true, status: 200, json: async () => catalog }
  }

  const slots = []
  const sources = []
  const sandbox = {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
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
    Symbol,
    encodeURIComponent,
    decodeURIComponent,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  sandbox.globalThis = sandbox
  let definition
  sandbox.window.__ModuleLoader__ = { load: (value) => { definition = value } }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox)

  const client = definition.factory((id) => {
    if (id === 'react') return React
    // 替身 DSH 组件库：只验证"组件库可用时走的是这条分支"，不复制它的样式。
    if (id === '@deepseek-ai/dsh-client-ui-primitives' && options.primitives) {
      return {
        Button: ({ variant, icon, children, ...rest }) => React.createElement('button', { 'data-ui': `button-${variant || 'ghost'}`, ...rest }, icon, children),
        Pill: ({ active, children, ...rest }) => React.createElement('button', { 'data-ui': `pill-${active ? 'active' : 'idle'}`, ...rest }, children),
        Tag: ({ tone, children }) => React.createElement('span', { 'data-ui': `tag-${tone || 'grey'}` }, children),
        Modal: ({ open, title, closeLabel, className, children, footer }) => (open
          ? React.createElement('div', { 'data-ui': 'modal', 'data-title': title, className },
            React.createElement('button', { 'data-ui': 'modal-close', 'aria-label': closeLabel }, 'x'), children, footer)
          : null),
        IconRefreshOutlineRegular: () => React.createElement('span', { 'data-ui': 'icon-refresh' }, '↻'),
        IconCloseOutlineRegular: () => React.createElement('span', { 'data-ui': 'icon-close' }, '✕'),
      }
    }
    throw new Error(`unexpected require(${id})`)
  })

  const ctx = {
    get: (key) => {
      if (key === 'inputTriggers') return { registerSource: (source) => { sources.push(source); return () => {} } }
      if (key === 'uiWorkspace' && options.picker) return { pickDirectory: async () => 'D:\\picked\\skill-folder' }
      return undefined
    },
    effect: (callback) => {
      const dispose = callback()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    // 模拟"locale 服务没有这个键"：必须回退到插件自带字典，否则界面会显示键名。
    locale: { bind: () => () => undefined, register: () => () => {} },
    slots: {
      inject(name, factory) {
        const result = factory()
        if (result && typeof result.next === 'function') {
          let step = result.next()
          while (step.done !== true) step = result.next()
        }
        return () => {}
      },
      register(slot, Component) {
        slots.push({ slot, Component })
        return () => {}
      },
    },
  }
  client.apply(ctx)

  const panel = slots.find((entry) => entry.slot.name === 'main')
  assert.ok(panel, '必须注册 main 面板')

  const { act } = React
  const container = window.document.getElementById('host')
  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(panel.Component, {}))
  })
  // 让 useEffect 里的异步 fetch + setState 落地。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  return {
    container,
    window,
    document: window.document,
    html: container.innerHTML,
    requests,
    imports,
    actions,
    installs,
    errors: consoleErrors,
    sources,
    click: async (label) => {
      // 按钮文字可能带图标（替身图标是 `↻`），比对时先去掉它。
      const button = [...container.querySelectorAll('button')]
        .find((item) => item.textContent === label || item.textContent.replace('↻', '') === label)
      assert.ok(button, `找不到按钮：${label}`)
      button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25))
      })
    },
    // 在同一张卡片里点按钮：卡片网格里同名按钮（「详情」）有多份，必须按卡片定位。
    settle: async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25))
      })
    },
    // 在某个元素上按一个键（Enter 之类的提交动作）。
    press: async (element, key) => {
      assert.ok(element, '找不到要按键的元素')
      element.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }))
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25))
      })
    },
    // 往输入框里打字：必须走原生 setter，否则 React 的 value tracker 会吞掉这次变化。
    type: async (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, value)
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25))
      })
    },
    // 点任意元素（开关这类没有文字的按钮用它）。
    clickElement: async (element) => {
      assert.ok(element, '找不到要点的元素')
      element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25))
      })
    },
    // 自定义筛选下拉（不是原生 select）：先点触发器打开浮层，再点选项。
    pickFilter: async (name, value) => {
      const find = () => container.querySelector(`[data-sm-filter="${name}"] [data-option-value="${value}"]`)
      // 浮层可能已经开着（上一步 openFilter 打开过）：再点一次触发器会把它关掉。
      if (!find()) {
        const trigger = container.querySelector(`[data-sm-select="${name}"]`)
        assert.ok(trigger, `找不到筛选器：${name}`)
        assert.equal(trigger.disabled, false, `筛选器 ${name} 是禁用状态`)
        trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 15))
        })
      }
      const option = find()
      assert.ok(option, `筛选器 ${name} 里没有选项：${value}`)
      option.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25))
      })
    },
    // 打开筛选浮层并返回选项文字（读的 DOM 就是用户看到的那份）。
    // 已经开着就直接读——再点一次触发器会把它关掉。
    openFilter: async (name) => {
      const read = () => [...container.querySelectorAll(`[data-sm-filter="${name}"] [role="option"]`)]
        .map((item) => item.textContent)
      if (read().length === 0) {
        const trigger = container.querySelector(`[data-sm-select="${name}"]`)
        assert.ok(trigger, `找不到筛选器：${name}`)
        trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 15))
        })
      }
      return read()
    },
    clickInCard: async (skillName, label) => {
      // 卡片靠 `data-skill-card` 定位（卡片根上不再挂 title，免得悬浮名字时冒出介绍）。
      const card = container.querySelector(`[data-skill-card="${skillName}"]`)
      assert.ok(card, `找不到卡片：${skillName}`)
      const button = [...card.querySelectorAll('button')].find((item) => item.textContent === label)
      assert.ok(button, `卡片 ${skillName} 里找不到按钮：${label}`)
      button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
    },
    // 卸载同样需要 window；再等一小会儿让 React 的收尾调度跑完，之后才恢复全局，
    // 否则残留的定时回调会碰到已经删掉的 window（表现为"测试结束后仍有异步活动"）。
    dispose: async () => {
      try {
        await act(async () => {
          root.unmount()
        })
      } catch {
        /* 卸载失败不影响断言 */
      }
      await new Promise((resolve) => setTimeout(resolve, 30))
      console.error = originalError
      for (const [key, value] of Object.entries(priorGlobals)) {
        if (value === undefined) delete globalThis[key]
        else globalThis[key] = value
      }
    },
  }
}

test('侧栏页面在真实 DOM 里渲染：三入口、卡片网格、状态徽章', async (t) => {
  const rendered = await renderPanel()
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom（pnpm add -D react react-dom jsdom）')
    return
  }
  try {
    assert.ok(rendered.requests.some((route) => route.startsWith('/skill-manager/catalog')), '页面必须去拉目录数据')
    const realErrors = rendered.errors.filter((line) => !line.includes('not wrapped in act'))
    assert.deepEqual(realErrors, [], '渲染不能有 console.error')

    const html = rendered.html
    // 骨架：标题 + 三个入口 + 右上角刷新（设置已经挪进技能市场页）
    assert.match(html, /技能管理器/)
    assert.match(html, /已安装/)
    assert.match(html, /技能市场/)
    assert.match(html, /回收站/)
    assert.match(html, /刷新/)
    // 设置属于技能市场：不在已安装页的顶栏里。
    assert.equal([...rendered.container.querySelectorAll('[data-sm-topbar] button')]
      .some((item) => item.textContent.includes('设置')), false, '设置不该出现在顶栏')
    // 工具栏：两个筛选器（自定义下拉）+ 导入本地（实心主按钮，黑色）。
    assert.match(html, /技能目录/)
    assert.match(html, /全部目录/)
    assert.match(html, /分类/)
    assert.match(html, /全部分类/)
    assert.match(html, /data-sm-filter="root"/)
    assert.match(html, /data-sm-filter="category"/)
    const importButton = [...rendered.container.querySelectorAll('[data-sm-toolbar] button')]
      .find((item) => item.textContent === '导入本地')
    assert.ok(importButton, '工具栏要有导入本地')
    // 选项在浮层里，点开才渲染（默认不铺在 DOM 里）。
    assert.equal(rendered.container.querySelectorAll('[role="option"]').length, 0, '浮层默认收起')
    assert.deepEqual(await rendered.openFilter('root'),
      ['全部目录（5）', '插件提供（1）', 'project-dsh（0）', 'user-agents（4）'])
    // 卡片网格：每行 6 个、可视 4 行；行高是原来的 200%（132px → 264px）。
    assert.match(html, /grid-template-columns:\s*repeat\(6, minmax\(0, 1fr\)\)/)
    assert.match(html, /grid-auto-rows:\s*264px/)
    assert.match(html, /max-height:\s*calc\(1086px\)/)
    // 卡片内容：名字 + 介绍；**卡片上不再显示生效/无效状态**（用户要求去掉）。
    assert.match(html, /demo-skill/)
    assert.match(html, /演示技能：说明文字/)
    const demoCard = rendered.container.querySelector('[data-skill-card="demo-skill"]')
    for (const word of ['生效', '无效', '被遮蔽', '按优先级推算', '插件提供']) {
      assert.equal(demoCard.textContent.includes(word), false, `卡片上不该再有「${word}」`)
    }
    // 插件内嵌技能也在网格里，标为「插件提供」
    assert.match(html, /plugin-skill/)
    assert.match(html, /插件提供/)
    // 警告照常展示；斜杠源注册了一次
    assert.match(html, /技能名冲突/)
    assert.equal(rendered.sources.filter((source) => source.name === 'skill-path').length, 1)

    // 点开 demo-skill 的「详情」：路径、metadata、资源统计、遮蔽来源都要出现。
    await rendered.clickInCard('demo-skill', '详情')
    const expanded = rendered.container.innerHTML
    assert.match(expanded, /SKILL\.md/)
    assert.match(expanded, /requires/)
    assert.match(expanded, /3 files \/ 1234 bytes/)
    assert.match(expanded, /references/)
    // 用户要求：详情不显示「何时使用」「问题」两行，连 whenToUse 的值也不再出现。
    const detailFacts = [...rendered.container.querySelectorAll('[data-ui="modal"] dt')].map((item) => item.textContent)
    assert.equal(detailFacts.includes('何时使用'), false, `详情不该有「何时使用」：${detailFacts.join('/')}`)
    assert.equal(detailFacts.includes('问题'), false, `详情不该有「问题」：${detailFacts.join('/')}`)
    assert.equal(expanded.includes('当用户要做演示时'), false, 'whenToUse 的值不该再出现在详情里')
    // 详情打开的是这一张卡片的技能，不是网格里的第一张。
    assert.match(expanded, /demo-skill/)
    assert.match(expanded, /关闭/)
  } finally {
    await rendered.dispose()
  }
})

test('技能目录筛选：选到空目录只显示空提示，不能把页面打崩', async (t) => {
  const rendered = await renderPanel({ primitives: true })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    assert.ok(rendered.container.querySelector('[data-sm-select="root"]'), '已安装页要有「技能目录」筛选器')

    // 项目根还没放技能时是空的（`project-dsh` 在这个 fixture 里就是 0 个）。
    // 这里曾经引用了外层作用域里不存在的 `rootFilter`，一选到空目录就抛
    // ReferenceError，整个已安装页直接白掉。
    await rendered.pickFilter('root', 'project-dsh')
    const html = rendered.container.innerHTML
    assert.match(html, /这个目录下没有技能/, '选到空目录要给出空提示')
    assert.equal(html.includes('plugin-skill'), false, '筛选后不该混进插件提供的技能')
    assert.equal(html.includes('demo-skill'), false, '筛选后不该混进别的目录的技能')

    // 切回「全部目录」：技能要回来。
    await rendered.pickFilter('root', '')
    assert.match(rendered.container.innerHTML, /demo-skill/, '切回全部目录后技能要回来')
  } finally {
    await rendered.dispose()
  }
})

test('技能目录筛选：计数跟着筛选走，同名目录在下拉里能区分', async (t) => {
  const rendered = await renderPanel({
    primitives: true,
    // 随包分发的根会有好几个，`label` 全是 `bundled`：下拉里必须能分清。
    extraRoots: [
      { id: 'bundled-1', label: 'bundled', rank: 600, path: 'C:\\x\\bundle-a', exists: true, writable: false, skillCount: 0 },
      { id: 'bundled-2', label: 'bundled', rank: 600, path: 'C:\\x\\bundle-b', exists: true, writable: false, skillCount: 0 },
    ],
  })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    // 同名根带上路径尾巴，否则两个「bundled（0）」长得一模一样。
    assert.deepEqual(await rendered.openFilter('root'), [
      '全部目录（5）',
      '插件提供（1）',
      'project-dsh（0）',
      'user-agents（4）',
      'bundled · x/bundle-a（0）',
      'bundled · x/bundle-b（0）',
    ])
    // 收起浮层（点一下触发器）。
    await rendered.pickFilter('root', 'user-agents')
    const html = rendered.container.innerHTML
    assert.match(html, /demo-skill/)
    assert.match(html, /shadowed-skill/)
    assert.equal(html.includes('plugin-skill'), false, '别的目录的技能要滤掉')
    // 计数是「筛出来的 / 全部」，不能永远只报全部。
    assert.match(html, /共 4 \/ 5 个/, '筛选后计数要显示 4 / 5')
  } finally {
    await rendered.dispose()
  }
})

test('技能市场：设置是实心主按钮、搜索是描边按钮（跟 DSH 的按钮层级一致）', async (t) => {
  for (const market of [false, true]) {
    const rendered = await renderPanel({ primitives: true, market })
    if (!rendered) {
      t.skip('未安装 react / react-dom / jsdom')
      return
    }
    try {
      await rendered.click('技能市场')
      const find = (label) => [...rendered.container.querySelectorAll('button')]
        .find((item) => item.textContent.replace('↻', '') === label)
      const search = find('搜索')
      const settings = find('设置')
      assert.ok(search && settings, `市场页要有搜索与设置（market=${market}）`)
      assert.equal(search.getAttribute('data-ui'), 'button-outline', '搜索用描边按钮（白底）')
      assert.equal(settings.getAttribute('data-ui'), 'button-primary', '设置用实心主按钮（黑底）')
      // 位置关系不变：搜索右边紧挨着设置。
      const buttons = [...rendered.container.querySelectorAll('button')]
        .map((item) => item.textContent.replace('↻', ''))
      assert.equal(buttons.indexOf('设置'), buttons.indexOf('搜索') + 1, '设置紧挨着搜索右边')
    } finally {
      await rendered.dispose()
    }
  }
})

test('DSH 组件库可用时：刷新用它的图标与按钮，导入弹窗用它的 Modal 与关闭图标', async (t) => {
  const rendered = await renderPanel({ primitives: true })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    const html = rendered.html
    assert.match(html, /data-ui="icon-refresh"/, '刷新必须用 DSH 的刷新图标')
    assert.match(html, /data-ui="button-outline"/, '刷新走 DSH 的 Button（描边，不做实心主按钮）')
    // title 不再交给浏览器（原生 tooltip 跟 DSH 不一致），改成气泡；按钮上不该再有 title。
    assert.equal(html.includes('title="刷新"'), false, '按钮上不要留原生 title（改走 DSH 气泡）')
    // 卡片上的技能目录/分类是自绘彩色标签（不是 DSH 的 Tag：Tag 的色阶不够区分目录/分类）。
    assert.match(html, /data-sm-chip="root"/, '技能目录标签')
    assert.match(html, /data-sm-chip="category"/, '分类标签')
    // 页签保持普通文字按钮（此前误改成胶囊，用户要求改回去）。
    assert.equal(html.includes('data-ui="pill-'), false, '页签不要再换成胶囊样式')
    // 用户明确指出的问题：界面上只能有一个刷新入口。
    assert.equal((html.match(/>刷新</g) || []).length, 1, '刷新文案只能出现一次')

    /**
     * 取顶栏那一行的按钮文字（去掉替身图标字符，只比文字）。
     * @returns {string[]} 按钮文字。
     */
    const topbarButtons = () => [...rendered.container.querySelectorAll('[data-sm-topbar] button')]
      .map((item) => item.textContent.replace('↻', ''))
    /** 取已安装页工具栏里的按钮文字。 */
    const toolbarButtons = () => [...rendered.container.querySelectorAll('[data-sm-toolbar] button')].map((item) => item.textContent)
    // 顶栏在任何页签下都必须是同一组按钮、同一个顺序（用户报过"切 tab 右边就乱"）。
    assert.equal(JSON.stringify(topbarButtons()), JSON.stringify(['已安装', '技能市场', '回收站', '刷新']),
      '顶栏固定为：三个页签 + 刷新（设置已挪进技能市场页）')
    // 页签专属控件（两个筛选器 + 导入本地）放在内容区，不许挤进顶栏。
    assert.equal(topbarButtons().includes('导入本地'), false, '导入本地不在顶栏')
    assert.deepEqual(toolbarButtons(), ['全部目录（5）', '全部分类（5）', '导入本地'],
      '工具栏 = 技能目录筛选 + 分类筛选 + 导入本地')
    // 导入本地是实心主按钮（黑色）。
    const importButton = [...rendered.container.querySelectorAll('[data-sm-toolbar] button')]
      .find((item) => item.textContent === '导入本地')
    assert.equal(importButton.getAttribute('data-ui'), 'button-primary', '导入本地用实心主按钮')

    await rendered.click('导入本地')
    const dialog = rendered.container.innerHTML
    assert.match(dialog, /data-ui="modal"/, '导入弹窗必须用 DSH 的 Modal')
    assert.match(dialog, /data-ui="modal-close"/, '关闭用图标按钮，而不是文字"取消"')
    assert.match(dialog, /class="dsh-skill-manager-dialog-import"/, '导入弹窗要带 +50% 宽度的类名')
    assert.equal(dialog.includes('>取消<'), false, '不该再出现文字取消按钮')
    assert.match(dialog, /导入本地技能/)
    // 只有两件事：拖拽，或点击浏览本地目录。界面上只显示"这次选中的路径"。
    assert.match(dialog, /拖拽技能文件夹到这里/)
    assert.match(dialog, /或点击浏览本地目录/)
    assert.equal(rendered.requests.some((route) => route.startsWith('/skill-manager/browse')), false,
      '打开弹窗时不该自动去列目录')
    assert.equal(dialog.includes('这个目录里没有子目录'), false, '不该自动显示目录树')
    // 多余的东西一律不许有：目标根选择、覆盖勾选框、粘贴路径、路径输入框。
    assert.equal(dialog.includes('目标已存在时覆盖'), false, '不该再有覆盖勾选框')
    assert.equal(dialog.includes('粘贴路径'), false, '不该再有粘贴路径入口')
    assert.equal(rendered.container.querySelectorAll('input[type="checkbox"]').length, 0, '不该再有勾选框')
    assert.equal(rendered.container.querySelectorAll('input[type="text"]').length, 0, '不该再有路径输入框')
    // 「导入」按钮要在：选中之后由用户点这一下才真的导入。
    const dialogButtons = [...rendered.container.querySelectorAll('[data-ui="modal"] button')]
    // 「导入到」现在也是自绘下拉（触发器是个 button），所以按 data 属性把它排除掉再比。
    const plainButtons = dialogButtons
      .filter((item) => !item.hasAttribute('data-sm-select') && !item.hasAttribute('data-sm-select-trigger'))
      .map((item) => item.textContent)
    assert.deepEqual(plainButtons, ['x', '导入'], `弹窗里只有关闭图标与「导入」：${plainButtons.join('/')}`)
    assert.ok(rendered.container.querySelector('[data-sm-select="import-root"]'), '「导入到」要用自绘下拉（跟筛选器同一套），不能是原生 select')
    assert.equal(rendered.container.querySelectorAll('select').length, 0, '界面上不该再有原生 select')

    // 宿主半边没重启时（构建标记不一致）必须直接说出来，而不是让用户去猜报错。
    assert.match(html, /客户端与宿主半边版本不一致/, '构建标记不一致要给出提示')
    assert.match(html, /完全退出 DSH Desktop 再打开/)
    assert.equal(rendered.requests.some((route) => route.startsWith('/skill-manager/catalog')), true)

    // 技能详情也必须是弹窗，而不是塞在网格上方的内联面板。
    await rendered.clickInCard('demo-skill', '详情')
    const detail = rendered.container.innerHTML
    assert.match(detail, /data-ui="modal" data-title="demo-skill"/, '详情要用 DSH 的 Modal，标题是技能名')
    assert.match(detail, /data-ui="modal-close"/, '详情弹窗也要有关闭图标')
    // 宽度：详情弹窗带宽版类名，并注入了对应的 CSS（默认约 400px 级 → 3 倍 → 再收窄 20%）。
    assert.match(detail, /class="dsh-skill-manager-dialog-wide"/, '详情弹窗必须带宽版类名')
    const styleTag = rendered.document.querySelector('style[data-skill-manager="dialog-width"]')
    assert.ok(styleTag, '必须注入宽度样式')
    assert.match(styleTag.textContent, /dsh-skill-manager-dialog-wide\{width:min\(1056px,75vw\)!important/)
    assert.match(styleTag.textContent, /max-width:min\(1056px,75vw\)!important/)
    // 导入弹窗：DSH 默认 380px，+50% = 570px。
    assert.match(styleTag.textContent, /dsh-skill-manager-dialog-import\{width:min\(570px,92vw\)!important/)
    // 用户要求：详情不显示「何时使用」「问题」。
    const detailFacts = [...rendered.container.querySelectorAll('[data-ui="modal"] dt')].map((item) => item.textContent)
    assert.equal(detailFacts.includes('何时使用'), false, `详情不该有「何时使用」：${detailFacts.join('/')}`)
    assert.equal(detailFacts.includes('问题'), false, `详情不该有「问题」：${detailFacts.join('/')}`)
    assert.equal(detail.includes('当用户要做演示时'), false, 'whenToUse 的值不该再出现在详情里')
    assert.match(detail, /3 files \/ 1234 bytes/)
    // 弹窗里只留三个操作：查看 SKILL.md、启停开关、删除。模型/用户/重命名/复制都不再出现。
    assert.match(detail, /查看 SKILL\.md/)
    assert.match(detail, /删除/)
    assert.match(detail, /role="switch"/)
    assert.equal(detail.includes('模型'), false, '详情里不该再有模型开关')
    assert.equal(detail.includes('重命名'), false, '详情里不该再有重命名')
    assert.equal(detail.includes('复制到'), false, '详情里不该再有复制')
  } finally {
    await rendered.dispose()
  }
})

test('导入：点击浏览本地目录只选中路径，点「导入」才真的导入', async (t) => {
  const rendered = await renderPanel({ primitives: true, picker: true })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    await rendered.click('导入本地')
    assert.match(rendered.container.innerHTML, /或点击浏览本地目录/)
    assert.equal(rendered.requests.some((route) => route.startsWith('/skill-manager/browse')), false,
      '有系统选目录时不该去列目录')

    // 点拖拽区 → 调系统选目录 → 只把路径显示出来，**还没有导入**。
    const zone = [...rendered.container.querySelectorAll('[role="button"]')].at(-1)
    assert.ok(zone, '找不到拖拽/点击区')
    zone.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await rendered.settle()
    assert.match(rendered.container.innerHTML, /D:\\picked\\skill-folder/, '要显示这次选中的路径')
    assert.equal(rendered.imports.length, 0, '选中之后不该自动导入，要等用户点「导入」')

    // 「导入到」必须可以自己选目标根（用户报过这里被固定成 user-dsh 了）。
    // 现在是自绘下拉：点触发器开面板，面板里是 DSH 风格的单选列表。
    const rootTrigger = rendered.container.querySelector('[data-sm-select="import-root"]')
    assert.ok(rootTrigger, '导入弹窗里要有「导入到」的目标根选择')
    assert.match(rootTrigger.textContent, /user-agents/, '默认优先用户级根')
    await rendered.clickElement(rootTrigger)
    const rootOptions = [...rendered.container.querySelectorAll('[data-sm-filter="import-root"] [data-option-value]')]
      .map((item) => item.getAttribute('data-option-value'))
    assert.deepEqual(rootOptions, ['project-dsh', 'user-agents'], '列出所有可写技能根')
    await rendered.clickElement(rendered.container.querySelector('[data-sm-filter="import-root"] [data-option-value="project-dsh"]'))
    assert.match(rendered.container.querySelector('[data-sm-select="import-root"]').textContent, /project-dsh/,
      '选完要显示新目标')
    await rendered.click('导入')
    assert.equal(rendered.imports.at(-1).rootId, 'project-dsh', '换根之后要按选的根导入')

    // 再点一次「导入」用的是选中的那个路径。
    assert.equal(rendered.imports.length, 1, '点「导入」要发起一次导入')
    assert.equal(rendered.imports[0].sourcePath, 'D:\\picked\\skill-folder')
    assert.equal(rendered.imports[0].overwrite, false)
    assert.match(rendered.container.innerHTML, /已导入/)
  } finally {
    await rendered.dispose()
  }
})

test('导入成功后可以马上再选一个文件夹接着导入（按钮不能一直灰着）', async (t) => {
  const rendered = await renderPanel({ primitives: true, picker: true })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    await rendered.click('导入本地')
    const zone = () => [...rendered.container.querySelectorAll('[role="button"]')].at(-1)
    const importButton = () => [...rendered.container.querySelectorAll('[data-ui="modal"] button')]
      .find((item) => item.textContent === '导入')

    // 第一次：选中 → 导入。
    zone().dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await rendered.settle()
    await rendered.click('导入')
    assert.equal(rendered.imports.length, 1)
    assert.equal(importButton().disabled, true, '导入成功后按钮先置灰，防重复点')

    // 关键：再选一个文件夹之后，按钮必须恢复可点，并且能真的再导入一次。
    zone().dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await rendered.settle()
    assert.equal(importButton().disabled, false, '重新选中之后导入按钮必须可点（用户报过这里一直灰着）')
    await rendered.click('导入')
    assert.equal(rendered.imports.length, 2, '第二次也要能导入')
  } finally {
    await rendered.dispose()
  }
})

test('导入：没有系统选目录时，点击才展开本机目录（不是打开就铺开）', async (t) => {
  const rendered = await renderPanel({ primitives: true })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    await rendered.click('导入本地')
    assert.equal(rendered.requests.some((route) => route.startsWith('/skill-manager/browse')), false,
      '打开弹窗不该列目录')
    const zone = [...rendered.container.querySelectorAll('[role="button"]')].at(-1)
    zone.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await rendered.settle()
    assert.ok(rendered.requests.some((route) => route.startsWith('/skill-manager/browse')),
      '点击浏览本地目录要真的去列目录（以前这里点了没反应）')
  } finally {
    await rendered.dispose()
  }
})

test('导入遇到同名：弹确认框问是否覆盖，点「覆盖」才带 overwrite 重试', async (t) => {
  const rendered = await renderPanel({ primitives: true, picker: true, importConflict: true })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    await rendered.click('导入本地')
    const zone = [...rendered.container.querySelectorAll('[role="button"]')].at(-1)
    zone.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await rendered.settle()
    assert.equal(rendered.imports.length, 0, '选中路径本身不导入')
    await rendered.click('导入')

    // 第一次导入被拒（目标已存在）→ 界面弹确认框，而不是偷偷覆盖。
    assert.equal(rendered.imports.length, 1)
    assert.equal(rendered.imports[0].overwrite, false)
    const asked = rendered.container.innerHTML
    assert.match(asked, /已存在同名技能/, '要弹出覆盖确认框')
    assert.match(asked, /demo-skill/)
    assert.match(asked, /覆盖/)

    // 取消：不再发请求。
    await rendered.click('取消')
    assert.equal(rendered.imports.length, 1, '取消后不该再导入')
    assert.equal(rendered.container.innerHTML.includes('已存在同名技能'), false, '确认框要关掉')

    // 再点一次「导入」并确认覆盖：重试请求必须带 overwrite: true。
    await rendered.click('导入')
    assert.equal(rendered.imports.length, 2, '再点导入会再尝试一次')
    assert.equal(rendered.imports[1].overwrite, false)
    await rendered.click('覆盖')
    assert.equal(rendered.imports.length, 3, '确认覆盖后要带 overwrite 重试一次')
    assert.equal(rendered.imports[2].overwrite, true, '重试必须带 overwrite: true')
    assert.match(rendered.container.innerHTML, /已导入/)
  } finally {
    await rendered.dispose()
  }
})

test('切页签：右上角那组按钮位置与内容都不变（用户报过"切 tab 右边就乱"）', async (t) => {
  const rendered = await renderPanel({ primitives: true })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    const topbar = () => [...rendered.container.querySelectorAll('[data-sm-topbar] button')]
      .map((item) => item.textContent.replace('↻', ''))
    const expected = JSON.stringify(['已安装', '技能市场', '回收站', '刷新'])
    assert.equal(JSON.stringify(topbar()), expected, '初始（已安装）')
    for (const tab of ['技能市场', '回收站', '已安装']) {
      await rendered.click(tab)
      assert.equal(JSON.stringify(topbar()), expected, `切到「${tab}」后顶栏必须原样`)
      // 全页永远只有一个刷新。
      assert.equal((rendered.container.innerHTML.match(/>刷新</g) || []).length, 1, `「${tab}」下只能有一个刷新`)
    }
  } finally {
    await rendered.dispose()
  }
})

test('刷新按当前页签走：已安装重扫技能目录、回收站只重读、市场重跑搜索', async (t) => {
  const rendered = await renderPanel({ primitives: true, market: true })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    const clear = () => { rendered.requests.length = 0 }

    // 已安装：必须带 refresh=1（重扫技能文件夹、重建注册表）
    clear()
    await rendered.click('刷新')
    assert.ok(rendered.requests.some((route) => route.startsWith('/skill-manager/catalog?refresh=1')),
      `已安装页的刷新要重扫技能目录，实际请求：${JSON.stringify(rendered.requests)}`)

    // 回收站：只重读目录数据，不重扫技能目录
    await rendered.click('回收站')
    clear()
    await rendered.click('刷新')
    assert.ok(rendered.requests.some((route) => route.startsWith('/skill-manager/catalog')),
      '回收站页的刷新要重读目录数据')
    assert.equal(rendered.requests.some((route) => route.includes('refresh=1')), false,
      '回收站页不必重扫技能目录')

    // 技能市场：搜过一次之后，刷新要重跑那次搜索（并刷新已装列表）
    await rendered.click('技能市场')
    assert.ok(rendered.container.querySelector('input[placeholder="搜索技能"]'), '市场页要有搜索框')
    await rendered.click('搜索')
    assert.ok(rendered.requests.some((route) => route.startsWith('/skill-manager/market?q=')),
      `搜索要打到市场端点并带上关键词参数，实际请求：${JSON.stringify(rendered.requests)}`)
    clear()
    await rendered.click('刷新')
    assert.ok(rendered.requests.some((route) => route.startsWith('/skill-manager/market?q=')),
      `市场页的刷新要重跑当前搜索，实际请求：${JSON.stringify(rendered.requests)}`)
  } finally {
    await rendered.dispose()
  }
})

test('设置按钮在技能市场页的搜索右边（顶栏里没有它）', async (t) => {
  const rendered = await renderPanel({ primitives: true })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    assert.equal([...rendered.container.querySelectorAll('[data-sm-topbar] button')]
      .some((item) => item.textContent.includes('设置')), false, '顶栏里不该有设置')

    await rendered.click('技能市场')
    const buttons = [...rendered.container.querySelectorAll('button')].map((item) => item.textContent.replace('↻', ''))
    // 市场页里：搜索 → 设置（紧挨着右边）
    const searchButton = buttons.indexOf('搜索')
    const settingsButton = buttons.indexOf('设置')
    assert.ok(searchButton >= 0 && settingsButton >= 0, `市场页要有搜索与设置，实际：${JSON.stringify(buttons)}`)
    assert.equal(settingsButton, searchButton + 1, '设置要紧挨着搜索右边')

    await rendered.click('设置')
    assert.match(rendered.container.innerHTML, /市场地址/, '设置弹窗里要有市场地址')
  } finally {
    await rendered.dispose()
  }
})

test('卡片只留 3 个常显按钮：删除（红）/ 详情（描边）/ 启停开关，不用悬浮', async (t) => {
  const rendered = await renderPanel({ primitives: true })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    /**
     * 取某张卡片里的按钮。
     * @param {string} name 技能名。
     * @returns {Element[]} 按钮。
     */
    const cardButtons = (name) => {
      const card = rendered.container.querySelector(`[data-skill-card="${name}"]`)
      assert.ok(card, `找不到卡片：${name}`)
      return [...card.querySelectorAll('button')]
    }

    const demo = cardButtons('demo-skill')
    // 删除 + 详情 + 开关，一共三个；没有鼠标悬浮这回事（初始渲染就得在）。
    assert.equal(demo.length, 3, `卡片上只能有 3 个按钮，实际：${demo.map((item) => item.textContent).join('/')}`)
    const trash = demo.find((item) => item.textContent === '删除')
    const detail = demo.find((item) => item.textContent === '详情')
    const toggle = demo.find((item) => item.getAttribute('role') === 'switch')
    assert.ok(trash && detail && toggle, '三个按钮都要在')
    // 删除走 DSH 的"危险"样式（红字），详情走 DSH 的描边白按钮。
    assert.match(trash.className, /dsh-sm-danger/)
    assert.equal(detail.className, 'dsh-sm-compact')
    // 旧的那一堆悬浮按钮（模型/用户/文件/改名/复制）都不许再出现。
    const labels = demo.map((item) => item.textContent)
    for (const gone of ['模型', '用户', '改名', '复制', '📄', '✎', '⧉', '🗑']) {
      assert.equal(labels.some((label) => label.includes(gone)), false, `卡片上不该再有「${gone}」按钮`)
    }
    // 开关的类名与 DSH 的 Switch 一致（36×20 轨道 + 滑块）。
    assert.equal(toggle.className, 'dsh-sm-switch')
    assert.ok(toggle.querySelector('.dsh-sm-switch-thumb'), '开关要有滑块')

    // 插件提供的技能没有可写的文件：只留「详情」。
    const provided = cardButtons('plugin-skill')
    assert.equal(provided.length, 1, '插件内嵌技能只有「详情」')
    assert.equal(provided[0].textContent, '详情')
  } finally {
    await rendered.dispose()
  }
})

test('停用的技能：开关关着、卡片上不再有状态文字；开关开启色是 #00CC00', async (t) => {
  const rendered = await renderPanel({ primitives: true })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    const card = rendered.container.querySelector('[data-skill-card="off-skill"]')
    assert.ok(card, '被停用的技能也要在网格里')
    assert.equal(card.querySelector('button[role="switch"]').getAttribute('aria-checked'), 'false',
      '停用的技能开关必须是关的')
    // 状态文案已经从卡片上去掉了（用户要求）。
    assert.equal(card.textContent.includes('无效'), false, '卡片上不该有「无效」')
    assert.equal(card.textContent.includes('生效'), false, '卡片上不该有「生效」')

    // 开启态的颜色：用户指定 #00CC00（不是原来的黑）。
    const styleTag = rendered.document.querySelector('style[data-skill-manager="dialog-width"]')
    assert.ok(styleTag, '必须注入样式')
    assert.match(styleTag.textContent, /\.dsh-sm-switch\[aria-checked="true"\]\{background:#00CC00;?\}/,
      '开关开启时必须是 #00CC00')
    assert.equal(styleTag.textContent.includes('dsh-sm-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary'),
      false, '不能再沿用黑色的 brand-primary')
  } finally {
    await rendered.dispose()
  }
})

test('卡片上的开关：拨一下就同时写两个调用标记（开 / 关）', async (t) => {
  const rendered = await renderPanel({ primitives: true })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    const toggle = () => rendered.container.querySelector('[data-skill-card="demo-skill"] button[role="switch"]')
    assert.equal(toggle().getAttribute('aria-checked'), 'true', '默认是开着的')

    await rendered.clickElement(toggle())
    const calls = rendered.actions.filter((body) => body.action === 'set-invocation')
    // 一条请求带上两个标记：宿主把缺省的标记当 `true`，拆成两次发会把另一个又打开。
    assert.equal(calls.length, 1, `关一次只该发一条请求，实际：${JSON.stringify(calls)}`)
    assert.equal(calls[0].name, 'demo-skill')
    assert.equal(calls[0].rootId, 'user-agents')
    assert.equal(calls[0].modelInvocable, false, '模型标记要关掉')
    assert.equal(calls[0].userInvocable, false, '用户标记要关掉')
  } finally {
    await rendered.dispose()
  }
})

test('删除先弹确认框：取消不发请求，确认才真的删', async (t) => {
  const rendered = await renderPanel({ primitives: true })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    // 卡片上的「删除」
    await rendered.clickInCard('demo-skill', '删除')
    const confirmView = rendered.container.innerHTML
    assert.match(confirmView, /确认删除技能/, '要点删除就得先弹确认框')
    assert.match(confirmView, /删除后进回收站/, '确认框里要说清楚删到哪儿')
    // DSH 卸载确认那套：取消是描边，确认是实心红。
    const modalButtons = [...rendered.container.querySelectorAll('[data-ui="modal"] button')]
    assert.deepEqual(modalButtons.map((item) => item.textContent), ['x', '取消', '删除'])
    assert.match(modalButtons[2].className, /dsh-sm-danger-solid/)

    const before = rendered.actions.length
    await rendered.click('取消')
    assert.equal(rendered.actions.length, before, '取消之后不能发删除请求')
    assert.equal(rendered.container.innerHTML.includes('确认删除技能'), false, '取消要关掉确认框')

    await rendered.clickInCard('demo-skill', '删除')
    // 卡片上也有一个「删除」，所以这里必须点弹窗里那个。
    const modalTrash = [...rendered.container.querySelectorAll('[data-ui="modal"] button')]
      .find((item) => item.textContent === '删除')
    await rendered.clickElement(modalTrash)
    const trash = rendered.actions.filter((body) => body.action === 'trash')
    assert.equal(trash.length, 1, `确认之后才发删除请求，实际：${JSON.stringify(rendered.actions)}`)
    assert.equal(trash[0].name, 'demo-skill')
  } finally {
    await rendered.dispose()
  }
})

test('校验失败的技能：开关显示为关且不可拨（不能"灰轨道 + 滑块在右边"）', async (t) => {
  const rendered = await renderPanel({ primitives: true })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    // 禁止的原生 tooltip 已经换成 DSH 气泡：悬浮开关外面那层锚点才看得到解释
    // （禁用按钮本身在部分浏览器不发鼠标事件，这正是把锚点包在外面的原因）。
    const hoverAnchor = async (target) => {
      target.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, relatedTarget: null }))
      await rendered.settle()
    }
    const card = rendered.container.querySelector('[data-skill-card="Broken Name"]')
    assert.ok(card, '校验失败的技能也在网格里')
    const toggle = card.querySelector('button[role="switch"]')
    assert.equal(toggle.getAttribute('aria-checked'), 'false', '不能生效的技能，开关必须是关')
    assert.equal(toggle.disabled, true, '不能生效的技能，开关不可拨')
    assert.equal(toggle.getAttribute('title'), null, '开关上不该再有原生 title')
    await hoverAnchor(toggle.parentElement)
    const tip = rendered.container.querySelector('[data-sm-tooltip="switch"]')
    assert.ok(tip, '悬浮要出 DSH 气泡')
    assert.match(tip.textContent, /校验/, '要说明为什么不能拨')
    assert.match(tip.getAttribute('style'), /var\(--dsw-alias-tooltip-bg/, '气泡走 DSH 的 tooltip 底色')
    // 被遮蔽的技能同理。
    const shadowed = rendered.container.querySelector('[data-skill-card="shadowed-skill"] button[role="switch"]')
    assert.equal(shadowed.getAttribute('aria-checked'), 'false')
    assert.equal(shadowed.disabled, true)
    assert.equal(shadowed.getAttribute('title'), null)
    await hoverAnchor(shadowed.parentElement)
    const shadowedTip = rendered.container.querySelector('[data-sm-tooltip="switch"]')
    assert.ok(shadowedTip, '被遮蔽也要能悬浮看解释')
    assert.match(shadowedTip.textContent, /优先级/)
  } finally {
    await rendered.dispose()
  }
})

test('卡片高度翻倍后，描述文字吃掉多出来的空间（4 行 → 7 行）', async (t) => {
  const rendered = await renderPanel({ primitives: true })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    // 新顺序：名字+开关 → 标签 → 分割线 → 介绍。介绍在分割线下面。
    const desc = rendered.container.querySelector('[data-skill-card="demo-skill"] [data-sm-card-desc]')
    assert.ok(desc, '卡片里要有介绍块')
    assert.match(desc.textContent, /演示技能：说明文字/)
    const style = desc.getAttribute('style')
    assert.match(style, /max-height:\s*126px/, '描述最多 7 行（7 × 18px）')
    assert.match(style, /-webkit-line-clamp:\s*7/, '264px 的卡片正好放 7 行')
    assert.match(style, /flex:\s*1 1 auto/, '描述要吃掉分割线以下的剩余高度')
  } finally {
    await rendered.dispose()
  }
})

test('详情：facts 行高只有 DSH 原版的一半，查看 SKILL.md 之后再点变成「收起」', async (t) => {
  const rendered = await renderPanel({ primitives: true })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    const styleTag = rendered.document.querySelector('style[data-skill-manager="dialog-width"]')
    assert.ok(styleTag, '必须注入样式')
    // DSH 原版 `min-height:44px;padding:8px 2px`，这里按用户要求减半。
    assert.match(styleTag.textContent, /\.dsh-sm-facts > div\{[^}]*min-height:22px/)
    assert.match(styleTag.textContent, /\.dsh-sm-facts > div\{[^}]*padding:4px 2px/)

    await rendered.clickInCard('demo-skill', '详情')
    assert.match(rendered.container.innerHTML, /查看 SKILL\.md/, '一开始是「查看」')
    // 详情只看信息：没有启停开关、没有删除、也没有「状态」这一行（用户要求）。
    // 注意作用域：整页里卡片上本来就有开关，所以要限定在弹窗里查。
    const detailDialog = rendered.container.querySelector('[data-ui="modal"]')
    assert.ok(detailDialog, '详情要用 Modal')
    assert.equal(detailDialog.querySelector('button[role="switch"]'), null, '详情页不该有启停开关')
    const dialogButtons = [...detailDialog.querySelectorAll('button')].map((item) => item.textContent).filter(Boolean)
    assert.equal(dialogButtons.includes('删除'), false, `详情页不该有删除按钮，实际：${dialogButtons.join('/')}`)
    const dtLabels = [...detailDialog.querySelectorAll('dt')].map((item) => item.textContent)
    const factsText = dtLabels
    assert.equal(factsText.includes('状态'), false, `详情 facts 里不该有「状态」行：${factsText.join('/')}`)
    assert.ok(factsText.includes('技能目录'), '其他 facts 照旧')
    assert.ok(dtLabels.includes('分类'), `分类那一行的标签要叫「分类」：${dtLabels.join('/')}`)
    assert.equal(dtLabels.includes('添加分类'), false, '不要再叫「添加分类」')
    await rendered.click('查看 SKILL.md')
    const opened = rendered.container.innerHTML
    assert.match(opened, /demo-skill 正文/, '点了就要显示文件内容')
    assert.match(opened, /收起文件/, '文件展开后按钮要变成「收起」')
    assert.equal(opened.includes('查看 SKILL.md'), false, '不该同时留着「查看」')

    await rendered.click('收起文件')
    const closed = rendered.container.innerHTML
    assert.equal(closed.includes('demo-skill 正文'), false, '收起后内容要消失')
    assert.match(closed, /查看 SKILL\.md/, '按钮要变回「查看」')
  } finally {
    await rendered.dispose()
  }
})

test('回收站：行样式跟 DSH 一致，三个按钮是 红/白/红，危险操作走确认弹窗', async (t) => {
  const rendered = await renderPanel({ primitives: true })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    await rendered.click('回收站')
    const container = rendered.container

    // 一行一条：ul/li + 细线分隔（不是一叠描边卡片）。
    const row = container.querySelector('ul li[data-trash-row="deleted-skill"]')
    assert.ok(row, '回收站要按行显示')
    assert.match(row.getAttribute('style'), /border-bottom:\s*0\.5px solid/, '行之间是细线分隔')
    assert.equal(row.getAttribute('style').includes('border-radius'), false, '行不再是圆角卡片')
    // 文字层级：只有名字 + 来源与时间（按用户要求**不显示技能路径**）。
    assert.match(row.textContent, /deleted-skill/)
    assert.match(row.textContent, /user-agents/, '要显示来源技能根')
    assert.equal(row.textContent.includes('SKILL.md'), false, '回收站行里不再显示路径')
    assert.equal(row.textContent.includes('C:\\Users'), false, '回收站行里不再显示路径')
    // 两行文字，行内距比三行版本小（8px 上下）。
    assert.match(row.getAttribute('style'), /padding:\s*8px 2px/, '行内距要跟着两行内容调整')

    // 三个按钮的颜色层级：清空回收站=红、还原=白（描边）、彻底删除=红。
    const emptyButton = [...container.querySelectorAll('button')].find((item) => item.textContent === '清空回收站')
    const restoreButton = [...row.querySelectorAll('button')].find((item) => item.textContent === '还原')
    const purgeButton = [...row.querySelectorAll('button')].find((item) => item.textContent === '彻底删除')
    assert.ok(emptyButton && restoreButton && purgeButton, '三个按钮都要在')
    assert.match(emptyButton.className, /dsh-sm-danger/)
    assert.equal(restoreButton.className, 'dsh-sm-compact', '还原是白色描边按钮')
    assert.match(purgeButton.className, /dsh-sm-danger/)

    // 彻底删除：先弹确认框，取消不发请求。
    const before = rendered.actions.length
    await rendered.clickElement(purgeButton)
    assert.match(container.innerHTML, /彻底删除这个技能/, '要弹确认框')
    const modalButtons = [...container.querySelectorAll('[data-ui="modal"] button')]
    assert.deepEqual(modalButtons.map((item) => item.textContent), ['x', '取消', '彻底删除'])
    assert.match(modalButtons[2].className, /dsh-sm-danger-solid/, '确认按钮是实心红')
    await rendered.clickElement(modalButtons[1])
    assert.equal(rendered.actions.length, before, '取消之后不能发请求')

    // 再点一次并确认：才真的彻底删除。
    await rendered.clickElement(purgeButton)
    const confirmButton = [...container.querySelectorAll('[data-ui="modal"] button')]
      .find((item) => item.textContent === '彻底删除')
    await rendered.clickElement(confirmButton)
    const purged = rendered.actions.filter((body) => body.action === 'purge')
    assert.equal(purged.length, 1, `确认后才发请求，实际：${JSON.stringify(rendered.actions)}`)
    assert.equal(purged[0].id, 't1')
    assert.equal(purged[0].confirm, true)

    // 清空回收站：同一套确认框。
    await rendered.clickElement(emptyButton)
    assert.match(container.innerHTML, /清空回收站/, '确认框标题就是清空回收站')
    assert.match(container.innerHTML, /无法恢复/)
  } finally {
    await rendered.dispose()
  }
})

test('两个筛选互相联动：先选目录分类变窄，先选分类目录也变窄', async (t) => {
  const rendered = await renderPanel({ primitives: true })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    assert.ok(rendered.container.querySelector('[data-sm-filter="root"]'), '要有技能目录筛选器')
    assert.ok(rendered.container.querySelector('[data-sm-filter="category"]'), '要有分类筛选器')
    // 初始：两边都是全量。
    assert.deepEqual(await rendered.openFilter('root'), ['全部目录（5）', '插件提供（1）', 'project-dsh（0）', 'user-agents（4）'])
    // 分类来自 metadata.category，没写的归到「未分类」。
    assert.deepEqual(await rendered.openFilter('category'), ['全部分类（5）', 'demo（1）', '未分类（4）'])

    // ① 先选分类：只剩带 category: demo 的那个。
    await rendered.pickFilter('category', 'demo')
    assert.match(rendered.container.innerHTML, /共 1 \/ 5 个/)
    assert.match(rendered.container.innerHTML, /demo-skill/)
    assert.equal(rendered.container.innerHTML.includes('off-skill'), false, '别的分类要被滤掉')

    // ② **反向联动**：目录下拉只剩"真的有 demo"的目录，计数也是筛完之后的；
    //    空目录 project-dsh 和没有分类的插件技能都不该出现。
    assert.deepEqual(await rendered.openFilter('root'), ['全部目录（1）', 'user-agents（1）'],
      '先选分类时，目录下拉要跟着收窄')

    // ③ 再叠目录：还是那一个（两个条件是与的关系）。
    await rendered.pickFilter('root', 'user-agents')
    assert.match(rendered.container.innerHTML, /共 1 \/ 5 个/)
    assert.match(rendered.container.innerHTML, /demo-skill/)

    // ④ 回到全部目录：分类仍然生效（不会因为换目录被清掉）。
    await rendered.pickFilter('root', '')
    assert.match(rendered.container.innerHTML, /共 1 \/ 5 个/)
    // 触发器显示的是"当前选中的那一项"，所以是 demo（1）——计数跟着目录走。
    assert.equal(rendered.container.querySelector('[data-sm-select="category"]').textContent, 'demo（1）',
      '分类触发器的计数跟着目录走')

    // ⑤ 清掉分类：回到 5 条。
    await rendered.pickFilter('category', '')
    assert.match(rendered.container.innerHTML, /共 5 个/)

    // ⑥ 另一个方向：先选目录 → 分类选项变窄；选到没有技能的目录时分类被清掉并禁用。
    await rendered.pickFilter('root', 'project-dsh')
    assert.match(rendered.container.innerHTML, /这个目录下没有技能/)
    const categoryTrigger = rendered.container.querySelector('[data-sm-select="category"]')
    assert.equal(categoryTrigger.textContent, '全部分类（0）', '分类筛选要自动回到全量')
    assert.equal(categoryTrigger.disabled, true, '没有分类可选时禁用')
    assert.deepEqual(await rendered.openFilter('category'), [], '禁用时点不开浮层')

    // ⑦ 回到全部目录：分类筛选仍是「全部分类」（没有残留）。
    await rendered.pickFilter('root', '')
    assert.equal(rendered.container.querySelector('[data-sm-select="category"]').textContent, '全部分类（5）')
    assert.match(rendered.container.innerHTML, /共 5 个/)
  } finally {
    await rendered.dispose()
  }
})

test('筛选下拉浮层照 DSH 的菜单样式，卡片带 hover 底色', async (t) => {
  const rendered = await renderPanel({ primitives: true })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    const trigger = rendered.container.querySelector('[data-sm-select="root"]')
    assert.equal(trigger.className, 'dsh-sm-select')
    // 筛选器还是「带边框的字段」：框是一种边界（用户明确说这比竖分割线好），
    // 框里那个按钮只负责文字 + 箭头，自身无边框。
    const field = trigger.closest('[data-sm-filter="root"]')
    assert.match(field.getAttribute('style'), /border:\s*0\.5px solid/, '筛选器要有边框')
    assert.match(field.getAttribute('style'), /height:\s*32px/)
    assert.equal(trigger.getAttribute('style').includes('border: medium'), true, '框里的按钮没有边框')

    await rendered.openFilter('root')
    const menu = rendered.container.querySelector('[data-sm-filter="root"] [role="listbox"]')
    assert.ok(menu, '点开要有浮层列表')
    const menuStyle = menu.getAttribute('style')
    assert.match(menuStyle, /position:\s*fixed/, '浮层是浮起来的（fixed 定位，弹窗里也不会被裁掉），不挤下面的内容')
    assert.match(menuStyle, /border-radius:\s*var\(--dsw-radius-lg/, '圆角照 DSH 菜单')
    assert.match(menuStyle, /dsw-elevation-prominent/, '阴影用 DSH 的 elevation token')
    // 每一项 34px 高；选中项只靠右侧对勾区分，**不能有底色**（底色留给悬停）。
    const selected = menu.querySelector('[role="option"][aria-selected="true"]')
    assert.ok(selected, '当前项要有 aria-selected')
    assert.match(selected.getAttribute('style'), /min-height:\s*34px/)
    assert.ok(selected.querySelector('svg'), '当前项右侧要有对勾')
    assert.match(selected.getAttribute('style'), /background:\s*transparent/, '选中项不要再上底色（有对勾就够了）')
    const others = [...menu.querySelectorAll('[role="option"]')].filter((item) => item !== selected)
    assert.ok(others.length > 0)
    for (const item of others) {
      assert.equal(item.querySelector('svg'), null, '没选中的项不该有对勾')
    }
    assert.equal(menu.querySelectorAll('[role="option"]').length, 4)
    // 浮层必须不透明：菜单浮在卡片上，半透明会透出下面的字。
    assert.match(menuStyle, /background:\s*var\(--dsw-alias-bg-base/, '浮层要用不透明底色')

    const styleTag = rendered.document.querySelector('style[data-skill-manager="dialog-width"]')
    assert.ok(styleTag, '必须注入样式')
    // hover 在**字段框**上（框就是一整个控件），列表行 hover 才上底色。
    assert.match(styleTag.textContent, /\.dsh-sm-field:hover\{border-color/, '字段框要有 hover 效果')
    assert.match(styleTag.textContent, /\.dsh-sm-select\[aria-expanded="true"\] \.dsh-sm-chevron\{transform:rotate\(180deg\)/, '展开时箭头要转 180°')
    assert.match(styleTag.textContent, /\.dsh-sm-menu-item:hover\{background:var\(--dsw-alias-interactive-bg-hover/, '浮层选项要有 hover 效果')
    assert.match(styleTag.textContent, /\.dsh-sm-card:hover\{background:var\(--dsw-alias-interactive-bg-hover/)
    const card = rendered.container.querySelector('[data-skill-card="demo-skill"]')
    assert.equal(card.className, 'dsh-sm-card', '卡片要挂 hover 类名')
    assert.equal(selected.className, 'dsh-sm-menu-item', '选项要挂 hover 类名')
  } finally {
    await rendered.dispose()
  }
})

test('卡片底部固定：分割线以上是介绍，下面是目录/分类彩色标签 + 按钮', async (t) => {
  const rendered = await renderPanel({ primitives: true })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    const card = rendered.container.querySelector('[data-skill-card="demo-skill"]')
    // 版式（用户定的）：名字+开关 → 标签 → 分割线 → 介绍 → 删除/详情。
    const children = [...card.children]
    assert.equal(children.length, 5, `卡片应该是 5 块，实际 ${children.length}`)
    assert.match(children[0].textContent, /demo-skill/, '第 1 块是名字那一行')
    assert.equal(children[0].textContent.includes('生效'), false, '名字那一行不再带状态')

    // 第 1 块里：名字 + 开关（开关在名字右侧）。
    const head = children[0]
    assert.equal(head.getAttribute('data-sm-card-head'), '1')
    assert.ok(head.querySelector('[data-skill-name]'), '名字在这一行')
    const headSwitch = head.querySelector('button[role="switch"]')
    assert.ok(headSwitch, '启停开关也要在这一行')
    assert.match(head.querySelector('[data-skill-name]').getAttribute('style'), /flex:\s*1 1 auto/,
      '名字占满左侧，开关自然被推到最右')

    // 第 2 块：标签行，左对齐（默认 flex-start，不写 justify-content:flex-end）。
    const tags = children[1]
    assert.equal(tags.getAttribute('data-sm-card-tags'), '1')
    assert.equal(/justify-content:\s*flex-end/.test(tags.getAttribute('style')), false, '标签行要左对齐')
    const chips = [...tags.querySelectorAll('[data-sm-chip]')]
    assert.equal(chips.length, 2, '目录标签 + 分类标签')
    assert.equal(chips[0].getAttribute('data-sm-chip'), 'root')
    assert.equal(chips[1].getAttribute('data-sm-chip'), 'category')
    assert.equal(chips[1].textContent, 'demo', '分类取自 metadata.category')

    // 第 3 块：分割线；第 4 块：介绍（在分割线下方）。
    assert.equal(children[2].getAttribute('data-sm-card-divider'), '1')
    assert.match(children[2].getAttribute('style'), /border-top:\s*0\.5px solid/, '标签下方是分割线')
    assert.equal(children[3].getAttribute('data-sm-card-desc'), '1')
    assert.match(children[3].textContent, /演示技能：说明文字/, '分割线以下全是介绍')

    // 第 5 块：删除 / 详情，压在卡片最下方、右对齐。
    const actions = children[4]
    assert.equal(actions.getAttribute('data-sm-card-actions'), '1')
    assert.match(actions.getAttribute('style'), /justify-content:\s*flex-end/, '按钮行要右对齐')
    assert.match(actions.getAttribute('style'), /margin-top:\s*auto/, '按钮行要贴卡片底部')
    const labels = [...actions.querySelectorAll('button')].map((item) => item.textContent).filter(Boolean)
    assert.deepEqual(labels, ['删除', '详情'], '最下方只放删除 / 详情（开关已上移到名字那行）')
    assert.equal(actions.querySelector('button[role="switch"]'), null, '开关不该再出现在底部按钮行')

    // 标签颜色：目录和分类不同色。
    const inkOf = (chip) => (chip.getAttribute('style').match(/color:\s*(rgb\([^)]+\))/) || [])[1]
    assert.ok(inkOf(chips[0]) && inkOf(chips[1]), '标签要有颜色')
    assert.notEqual(inkOf(chips[0]), inkOf(chips[1]), '目录和分类用不同颜色')

    // 不同目录 → 不同颜色；没有 category 的技能显示「未分类」。
    const otherRoot = rendered.container.querySelector('[data-skill-card="plugin-skill"] [data-sm-chip="root"]')
    assert.notEqual(inkOf(otherRoot), inkOf(chips[0]), '不同技能目录颜色不同')
    const noCategory = rendered.container.querySelector('[data-skill-card="off-skill"] [data-sm-chip="category"]')
    assert.equal(noCategory.textContent, '未分类')
  } finally {
    await rendered.dispose()
  }
})

test('卡片名：一行省略；没被截断不出气泡，被截断才用 DSH 气泡显示完整名', async (t) => {
  // React 的 onMouseEnter 是靠 mouseover 委托合成的，这里派发 mouseover（relatedTarget 为空 = 从外面进来）。
  const hover = async (rendered, element) => {
    element.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, relatedTarget: null }))
    await rendered.settle()
  }

  // 1) 没截断（正常宽度）：悬浮不出气泡，名字上也不留原生 title。
  const normal = await renderPanel({ primitives: true })
  if (!normal) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    const card = normal.container.querySelector('[data-skill-card="demo-skill"]')
    assert.equal(card.getAttribute('title'), null, '卡片根上不该再挂 title（悬浮名字会冒出介绍）')
    const name = card.querySelector('[data-skill-name]')
    assert.ok(name, '名字元素要带 data-skill-name，便于定位')
    assert.equal(name.textContent, 'demo-skill')
    const style = name.getAttribute('style')
    assert.match(style, /white-space:\s*nowrap/, '名字永远一行')
    assert.match(style, /text-overflow:\s*ellipsis/, '太长显示省略号')
    assert.equal(name.getAttribute('data-truncated'), 'false', '没截断')
    assert.equal(name.getAttribute('title'), null, '不用原生 title（样式跟 DSH 不一致）')
    await hover(normal, name)
    assert.equal(normal.container.querySelector('[data-sm-tooltip]'), null, '没截断就什么提示都不显示')
  } finally {
    await normal.dispose()
  }

  // 2) 截断（伪造"元素比容器宽"）：悬浮出 DSH 气泡，内容是完整技能名。
  const squeezed = await renderPanel({ primitives: true, layout: { client: 80, scroll: 200 } })
  try {
    const name = squeezed.container.querySelector('[data-skill-card="demo-skill"] [data-skill-name]')
    assert.equal(name.getAttribute('data-truncated'), 'true', '被截断')
    assert.equal(name.getAttribute('title'), null, '原生 title 一律不用')
    await hover(squeezed, name)
    const tip = squeezed.container.querySelector('[data-sm-tooltip="name"]')
    assert.ok(tip, '被截断时悬浮要出气泡')
    assert.equal(tip.textContent, 'demo-skill', '气泡里是完整技能名')
    const tipStyle = tip.getAttribute('style')
    assert.match(tipStyle, /position:\s*fixed/, '气泡 fixed 才不会被卡片裁掉')
    assert.match(tipStyle, /var\(--dsw-alias-tooltip-bg/, '气泡走 DSH 的 tooltip 底色')
    assert.match(tipStyle, /pointer-events:\s*none/)
    assert.match(tipStyle, /max-width:\s*50vw/, '名字气泡保持默认宽度（只有卡片介绍收窄）')
    // 移开就收起。
    name.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, relatedTarget: null }))
    await squeezed.settle()
    assert.equal(squeezed.container.querySelector('[data-sm-tooltip]'), null, '移开要收起')
  } finally {
    await squeezed.dispose()
  }
})

test('卡片里的标签悬浮也是 DSH 气泡；卡片内不再有任何原生 title', async (t) => {
  const hover = async (rendered, element) => {
    element.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, relatedTarget: null }))
    await rendered.settle()
  }

  // 1) 没省略：悬浮不出气泡；整张卡片里也没有任何原生 `title=`。
  const normal = await renderPanel({ primitives: true })
  if (!normal) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    const card = normal.container.querySelector('[data-skill-card="demo-skill"]')
    assert.equal(card.innerHTML.includes('title="'), false, '卡片里不该再有原生 title（标签/按钮/开关都走气泡）')
    const chip = card.querySelector('[data-sm-chip="category"]')
    await hover(normal, chip)
    assert.equal(normal.container.querySelector('[data-sm-tooltip]'), null, '标签没被省略就不该有气泡')
  } finally {
    await normal.dispose()
  }

  // 2) 被省略：悬浮出 DSH 气泡，内容是标签全文。
  const squeezed = await renderPanel({ primitives: true, layout: { client: 40, scroll: 120 } })
  try {
    const chip = squeezed.container.querySelector('[data-skill-card="demo-skill"] [data-sm-chip="category"]')
    await hover(squeezed, chip)
    const tip = squeezed.container.querySelector('[data-sm-tooltip="chip"]')
    assert.ok(tip, '标签被省略时悬浮要给气泡')
    assert.equal(tip.textContent, 'demo', '气泡里是标签全文')
    const style = tip.getAttribute('style')
    assert.match(style, /position:\s*fixed/, '气泡 fixed，不被卡片裁掉')
    assert.match(style, /var\(--dsw-alias-tooltip-bg/, '气泡底色走 DSH tooltip token')
    assert.match(style, /pointer-events:\s*none/)
  } finally {
    await squeezed.dispose()
  }
})

test('筛选器触发器不留原生 title；只有值被省略时才出 DSH 气泡', async (t) => {
  const hover = async (rendered, element) => {
    element.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, relatedTarget: null }))
    await rendered.settle()
  }

  const normal = await renderPanel({ primitives: true })
  if (!normal) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    const trigger = normal.container.querySelector('[data-sm-select="root"]')
    assert.equal(trigger.getAttribute('title'), null, '触发器上不该再有原生 title（它就显示"技能目录"，跟左侧标签重复）')
    await hover(normal, trigger)
    assert.equal(normal.container.querySelector('[data-sm-tooltip="filter"]'), null, '值没被省略就不出气泡')
  } finally {
    await normal.dispose()
  }

  // 值被省略（伪造窄宽度）：悬浮出气泡，内容是完整的当前选项。
  const squeezed = await renderPanel({ primitives: true, layout: { client: 40, scroll: 200 } })
  try {
    const trigger = squeezed.container.querySelector('[data-sm-select="root"]')
    await hover(squeezed, trigger)
    const tip = squeezed.container.querySelector('[data-sm-tooltip="filter"]')
    assert.ok(tip, '值被省略时悬浮要给气泡')
    assert.match(tip.textContent, /全部目录/, '气泡里是完整的当前值')
    assert.match(tip.getAttribute('style'), /var\(--dsw-alias-tooltip-bg/, '气泡走 DSH tooltip token')
  } finally {
    await squeezed.dispose()
  }
})

test('介绍显示不全时，悬浮才给 DSH 风格的气泡提示', async (t) => {
  // React 的 onMouseEnter 是靠 mouseover 委托合成的，这里派发 mouseover（relatedTarget 为空 = 从外面进来）。
  const hover = async (rendered, element) => {
    element.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, relatedTarget: null }))
    await rendered.settle()
  }

  // 1) 没被裁：悬浮不出气泡。
  const normal = await renderPanel({ primitives: true })
  if (!normal) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    const desc = normal.container.querySelector('[data-skill-card="demo-skill"] [data-sm-card-desc]')
    await hover(normal, desc)
    assert.equal(normal.container.querySelector('[data-sm-tooltip]'), null, '介绍显示得下就不该有气泡')
  } finally {
    await normal.dispose()
  }

  // 2) 被裁：悬浮出气泡，内容就是完整介绍，样式走 DSH 的 tooltip token。
  const clipped = await renderPanel({
    primitives: true,
    layout: { client: 200, scroll: 200, clientHeight: 126, scrollHeight: 400 },
  })
  try {
    const desc = clipped.container.querySelector('[data-skill-card="demo-skill"] [data-sm-card-desc]')
    assert.ok(desc, '卡片里有介绍块')
    await hover(clipped, desc)
    const tip = clipped.container.querySelector('[data-sm-tooltip]')
    assert.ok(tip, '介绍显示不全时悬浮要给气泡')
    assert.equal(tip.getAttribute('role'), 'tooltip')
    assert.match(tip.textContent, /演示技能：说明文字/, '气泡里是完整介绍')
    const style = tip.getAttribute('style')
    assert.match(style, /position:\s*fixed/, '气泡用 fixed，才不会被卡片的 overflow 裁掉')
    assert.match(style, /var\(--dsw-alias-tooltip-bg/, '气泡底色用 DSH 的 tooltip token')
    assert.match(style, /pointer-events:\s*none/, '气泡不吃鼠标事件')
    // 宽度：卡片介绍的气泡只有默认（50vw）的一半——25vw（用户指定）。
    assert.match(style, /max-width:\s*25vw/, '卡片介绍的气泡宽度要收窄到默认的一半')
    // 鼠标移开就收起。
    desc.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, relatedTarget: null }))
    await clipped.settle()
    assert.equal(clipped.container.querySelector('[data-sm-tooltip]'), null, '移开要收起')
  } finally {
    await clipped.dispose()
  }
})

test('靠右/靠底的卡片：介绍气泡会被夹回视口内', async (t) => {
  const hover = async (rendered, element) => {
    element.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, relatedTarget: null }))
    await rendered.settle()
  }
  const tooltipStyle = (rendered) => {
    const tip = rendered.container.querySelector('[data-sm-tooltip]')
    assert.ok(tip, '应该有气泡')
    return tip.getAttribute('style')
  }

  // 1) 最右一列：卡片左边缘 1200px，视口只有 1024px 宽 → 气泡必须往左收，不能顶出右边。
  const right = await renderPanel({
    primitives: true,
    layout: {
      client: 200,
      scroll: 200,
      clientHeight: 126,
      scrollHeight: 400,
      viewport: { width: 1024, height: 768 },
      // 气泡和触发元素量出来都是 200×60（假布局）。
      rect: { left: 1200, top: 200, width: 200, height: 60 },
    },
  })
  if (!right) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    await hover(right, right.container.querySelector('[data-skill-card="demo-skill"] [data-sm-card-desc]'))
    const style = tooltipStyle(right)
    // maxLeft = 1024 - 200(气泡宽) - 8(边距) = 816
    assert.match(style, /left:\s*816px/, '气泡左边要被夹到视口内')
    // 触发元素的 bottom = 200 + 60 = 260，气泡贴在下方 6px 处。
    assert.match(style, /top:\s*266px/, '下方放得下就显示在下方（260+6）')
    assert.match(style, /max-width:\s*25vw/, '卡片介绍气泡的宽度上限是默认的一半（25vw）')
  } finally {
    await right.dispose()
  }

  // 2) 最下面一行：下方放不下 → 翻到触发元素上方。
  const bottom = await renderPanel({
    primitives: true,
    layout: {
      client: 200,
      scroll: 200,
      clientHeight: 126,
      scrollHeight: 400,
      viewport: { width: 1024, height: 768 },
      rect: { left: 100, top: 700, width: 200, height: 60 },
    },
  })
  try {
    await hover(bottom, bottom.container.querySelector('[data-skill-card="demo-skill"] [data-sm-card-desc]'))
    const style = tooltipStyle(bottom)
    // 下方：746+60=806 > 768-8 → 翻到上方：700-60-6 = 634
    assert.match(style, /top:\s*634px/, '下方不够高就翻到上方')
    assert.match(style, /left:\s*100px/, '左边够宽就贴着触发元素')
  } finally {
    await bottom.dispose()
  }
})

test('导入失败时提示要标红（成功那条不标红）', async (t) => {
  const rendered = await renderPanel({ primitives: true, picker: true, importError: true })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    await rendered.click('导入本地')
    const zone = [...rendered.container.querySelectorAll('[role="button"]')].at(-1)
    zone.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await rendered.settle()
    await rendered.click('导入')

    const message = rendered.container.querySelector('[data-sm-import-message]')
    assert.ok(message, '导入之后要有提示')
    assert.equal(message.getAttribute('data-sm-import-message'), 'error', '失败要标成 error')
    assert.match(message.textContent, /导入失败/)
    // `styles.error` 就是红色（#d4380d），提示文字必须带上它。
    assert.match(message.getAttribute('style'), /color:\s*rgb\(212, 56, 13\)|color:\s*#d4380d/i, '失败提示要标红')
  } finally {
    await rendered.dispose()
  }
})

test('市场安装走两步：先给清单确认，带 confirm:true 才落盘', async (t) => {
  const rendered = await renderPanel({ primitives: true, market: true })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    await rendered.click('技能市场')
    await rendered.click('搜索')
    await rendered.click('安装')

    // 第一次请求不带 confirm；界面要弹出清单确认框。
    assert.equal(rendered.installs.length, 1)
    assert.equal(rendered.installs[0].confirm, false)
    const confirmView = rendered.container.innerHTML
    assert.match(confirmView, /确认安装/, '要弹出安装确认框')
    assert.match(confirmView, /SKILL\.md/, '确认框里要有文件清单')
    assert.match(confirmView, /412 B/, '文件清单要带大小')
    assert.match(confirmView, /sha256:bb/, '要展示包摘要')

    await rendered.click('确认安装')
    assert.equal(rendered.installs.length, 2, '确认后要再发一次')
    assert.equal(rendered.installs[1].confirm, true, '第二次必须带 confirm: true')
    assert.match(rendered.container.innerHTML, /完成/)
  } finally {
    await rendered.dispose()
  }
})

test('切入口：回收站可还原、市场未配置有说明、设置列出技能目录与 rank', async (t) => {
  const rendered = await renderPanel()
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    await rendered.click('回收站')
    const trashView = rendered.container.innerHTML
    assert.match(trashView, /deleted-skill/)
    assert.match(trashView, /还原/)
    assert.match(trashView, /彻底删除/)
    assert.match(trashView, /清空回收站/)

    await rendered.click('技能市场')
    const marketView = rendered.container.innerHTML
    assert.match(marketView, /未配置市场地址/)
    assert.match(marketView, /搜索技能/)
    // 设置按钮就在市场页（搜索右边），点开是设置弹窗。
    assert.ok([...rendered.container.querySelectorAll('button')].some((item) => item.textContent === '设置'),
      '市场页要有设置按钮')

    await rendered.click('设置')
    const settingsView = rendered.container.innerHTML
    assert.match(settingsView, /rank 100/)
    assert.match(settingsView, /rank 500/)
    assert.match(settingsView, /目录不存在/)
    assert.match(settingsView, /注册表/)
  } finally {
    await rendered.dispose()
  }
})

test('详情页：右下是 取消 / 确定，没改动时确定不可点；取消不发请求', async (t) => {
  const rendered = await renderPanel({ primitives: true })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    await rendered.clickInCard('demo-skill', '详情')
    const dialog = rendered.container.querySelector('[data-ui="modal"]')
    assert.ok(dialog, '详情要用 Modal')
    const buttons = [...dialog.querySelectorAll('button')].map((item) => item.textContent)
    assert.ok(buttons.includes('取消'), '要有取消')
    assert.ok(buttons.includes('确定'), '要有确定')
    // 顺序：确定在取消右边。
    assert.ok(buttons.indexOf('确定') > buttons.indexOf('取消'), `按钮顺序不对：${buttons.join('/')}`)

    // 说明文字在「取消」左边（用户要求），不占正文第一行。
    const hint = dialog.querySelector('[data-sm-edit-hint]')
    assert.ok(hint, '要显示「改完点确定才生效」的提示')
    const footerRow = hint.parentElement
    const rowButtons = [...footerRow.querySelectorAll('button')].map((item) => item.textContent)
    assert.deepEqual(rowButtons, ['查看 SKILL.md', '取消', '确定'], `底部按钮顺序不对：${rowButtons.join('/')}`)
    const cancelButton = [...footerRow.querySelectorAll('button')].find((item) => item.textContent === '取消')
    // 4 = Node.DOCUMENT_POSITION_FOLLOWING：提示在取消之前。
    assert.equal(hint.compareDocumentPosition(cancelButton) & 4, 4, '提示要排在「取消」左边')

    const save = dialog.querySelector('[data-sm-save]')
    assert.ok(save, '确定按钮要带 data-sm-save')
    assert.equal(save.getAttribute('data-sm-save'), 'off', '没改动时确定不可点')
    assert.equal(save.disabled, true)

    // 改动前的请求计数：点取消后不能有任何写动作。
    const writes = () => rendered.actions.filter((item) => item.action === 'set-categories' || item.action === 'move-root')
    assert.equal(writes().length, 0)
    await rendered.click('取消')
    assert.equal(rendered.container.querySelector('[data-ui="modal"]'), null, '取消要关掉弹窗')
    assert.equal(writes().length, 0, '取消不发写请求')
  } finally {
    await rendered.dispose()
  }
})

test('详情页改技能目录：下拉只列存在的目录，点确定才发 move-root 并刷新注册表', async (t) => {
  const rendered = await renderPanel({
    primitives: true,
    extraRoots: [{ id: 'user-dsh', label: 'user-dsh', rank: 300, path: 'C:\\Users\\x\\.dsh\\skills', exists: true, writable: true, skillCount: 2 }],
  })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    await rendered.clickInCard('demo-skill', '详情')
    // 详情页的「技能目录」用的是**和筛选器同一个组件**（FilterSelect）。
    const rootTrigger = rendered.container.querySelector('[data-sm-select="detail-root"]')
    assert.ok(rootTrigger, '详情页的技能目录要复用筛选器那套下拉组件')
    await rendered.clickElement(rootTrigger)
    const options = [...rendered.container.querySelectorAll('[data-sm-filter="detail-root"] [data-option-value]')]
      .map((item) => item.getAttribute('data-option-value'))
    assert.deepEqual(options, ['user-agents', 'user-dsh'],
      '下拉里只有真实存在的技能目录（project-dsh 不存在，不能出现）')
    // 当前目录是选中态，且选中项只靠右侧对勾区分。
    const current = rendered.container.querySelector('[data-sm-filter="detail-root"] [data-option-value="user-agents"]')
    assert.equal(current.getAttribute('aria-selected'), 'true')
    assert.ok(current.querySelector('svg'), '选中项右侧要有对勾')

    await rendered.clickElement(rendered.container.querySelector('[data-sm-filter="detail-root"] [data-option-value="user-dsh"]'))
    const save = rendered.container.querySelector('[data-sm-save]')
    assert.equal(save.disabled, false, '改了目录，确定要可点')
    // 点确定之前不能有任何写请求。
    assert.equal(rendered.actions.filter((item) => item.action === 'move-root').length, 0)

    await rendered.clickElement(save)
    const move = rendered.actions.find((item) => item.action === 'move-root')
    assert.ok(move, '必须发 move-root')
    assert.equal(move.rootId, 'user-agents', '从原目录搬')
    assert.equal(move.targetRootId, 'user-dsh', '搬到选中的目录')
    assert.ok(rendered.requests.some((item) => item.includes('refresh=1')), '保存后要刷新注册表')
    assert.equal(rendered.container.querySelector('[data-ui="modal"]'), null, '保存后关掉弹窗')
  } finally {
    await rendered.dispose()
  }
})

test('详情页改分类：勾选 / 新增 / 改名，确定后发 set-categories', async (t) => {
  const rendered = await renderPanel({ primitives: true })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    await rendered.clickInCard('demo-skill', '详情')
    const trigger = () => rendered.container.querySelector('[data-sm-multi-trigger="category"]')
    // 分类不再用彩色标签，显示成逗号分隔的纯文本（触发器跟单选下拉同一套字段框）。
    assert.equal(trigger().querySelector('[data-sm-chip]'), null, '不要彩色标签')
    assert.match(trigger().textContent, /demo/, '当前分类要以文本显示')
    assert.ok(rendered.container.querySelector('[data-sm-filter="root"], [data-sm-select="detail-root"]'), '技能目录用统一单选组件')

    await rendered.clickElement(trigger())
    const option = (name) => rendered.container.querySelector(`[data-sm-category-option="${name}"]`)
    assert.ok(option('demo'), '下拉里要有当前分类')
    assert.equal(option('demo').getAttribute('aria-selected'), 'true', '当前分类是勾上的')

    // 新增一个分类。
    const input = rendered.container.querySelector('[data-sm-new-category]')
    await rendered.type(input, 'brand-new')
    await rendered.settle()
    await rendered.click('添加')
    assert.ok(option('brand-new'), '新分类要加进下拉')

    // 改名：把 brand-new 改成 renamed。
    await rendered.clickElement(rendered.container.querySelector('[data-sm-rename="brand-new"]'))
    const renameInput = rendered.container.querySelector('[data-sm-rename-input="brand-new"]')
    assert.ok(renameInput, '点铅笔要变成输入框')
    await rendered.type(renameInput, 'renamed')
    await rendered.press(renameInput, 'Enter')
    assert.ok(option('renamed'), '改名后下拉里是新名字')
    assert.equal(option('renamed').getAttribute('aria-selected'), 'true', '改名后仍是选中状态')

    // 确定：请求体里是最终的两个分类。
    const save = rendered.container.querySelector('[data-sm-save]')
    assert.equal(save.disabled, false, '有改动，确定可点')
    await rendered.clickElement(save)
    const call = rendered.actions.find((item) => item.action === 'set-categories')
    assert.ok(call, '必须发 set-categories')
    assert.deepEqual(call.categories.slice().sort(), ['demo', 'renamed'], `实际：${JSON.stringify(call.categories)}`)
    assert.equal(call.rootId, 'user-agents', '写到技能所在的根')
    assert.ok(rendered.requests.some((item) => item.includes('refresh=1')), '保存后要刷新注册表')
  } finally {
    await rendered.dispose()
  }
})

test('详情页分类最多 5 个：满了之后没选的项不可点、继续加会被拦住', async (t) => {
  const rendered = await renderPanel({ primitives: true })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    await rendered.clickInCard('demo-skill', '详情')
    await rendered.clickElement(rendered.container.querySelector('[data-sm-multi-trigger="category"]'))
    // 已有 demo，再补 4 个凑满 5 个。
    for (const name of ['c1', 'c2', 'c3', 'c4']) {
      await rendered.type(rendered.container.querySelector('[data-sm-new-category]'), name)
      await rendered.click('添加')
    }
    const valueText = rendered.container.querySelector('[data-sm-multi-value="category"]').textContent
    assert.equal(valueText.split(', ').length, 5, `应该是 5 个分类，实际「${valueText}」`)
    // 第 6 个加不进去：输入框 + 添加被禁用，提示里写着 5/5。
    const addButton = [...rendered.container.querySelectorAll('[data-sm-pop="category"] button')].find((item) => item.textContent === '添加')
    assert.ok(addButton)
    assert.equal(addButton.disabled, true, '满了之后添加按钮要禁用')
    const hint = rendered.container.querySelector('[data-sm-pop="category"] div[style*="11.5px"]')
    assert.ok(hint && hint.textContent.includes('5/5'), '提示要显示 5/5')
    // 反选一个（demo）之后又能加了。
    await rendered.clickElement(rendered.container.querySelector('[data-sm-category-option="demo"]'))
    const valueAfter = rendered.container.querySelector('[data-sm-multi-value="category"]').textContent
    assert.equal(valueAfter.split(', ').length, 4, '反选后剩 4 个')
    const addAgain = [...rendered.container.querySelectorAll('[data-sm-pop="category"] button')].find((item) => item.textContent === '添加')
    assert.equal(addAgain.disabled, false, '反选后可以继续添加')
  } finally {
    await rendered.dispose()
  }
})

test('分类多选：勾选后再反勾选，方框不能消失（简写/长写混用会丢样式）', async (t) => {
  const rendered = await renderPanel({ primitives: true })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    await rendered.clickInCard('demo-skill', '详情')
    await rendered.clickElement(rendered.container.querySelector('[data-sm-multi-trigger="category"]'))
    const option = () => rendered.container.querySelector('[data-sm-category-option="demo"]')
    const box = () => option().querySelector('span')
    const boxStyle = () => box().getAttribute('style') || ''

    // 一开始是勾上的：有对勾、边框色是主色。
    assert.ok(box().querySelector('svg'), '勾选时要有对勾')
    assert.match(boxStyle(), /border-color:\s*var\(--dsw-alias-button-primary-fill/, '勾选时边框是实心主色')

    // 反勾选：方框必须还在，边框要回到"可见的空框"。
    await rendered.clickElement(option())
    assert.equal(option().getAttribute('aria-selected'), 'false', '反勾选后是未选中')
    assert.equal(box().querySelector('svg'), null, '未选中不该有对勾')
    assert.match(boxStyle(), /border-width:\s*1px/, '方框宽度不能被冲掉')
    assert.match(boxStyle(), /border-style:\s*solid/, '方框样式不能被冲掉')
    assert.match(boxStyle(), /border-color:\s*var\(--dsw-alias-border-l3/, '方框边框色要回到普通边线色')
    assert.match(boxStyle(), /background:\s*transparent/, '未选中不能留着深色底')

    // 再勾回来：又要变成实心 + 对勾。
    await rendered.clickElement(option())
    assert.equal(option().getAttribute('aria-selected'), 'true')
    assert.ok(box().querySelector('svg'), '重新勾选要有对勾')
    assert.match(boxStyle(), /border-color:\s*var\(--dsw-alias-button-primary-fill/)

    // React 对"重渲染时删掉简写属性"会告警，这里顺手钉住不发生。
    const warnings = rendered.errors.filter((line) => line.includes('Removing a style property'))
    assert.deepEqual(warnings, [], `不该出现样式被冲掉的告警：${warnings.join(' | ')}`)
  } finally {
    await rendered.dispose()
  }
})

test('/skill 提示链路：/ → 技能目录 → 技能，选中后插入两级路径', async (t) => {
  const rendered = await renderPanel({ primitives: true })
  if (!rendered) {
    t.skip('未安装 react / react-dom / jsdom')
    return
  }
  try {
    const source = rendered.sources.find((item) => item && item.name === 'skill-path')
    assert.ok(source, '必须注册 /skill 提示源（名字 skill-path，trigger 是 /）')
    assert.equal(source.trigger, '/')
    // 注意：候选结果来自 vm 沙箱里的另一个 realm，数组原型不同，用 join 比较最稳。
    const names = async (query) => (await source.candidates({}, { query })).map((item) => item.name).join(',')

    // 一级：/ → /skill/
    assert.equal(await names(''), 'skill')
    // 二级：/skill → 只列**存在的**技能目录（project-dsh 不存在，不出现）
    assert.equal(await names('skill'), 'user-agents/')
    assert.equal(await names('skill/'), 'user-agents/')
    // 三级：/skill/<目录>/ → 这个目录下用户可调用的技能（校验失败的、被停用的都滤掉）
    assert.equal(await names('skill/user-agents/'), 'demo-skill,shadowed-skill')
    // 前缀过滤
    assert.equal(await names('skill/user-agents/demo'), 'demo-skill')

    // 插入形态固定是两级路径（能精确指定技能目录）。
    const third = await source.candidates({}, { query: 'skill/user-agents/' })
    const insertOf = (name) => third.find((item) => item.name === name).insert
    assert.equal(insertOf('demo-skill'), 'skill/user-agents/demo-skill ')
    // 选中一级条目后插入的是 /skill/
    assert.equal(source.onPick({ candidate: { name: 'skill', insert: 'skill/' } }).text, '/skill/')
    // 选中技能后插入的是两级路径（末尾留空格，方便接着打字）
    assert.equal(
      source.onPick({ candidate: { name: 'demo-skill', insert: 'skill/user-agents/demo-skill ' } }).text,
      '/skill/user-agents/demo-skill ',
    )
  } finally {
    await rendered.dispose()
  }
})
