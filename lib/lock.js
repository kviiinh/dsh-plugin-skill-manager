/**
 * 跨进程的简单文件锁。
 *
 * 为什么需要：技能市场的台账 `market.json` 是"读-改-写"结构，而管理器可能被
 * **多个进程**同时操作（Host + 用户自己跑的脚本、两个窗口、CLI）。没有锁时
 * 8 个并发安装会互相覆盖台账，出现"技能装上了但管理器不认、拒绝卸载"。
 *
 * 实现：用一个 `wx`（独占创建）的锁文件当互斥量；
 *   - 拿不到锁就短睡重试，超过 `timeoutMs` 就**放弃加锁直接执行**——
 *     宁可退化成无锁（写入侧还有重试与原子改名兜底），也不能把安装卡死；
 *   - Windows 上"文件已被别人打开"不一定报 `EEXIST`，也可能是 `EPERM`/`EACCES`/`EBUSY`，
 *     这些**同样是竞争**，必须继续重试——早先只认 `EEXIST`，把竞争当成了"目录不可写"，
 *     于是并发安装退化成无锁，台账偶发丢条目；
 *   - 锁文件里写 pid + 时间戳 + 本次持有的随机 token，超过 `staleMs` 视为持有者已崩溃并抢占；
 *   - 释放时**只在 token 还是自己的时候**删锁文件：否则"被抢占后归来的旧持有者"
 *     会把别人刚拿到的锁删掉，互斥就失效了。
 *
 * @module dsh-plugin-skill-manager/lib/lock
 */

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'

/** 说明：这些错误码代表"锁被占用"，不是"锁不可用"。 */
const CONTENDED = new Set(['EEXIST', 'EACCES', 'EPERM', 'EBUSY'])

/**
 * 在文件锁保护下执行一个异步任务。
 * @param {string} lockPath 锁文件路径。
 * @param {() => Promise<any>} task 任务。
 * @param {{timeoutMs?: number, staleMs?: number, retryMs?: number}} [options] 选项。
 * @returns {Promise<any>} 任务结果。
 */
export async function withFileLock(lockPath, task, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000
  const staleMs = options.staleMs ?? 30_000
  const retryMs = options.retryMs ?? 25
  const deadline = Date.now() + timeoutMs
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`
  let handle

  for (;;) {
    try {
      handle = openSync(lockPath, 'wx')
      writeSync(handle, `${process.pid} ${Date.now()} ${token}\n`)
      break
    } catch (error) {
      if (!CONTENDED.has(error?.code)) {
        // 锁目录不可写之类：不因为锁的问题让业务失败。
        return task()
      }
    }
    try {
      const parts = readFileSync(lockPath, 'utf8').trim().split(/\s+/)
      const heldSince = Number(parts[1])
      if (Number.isFinite(heldSince) && Date.now() - heldSince > staleMs) {
        // 持有者多半已经死了：抢占。
        try {
          unlinkSync(lockPath)
        } catch {
          /* 别人先抢到了，继续重试 */
        }
        continue
      }
    } catch {
      /* 锁文件读不到（刚好被别人删了）：直接重试 */
    }
    if (Date.now() > deadline) return task()
    await new Promise((resolve) => setTimeout(resolve, retryMs + Math.floor(Math.random() * retryMs)))
  }

  try {
    return await task()
  } finally {
    try {
      closeSync(handle)
    } catch {
      /* 已经关了 */
    }
    // 只删自己的锁：被别人判定 stale 抢占过的话，这个锁已经不归我们了。
    try {
      const holder = readFileSync(lockPath, 'utf8').trim().split(/\s+/)
      if (holder[2] === token) unlinkSync(lockPath)
    } catch {
      /* 锁文件已经没了 / 读不到：无所谓 */
    }
  }
}
