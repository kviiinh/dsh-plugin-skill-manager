/**
 * frontmatter 解析 / 校验 / 改写。
 *
 * @module dsh-plugin-skill-manager/test/frontmatter.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyCategories,
  applyInvocation,
  applyName,
  categoriesOfMetadata,
  isSkillName,
  MAX_CATEGORIES,
  parseFrontmatterLines,
  parseStrictBoolean,
  readSkillRecord,
  renderSkillTemplate,
  rewriteFrontmatter,
  splitFrontmatter,
} from '../lib/frontmatter.js'

test('isSkillName 只认 kebab-case', () => {
  assert.equal(isSkillName('dingtalk-calendar'), true)
  assert.equal(isSkillName('a'), true)
  assert.equal(isSkillName('a1-b2'), true)
  assert.equal(isSkillName('Bad'), false)
  assert.equal(isSkillName('has space'), false)
  assert.equal(isSkillName('-lead'), false)
  assert.equal(isSkillName('中文技能'), false)
  assert.equal(isSkillName(undefined), false)
})

test('严格布尔文法（DSH 会因非法值丢弃整个技能）', () => {
  assert.deepEqual(parseStrictBoolean(undefined), { present: false, valid: true })
  for (const token of ['true', 'TRUE', 'yes', 'On', '1']) {
    assert.deepEqual(parseStrictBoolean(token), { present: true, value: true, valid: true }, token)
  }
  for (const token of ['false', 'no', 'OFF', '0']) {
    assert.deepEqual(parseStrictBoolean(token), { present: true, value: false, valid: true }, token)
  }
  assert.equal(parseStrictBoolean('maybe').valid, false)
  assert.equal(parseStrictBoolean(2).valid, false)
})

test('切分 frontmatter：BOM、正文、缺失结束符', () => {
  const ok = splitFrontmatter('\uFEFF---\nname: a\n---\n正文\n')
  assert.equal(ok.error, undefined)
  assert.equal(ok.frontmatter, 'name: a')
  assert.equal(ok.body, '正文\n')

  assert.match(splitFrontmatter('没有 frontmatter').error, /不是 `---`/)
  assert.match(splitFrontmatter('---\nname: a\n').error, /没有结束/)
  assert.equal(splitFrontmatter('---\nname: a\n...\n正文').body, '正文')
})

test('解析嵌套 metadata 与行内数组（钉钉那类真实技能）', () => {
  const record = readSkillRecord({
    text: [
      '---',
      'name: dingtalk-calendar',
      'description: 钉钉日历与会议室。',
      'metadata:',
      '  cli_version: ">=0.2.14"',
      '  category: product',
      '  requires:',
      '    bins:',
      '      - dws',
      'tags: [dingtalk, calendar]',
      '---',
      '# 正文',
    ].join('\n'),
  })
  assert.equal(record.valid, true, JSON.stringify(record.issues))
  assert.equal(record.name, 'dingtalk-calendar')
  assert.equal(record.metadata.category, 'product')
  assert.equal(record.metadata.cli_version, '>=0.2.14')
  assert.deepEqual(record.metadata.requires.bins, ['dws'])
  assert.deepEqual(record.data.tags, ['dingtalk', 'calendar'])
})

test('无效技能要给出原因（DSH 静默丢弃，管理器负责解释）', () => {
  const missingDescription = readSkillRecord({ text: '---\nname: ok-name\n---\n正文' })
  assert.equal(missingDescription.valid, false)
  assert.match(missingDescription.issues.join('；'), /description/)

  const badName = readSkillRecord({ text: '---\nname: Bad Name\ndescription: x\n---\n' })
  assert.equal(badName.valid, false)
  assert.match(badName.issues.join('；'), /kebab-case/)

  const badFlag = readSkillRecord({ text: '---\nname: ok-name\ndescription: x\ndisable-model-invocation: maybe\n---\n' })
  assert.equal(badFlag.valid, false)
  assert.match(badFlag.issues.join('；'), /合法布尔值/)
})

test('不支持的 YAML 语法记进 issues 而不是猜', () => {
  const { issues } = parseFrontmatterLines(['description: |', 'name: a'])
  assert.ok(issues.some((issue) => issue.includes('块标量')))
})

test('invocation 默认两面都开，显式关闭后语义正确', () => {
  const base = readSkillRecord({ text: '---\nname: a-b\ndescription: d\n---\n' })
  assert.deepEqual(base.invocation, { modelInvocable: true, userInvocable: true })

  const userOnly = readSkillRecord({ text: '---\nname: a-b\ndescription: d\ndisable-model-invocation: true\n---\n' })
  assert.deepEqual(userOnly.invocation, { modelInvocable: false, userInvocable: true })

  const modelOnly = readSkillRecord({ text: '---\nname: a-b\ndescription: d\nuser-invocable: false\n---\n' })
  assert.deepEqual(modelOnly.invocation, { modelInvocable: true, userInvocable: false })
})

test('改 invocation 保留正文与其它键，且"默认许可"会删掉冗余键', () => {
  const text = '---\nname: a-b\ndescription: d\nmetadata:\n  x: 1\n---\n正文\n'
  const disabled = applyInvocation(text, { modelInvocable: false, userInvocable: true })
  assert.equal(disabled.changed, true)
  assert.match(disabled.text, /disable-model-invocation: true/)
  assert.match(disabled.text, /metadata:\n {2}x: 1/)
  assert.ok(disabled.text.endsWith('正文\n'))

  const enabled = applyInvocation(disabled.text, { modelInvocable: true, userInvocable: true })
  assert.doesNotMatch(enabled.text, /disable-model-invocation/)
  assert.match(enabled.text, /name: a-b/)

  const both = applyInvocation(text, { modelInvocable: false, userInvocable: false })
  assert.match(both.text, /user-invocable: false/)
})

test('改名与通用改写', () => {
  const next = applyName('---\nname: old-name\ndescription: d\n---\n正文', 'new-name')
  assert.match(next.text, /name: new-name/)
  assert.doesNotMatch(next.text, /old-name/)

  const removed = rewriteFrontmatter('---\nname: a-b\ndescription: d\n---\n', { description: undefined })
  assert.doesNotMatch(removed.text, /description/)
  assert.match(removed.text, /name: a-b/)
})

test('改写保留 CRLF 换行风格', () => {
  const crlf = '---\r\nname: a-b\r\ndescription: d\r\n---\r\n正文\r\n第二行\r\n'
  const next = applyInvocation(crlf, { modelInvocable: false, userInvocable: true })
  assert.equal(next.changed, true)
  assert.match(next.text, /disable-model-invocation: true\r\n/)
  // 先抹掉全部 CRLF，再看还有没有剩下的裸 LF。
  assert.equal(next.text.replace(/\r\n/g, '').includes('\n'), false, '不能混入裸 LF')
  assert.match(next.text, /正文\r\n第二行/)

  const lf = applyInvocation('---\nname: a-b\ndescription: d\n---\n正文\n', { modelInvocable: false, userInvocable: true })
  assert.equal(lf.text.includes('\r'), false)
})

test('新建模板本身就是合法技能', () => {
  const record = readSkillRecord({ text: renderSkillTemplate({ name: 'my-skill', description: '做某件事' }) })
  assert.equal(record.valid, true, JSON.stringify(record.issues))
  assert.equal(record.name, 'my-skill')
})

test('applyCategories：只改 metadata.category，同块其它键与正文原样保留', () => {
  const text = [
    '---',
    'name: demo',
    'description: 演示',
    'metadata:',
    '  owner: lead',
    '  category: old',
    '---',
    '',
    '# demo',
    '正文',
  ].join('\n')
  const next = applyCategories(text, ['alpha', 'beta'])
  assert.equal(next.error, undefined)
  assert.equal(next.changed, true)
  assert.deepEqual(next.categories, ['alpha', 'beta'])
  assert.match(next.text, /^  category: alpha,beta$/m, '逗号分隔写进 metadata 块')
  assert.match(next.text, /^  owner: lead$/m, '同块其它键不能动')
  assert.match(next.text, /# demo\n正文/, '正文原样保留')
  assert.equal(next.text.includes('category: old'), false)
  // 读回来就是两个分类。
  const record = readSkillRecord({ text: next.text })
  assert.deepEqual(categoriesOfMetadata(record.metadata), ['alpha', 'beta'])
  assert.equal(record.valid, true, JSON.stringify(record.issues))
})

test('applyCategories：没有 metadata 块就新建；清空分类就把 category 行删掉', () => {
  const bare = '---\nname: demo\ndescription: 演示\n---\n正文\n'
  const created = applyCategories(bare, ['one'])
  assert.equal(created.changed, true)
  assert.match(created.text, /metadata:\n  category: one/)
  assert.deepEqual(categoriesOfMetadata(readSkillRecord({ text: created.text }).metadata), ['one'])

  const cleared = applyCategories(created.text, [])
  assert.equal(cleared.changed, true)
  assert.equal(/category:/.test(cleared.text), false, '清空后不留 category 行')
  assert.deepEqual(categoriesOfMetadata(readSkillRecord({ text: cleared.text }).metadata), [])
  // metadata 块本身保留（里面可能还有别的键）。
  assert.match(cleared.text, /metadata:/)

  // 本来就没有分类、又不写分类：不算修改。
  const untouched = applyCategories(bare, [])
  assert.equal(untouched.changed, false)
  assert.equal(untouched.text, bare)
})

test('applyCategories：行内数组与列表块写法都会被换成逗号标量', () => {
  const inlineArray = '---\nname: demo\ndescription: d\nmetadata: {}\n---\n正文\n'
  const a = applyCategories(inlineArray, ['x', 'y'])
  assert.equal(a.error, undefined)
  assert.match(a.text, /metadata:\n  category: x,y/)
  assert.deepEqual(categoriesOfMetadata(readSkillRecord({ text: a.text }).metadata), ['x', 'y'])

  const blockList = [
    '---',
    'name: demo',
    'description: d',
    'metadata:',
    '  category:',
    '    - p',
    '    - q',
    '  owner: me',
    '---',
    '正文',
  ].join('\n')
  const b = applyCategories(blockList, ['p', 'q', 'r'])
  assert.deepEqual(categoriesOfMetadata(readSkillRecord({ text: b.text }).metadata), ['p', 'q', 'r'])
  assert.match(b.text, /  owner: me/, '列表块后面的键不能被吞掉')
  assert.equal(b.text.includes('- p'), false, '旧的列表项要清掉')
})

test('applyCategories：最多 5 个、名字不能带逗号、行内 metadata 不猜', () => {
  const text = '---\nname: demo\ndescription: d\nmetadata:\n  category: a\n---\n'
  const tooMany = applyCategories(text, ['1', '2', '3', '4', '5', '6'])
  assert.equal(tooMany.changed, false)
  assert.match(tooMany.error, new RegExp(`最多 ${MAX_CATEGORIES} 个`))

  const comma = applyCategories(text, ['a,b'])
  assert.equal(comma.changed, false)
  assert.match(comma.error, /逗号/)

  const inline = applyCategories('---\nname: demo\ndescription: d\nmetadata: {category: a}\n---\n', ['b'])
  assert.equal(inline.changed, false)
  assert.match(inline.error, /行内写法/)

  // 去重 + trim。
  const dedup = applyCategories(text, ['  a  ', 'a', 'b'])
  assert.deepEqual(dedup.categories, ['a', 'b'])
})

test('applyCategories：CRLF 文件改写后不混入裸 LF', () => {
  const crlf = '---\r\nname: demo\r\ndescription: d\r\nmetadata:\r\n  category: a\r\n---\r\n正文\r\n'
  const next = applyCategories(crlf, ['a', 'b'])
  assert.equal(next.changed, true)
  assert.match(next.text, /  category: a,b\r\n/)
  assert.equal(next.text.replace(/\r\n/g, '').includes('\n'), false, '不能混入裸 LF')
  assert.match(next.text, /正文\r\n/)
})

test('metadata 里更深层的同名键不是分类：只加/改直接子项，不碰它', () => {
  const text = '---\nname: demo\ndescription: d\nmetadata:\n  requires:\n    category: inner\n---\n'
  const next = applyCategories(text, ['product'])
  assert.match(next.text, /^  category: product$/m, '直接子项要写进去')
  assert.match(next.text, /^    category: inner$/m, '嵌套的同名键必须原样保留')
  // 再改一次：仍然只改直接子项，嵌套那个不受影响。
  const again = applyCategories(next.text, ['product', 'analysis'])
  assert.match(again.text, /^  category: product,analysis$/m)
  assert.equal((again.text.match(/category: inner/g) || []).length, 1)
})

test('metadata 块用 4 空格缩进：新写的 category 跟随同样的缩进', () => {
  const text = '---\nname: demo\ndescription: d\nmetadata:\n    owner: me\n---\n'
  const next = applyCategories(text, ['a', 'b'])
  assert.match(next.text, /^    category: a,b$/m, '缩进要跟块一致，否则 YAML 层级会错')
  assert.equal(/^  category:/m.test(next.text), false)
})
