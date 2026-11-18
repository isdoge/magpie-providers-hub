// 各渠道共享的小工具：账号槽读取、信封解析、额度分档。
//
// ⚠️ v0.5.0 起本模块**不写任何文件**（除了显式开启的诊断日志，且落在系统临时目录）：
//    插件不碰 magpie 的配置目录，账号只存 magpie 账号槽。

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * magpie 的配置目录（**只用于读它自己的文件**：plugin-auth.json / models.json）。
 * ⚠️ 惰性求值：模块级常量会在首次 import 时固化 homedir。
 * ⚠️ 便携版 magpie 或设了 XDG_CONFIG_HOME 时这里可能指错 —— 但既然只读、
 *    读不到就回退（`readOwnAuthEntries` 的 catch 返回空数组），不会污染任何东西。
 */
const storeDir = () => join(homedir(), '.config', 'magpie')

/**
 * 全链路诊断日志（排查用）。**默认关闭**：设 `DSH_HUB_DEBUG=1` 才写。
 *
 * ⚠️ 落点是**系统临时目录**（`<tmp>/providers-hub-debug.log`），不是 magpie 的
 *    配置目录 —— 社区审核（PR #502 第 2 条）要求插件不往宿主的目录里写文件。
 */
export function debugLog(line) {
  if (process.env.DSH_HUB_DEBUG !== '1') return
  try {
    const dir = join(tmpdir(), 'providers-hub')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'debug.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch { /* 忽略 */ }
}

/**
 * magpie 的账号槽存储（plugin-auth.json）—— 供「每渠道账号数」统计与旧槽迁移用。
 * ⚠️ 只读，绝不写（那是 magpie 的地盘）；路径可用 env 重定向（测试）。
 */
export function magpieAuthPath() {
  return process.env.DSH_HUB_AUTH_PATH ?? join(storeDir(), 'plugin-auth.json')
}

/** 本插件自己的账号槽前缀（`hub-<ch>` 与 0.3.x 的 `providers-hub*`）—— 见 isOwnSlotKey。 */

/**
 * 这个 key 是不是本插件的槽。
 *
 * 认三种形态：
 *   `hub-<渠道>` / `hub-<渠道>#<slot>`   —— v0.4.0 起的槽
 *   `providers-hub` / `providers-hub#<slot>` —— v0.3.x 聚合形态的旧槽（迁移用）
 *
 * ⚠️ 别写成 `key.startsWith(p + '-')` 一把梭：`hub-` 后面直接跟渠道名
 *    （`hub-astudio`），没有第二个分隔符 —— 那样写会把所有自己的槽全漏掉
 *    （实测：`readOwnAuthEntries()` 返回空数组）。
 */
function isOwnSlotKey(key) {
  const k = String(key ?? '')
  if (k.startsWith('hub-')) return true
  if (k === 'providers-hub') return true
  return k.startsWith('providers-hub#') || k.startsWith('providers-hub-')
}

/**
 * 读 magpie 账号槽的**原始条目**：`[{key, channel, value}]`（value 是 magpie 存的整个 auth）。
 * 只读，绝不写（那是 magpie 的地盘）；路径可用 env 重定向（测试）。
 *
 * ⚠️⚠️ **必须按 key 前缀过滤后再取值**（PR #502 审核第 3 条）：不带过滤地调用会把
 *    `plugin-auth.json` 里**所有**供应商的完整 auth（包括别的插件的 token）读进内存 ——
 *    而调用方往往只用来数账号。现在默认**只返回本插件的槽**，且 `withValue:false`
 *    时连 auth 内容都不保留（直接丢弃 value）。
 *
 * @param {{providerId?: string, withValue?: boolean}} [opts]
 *   providerId 省略 = 本插件的全部槽（`hub-*` / `providers-hub*`）；
 *   withValue 只在**迁移**时才需要（要复制旧槽的 auth）。
 */
export function readOwnAuthEntries({ providerId, withValue = false } = {}) {
  try {
    const obj = JSON.parse(readFileSync(magpieAuthPath(), 'utf8'))
    const out = []
    for (const [key, val] of Object.entries(obj ?? {})) {
      // ① 先按 key 收窄：别人的槽**连值都不碰**
      if (!isOwnSlotKey(key)) continue
      if (providerId !== undefined && key !== providerId && !key.startsWith(`${providerId}#`)) continue
      if (typeof val !== 'object' || val === null) continue
      const channel = typeof val.channel === 'string' ? val.channel : ''
      // ② 不需要值时**不把 auth 放进返回对象**（凭据不经过不需要它的代码）
      out.push(withValue ? { key, channel, value: val } : { key, channel })
    }
    return out
  } catch {
    return []
  }
}

/**
 * 读 magpie 账号槽的摘要：`[{key, type, accountId, channel, expires}]`。
 * @param {string} [providerId] 省略 = 全部槽（页面快照用，按 `channel` 归属）
 */
export function readMagpieAuthSlots(providerId) {
  // ⚠️ 这里需要 expires（判「重复登录是否已过期」），所以对本插件自己的槽取 value。
  return readOwnAuthEntries({ providerId, withValue: true }).map(({ key, value: val, channel }) => {
    const expires = Number(val.expires)
    return {
      key,
      type: typeof val.type === 'string' ? val.type : '',
      accountId: typeof val.accountId === 'string' ? val.accountId : '',
      channel,
      expires: Number.isFinite(expires) && expires > 0 ? expires : undefined,
    }
  })
}

// ── OAuth 回调 / 登录载体地址收口（issue #3）─────────────────────────────
//
// 背景：headless Linux 服务器上跑 magpie 时，登录浏览器在**另一台机器**上，
// 回调写死 127.0.0.1 就永远等不到（回调落在用户那台机器的回环上）。
// 收口方式：所有渠道的「回调 host/port」都从本函数取 ——
//   · 默认仍是 127.0.0.1 + 随机端口（桌面端行为一格不变）；
//   · 该供应商的 options（magpie plugins.json 里那一条的 options）填了
//     oauthCallbackHost / oauthCallbackPort 时用用户的值。
// ⚠️ 渠道文件里**不要**再各自写死回调 host/port，一律走这里。

/** 回调默认 host（桌面端语义：只绑回环，局域网投不进伪造回调）。 */
export const OAUTH_CALLBACK_DEFAULT_HOST = '127.0.0.1'

/**
 * fetch 规范的「坏端口」清单 —— 浏览器与 Node fetch(undici) 都**拒发**这些端口
 * （ERR_UNSAFE_PORT / "bad port"）。随机端口（listen 0）有约千分之几的概率撞上
 * （Windows 临时端口段里的 5060/5061/6000/6566/6665–6669/6697 等）——
 * 撞上时回调永远进不来，登录只能干等超时。真机事故：全量测试偶发
 * 「fetch failed: bad port」，根因就是 OS 随机派了个禁用端口。
 */
const FETCH_BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  138, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
])

