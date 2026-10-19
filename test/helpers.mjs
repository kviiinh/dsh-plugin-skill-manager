/**
 * 测试用的小工具：临时目录、技能骨架、假 Host 上下文。
 *
 * @module dsh-plugin-skill-manager/test/helpers
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * 建一个临时目录。
 * @param {string} [prefix] 前缀。
 * @returns {string} 目录路径。
 */
export function makeTemp(prefix = 'skillmgr-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * 删除临时目录。
 * @param {string} path 目录。
 * @returns {void}
 */
export function cleanup(path) {
  if (path) rmSync(path, { recursive: true, force: true })
}

/**
 * 写一个目录包技能。
 * @param {string} root 技能根目录。
 * @param {string} dirName 目录名。
 * @param {string} frontmatter frontmatter 内容（不含 `---`）。
 * @param {string} [body] 正文。
 * @returns {string} SKILL.md 路径。
 */
export function writeBundleSkill(root, dirName, frontmatter, body = '# 技能正文\n') {
  const dir = join(root, dirName)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'SKILL.md')
  writeFileSync(file, `---\n${frontmatter}\n---\n${body}`, 'utf8')
  return file
}

/**
 * 写一个扁平技能 `<name>.md`。
 * @param {string} root 技能根目录。
 * @param {string} name 技能名。
 * @param {string} frontmatter frontmatter 内容。
 * @returns {string} 文件路径。
 */
export function writeFlatSkill(root, name, frontmatter) {
  mkdirSync(root, { recursive: true })
  const file = join(root, `${name}.md`)
  writeFileSync(file, `---\n${frontmatter}\n---\n# ${name}\n`, 'utf8')
  return file
}

/**
 * 写任意文件（自动建目录）。
 * @param {string} path 路径。
 * @param {string | Buffer} content 内容。
 * @returns {string} 路径。
 */
export function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

/**
 * 造一个够用的假 Cordis 上下文。
 * @returns {object} 假 ctx 与观测面。
 */
export function createFakeContext() {
  const state = {
    routes: new Map(),
    listeners: new Map(),
    effects: [],
    logs: [],
    warnings: [],
  }
  const services = new Map()
  const ctx = {
    logger: {
      info: (message) => state.logs.push(String(message)),
      warn: (message) => state.warnings.push(String(message)),
    },
    get: (key) => services.get(key),
    on(event, handler) {
      const bucket = state.listeners.get(event) ?? []
      bucket.push(handler)
      state.listeners.set(event, bucket)
      return () => {
        const list = state.listeners.get(event) ?? []
        state.listeners.set(event, list.filter((item) => item !== handler))
      }
    },
    effect(callback) {
      const dispose = callback()
      state.effects.push(dispose)
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
  }
  services.set('connection', { requestRejection: () => undefined })
  services.set('webServer', {
    register(route) {
      state.routes.set(route.path, route)
      return () => state.routes.delete(route.path)
    },
  })
  return { ctx, state, services }
}

/**
 * 造一个假的 HTTP 请求 / 响应对，用于直接调用路由 handler。
 * @param {{method?: string, url?: string, body?: unknown}} input 输入。
 * @returns {{request: object, response: object, result: () => Promise<object>}} 结果。
 */
export function createHttpPair(input = {}) {
  const chunks = input.body === undefined ? [] : [Buffer.from(JSON.stringify(input.body), 'utf8')]
  const request = {
    method: input.method ?? 'GET',
    url: input.url ?? '/',
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  let resolveDone
  const done = new Promise((resolveDoneInner) => {
    resolveDone = resolveDoneInner
  })
  let status = 0
  let body = ''
  const response = {
    writeHead(code) {
      status = code
      return response
    },
    end(payload) {
      body = payload === undefined ? '' : String(payload)
      resolveDone()
      return response
    },
  }
  return {
    request,
    response,
    result: async () => {
      await done
      return { status, body: body === '' ? undefined : JSON.parse(body) }
    },
  }
}
