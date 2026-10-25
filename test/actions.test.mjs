/**
 * 管理动作：开关、改名、回收站、复制、新建，以及"绝不出根"的保障。
 *
 * @module dsh-plugin-skill-manager/test/actions.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, makeTemp, writeBundleSkill } from './helpers.mjs'
import { createSkill, copySkill, listTrash, moveSkill, purgeTrash, renameSkill, replaceSkillDirectory, restoreTrash, setCategories, setInvocation, trashSkill } from '../lib/actions.js'
import { readSkillRecord } from '../lib/frontmatter.js'
import { describeResources, scanRoots } from '../lib/roots.js'

/**
 * 建一个带单个技能的根。
 * @param {string} base 临时目录。
 * @param {string} id 根 id。
 * @returns {{root: object, skill: object, managerRoot: string}} 环境。
 */
function fixture(base, id = 'user-agents') {
  const rootPath = join(base, 'skills')
  writeBundleSkill(rootPath, 'demo-skill', 'name: demo-skill\ndescription: 演示')
  writeFileSync(join(rootPath, 'demo-skill', 'references.md'), '参考资料', 'utf8')
  const root = { id, label: id, rank: 400, path: rootPath, writable: true }
  const scanned = scanRoots([root])
  const skill = scanned.skills.find((item) => item.name === 'demo-skill')
  return { root, skill, managerRoot: join(base, 'manager') }
}

test('setInvocation 写 DSH 原生开关', () => {
  const temp = makeTemp()
  try {
    const { root, skill } = fixture(temp)
    const off = setInvocation({ root, skill, invocation: { modelInvocable: true, userInvocable: false } })
    assert.equal(off.ok, true)
    const text = readFileSync(skill.path, 'utf8')
    assert.match(text, /user-invocable: false/)

    const record = readSkillRecord({ text })
    assert.equal(record.valid, true)
    assert.deepEqual(record.invocation, { modelInvocable: true, userInvocable: false })
    assert.ok(existsSync(`${skill.path}.bak`), '改写前应留下 .bak 备份')
  } finally {
    cleanup(temp)
  }
})

test('renameSkill 同步改 frontmatter 与目录名', () => {
  const temp = makeTemp()
  try {
    const { root, skill } = fixture(temp)
    const renamed = renameSkill({ root, skill, newName: 'renamed-skill' })
    assert.equal(renamed.ok, true, renamed.error)
    assert.equal(renamed.path, join(root.path, 'renamed-skill', 'SKILL.md'))
    assert.equal(existsSync(join(root.path, 'demo-skill')), false)
    const record = readSkillRecord({ text: readFileSync(renamed.path, 'utf8') })
    assert.equal(record.name, 'renamed-skill')

    const bad = renameSkill({ root, skill: { ...skill, path: renamed.path }, newName: 'Bad_Name' })
    assert.equal(bad.ok, false)
    assert.equal(bad.code, 'invalid-name')
  } finally {
    cleanup(temp)
  }
})

test('rename 目标被占时不能留下"名字改了、目录没动"的半成品', () => {
  const temp = makeTemp()
  try {
    const { root, skill } = fixture(temp)
    // 先造一个占位目录，让改名必然失败。
    mkdirSync(join(root.path, 'occupied'), { recursive: true })
    const failed = renameSkill({ root, skill, newName: 'occupied' })
    assert.equal(failed.ok, false)
    assert.equal(failed.code, 'target-exists')

    const text = readFileSync(skill.path, 'utf8')
    assert.match(text, /name: demo-skill/, 'frontmatter 不能被改')
    assert.equal(existsSync(join(root.path, 'demo-skill')), true)
    assert.equal(existsSync(join(root.path, 'occupied', 'SKILL.md')), false)
  } finally {
    cleanup(temp)
  }
})