/** 是否 fetch 禁用端口（显式配置要拒，随机抽中要重抽）。 */
export const isFetchBadPort = (port) => FETCH_BAD_PORTS.has(Number(port))

/**
 * 起回调/载体页服务的统一 listen 包装：
 *   · 先挂 error 再 listen（EADDRINUSE 是异步 error 事件，不挂会崩进程）；
 *   · 只等端口绑定（毫秒级），不等用户登录；
 *   · 随机端口（redirect.port === 0）抽中 fetch 禁用端口时**关掉重抽**；
 *   · unref 选项给「登录窗口不该吊住宿主退出」的载体页渠道用。
 *
 * @param {import('node:http').Server} server
 * @param {{port: number, bindHost: string}} redirect oauthRedirect() 的返回值
 * @param {{unref?: boolean, attempts?: number}} [opts]
 * @returns {Promise<number>} 实际监听端口
 */
export async function listenCallbackPort(server, redirect, { unref = false, attempts = 12 } = {}) {
  for (let i = 0; ; i++) {
    const port = await new Promise((resolve, reject) => {
      let settled = false
      const onError = (error) => { if (!settled) { settled = true; reject(error) } }
      server.once('error', onError)
      server.listen(redirect.port, redirect.bindHost, () => {
        settled = true
        server.removeListener('error', onError)
        server.on('error', () => {})
        if (unref) server.unref()
        const addr = server.address()
        resolve(typeof addr === 'object' && addr !== null ? addr.port : 0)
      })
    })
    if (redirect.port !== 0 || !isFetchBadPort(port)) return port
    if (i >= attempts - 1) {
      throw new Error('回调端口连续抽中 fetch 禁用端口 —— 请用 oauthCallbackPort 指定一个固定端口')
    }
    await new Promise((resolve) => server.close(resolve))
  }
}

