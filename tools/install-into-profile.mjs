#!/usr/bin/env node
/**
 * 把技能管理器装进（或从）本机某个 DSH profile。
 *
 * 为什么是 Node 脚本而不是 .ps1：Windows 上 PowerShell 常默认禁止运行脚本
 * （ExecutionPolicy），而 Node 一直可用（DSH 自带运行时）。
 *
 * 只改 profile 的 `package.json` 两处：
 *
 *   1. `dependencies` 加一条 `link:` 指向本插件目录；
 *   2. `dsh.profile.bundles` 加一个名字——**bundles 列表才是"启用这个插件"的开关**。
 *
 * 然后在 profile 目录里跑 `dsh plugin --profile <name> install`（即 pnpm install），
 * 把 link 落成 node_modules 里的软链。改动前会备份成
 * `package.json.bak-skill-manager`，`--uninstall` 会还原这两处。
 *
 * 用法：
 *   node tools/install-into-profile.mjs --dry-run
 *   node tools/install-into-profile.mjs
 *   node tools/install-into-profile.mjs --uninstall
 *
 * 宿主必须重启（DSH Desktop 退出重开）才会加载新的 Host 半边与浏览器半边。
 *
 * @module dsh-plugin-skill-manager/tools/install-into-profile
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_NAME = 'dsh-plugin-skill-manager'
const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 解析命令行参数。
 * @param {string[]} argv 参数。
 * @returns {{profile: string, uninstall: boolean, dryRun: boolean}} 选项。
 */
function parseArgs(argv) {
  const options = { profile: 'desktop', uninstall: false, dryRun: false, dsh: '' }
  for (let at = 0; at < argv.length; at += 1) {
    const token = argv[at]
    if (token === '--profile') {
      options.profile = argv[at + 1] ?? ''
      at += 1
    } else if (token === '--dsh') {
      options.dsh = argv[at + 1] ?? ''
      at += 1
    } else if (token === '--uninstall') options.uninstall = true
    else if (token === '--dry-run') options.dryRun = true
    else if (token === '--help' || token === '-h') {
      console.log('用法：node tools/install-into-profile.mjs [--profile <name>] [--dsh <dsh 可执行文件>] [--uninstall] [--dry-run]')
      process.exit(0)
    } else if (token.startsWith('--')) {
      console.error(`未知参数：${token}`)
      process.exit(2)
    }
  }
  if (!options.profile) {
    console.error('--profile 不能为空')
    process.exit(2)
  }
  return options
}

/**
 * 找到 dsh CLI 的入口：`--dsh <path>` > `$DSH_CLI` > PATH 里的 `dsh`。
 *
 * 不写死任何本机安装路径——桌面版自带的 CLI 一般在
 * `<安装目录>/resources/runtime/cli/bin/dsh(.cmd)`，需要时用 `--dsh` 指过去即可。
 * @param {string} [explicit] 命令行给的路径。
 * @returns {{command: string, prefix: string[]}} 可执行命令与前置参数。
 */
function findDsh(explicit) {
  const candidate = explicit || process.env.DSH_CLI || ''
  if (candidate && existsSync(candidate)) return { command: candidate, prefix: [] }
  const fallback = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
  return { command: fallback, prefix: [] }
}

const options = parseArgs(process.argv.slice(2))
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', options.profile)
const manifestPath = join(profileDir, 'package.json')

if (!existsSync(manifestPath)) {
  console.error(`找不到 profile 清单：${manifestPath}`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.dependencies ??= {}
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? [...manifest.dsh.profile.bundles] : []
const linkSpec = `link:${pluginDir.replace(/\\/g, '/')}`

if (options.uninstall) {
  delete manifest.dependencies[PLUGIN_NAME]
  manifest.dsh.profile.bundles = bundles.filter((name) => name !== PLUGIN_NAME)
  console.log(`将移除 dependencies.${PLUGIN_NAME}`)
  console.log(`将从 dsh.profile.bundles 移除 ${PLUGIN_NAME}`)
} else {
  manifest.dependencies[PLUGIN_NAME] = linkSpec
  if (!bundles.includes(PLUGIN_NAME)) bundles.push(PLUGIN_NAME)
  manifest.dsh.profile.bundles = bundles
  console.log(`将写入 dependencies.${PLUGIN_NAME} = ${linkSpec}`)
  console.log(`将写入 dsh.profile.bundles += ${PLUGIN_NAME}`)
}

const next = `${JSON.stringify(manifest, null, 2)}\n`
if (options.dryRun) {
  console.log(`\n--- ${manifestPath}（dry-run，未落盘）---`)
  console.log(next)
  console.log(`--- 之后会执行：dsh plugin --profile ${options.profile} install ---`)
  process.exit(0)
}

const backupPath = join(profileDir, 'package.json.bak-skill-manager')
if (!existsSync(backupPath)) {
  copyFileSync(manifestPath, backupPath)
  console.log(`已备份：${backupPath}`)
}
writeFileSync(manifestPath, next, 'utf8')
console.log(`已写入：${manifestPath}`)

const dsh = findDsh(options.dsh)
console.log(`\n执行：${dsh.command} plugin --profile ${options.profile} install`)
// Windows 上 `.cmd` 必须经 cmd.exe 执行；直接 spawn + shell:true 会触发 Node 的
// DEP0190（参数只拼接不转义），所以这里显式走 `cmd /d /s /c`。
const isWindowsCommand = process.platform === 'win32'
const spawnCommand = isWindowsCommand ? (process.env.ComSpec ?? 'cmd.exe') : dsh.command
const spawnArgs = isWindowsCommand
  ? ['/d', '/s', '/c', dsh.command, 'plugin', '--profile', options.profile, 'install']
  : ['plugin', '--profile', options.profile, 'install']
const result = spawnSync(spawnCommand, spawnArgs, {
  cwd: profileDir,
  stdio: 'inherit',
  shell: false,
})
if (result.status !== 0) {
  console.error(`\npnpm install 失败（退出码 ${result.status}）。`)
  console.error(`可先还原：node tools/install-into-profile.mjs --uninstall`)
  process.exit(result.status ?? 1)
}
console.log('\n完成。请重启宿主（DSH Desktop 退出重开），侧栏会出现「技能」页。')
console.log('回滚：node tools/install-into-profile.mjs --uninstall，然后重启宿主。')