test('回收站：删除 → 撤销 → 清空', async () => {
  const temp = makeTemp()
  try {
    const { root, skill, managerRoot } = fixture(temp)
    const removed = trashSkill({ root, skill, managerRoot, now: 1_700_000_000_000 })
    assert.equal(removed.ok, true, removed.error)
    assert.equal(existsSync(join(root.path, 'demo-skill')), false)
    assert.equal(listTrash(managerRoot).length, 1)

    const restored = restoreTrash({ managerRoot, id: removed.id, roots: [root] })
    assert.equal(restored.ok, true, restored.error)
    assert.equal(existsSync(join(root.path, 'demo-skill', 'SKILL.md')), true)
    assert.equal(listTrash(managerRoot).length, 0)

    const again = trashSkill({ root, skill, managerRoot })
    assert.equal(again.ok, true)
    const purged = await purgeTrash({ managerRoot })
    assert.equal(purged.ok, true)
    assert.equal(purged.purged, 1)
    assert.equal(listTrash(managerRoot).length, 0)
  } finally {
    cleanup(temp)
  }
})

test('复制到另一个根；目标存在时默认拒绝', () => {
  const temp = makeTemp()
  try {
    const { root, skill } = fixture(temp)
    const target = { id: 'project-dsh', label: 'project-dsh', rank: 100, path: join(temp, 'project'), writable: true }
    const copied = copySkill({ skill, targetRoot: target })
    assert.equal(copied.ok, true, copied.error)
    assert.ok(existsSync(join(target.path, 'demo-skill', 'SKILL.md')))
    assert.ok(existsSync(join(target.path, 'demo-skill', 'references.md')), '资源文件要一起复制')

    const again = copySkill({ skill, targetRoot: target })
    assert.equal(again.ok, false)
    assert.equal(again.code, 'target-exists')

    const overwrite = copySkill({ skill, targetRoot: target, overwrite: true })
    assert.equal(overwrite.ok, true)
    assert.equal(root.id, 'user-agents')
  } finally {
    cleanup(temp)
  }
})

test('新建技能：名字与 description 都要合法', () => {
  const temp = makeTemp()
  try {
    const { root } = fixture(temp)
    const created = createSkill({ root, name: 'brand-new', description: '新技能' })
    assert.equal(created.ok, true, created.error)
    const record = readSkillRecord({ text: readFileSync(created.path, 'utf8') })
    assert.equal(record.valid, true)

    assert.equal(createSkill({ root, name: 'Bad Name', description: 'x' }).code, 'invalid-name')
    assert.equal(createSkill({ root, name: 'no-desc', description: '' }).code, 'missing-description')
    assert.equal(createSkill({ root, name: 'brand-new', description: 'x' }).code, 'target-exists')
  } finally {
    cleanup(temp)
  }
})

test('安全：技能记录指向根外时一律拒绝', () => {
  const temp = makeTemp()
  try {
    const { root, skill, managerRoot } = fixture(temp)
    const outside = join(temp, 'outside', 'SKILL.md')
    mkdirSync(join(temp, 'outside'), { recursive: true })
    writeFileSync(outside, '---\nname: evil\ndescription: x\n---\n', 'utf8')

    const hijack = { ...skill, path: outside }
    assert.equal(setInvocation({ root, skill: hijack, invocation: { modelInvocable: false, userInvocable: false } }).code, 'outside-root')
    assert.equal(trashSkill({ root, skill: hijack, managerRoot }).code, 'outside-root')
    assert.equal(renameSkill({ root, skill: hijack, newName: 'other' }).code, 'outside-root')
    assert.equal(existsSync(outside), true, '根外文件必须原样保留')
  } finally {
    cleanup(temp)
  }
})