/**
 * 解析回调地址覆盖配置。
 *
 * @param {object} [options] 供应商 options（aggregate 工厂透传）。
 *   - `oauthCallbackHost`：本机**对外可达**的 host（IP 或域名，如 tailscale IP）。
 *     只填 host，不带协议/端口/路径；IPv6 要带方括号（`[fd7a:…::1]`）。
 *   - `oauthCallbackPort`：固定端口（1–65535）。不填 = 0 = 随机空闲端口。
 * @returns {{host: string, urlHost: string, port: number, bindHost: string, overridden: boolean}}
 *   - `host`：裸 host（IPv6 不带括号）；
 *   - `urlHost`：拼 URL 用的 host（IPv6 自动带括号）；
 *   - `port`：listen 用端口（0 = 随机，实际端口以 listening 事件为准）；
 *   - `bindHost`：server.listen 的绑定地址 —— 覆盖后必须绑 0.0.0.0，
 *     否则远端机器的回调进不来；默认仍绑回环；
 *   - `overridden`：是否启用了覆盖（渠道可据此在 instructions 里提示远程模式）。
 * @throws 配置非法时抛可读错误（宁可登录失败提示，也不静默用错地址）。
 *
 * ⚠️ 安全口径：覆盖后载体页/回调口对绑定网卡可达 —— OAuth 渠道仍有
 *    state/PKCE 回验兜底；载体页渠道请只在可信网络（如 tailscale）里启用。
 */
export function oauthRedirect(options = {}) {
  const rawHost = options?.oauthCallbackHost
  const rawPort = options?.oauthCallbackPort
  const hasHost = typeof rawHost === 'string' && rawHost.trim() !== ''
  const hasPort = rawPort !== undefined && rawPort !== null && String(rawPort).trim() !== ''
  if (!hasHost && !hasPort) {
    return { host: OAUTH_CALLBACK_DEFAULT_HOST, urlHost: OAUTH_CALLBACK_DEFAULT_HOST, port: 0, bindHost: OAUTH_CALLBACK_DEFAULT_HOST, overridden: false }
  }

  let host = OAUTH_CALLBACK_DEFAULT_HOST
  if (hasHost) {
    const trimmed = rawHost.trim()
    let parsed
    try {
      parsed = new URL(`http://${trimmed}`)
    } catch {
      throw new Error(`oauthCallbackHost 不是合法的 host：「${trimmed}」（只填 IP 或域名，IPv6 带方括号，不带协议/端口/路径）`)
    }
    if (parsed.username !== '' || parsed.password !== '' || parsed.port !== ''
      || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
      throw new Error(`oauthCallbackHost 只能填 host 本身：「${trimmed}」（不要带协议、端口、路径或查询串；端口用 oauthCallbackPort 单独填）`)
    }
    // ⚠️ Node 的 URL.hostname 对 IPv6 **保留方括号**（'[fd7a::1]'）——
    //    这里统一剥成裸地址，拼 URL 时再按 ':' 补括号，否则会出现双括号。
    host = parsed.hostname.replace(/^\[|\]$/g, '')
  }

  let port = 0
  if (hasPort) {
    const n = Number(rawPort)
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
      throw new Error(`oauthCallbackPort 必须是 0–65535 的整数（0 = 随机端口），收到：「${rawPort}」`)
    }
    if (isFetchBadPort(n)) {
      throw new Error(`oauthCallbackPort 不能是 ${n} —— 这是 fetch 规范的禁用端口（浏览器与 Node fetch 都拒发），换一个`)
    }
    port = n
  }

  // IPv6 拼 URL 必须带方括号（listen 用裸地址）
  const urlHost = host.includes(':') ? `[${host}]` : host
  return { host, urlHost, port, bindHost: '0.0.0.0', overridden: true }
}

