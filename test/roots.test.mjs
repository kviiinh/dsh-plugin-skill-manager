/**
 * 技能根解析、扫描与对账。
 *
 * @module dsh-plugin-skill-manager/test/roots.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, makeTemp, writeBundleSkill, writeFlatSkill } from './helpers.mjs'
import { findProjectRoot, reconcile, resolveHomes, resolveRoots, scanRoots, skillDirectory } from '../lib/roots.js'

test('resolveHomes 优先配置，其次环境变量，最后 ~/.dsh 与 ~/.agents', () => {
  const env = { USERPROFILE: 'C:\\Users\\tester', DSH_HOME: 'C:\\env\\dsh', DSH_AGENTS_HOME: 'C:\\env\\agents' }
  const fromEnv = resolveHomes({ env })
  assert.equal(fromEnv.dshHome, 'C:\\env\\dsh')
  assert.equal(fromEnv.agentsHome, 'C:\\env\\agents')

  const fromConfig = resolveHomes({ dshHome: 'C:\\cfg\\dsh', agentsHome: '', env })
  assert.equal(fromConfig.dshHome, 'C:\\cfg\\dsh')
  assert.equal(fromConfig.agentsHome, 'C:\\env\\agents')

  const fallback = resolveHomes({ env: { USERPROFILE: 'C:\\Users\\tester' } })
  assert.equal(fallback.dshHome, join('C:\\Users\\tester', '.dsh'))
})

test('findProjectRoot 找到最近的 .git 祖先', () => {
  const temp = makeTemp()
  try {
    const project = join(temp, 'proj')
    const nested = join(project, 'a', 'b')
    mkdirSync(join(project, '.git'), { recursive: true })
    mkdirSync(nested, { recursive: true })
    assert.equal(findProjectRoot(nested), project)
    const outside = join(temp, 'outside')
    mkdirSync(outside, { recursive: true })
    assert.equal(findProjectRoot(outside), outside)
  } finally {
    cleanup(temp)
  }
})

test('resolveRoots：顺序 = rank，来源标签与 DSH 对齐，重复路径去重', () => {
  const temp = makeTemp()
  try {
    const project = join(temp, 'proj')
    mkdirSync(join(project, '.git'), { recursive: true })
    const roots = resolveRoots({
      cwd: join(project, 'sub'),
      dshHome: join(temp, 'home', '.dsh'),
      agentsHome: join(temp, 'home', '.agents'),
      customRoots: [{ id: 'my-team', path: join(temp, 'team'), rank: 250 }],
    })
    assert.deepEqual(roots.map((root) => root.id), ['project-dsh', 'project-agents', 'my-team', 'user-dsh', 'user-agents'])
    assert.deepEqual(roots.map((root) => root.rank), [100, 200, 250, 400, 500])
    assert.equal(roots[0].path, join(project, '.dsh', 'skills'))
    assert.equal(roots[2].label, 'custom')
    assert.equal(roots[3].label, 'user-dsh')
    assert.equal(roots[3].path, join(temp, 'home', '.dsh', 'skills'))

    const duplicated = resolveRoots({
      cwd: project,
      dshHome: join(project, '.dsh'),
      agentsHome: join(temp, 'agents'),
      customRoots: [{ id: 'dup', path: join(project, '.dsh', 'skills') }],
    })
    assert.equal(new Set(duplicated.map((root) => root.path)).size, duplicated.length)
  } finally {
    cleanup(temp)
  }
})

test('scanRoots：目录包 / 扁平文件 / 无效技能 / 隐藏目录 / 缺失根', () => {
  const temp = makeTemp()
  try {
    const rootPath = join(temp, 'skills')
    writeBundleSkill(rootPath, 'alpha', 'name: alpha\ndescription: 有效技能')
    writeBundleSkill(rootPath, 'broken', 'name: Broken Name\ndescription: 名字不合法')
    writeBundleSkill(rootPath, 'no-desc', 'name: no-desc')
    writeFlatSkill(rootPath, 'flat-one', 'name: flat-one\ndescription: 扁平技能')
    mkdirSync(join(rootPath, '.trash'), { recursive: true })
    mkdirSync(join(rootPath, 'not-a-skill'), { recursive: true })
    writeBundleSkill(rootPath, '.hidden', 'name: hidden\ndescription: 不该出现')
    if (process.platform !== 'win32') {
      symlinkSync(join(rootPath, 'alpha'), join(rootPath, 'alpha-link'), 'dir')
    }

    const roots = [
      { id: 'custom', label: 'custom', rank: 300, path: rootPath, writable: true },
      { id: 'missing', label: 'user-dsh', rank: 400, path: join(temp, 'nope'), writable: true },
    ]
    const scanned = scanRoots(roots)
    const names = scanned.skills.map((skill) => skill.name).sort()
    assert.deepEqual([...names].sort(), ['Broken Name', 'alpha', 'flat-one', 'no-desc'].sort())
    assert.equal(scanned.roots.find((root) => root.id === 'missing').exists, false)
    assert.equal(scanned.roots.find((root) => root.id === 'custom').skillCount, 4)

    const alpha = scanned.skills.find((skill) => skill.name === 'alpha')
    assert.equal(alpha.valid, true)
    assert.equal(alpha.kind, 'bundle')
    assert.equal(skillDirectory(alpha), join(rootPath, 'alpha'))

    const broken = scanned.skills.find((skill) => skill.dirName === 'broken')
    assert.equal(broken.valid, false)
    assert.match(broken.issues.join('；'), /kebab-case/)

    const flat = scanned.skills.find((skill) => skill.name === 'flat-one')
    assert.equal(flat.kind, 'flat')
    assert.equal(skillDirectory(flat), rootPath)
  } finally {
    cleanup(temp)
  }
})

test('缺失但可创建的根仍算可写（否则市场页一个安装位置都列不出来）', () => {
  const temp = makeTemp()
  try {
    const roots = [
      { id: 'user-agents', label: 'user-agents', rank: 500, path: join(temp, 'nope', 'skills'), writable: true },
      { id: 'bundled-1', label: 'bundled', rank: 600, path: join(temp, 'bundled'), writable: false },
    ]
    const scanned = scanRoots(roots)
    const userRoot = scanned.roots.find((root) => root.id === 'user-agents')
    assert.equal(userRoot.exists, false)
    assert.equal(userRoot.writable, true, '父目录可写 => 可以创建')
    assert.equal(scanned.roots.find((root) => root.id === 'bundled-1').writable, false, '只读根不可写')
  } finally {
    cleanup(temp)
  }
})

test('对账：rank 小的胜出，其它标记被遮蔽；注册表里别处胜出则标 other-provider', () => {
  const temp = makeTemp()
  try {
    const high = join(temp, 'project')
    const low = join(temp, 'user')
    const highPath = writeBundleSkill(high, 'shared', 'name: shared\ndescription: 项目版')
    const lowPath = writeBundleSkill(low, 'shared', 'name: shared\ndescription: 用户版')
    writeBundleSkill(low, 'user-only', 'name: user-only\ndescription: 只有用户根有')

    const scanned = scanRoots([
      { id: 'project-dsh', label: 'project-dsh', rank: 100, path: high, writable: true },
      { id: 'user-agents', label: 'user-agents', rank: 500, path: low, writable: true },
    ])

    const result = reconcile({
      skills: scanned.skills,
      snapshot: {
        skills: [
          { name: 'shared', path: highPath, source: 'project-dsh', invocation: { modelInvocable: true, userInvocable: true } },
          { name: 'user-only', path: lowPath, source: 'user-agents', invocation: { modelInvocable: true, userInvocable: true } },
          { name: 'plugin-provided', description: '插件内嵌技能', source: 'bundled', invocation: { modelInvocable: true, userInvocable: true } },
        ],
      },
    })

    const shared = result.skills.filter((skill) => skill.name === 'shared')
    assert.equal(shared.length, 2)
    const project = shared.find((skill) => skill.rootId === 'project-dsh')
    const user = shared.find((skill) => skill.rootId === 'user-agents')
    assert.equal(project.effective, true)
    assert.equal(project.registryState, 'present')
    assert.equal(user.effective, false)
    assert.equal(user.shadowedBy.path, highPath)
    assert.ok(result.warnings.some((warning) => warning.includes('shared')))

    assert.deepEqual(result.providerOnly.map((skill) => skill.name), ['plugin-provided'])
    assert.equal(result.providerOnly[0].origin, 'provider')
  } finally {
    cleanup(temp)
  }
})

test('对账：注册表在别处胜出时，本地同名技能不算生效', () => {
  const temp = makeTemp()
  try {
    const rootPath = join(temp, 'skills')
    writeBundleSkill(rootPath, 'dup', 'name: dup\ndescription: 本地版')
    const scanned = scanRoots([{ id: 'user-dsh', label: 'user-dsh', rank: 400, path: rootPath, writable: true }])
    const result = reconcile({
      skills: scanned.skills,
      snapshot: { skills: [{ name: 'dup', path: join(temp, 'other', 'SKILL.md'), source: 'bundled' }] },
    })
    const skill = result.skills.find((item) => item.name === 'dup')
    assert.equal(skill.effective, false)
    assert.equal(skill.registryState, 'other-provider')
    assert.equal(skill.shadowedBy.rootLabel, 'bundled')
  } finally {
    cleanup(temp)
  }
})