test('安全：技能根里的符号链接/junction 不能把写入带到根外', () => {
  const temp = makeTemp()
  try {
    const outside = join(temp, 'outside')
    mkdirSync(outside, { recursive: true })
    const outsideFile = join(outside, 'SKILL.md')
    writeFileSync(outsideFile, '---\nname: linked-skill\ndescription: 根外技能\n---\n', 'utf8')

    const rootPath = join(temp, 'skills')
    mkdirSync(rootPath, { recursive: true })
    // Windows 上 junction 不需要管理员权限；其它平台用目录符号链接。
    symlinkSync(outside, join(rootPath, 'linked-dir'), process.platform === 'win32' ? 'junction' : 'dir')

    const root = { id: 'user-agents', label: 'user-agents', rank: 400, path: rootPath, writable: true }
    const skill = {
      name: 'linked-skill',
      dirName: 'linked-dir',
      kind: 'bundle',
      path: join(rootPath, 'linked-dir', 'SKILL.md'),
      rootId: 'user-agents',
      rank: 400,
    }

    // 词法上在根内，物理上在根外——必须拒绝。
    const blocked = setInvocation({ root, skill, invocation: { modelInvocable: false, userInvocable: true } })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, 'outside-root')
    assert.doesNotMatch(readFileSync(outsideFile, 'utf8'), /disable-model-invocation/)

    assert.equal(trashSkill({ root, skill, managerRoot: join(temp, 'manager') }).code, 'outside-root')
    assert.equal(existsSync(outsideFile), true)
  } finally {
    cleanup(temp)
  }
})

test('安全：技能记录的 path 就是技能根本身时，不能移动整个根', () => {
  const temp = makeTemp()
  try {
    const precious = join(temp, 'PRECIOUS.txt')
    writeFileSync(precious, '别动我', 'utf8')
    const rootPath = join(temp, 'skills')
    mkdirSync(rootPath, { recursive: true })
    const root = { id: 'user-agents', label: 'user-agents', rank: 400, path: rootPath, writable: true }

    // 伪造一条"技能文件就是根目录"的记录（例如被人改过的台账）。
    const forged = { name: 'evil', dirName: 'evil', kind: 'bundle', path: rootPath, rootId: 'user-agents', rank: 400 }
    const managerRoot = join(temp, 'manager')
    for (const result of [
      trashSkill({ root, skill: forged, managerRoot }),
      setInvocation({ root, skill: forged, invocation: { modelInvocable: false, userInvocable: false } }),
      renameSkill({ root, skill: forged, newName: 'renamed' }),
    ]) {
      assert.equal(result.ok, false)
      assert.equal(result.code, 'outside-root')
    }
    assert.equal(existsSync(rootPath), true)
    assert.equal(existsSync(precious), true)
    assert.equal(listTrash(managerRoot).length, 0)

    // 文件名的形状也必须对：技能包的目标必须是 SKILL.md（目录合法、文件名不对）。
    const weirdDir = join(rootPath, 'weird')
    mkdirSync(weirdDir, { recursive: true })
    const wrongName = { name: 'weird', dirName: 'weird', kind: 'bundle', path: join(weirdDir, 'notes.md'), rootId: 'user-agents', rank: 400 }
    writeFileSync(wrongName.path, '# 不是技能文件\n', 'utf8')
    assert.equal(trashSkill({ root, skill: wrongName, managerRoot }).code, 'bad-target')
  } finally {
    cleanup(temp)
  }
})

test('资源统计用于界面展示', () => {
  const temp = makeTemp()
  try {
    const { skill } = fixture(temp)
    const resources = describeResources(skill)
    assert.equal(resources.files >= 2, true)
    assert.equal(resources.bytes > 0, true)
  } finally {
    cleanup(temp)
  }
})