// ── 回调粘贴中转（issue #3，仅覆盖模式启用）──────────────────────────────
//
// 远程场景下，用户在**自己机器**的浏览器里完成登录后，回调可能落在用户机器
// 的回环上（浏览器与 magpie 不在同一台机）。此时浏览器地址栏里仍留着完整的
// 回调 URL（code + state）—— 让用户复制整条地址粘贴回来，插件在服务端完成
// code 交换即可（社区 autoclaw 的回调结构证明了这条路可行：交换是纯服务端
// API 调用，不依赖回调落在哪台机器）。
// ⚠️ 只在 `oauthRedirect().overridden === true` 时挂载这些路由 —— 桌面默认
//    模式一个字节都不变（自动回调路在覆盖模式下也照常并行可用）。

/** HTML 转义（中转页把登录 URL 塞进 href / 文本，& 等字符必须转义）。 */
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
}

/**
 * 渲染「登录 + 粘贴回调」中转页（GET /relay）。
 * 页面只用相对路径 fetch（/paste-callback），host 覆盖透明生效。
 *
 * @param {{displayName: string, loginUrl: string}} opts
 */
export function renderCallbackRelayPage({ displayName, loginUrl }) {
  const name = escapeHtml(displayName)
  const href = escapeHtml(loginUrl)
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${name} 登录中转</title></head>
<body style="font-family:system-ui,sans-serif;max-width:680px;margin:2rem auto;padding:0 1rem;line-height:1.7">
<h1 style="font-size:1.3rem">${name} 登录</h1>
<ol>
<li>打开登录页并完成登录：<a href="${href}" target="_blank" rel="noopener">${href}</a></li>
<li>如果登录后浏览器显示「无法访问 / 连接被拒绝」——说明回调落在了<b>你自己机器</b>上，这是正常的。
请把地址栏里的<b>完整地址</b>（含 http:// 与全部参数）复制下来，粘贴到下面：</li>
</ol>
<textarea id="cb" rows="3" style="width:100%;box-sizing:border-box;font-family:monospace" placeholder="http://127.0.0.1:端口/callback?code=...&amp;state=..."></textarea>
<p><button id="go" style="padding:.4rem 1.2rem">提交回调地址</button></p>
<p id="msg" style="color:#555"></p>
<script>
document.getElementById('go').addEventListener('click', async () => {
  const msg = document.getElementById('msg')
  msg.textContent = '校验中…'
  try {
    const r = await fetch('/paste-callback', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: document.getElementById('cb').value }),
    })
    const j = await r.json()
    msg.textContent = j.message || (j.ok ? '登录成功，可以关闭本页' : '失败')
    msg.style.color = j.ok ? '#0a7d32' : '#b00020'
    if (j.ok) document.getElementById('go').disabled = true
  } catch (e) { msg.textContent = '提交失败：' + e.message }
})
</script>
</body>
</html>`
}

/**
 * 解析用户粘贴的整条回调 URL。
 *
 * ⚠️ 只校验**路径**（state 校验留给调用方，各渠道口径不同）：不校验 host ——
 *    回调可能落在用户机器的 127.0.0.1 上，与覆盖 host 不同是**预期情形**。
 * @throws 空串 / 非法 URL / 路径不符时抛可读错误（粘贴错误不应终结登录会话，
 *         调用方 catch 后回报错误、允许再贴一次）。
 */
export function parsePastedCallbackUrl(raw, expectedPath) {
  const trimmed = String(raw ?? '').trim()
  if (trimmed === '') throw new Error('请粘贴完整的回调地址')
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('不是合法的 URL —— 请从浏览器地址栏复制完整地址（含 http:// 开头与全部参数）')
  }
  if (parsed.pathname !== expectedPath) {
    throw new Error(`这不是本次登录的回调地址（路径应为 ${expectedPath}）—— 请复制完成登录后跳转到的那个地址`)
  }
  return parsed
}

/**
 * ⚠️ v0.5.0 起**没有** `saveCredential` / `loadCredential` / `credentialPath`：
 *    插件不再往 magpie 的配置目录写任何凭据文件（PR #502 审核第 2 条）。
 *    账号只存 magpie 账号槽，凭据只在内存里流转（见 src/aggregate.mjs 的
 *    memoryCredentials）。

/**
 * 上游信封 `{code, message, data}`；`code === 0` 为成功。
 * 非 JSON 或 code 非 0 都抛出可读错误（不静默吞掉）。
 */
export async function parseEnvelope(response, what) {
  let parsed
  try {
    parsed = await response.json()
  } catch {
    throw new Error(`${what} 响应不是 JSON（HTTP ${response.status}）`)
  }
  const code = typeof parsed?.code === 'number' ? parsed.code : NaN
  if (code !== 0) {
    throw new Error(`${what} 失败：${parsed?.message ?? `HTTP ${response.status}`}`)
  }
  return parsed?.data
}

/** 未登录错误：带 signIn 标记，让 magpie 提示重新登录而不是报普通错。 */
export function notSignedIn(message) {
  return Object.assign(new Error(message), { signIn: 'expired' })
}

/** 「N 分钟 / N 小时 / N 天」的人类可读倒计时；非法/过去时刻给 undefined。 */
export function humanUntil(iso, nowMs = Date.now()) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return undefined
  const mins = Math.round((t - nowMs) / 60000)
  if (mins < 0) return undefined
  if (mins < 60) return `${mins} 分钟`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours} 小时`
  return `${Math.round(hours / 24)} 天`
}

