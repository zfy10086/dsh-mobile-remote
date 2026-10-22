/**
 * binary-fix 的最小验证：用一个已知可用的 cloudflared 和它的截断副本，
 * 确认「完整性判定」和「可执行判定」都能识别坏文件。
 *
 * 用法：node test-binary-fix.mjs [可用的 cloudflared.exe 路径]
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { peComplete, probeBinary } from './lib/binary-fix.js'

const good = process.argv[2] ?? 'C:/Users/ZFY/.dsh/profiles/desktop/node_modules/cloudflared/bin/cloudflared.exe'
if (!existsSync(good)) {
  console.log(`跳过：没找到可用的 cloudflared（${good}）`)
  process.exit(0)
}

assert.equal(peComplete(good), true, '完整二进制应通过 PE 校验')
assert.equal(await probeBinary(good), true, '完整二进制应能跑 --version')

const tmp = mkdtempSync(join(tmpdir(), 'mobile-remote-fix-'))
try {
  const whole = readFileSync(good)
  const cut = join(tmp, 'truncated.exe')
  writeFileSync(cut, whole.subarray(0, Math.floor(whole.length / 4)))
  assert.equal(peComplete(cut), false, '截断的 PE 必须被识别为不完整')
  assert.equal(await probeBinary(cut), false, '截断的 PE 必须被判为不可运行')

  const empty = join(tmp, 'empty.exe')
  writeFileSync(empty, '')
  assert.equal(peComplete(empty), false, '空文件不算完整')
  assert.equal(await probeBinary(empty), false, '空文件不可运行')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log('✅ binary-fix tests passed')