test('替换技能目录：复制没成功之前绝不动旧的那份（丢数据回归）', () => {
  const temp = makeTemp()
  try {
    const rootPath = join(temp, 'skills')
    mkdirSync(rootPath, { recursive: true })

    // 旧版本（用户已经导进来的那份）
    const target = join(rootPath, 'imported-skill')
    writeBundleSkill(rootPath, 'imported-skill', 'name: imported-skill\ndescription: 旧版本')
    const precious = join(target, 'precious.md')
    writeFileSync(precious, '不能丢的内容\n', 'utf8')

    // 1) 来源根本不存在 → 必须失败，并且旧的那份**完全没被动过**。
    const missing = replaceSkillDirectory({ source: join(temp, 'nope'), target, rootPath, isDirectory: true })
    assert.equal(missing.ok, false)
    assert.match(missing.error, /来源不存在/)
    assert.equal(existsSync(target), true, '旧目录必须还在')
    assert.equal(readFileSync(precious, 'utf8'), '不能丢的内容\n', '旧内容必须原样')

    // 2) 正常替换：内容换成新的；暂存**不能落在技能根里**，也不能留下 `.replaced-*`。
    const source = join(temp, 'incoming')
    writeBundleSkill(temp, 'incoming-src', 'name: imported-skill\ndescription: 新版本')
    const newSource = join(temp, 'incoming-src')
    writeFileSync(join(newSource, 'extra.md'), '新资源\n', 'utf8')
    void source
    const replaced = replaceSkillDirectory({ source: newSource, target, rootPath, isDirectory: true })
    assert.equal(replaced.ok, true, replaced.error)
    assert.equal(replaced.replaced, true, '覆盖时应报告替换')
    assert.match(readFileSync(join(target, 'SKILL.md'), 'utf8'), /新版本/)
    assert.equal(existsSync(join(target, 'extra.md')), true, '新资源要一起搬过去')
    assert.equal(existsSync(precious), false, '旧内容已被新版本替换')
    const leftovers = readdirSync(rootPath).filter((name) => name.startsWith('.skill-manager-import-'))
    assert.deepEqual(leftovers, [], '暂存目录不能留在技能根里')
    const asides = readdirSync(rootPath).filter((name) => name.includes('.replaced-'))
    assert.deepEqual(asides, [], '旧目录挪开之后要删掉，不留 .replaced-*')

    // 3) 单文件形态：同样只在复制校验通过后才替换。
    const flatTarget = join(rootPath, 'flat-skill.md')
    writeFileSync(flatTarget, '旧单文件\n', 'utf8')
    const flatSource = join(temp, 'flat.md')
    writeFileSync(flatSource, '新单文件\n', 'utf8')
    const flat = replaceSkillDirectory({ source: flatSource, target: flatTarget, rootPath, isDirectory: false })
    assert.equal(flat.ok, true, flat.error)
    assert.equal(readFileSync(flatTarget, 'utf8'), '新单文件\n')

    const flatMissing = replaceSkillDirectory({ source: join(temp, 'none.md'), target: flatTarget, rootPath, isDirectory: false })
    assert.equal(flatMissing.ok, false)
    assert.equal(readFileSync(flatTarget, 'utf8'), '新单文件\n', '失败时旧文件不能被删掉')

    // 4) 全新安装（目标本来不存在）：不该报告"替换"。
    const fresh = replaceSkillDirectory({ source: newSource, target: join(rootPath, 'brand-new'), rootPath, isDirectory: true })
    assert.equal(fresh.ok, true, fresh.error)
    assert.equal(fresh.replaced, false, '全新安装不算替换')
  } finally {
    cleanup(temp)
  }
})

test('setCategories 写 metadata.category，其余内容与正文原样保留', () => {
  const temp = makeTemp()
  try {
    const { root, skill } = fixture(temp)
    const before = readFileSync(skill.path, 'utf8')
    const result = setCategories({ root, skill, categories: ['alpha', 'beta'] })
    assert.equal(result.ok, true, result.error)
    assert.deepEqual(result.categories, ['alpha', 'beta'])
    const text = readFileSync(skill.path, 'utf8')
    assert.match(text, /category: alpha,beta/)
    assert.match(text, /description: 演示/, '其它 frontmatter 不能被冲掉')
    assert.equal(readSkillRecord({ text }).valid, true)
    // 正文没变。
    assert.equal(readSkillRecord({ text }).body, readSkillRecord({ text: before }).body)

    // 再写同样的值：不算修改。
    const same = setCategories({ root, skill, categories: ['alpha', 'beta'] })
    assert.equal(same.ok, true)
    assert.equal(same.changed, false)

    // 清空：category 行消失。
    const cleared = setCategories({ root, skill, categories: [] })
    assert.equal(cleared.ok, true, cleared.error)
    assert.equal(readFileSync(skill.path, 'utf8').includes('category:'), false)
  } finally {
    cleanup(temp)
  }
})