/** 「X 后作废」拼进亮色主文本用（'过期'辅助行太浅看不清 —— 用户报障）。 */
export function untilText(iso, nowMs = Date.now()) {
  const t = humanUntil(iso, nowMs)
  return t === undefined ? undefined : `${t}后作废`
}

// ── 到期分档（滚动指针，用户 2026-10-25 定案）────────────────────────────
//
// 「临期」永远指向**最早到期的未耗尽桶**（FEFO 头 = 服务端正在扣的那桶），
// 它用完或过期后指针自动轮到下一桶。固定 15 天窗被否：两个桶 3 天/12 天
// 各一笔时只标最早的会瞒住另一笔，而最早 200 天后到期时标红是假警报。
// 指针方案无这两病：永远一个红桶、永远显示真实剩余天数（N 天如实可见）。

/**
 * 给桶列表分配到期档位（就地补 `band` 键）。
 *
 * @param buckets `{ expireMs?: number, remaining?: number, ... }[]`
 *   - `expireMs` 缺失/非法 = 永久桶（`band: '永久'`）；
 *   - `remaining <= 0` = 已耗尽（`band: '已耗尽'`，**不参与**指针）；
 *   - 其余按到期升序，**最早的一个** = `临期·N天`（N = 真实剩余天数），
 *     之后 = `长期`。
 */
export function assignExpiryBands(buckets, now = Date.now()) {
  const pointer = buckets
    .map((bucket, index) => ({ index, expireMs: bucket.expireMs, remaining: bucket.remaining }))
    .filter((b) => Number.isFinite(b.expireMs) && b.expireMs !== null
      && Number.isFinite(b.remaining) && b.remaining > 0)
    .sort((a, b) => a.expireMs - b.expireMs)[0]
  for (const bucket of buckets) {
    // ⚠️ 已耗尽判定**先于**永久判定：剩 0 且无到期的桶（如 AStudio 会员/购买池）
    //    应标「已耗尽」而不是「永久」—— 永久是"有额度且不过期"，剩 0 恰恰相反。
    if (!Number.isFinite(bucket.remaining) || bucket.remaining <= 0) {
      bucket.band = '已耗尽'
      continue
    }
    if (!Number.isFinite(bucket.expireMs) || bucket.expireMs === null) {
      bucket.band = '永久'
      continue
    }
    bucket.band = pointer !== undefined && bucket === buckets[pointer.index]
      ? `临期·${Math.ceil((bucket.expireMs - now) / 86_400_000)}天`
      : '长期'
  }
  return buckets
}

/**
 * 【新渠道必用】把「额度桶」一步变成 magpie 窗口数组（滚动指针全套）。
 *
 * 所有渠道的 usage() 都该走这里，别自己拼 window —— 手工拼漏了档位名，
 * `tests/expiry-bands-required.test.mjs` 会红。
 *
 * 入参 bucket：
 *   {
 *     label: string,          // 展示名（如 '每日赠送' / '积分包' / '会员积分'）
 *     remaining: number,      // 剩余量
 *     expireMs?: number,      // 到期毫秒；undefined = 永久
 *     poolTotal?: number,     // 该池总量（给 used% 用；缺省按 remaining 视为满额）
 *     expireRaw?: string,     // 原始到期串（取 MM-DD 显示用）
 *   }
 *
 * 出参：magpie window[]，每项 name 形如 `{label} · {临期·N天|长期|永久|已耗尽}`，
 *       display 形如 `剩余 {N}[ · MM-DD 到期]`，剩 0 的桶 aside 折叠。
 */
