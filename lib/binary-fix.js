/**
 * cloudflared 二进制自愈（dsh-mobile-remote 的核心补丁）。
 *
 * 为什么需要它
 * ------------
 * 上游 dsh-mobile-remote（v0.4.6）直接使用 npm 包 `cloudflared` 的
 * install()：从 GitHub 直链下载、无断点续传、无完整性校验。网络一中断就会留下
 * 一个「半个 exe」，而 Windows 执行被截断的 PE 会报 EFTYPE，插件最终只显示：
 *
 *     could not obtain the cloudflared binary: spawn EFTYPE
 *
 * 因此本模块在「启动隧道之前」做一次自愈：
 *
 *   1. 文件存在且 `--version` 能跑通 → 直接放行
 *   2. 文件在但跑不通（截断/架构不对）→ 改名留档，别挡住重下
 *   3. 依次尝试镜像（gh-proxy / ghproxy / GitHub 直链），带 Range 断点续传
 *   4. PE 完整性校验（节表数据不越过文件末尾）通过后才落盘
 *   5. 落盘后再 `--version` 验证一次
 *   6. 全部失败 → 回落到上游的默认逻辑（能下就下，不行就把原始错误抛出去）
 *
 * 只改 Windows 的 exe 资产（linux/macOS 的发布物是 .tgz，不在本补丁范围内，
 * 会把控制权交回上游的默认逻辑）。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, createWriteStream, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** 探测 `--version` 的超时（毫秒）。 */
const PROBE_TIMEOUT_MS = 20_000
/** 单次下载的重试次数。 */
const DOWNLOAD_ATTEMPTS = 6
/** 判定「文件被截断」的最小体积（完整 Windows 版约 55 MB）。 */
const MIN_WINDOWS_BYTES = 20 * 1024 * 1024

/** 平台/架构 → Cloudflare 官方发布资产名。非 Windows 返回 null（交回上游）。 */
function assetForPlatform(platform = process.platform, arch = process.arch) {
  if (platform !== 'win32') return null
  if (arch === 'x64') return 'cloudflared-windows-amd64.exe'
  if (arch === 'arm64') return 'cloudflared-windows-arm64.exe'
  return null
}

/** 镜像前缀（会拼在官方发布地址前面）。直链放最后。 */
const MIRROR_PREFIXES = [
  'https://gh-proxy.com/',
  'https://ghproxy.net/',
  'https://',
]
const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/'

/** 跑一次 `exe --version`；同步抛错（Windows 上的 EFTYPE 就是这种）也当作「不可用」。 */
function runs(executable) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(executable, ['--version'], { stdio: 'ignore' })
    } catch {
      // 关键修复点：上游只监听 'error' 事件，而截断 PE 的 EFTYPE 可能是同步抛出的
      resolve(false)
      return
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      resolve(false)
    }, PROBE_TIMEOUT_MS)
    child.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

/**
 * PE 结构完整性：MZ 头 + PE 签名 + 每个节的 (rawPtr + rawSize) 不越过文件末尾。
 * 截断的文件头仍然合法，只有节表数据能暴露问题。
 */
function peComplete(file) {
  let buf
  try { buf = readFileSync(file) } catch { return false }
  if (buf.length < MIN_WINDOWS_BYTES) return false
  if (buf[0] !== 0x4d || buf[1] !== 0x5a) return false
  const peOff = buf.readInt32LE(0x3c)
  if (peOff <= 0 || peOff + 24 > buf.length) return false
  if (buf.toString('ascii', peOff, peOff + 4) !== 'PE\u0000\u0000') return false
  const machine = buf.readUInt16LE(peOff + 4)
  if (machine !== 0x8664 && machine !== 0xaa64) return false
  const numSections = buf.readUInt16LE(peOff + 6)
  const optSize = buf.readUInt16LE(peOff + 20)
  const secOff = peOff + 24 + optSize
  if (numSections <= 0 || secOff + numSections * 40 > buf.length) return false
  let maxEnd = 0
  for (let i = 0; i < numSections; i++) {
    const o = secOff + 40 * i
    const rawSize = buf.readUInt32LE(o + 16)
    const rawPtr = buf.readUInt32LE(o + 20)
    if (rawPtr + rawSize > maxEnd) maxEnd = rawPtr + rawSize
  }
  return maxEnd > 0 && maxEnd <= buf.length
}