test('setCategories 拒绝非法输入且不落盘（>5 个 / 带逗号）', () => {
  const temp = makeTemp()
  try {
    const { root, skill } = fixture(temp)
    const before = readFileSync(skill.path, 'utf8')
    const tooMany = setCategories({ root, skill, categories: ['1', '2', '3', '4', '5', '6'] })
    assert.equal(tooMany.ok, false)
    assert.match(tooMany.error, /最多 5 个/)
    const comma = setCategories({ root, skill, categories: ['a,b'] })
    assert.equal(comma.ok, false)
    assert.match(comma.error, /逗号/)
    assert.equal(readFileSync(skill.path, 'utf8'), before, '失败不能改文件')
  } finally {
    cleanup(temp)
  }
})

test('moveSkill 把技能搬到另一个根：目标有内容、源被删掉、只留一份', () => {
  const temp = makeTemp()
  try {
    const { root, skill } = fixture(temp, 'user-agents')
    const otherPath = join(temp, 'agents-skills')
    const targetRoot = { id: 'user-dsh', label: 'user-dsh', rank: 300, path: otherPath, writable: true }
    const moved = moveSkill({ root, skill, targetRoot })
    assert.equal(moved.ok, true, moved.error)
    assert.equal(moved.changed, true)
    assert.equal(moved.path, join(otherPath, 'demo-skill', 'SKILL.md'))
    assert.equal(existsSync(join(otherPath, 'demo-skill', 'SKILL.md')), true)
    assert.equal(existsSync(join(otherPath, 'demo-skill', 'references.md')), true, '整目录都要搬过去')
    assert.equal(existsSync(join(root.path, 'demo-skill')), false, '源目录必须消失（是移动不是复制）')
  } finally {
    cleanup(temp)
  }
})

test('moveSkill：目标已存在就拒绝；同根不动；只读根拒绝', () => {
  const temp = makeTemp()
  try {
    const { root, skill } = fixture(temp, 'user-agents')
    const otherPath = join(temp, 'agents-skills')
    const targetRoot = { id: 'user-dsh', label: 'user-dsh', rank: 300, path: otherPath, writable: true }
    mkdirSync(join(otherPath, 'demo-skill'), { recursive: true })
    writeFileSync(join(otherPath, 'demo-skill', 'SKILL.md'), '---\nname: other\ndescription: d\n---\n', 'utf8')
    const exists = moveSkill({ root, skill, targetRoot })
    assert.equal(exists.ok, false)
    assert.match(exists.error, /已存在/)
    assert.equal(existsSync(join(root.path, 'demo-skill', 'SKILL.md')), true, '拒绝时源不能被删')

    const sameRoot = moveSkill({ root, skill, targetRoot: root })
    assert.equal(sameRoot.ok, true)
    assert.equal(sameRoot.changed, false)

    const readonly = moveSkill({ root, skill, targetRoot: { ...targetRoot, id: 'bundled', writable: false, path: join(temp, 'bundled') } })
    assert.equal(readonly.ok, false)
    assert.match(readonly.error, /不可写/)
  } finally {
    cleanup(temp)
  }
})

test('删除时目录被占用，要给出可读的中文提示而不是裸 EPERM/EBUSY', { skip: process.platform !== 'win32' ? '只有 Windows 会锁住被其他进程当作工作目录的目录' : false }, async () => {
  const temp = makeTemp()
  let holder
  try {
    const { root, skill, managerRoot } = fixture(temp)
    // 让子进程把这个技能目录当成工作目录：Windows 上它就不再允许被 rename（EBUSY），
    // 与"文件资源管理器正打开着这个目录"是同一类占用。
    holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cwd: join(root.path, 'demo-skill'), stdio: 'ignore' })
    await new Promise((resolve) => holder.once('spawn', resolve))

    const removed = trashSkill({ root, skill, managerRoot })
    assert.equal(removed.ok, false, '目录被占用时删除应该失败')
    assert.equal(removed.code, 'move-failed')
    assert.match(removed.error, /正被其他程序占用/, `提示要说清是"被占用"：${removed.error}`)
    assert.match(removed.error, /EBUSY|EPERM/, '错误码要保留，方便排查')
    assert.equal(existsSync(join(root.path, 'demo-skill', 'SKILL.md')), true, '失败后技能必须还在原地')
  } finally {
    if (holder) {
      const exited = holder.exitCode !== null ? Promise.resolve() : new Promise((resolve) => holder.once('exit', resolve))
      holder.kill()
      await exited
    }
    cleanup(temp)
  }
})