export function expiryBandedWindows(buckets, now = Date.now()) {
  assignExpiryBands(buckets, now)
  const windows = []
  for (const bucket of buckets) {
    const expiryShort = typeof bucket.expireRaw === 'string' && bucket.expireRaw !== ''
      ? String(bucket.expireRaw).replace(/^(\d{4})-(\d{2})-(\d{2}).*/, '$2-$3')
      : undefined
    // used%：有 poolTotal 按实际算，否则满额=0 / 剩0=100
    const used = Number.isFinite(bucket.poolTotal) && bucket.poolTotal > 0
      ? Math.max(0, Math.min(100, Math.round(((bucket.poolTotal - bucket.remaining) / bucket.poolTotal) * 100)))
      : (Number.isFinite(bucket.remaining) && bucket.remaining > 0 ? 0 : 100)
    windows.push({
      name: `${bucket.label} · ${bucket.band}`,
      used,
      // ⚠️ 刻意不挂 runsOutAt：档位名（临期·N天）+ display 绝对日期已够，
      //   多挂会多一行浅灰重复（AStudio/officeace 同款去重，用户报障过）。
      //
      // ⚠️⚠️ 但 **resetsAt 必须挂**（2026-10-31 真机）：它是「窗口什么时候结束」，
      //   magpie 的「剩余额度走势」靠它画**投影虚线**并把横轴伸到重置点。
      //   不带它的卡片只有一根空坐标轴（用户报障：「这卡片不对，没有虚线功能」），
      //   而 community 的 officeace-auth 每条窗口都带
      //   `resetsAt: new Date(expiresAt).toISOString()` —— 对照实证。
      //   与 runsOutAt 的区别：resetsAt 是窗口边界（画图用），runsOutAt 是
      //   「按当前速度什么时候用完」（会与档位名重复一行），只挂前者。
      ...(Number.isFinite(bucket.expireMs) ? { resetsAt: new Date(bucket.expireMs).toISOString() } : {}),
      ...(Number.isFinite(bucket.remaining) && bucket.remaining <= 0 ? { aside: true } : {}),
      display: `剩余 ${bucket.remaining}${expiryShort !== undefined ? ` · ${expiryShort} 到期` : ''}`,
    })
  }
  return windows
}

// ── 传输层重试（各渠道共用）────────────────────────────────────────────────

const sleep = (ms) => (ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)))

/**
 * 这个错误是不是**传输层**的（值得重发）。
 *
 * ⚠️ 只认网络/证书/DNS 这类「包没到或被切断」的错误；HTTP 业务错误（4xx/5xx
 *    被 fetch 正常解析成 Response）**不在此列** —— 那些重发只会原样失败、
 *    还会掩盖真因（额度/鉴权/限流各 有各 的处置）。
 * ⚠️ 追到 `cause` 链（Node 的 fetch 把真错误包在 `fetch failed` 外面）。
 */
export function isTransportError(error) {
  const seen = new Set()
  let current = error
  for (let depth = 0; current !== null && current !== undefined && depth < 6; depth += 1) {
    if (seen.has(current)) break
    seen.add(current)
    if (typeof current !== 'object') break
    const name = typeof current.name === 'string' ? current.name : ''
    const message = typeof current.message === 'string' ? current.message.toLowerCase() : ''
    const code = typeof current.code === 'string' ? current.code : ''
    if (name.startsWith('UND_ERR_') || code.startsWith('UND_ERR_')) return true
    if (code.startsWith('SELF_SIGNED_CERT') || code.startsWith('CERT_')
      || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return true
    if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EPIPE'
      || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return true
    if (message.includes('fetch failed')) return true
    if (message.includes('socket hang up') || message.includes('terminated')
      || message.includes('other side closed')) return true
    current = current.cause
  }
  return false
}

/** 传输级重试：默认 2 次、400ms 指数退避；abort 绝不重试；耗尽抛最后的错误。 */
export async function fetchWithRetry(fetchOnce, signal, retries = 2) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchOnce()
    } catch (error) {
      lastError = error
      if (signal?.aborted === true) throw error
      if (!isTransportError(error)) throw error
      if (attempt === retries) break
      await sleep(400 * 2 ** attempt)
    }
  }
  throw lastError
}