/** 带 Range 续传的下载；成功返回落盘路径。 */
async function downloadResumable(url, dest) {
  mkdirSync(dirname(dest), { recursive: true })
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    const have = existsSync(dest) ? statSync(dest).size : 0
    const headers = have > 0 ? { range: `bytes=${have}-` } : {}
    let res
    try {
      res = await fetch(url, { headers, redirect: 'follow' })
    } catch (error) {
      await sleep(600)
      if (attempt === DOWNLOAD_ATTEMPTS) throw error
      continue
    }
    if (res.status === 416) {
      // 已经下完（服务端认为 Range 超出）
      return dest
    }
    if (res.status !== 200 && res.status !== 206) {
      await sleep(600)
      if (attempt === DOWNLOAD_ATTEMPTS) throw new Error(`HTTP ${res.status} ${url}`)
      continue
    }
    const total = Number(res.headers.get('content-length') ?? 0) + (res.status === 206 ? have : 0)
    try {
      const out = createWriteStream(dest, { flags: res.status === 206 ? 'a' : 'w' })
      const reader = res.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r))
      }
      await new Promise((resolve, reject) => { out.once('error', reject); out.end(resolve) })
    } catch (error) {
      await sleep(600)
      if (attempt === DOWNLOAD_ATTEMPTS) throw error
      continue
    }
    const size = existsSync(dest) ? statSync(dest).size : 0
    if (total > 0 ? size >= total : size > 0) {
      if (peComplete(dest)) return dest
      // 下完了但结构不对：丢掉重来
      try { unlinkSync(dest) } catch { /* ignore */ }
    }
  }
  throw new Error(`镜像下载失败：${url}`)
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

/**
 * 确保 binPath 处有一个可用的 cloudflared。
 *
 * @param {string} binPath        cloudflared 包的二进制路径（上游的 bin）
 * @param {() => Promise<void>}   fallback 上游默认的「缺失则 install()」逻辑
 * @param {(msg: string) => void} [log]
 */
export async function ensureCloudflaredBinary(binPath, fallback, log = () => {}) {
  if (typeof binPath !== 'string' || binPath.length === 0) {
    if (typeof fallback === 'function') await fallback()
    return
  }
  // 1) 现成的能用就用
  if (existsSync(binPath) && await runs(binPath)) return

  // 2) 坏文件挪走留档（诊断用，不占着文件名）
  if (existsSync(binPath)) {
    const bad = `${binPath}.bad-${Date.now()}`
    try { renameSync(binPath, bad); log(`现有 cloudflared 不可用，已挪到 ${bad}`) } catch { /* ignore */ }
  }

  // 3) 只在 Windows 上做镜像重下；其他平台交回上游
  const asset = assetForPlatform()
  if (asset !== null) {
    const part = `${binPath}.part`
    for (const prefix of MIRROR_PREFIXES) {
      const url = `${prefix}${RELEASE_BASE}${asset}`
      try {
        log(`尝试下载 cloudflared：${url}`)
        await downloadResumable(url, part)
        renameSync(part, binPath)
        if (await runs(binPath)) return
        try { unlinkSync(binPath) } catch { /* ignore */ }
        log('下载完成但二进制仍无法运行，换下一个镜像')
      } catch (error) {
        log(`镜像失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // 4) 交回上游（离线安装等场景）
  if (typeof fallback === 'function') {
    await fallback()
    if (await runs(binPath)) return
  }
  throw new Error(`cloudflared 二进制不可用（${binPath}）：镜像与上游安装均失败`)
}

/** 供测试与诊断使用，不参与运行路径。 */
export { peComplete, runs as probeBinary }