test('清空回收站：目录已不存在的陈旧台账条目顺手清掉，不留点不动的幽灵行', async () => {
  const temp = makeTemp()
  try {
    const { root, skill, managerRoot } = fixture(temp)
    const removed = trashSkill({ root, skill, managerRoot })
    assert.equal(removed.ok, true, removed.error)
    // 模拟"目录已经被手工删掉、台账还没同步"：这种行在界面上点还原/彻底删除都没辙。
    rmSync(join(managerRoot, 'trash', removed.id), { recursive: true, force: true })

    const result = await purgeTrash({ managerRoot })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.purged, 1, '幽灵条目也算清掉了')
    assert.deepEqual(result.failed, [])
    assert.equal(listTrash(managerRoot).length, 0, '台账要一起清干净')
  } finally {
    cleanup(temp)
  }
})

test('清空回收站：被占用的条目跳过并留在台账，其余照删（一条失败不连坐）', { skip: process.platform !== 'win32' ? '只有 Windows 会锁住被其他进程当作工作目录的目录' : false }, async () => {
  const temp = makeTemp()
  let holder
  try {
    const { managerRoot } = fixture(temp)
    const trashRoot = join(managerRoot, 'trash')
    const entry = (id, name) => ({
      id,
      name,
      dirName: name,
      kind: 'bundle',
      from: join(temp, 'skills', name, 'SKILL.md'),
      rootId: 'user-agents',
      at: '2026-01-01T00:00:00.000Z',
    })
    // 一条被占用：子进程把它当工作目录，Windows 就不允许删它。
    mkdirSync(join(trashRoot, 'locked-entry', 'inner'), { recursive: true })
    writeFileSync(join(trashRoot, 'locked-entry', 'inner', 'note.md'), 'x', 'utf8')
    // 一条正常的 + 一条目录早就不在了的陈旧行。
    mkdirSync(join(trashRoot, 'plain-entry'), { recursive: true })
    writeFileSync(join(trashRoot, 'plain-entry', 'SKILL.md'), '---\nname: plain\n---\n', 'utf8')
    writeFileSync(
      join(trashRoot, 'index.json'),
      JSON.stringify([entry('locked-entry', 'locked'), entry('plain-entry', 'plain'), entry('ghost-entry', 'ghost')]),
      'utf8',
    )

    holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cwd: join(trashRoot, 'locked-entry', 'inner'), stdio: 'ignore' })
    await new Promise((resolve) => holder.once('spawn', resolve))

    const result = await purgeTrash({ managerRoot, retryDelays: [10, 20] })
    assert.equal(result.ok, true, '单条删不掉不该整批失败')
    assert.equal(result.purged, 2, `正常的 + 陈旧的都要清掉：${JSON.stringify(result)}`)
    assert.equal(result.failed.length, 1)
    assert.equal(result.failed[0].id, 'locked-entry')
    assert.equal(result.failed[0].name, 'locked')
    assert.match(result.failed[0].error, /正被其他程序占用/, `要说清是被占用：${result.failed[0].error}`)
    assert.match(result.failed[0].error, /EBUSY|EPERM/, '错误码要保留，方便排查')
    assert.equal(existsSync(join(trashRoot, 'plain-entry')), false, '正常条目要真删掉')
    assert.equal(existsSync(join(trashRoot, 'locked-entry')), true, '被占用的条目要原地保留')
    assert.deepEqual(listTrash(managerRoot).map((item) => item.id), ['locked-entry'], '台账只留删不掉的那条')
    // 界面上只说"被占用"，真正的失败路径要落进 delete.log，便于以后排查。
    const log = readFileSync(join(managerRoot, 'delete.log'), 'utf8')
    assert.match(log, /delete-failed id=locked-entry/, `日志要记下失败条目：${log}`)
    assert.match(log, /locked-entry/, '日志要带具体路径')
  } finally {
    if (holder) {
      const exited = holder.exitCode !== null ? Promise.resolve() : new Promise((resolve) => holder.once('exit', resolve))
      holder.kill()
      await exited
    }
    cleanup(temp)
  }
})

test('清空回收站：git 对象那种只读文件也能删掉，不被只读属性卡住', async () => {
  const temp = makeTemp()
  try {
    const { managerRoot } = fixture(temp)
    const trashRoot = join(managerRoot, 'trash')
    const target = join(trashRoot, 'readonly-entry')
    mkdirSync(join(target, '.git', 'objects', 'ab'), { recursive: true })
    writeFileSync(join(target, 'SKILL.md'), '---\nname: readonly\n---\n', 'utf8')
    writeFileSync(join(target, '.git', 'config'), 'x', 'utf8')
    writeFileSync(join(target, '.git', 'objects', 'ab', 'cdef'), 'x', 'utf8')
    // git 在 Windows 上会把对象文件设成只读；以前一把 rmSync 会因此整棵树失败。
    for (const file of [join(target, '.git', 'config'), join(target, '.git', 'objects', 'ab', 'cdef')]) chmodSync(file, 0o444)
    writeFileSync(
      join(trashRoot, 'index.json'),
      JSON.stringify([{ id: 'readonly-entry', name: 'readonly', dirName: 'readonly', kind: 'bundle', from: join(temp, 'skills', 'readonly', 'SKILL.md'), rootId: 'user-agents', at: '2026-01-01T00:00:00.000Z' }]),
      'utf8',
    )

    const result = await purgeTrash({ managerRoot, retryDelays: [10] })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.purged, 1)
    assert.deepEqual(result.failed, [], `只读文件不该挡住删除：${JSON.stringify(result.failed)}`)
    assert.equal(existsSync(target), false, '整棵树要删干净')
    assert.equal(existsSync(join(managerRoot, 'delete.log')), false, '删成功就不该写失败日志')
  } finally {
    cleanup(temp)
  }
})

test('清空回收站：占用只持续一会儿时，重试能等到它放开并删掉', { skip: process.platform !== 'win32' ? '只有 Windows 会把进程工作目录当成删除障碍' : false }, async () => {
  const temp = makeTemp()
  let holder
  let exitPromise
  try {
    const { managerRoot } = fixture(temp)
    const trashRoot = join(managerRoot, 'trash')
    const target = join(trashRoot, 'transient-entry')
    mkdirSync(join(target, 'inner'), { recursive: true })
    writeFileSync(join(target, 'SKILL.md'), '---\nname: transient\n---\n', 'utf8')
    writeFileSync(join(target, 'inner', 'note.md'), 'x', 'utf8')
    writeFileSync(
      join(trashRoot, 'index.json'),
      JSON.stringify([{ id: 'transient-entry', name: 'transient', dirName: 'transient', kind: 'bundle', from: join(temp, 'skills', 'transient', 'SKILL.md'), rootId: 'user-agents', at: '2026-01-01T00:00:00.000Z' }]),
      'utf8',
    )
    holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cwd: join(target, 'inner'), stdio: 'ignore' })
    // 子进程是 1.2 秒后自己被杀掉的，等 purge 返回时 exit 事件可能早就发生过了
    // （被信号杀掉时 exitCode 仍是 null），所以一开始就挂监听，别在 finally 里补挂。
    exitPromise = new Promise((resolve) => holder.once('exit', resolve))
    await new Promise((resolve) => holder.once('spawn', resolve))
    // 1.2 秒后把占用放掉；重试预算 0.2+0.4+0.8+1.6+3.0 秒足够等到这一刻。
    setTimeout(() => holder.kill(), 1200)

    const result = await purgeTrash({ managerRoot, retryDelays: [200, 400, 800, 1600, 3000] })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.purged, 1, `占用放开后应该删成功：${JSON.stringify(result)}`)
    assert.deepEqual(result.failed, [])
    assert.equal(existsSync(target), false, '最后要删干净，不能留半截')
  } finally {
    holder?.kill()
    if (exitPromise) await exitPromise
    cleanup(temp)
  }
})
