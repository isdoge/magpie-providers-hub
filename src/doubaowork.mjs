// 豆包工作（Doubao Work）渠道 —— 供应商 id `hub-doubaowork`，显示名「豆包工作」。
//
// ⚠️ 归属：本文件是 **移植**，不是原创。
//   上游实现：miaocell/magpie-doubao-work-auth（MIT，
//   Copyright (c) 2026 Doubao Work Magpie plugin contributors）。
//   移植范围：会话/请求参数（lib/session.mjs）、chat 全流程（lib/chat.mjs +
//   protocol/stream/responses/models）、额度（lib/quota.mjs）、签到（lib/checkin.mjs）、
//   临时会话清理（lib/lease.mjs）、错误映射（lib/errors.mjs）、Cookie 解析
//   （lib/cookie-import.mjs）。协议纯函数拆在 src/doubaowork-protocol.mjs。
//   本仓库新增：hub「一渠道一供应商」形态的接线、本地载体页粘贴登录、
//   apiAuth 粘贴兜底、滚动指针额度分档（expiryBandedWindows）。
//
// ## 与上游实现的差异（都是 hub 规矩逼出来的，逐条写明）
//
// 1. **登录三条路**：① 浏览器登录免粘贴（CDP 读 Cookie，移植上游 lib/cdp.mjs；
//    桌面拉一次性窗口 = magicrew 同款 spawn 例外，2026-11-17 用户批准；
//    无界面 Linux 经 options.doubaoCdpHost/Port 读**外部浏览器**的调试端口，
//    只读不拉窗口，ws 地址按可达 host 重写）；② 本地载体页粘贴 Cookie；
//    ③ magpie 原生 apiAuth 粘贴兜底。上游「读桌面客户端 DPAPI」那条**不移植**
//    （敏感面，等另行批准）。
// 2. **不落盘**：上游的 DPAPI 保管库（vault.mjs）与临时会话清理记录（落
//    %LOCALAPPDATA%）都不移植 —— 凭据只进 magpie 账号槽 + 本进程内存；清理记录
//    改内存 Map。**副作用**：进程被杀时未清理的临时会话会留在豆包侧边栏
//    （上游靠磁盘记录下次补删，这里做不到），如实记录不掩饰。
// 3. **chat 不挂硬超时**：上游 request 统一 180s 超时；AGENTS.md 规定 chat 只透传
//    调用方 signal。辅助请求（身份/launch/额度/签到/目录/会话清理）保留短超时。
// 4. **签到语义对齐 hub**：今天已签 → claimed（上游报 done；AGENTS.md 第 2 条
//    要求 claimed）。签到**纯只读**（上游 0.2.0 起同样只读：领取接口对未被投放
//    活动的账号恒回 biz_error 3「确认中」，纯 HTTP 绕不过，不发注定失败的写请求）。
// 5. **图片明确拒绝**：上游上传入口要前端 a_bogus 签名（纯 HTTP 造不出），
//    本就一律报错；这里同样报 400 清楚说明，不静默丢图、不移植死代码。
// 6. **Responses 协议按 body 形状检测**：上游按 URL pathname 判 /responses；
//    hub 的 loader 只传 body 不传路径 → 有 input 无 messages 即折叠。
// 7. **无续期端点**（诚实标记）：登录态是网站 Cookie，没有 refresh_token，
//    refresh 直接 throw；服务端 710012000/710012001 → 401 + X-Magpie-Sign-In。
//
// ## 协议总览（上游真机实测）
//
// ```
// 基址 https://www.doubao.com（桌面参数 aid=real_aid=497858 —— 不是 1044603，
//      用错会落到另一条产品线拿不到工作版菜单；device_platform=web、
//      version_code=20800、web_platform=browser、samantha_web=1、use-olympus-account=1）
//   GET  /passport/account/info/v2/            身份（user_id_str / screen_name）
//   POST /alice/user/launch                    bot_id / country / config.web_id / ttwid / 活动组
//   POST /chat/completion                      对话（SSE 补丁流，非 OpenAI 兼容）
//   POST /alice/slot/action_bar_v3/brief_list  模型菜单（基本只回 entry_list → 基线兜底）
//   POST /alice/commerce/sale/subscription/quota/summary/   额度三池
//   POST /alice/commerce/sale/subscription/overview/        套餐名
//   POST /alice/ug/campaign/v3/detail/         签到状态（只读）
//   POST /im/chain/recent_conv                 认领临时会话（cmd 3200）
//   POST /im/conversation/batch_del_user_conv  删除临时会话（cmd 4171）
// ```
//
// 业务失败恒 HTTP 200，成败读 body 的 code；同账号对话串行（风控保守）；
// 每次对话 = 一个临时会话（conversation_type=3），结束即删，不塞满用户侧边栏。

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { oauthRedirect, listenCallbackPort, expiryBandedWindows, fetchWithRetry, notSignedIn, isFetchBadPort } from './shared.mjs'
import { browserHooks } from './doubaowork-browser.mjs'
import {
  ProviderError, upstreamError,
  parseCookieHeader, cookiesFromHeader, clientInfoFromCookies,
  prepareRequest, upstreamBody, decodeReply, estimateTokens,
  readDoubao, responsesToChat, chatToResponses, responsesEventStream,
  parseModels, fallbackModels, selectModel,
  quotaNum, quotaIsoMs, CAMPAIGN_SCENE, CHECKIN_DETAIL_PATH, campaignGroup, readCheckin,
} from './doubaowork-protocol.mjs'

export const CHANNEL_ID = 'doubaowork'
export const DISPLAY_NAME = '豆包工作'

const BASE = 'https://www.doubao.com'

/**
 * 桌面端固定参数（上游实测照抄）。
 * ⚠️ aid 必须 497858（网页/客户端共用的对话应用）；1044603 是另一条产品线。
 */
const DESKTOP_PARAMS = {
  aid: '497858',
  real_aid: '497858',
  device_platform: 'web',
  doubao_device_platform: 'web',
  version_code: '20800',
  language: 'zh',
  samantha_web: '1',
  'use-olympus-account': '1',
  pkg_type: 'release_version',
  web_platform: 'browser',
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'

/** 没有客户端时用的 bot_id 兜底值（豆包工作桌面端的默认助手，服务端接受）。 */
const FALLBACK_BOT = '7338286299411103781'

/** 辅助请求（身份/额度/签到/目录/清理）的超时。chat 本体**不挂**硬超时。 */
const AUX_TIMEOUT_MS = 60_000
const CLEANUP_TIMEOUT_MS = 30_000
const LOGIN_WINDOW_MS = 10 * 60 * 1000

// ── 极简 cookie jar（移植 lib/session.mjs 的 Jar；只在内存，绝不落盘）────

class Jar {
  constructor() { this.cookies = new Map() }
  static from(cookies) {
    const jar = new Jar()
    for (const cookie of cookies) {
      jar.cookies.set(`${cookie.domain}|${cookie.path || '/'}|${cookie.name}`, { ...cookie })
    }
    return jar
  }
  headerFor(url) {
    const host = new URL(url).hostname
    const now = Math.floor(Date.now() / 1000)
    const parts = []
    for (const cookie of this.cookies.values()) {
      const domain = cookie.domain.replace(/^\./, '')
      if (host !== domain && !host.endsWith(`.${domain}`)) continue
      if (cookie.expires && cookie.expires < now) continue
      parts.push(`${cookie.name}=${cookie.value}`)
    }
    return parts.join('; ')
  }
  /** 吸收响应的 set-cookie（ttwid 等会轮换）——只更新内存里这份。 */
  absorb(url, setCookies) {
    const host = new URL(url).hostname
    for (const raw of setCookies) {
      const [pair, ...attrs] = raw.split(';')
      const index = pair.indexOf('=')
      if (index < 0) continue
      const name = pair.slice(0, index).trim()
      const value = pair.slice(index + 1).trim()
      if (!name) continue
      const cookie = { name, value, domain: host, path: '/', expires: 0, secure: true }
      for (const attr of attrs) {
        const [k, v = ''] = attr.split('=')
        const key = k.trim().toLowerCase()
        if (key === 'domain') cookie.domain = v.trim().replace(/^\./, '')
        else if (key === 'path') cookie.path = v.trim() || '/'
        else if (key === 'max-age') cookie.expires = Math.floor(Date.now() / 1000) + Number(v)
        else if (key === 'expires') { const t = Date.parse(v); if (!Number.isNaN(t)) cookie.expires = Math.floor(t / 1000) }
      }
      this.cookies.set(`${cookie.domain}|${cookie.path}|${cookie.name}`, cookie)
    }
  }
}

// ── 会话（移植 DesktopSession；凭据来源从「保管库/客户端」改成「粘贴 Cookie」）──

class DoubaoSession {
  constructor(credential) {
    this.credential = credential
    this.readyAt = 0
    // 串行化：同一账号同一时刻只跑一个对话请求（并发打上游易触发风控，
    // 也会让会话清理错乱）。锁只覆盖「建会话 + 拿到响应头」，读流不占锁。
    this.queue = Promise.resolve()
  }

  async exclusive(task) {
    const run = this.queue.then(task)
    // 无论成败都放行下一个，否则一次失败会把队列永久堵死
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  async ready(signal) {
    signal?.throwIfAborted()
    if (Date.now() - this.readyAt < 60_000) return
    this.pending ??= this.initialize().finally(() => { this.pending = undefined })
    await this.pending
    signal?.throwIfAborted()
  }

  async initialize() {
    const cookies = cookiesFromHeader(this.credential.cookie)
    this.jar = Jar.from(cookies)
    this.clientInfo = clientInfoFromCookies(cookies)

    const identity = await this.json('/passport/account/info/v2/', undefined, undefined, {
      account_sdk_source: 'web', sdk_version: '2.2.5',
    })
    const uid = String(identity.user_id_str ?? identity.user_id ?? '')
    if (!uid || uid === '0' || identity.is_visitor_account) {
      throw new ProviderError('豆包工作的登录态已失效，请重新登录 doubao.com 后粘贴新的 Cookie。', 401, 'session_expired', { signIn: 'expired' })
    }
    if (this.credential.uid && this.credential.uid !== uid) {
      throw new ProviderError('这份 Cookie 属于另一个豆包账号，与绑定账号不符；请重新粘贴对应账号的 Cookie。', 401, 'account_changed', { signIn: 'expired' })
    }
    const launch = await this.json('/alice/user/launch', {})
    const bot = String(launch.assistant_bot_id ?? '')
    // 粘贴 Cookie 登录时 launch 可能不带 bot_id，用约定的桌面端兜底值
    this.bot = /^[1-9]\d*$/.test(bot) ? bot : (this.credential.bot || FALLBACK_BOT)

    this.uid = uid
    this.launch = launch
    this.country = launch.country || ''
    this.name = identity.screen_name || identity.name || ''

    // 设备标识：粘贴 Cookie 时这些字段多半是空的，launch 的 config 里带着
    // 服务端认可的值，用它补齐 —— 比伪造一个稳定得多（上游实测）。
    const launchWebId = String(launch.config?.web_id ?? launch.web_id ?? '')
    const launchTtwid = String(launch.config?.ttwid ?? launch.ttwid ?? '')
    if (/^[1-9]\d*$/.test(launchWebId)) {
      this.clientInfo ??= {}
      if (!this.clientInfo.webId) this.clientInfo.webId = launchWebId
      if (!this.clientInfo.deviceId) this.clientInfo.deviceId = launchWebId
      if (!this.clientInfo.teaUuid) this.clientInfo.teaUuid = launchWebId
    }
    if (launchTtwid) {
      this.clientInfo ??= {}
      this.clientInfo.ttwid = launchTtwid
    }

    this.readyAt = Date.now()
  }

  buildUrl(path, params = {}) {
    const url = new URL(path, BASE)
    if (url.origin !== BASE) throw new Error('请求主机不匹配。')
    const client = this.clientInfo
    url.search = new URLSearchParams({
      ...DESKTOP_PARAMS,
      ...(client ? {
        web_id: client.webId, device_id: client.deviceId, tea_uuid: client.teaUuid,
        fp: `verify_${client.deviceId}`,
        tz_name: Intl.DateTimeFormat().resolvedOptions().timeZone,
      } : {}),
      ...(this.country ? { region: this.country, sys_region: this.country } : {}),
      ...params,
    }).toString()
    return url
  }

  /**
   * 发一个请求。⚠️ chat 走这里时 signal 原样透传、**不挂硬超时**（AGENTS.md）；
   * 辅助请求由 json()/im() 自己组合短超时。
   */
  async request(path, body, signal, params = {}, extraHeaders = {}) {
    const url = this.buildUrl(path, params)
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      ...(signal !== undefined ? { signal } : {}),
      headers: {
        'Content-Type': 'application/json',
        'Agw-Js-Conv': 'str',
        Origin: BASE,
        Referer: `${BASE}/`,
        'User-Agent': UA,
        Cookie: this.jar.headerFor(url.href),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const setCookies = response.headers.getSetCookie?.() ?? []
    if (setCookies.length) this.jar.absorb(url.href, setCookies)
    if (!response.ok) {
      const type = response.headers.get('content-type') || ''
      const payload = type.includes('json') ? await response.json().catch(() => ({})) : { message: (await response.text()).slice(0, 300) }
      const error = upstreamError(payload, response.status)
      if (error.signIn) this.readyAt = 0
      throw error
    }
    return response
  }

  /** JSON 信封：业务失败恒 HTTP 200，code !== 0 即错。辅助请求带短超时 + 传输重试。 */
  async json(path, body, signal, params) {
    const timeout = AbortSignal.timeout(AUX_TIMEOUT_MS)
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    const response = await fetchWithRetry(() => this.request(path, body, requestSignal, params), requestSignal)
    const text = await response.text()
    let result
    try { result = JSON.parse(text) }
    catch { throw new ProviderError(`豆包返回的不是 JSON：${text.slice(0, 200)}`, 502, 'invalid_response') }
    if ((result.code !== undefined && result.code !== 0) || (result.message === 'error')) {
      const payload = result.data?.error_code !== undefined ? result.data : result
      const error = upstreamError(payload)
      if (error.signIn) this.readyAt = 0
      throw error
    }
    if (!result.data) throw new ProviderError('豆包响应缺少 data 字段。', 502, 'invalid_response')
    return result.data
  }

  /** 模型菜单（按账号缓存 60 秒；在线拿不到就用内置基线；失败后 10 分钟不重试）。 */
  async models(signal, force = false) {
    await this.ready(signal)
    if (!force && this.catalog && Date.now() - this.catalogAt < 60_000) return this.catalog
    if (!force && this.modelsFailedAt && Date.now() - this.modelsFailedAt < 600_000 && this.catalog) {
      return this.catalog
    }
    let catalog
    try {
      const payload = await this.json('/alice/slot/action_bar_v3/brief_list', {
        language_code: 'zh',
        bot_id: this.bot,
      }, signal)
      catalog = parseModels(payload)
    } catch (error) {
      if (error?.signIn) throw error
      this.modelsFailedAt = Date.now()
    }
    if (!catalog) catalog = fallbackModels()
    this.catalog = catalog
    this.catalogAt = Date.now()
    return catalog
  }
}

// ── 会话缓存（纯内存，按 Cookie 键控；进程结束即消失）──────────────────

const sessions = new Map()

function sessionFor(credential) {
  const cookie = typeof credential?.cookie === 'string' ? credential.cookie.trim() : ''
  if (cookie === '') throw notSignedIn(`未登录：请先登录 ${DISPLAY_NAME}（粘贴 doubao.com 的 Cookie）`)
  let session = sessions.get(cookie)
  if (!session) {
    session = new DoubaoSession({ ...credential, cookie })
    sessions.set(cookie, session)
  }
  return session
}

// ── 错误 → 原始 Response（chat 绝不 throw；hub 形状 type: provider_error）──

function errorResponse(error) {
  const isProvider = error instanceof ProviderError
  // notSignedIn 等非 ProviderError 但带 signIn 标记的，也按 401 处理
  const status = isProvider ? error.status : (error?.signIn ? 401 : 502)
  const code = isProvider ? error.code : (error?.signIn ? 'sign_in_required' : 'plugin_error')
  const headers = { 'Content-Type': 'application/json; charset=utf-8' }
  // 只有登录类错误才让 magpie 标记账号（验证码/限流不标记）
  if (error?.signIn) headers['X-Magpie-Sign-In'] = error.signIn
  return new Response(JSON.stringify({
    error: { type: 'provider_error', code, message: error?.message || '插件内部错误' },
  }), { status, headers })
}

// ── 临时会话清理（移植 lib/lease.mjs；记录改内存，不落盘）────────────────
//
// 豆包每问一次产生一个会话。我们发的是临时会话（conversation_type=3），
// 请求结束就删，靠 local_conversation_id 在历史列表里认领自己的那条，
// 避免误删用户自己的对话。
// ⚠️ 与上游的差异：清理记录只在内存 —— 进程被杀时孤儿会话无法补删（见文件头）。

const LOCAL_ID = /^local_[a-f0-9]{32}$/
/** uid → Map(localId → record)：上次清理失败留下的记录，下次请求前补做。 */
const orphanRecords = new Map()
/** 正在飞行中的会话（补删时跳过，避免删掉并发请求的会话）。 */
const activeLeases = new Set()

/** 豆包的 IM 接口信封：cmd + sequence_id + uplink_body。 */
async function im(session, path, cmd, key, body) {
  const response = await session.request(
    path,
    { cmd, sequence_id: randomUUID(), channel: 2, version: '1', uplink_body: { [key]: body } },
    AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
    {},
    { 'Content-Type': 'application/json; encoding=utf-8' },
  )
  const data = await response.json()
  if (data.status_code !== 0) {
    throw new ProviderError(`豆包会话接口失败：${data.status_desc || '未知错误'}（${data.status_code}）`, 502, 'conversation_api_error')
  }
  if (!data.downlink_body) throw new ProviderError('豆包会话接口缺少响应数据。', 502, 'invalid_conversation_response')
  return data.downlink_body
}

async function findOwned(session, record) {
  let cursor = '0'
  const seen = new Set()
  for (let page = 0; page < 100; page++) {
    const data = await im(session, '/im/chain/recent_conv', 3200, 'pull_recent_conv_chain_uplink_body', {
      api_version: 1,
      conv_version: Number(cursor),
      direction: cursor === '0' ? 3 : 1,
      limit: 50,
      message_count_per_conv: 0,
      option: { not_need_message: true, need_complete_conversation: true, need_coco_conversation: true, need_coco_bot: true },
    })
    const chain = data.pull_recent_conv_chain_downlink_body
    if (String(chain?.user_id ?? '') !== String(session.uid)) {
      throw new ProviderError('临时会话清理的账号校验失败。', 401, 'account_changed')
    }
    if (!Array.isArray(chain?.cells) || typeof chain.has_more !== 'boolean') {
      throw new ProviderError('豆包历史列表格式发生变化。', 502, 'invalid_conversation_response')
    }
    for (const cell of chain.cells) {
      const conversation = cell.conversation
      if (conversation?.conv_extra?.local_conversation_id !== record.localId) continue
      if (String(conversation.bot_id) !== String(record.bot) || !/^[1-9]\d*$/.test(String(conversation.conversation_id))) {
        throw new ProviderError('临时会话归属校验失败。', 502, 'conversation_ownership_error')
      }
      return String(conversation.conversation_id)
    }
    if (!chain.has_more) return undefined
    cursor = String(chain.next_conv_version)
    if (!/^[1-9]\d*$/.test(cursor) || seen.has(cursor)) {
      throw new ProviderError('豆包历史列表分页游标无效。', 502, 'invalid_conversation_response')
    }
    seen.add(cursor)
  }
  return undefined
}

async function removeOwned(session, record) {
  const id = record.conversationId || await findOwned(session, record)
  if (!id) return false
  const data = await im(session, '/im/conversation/batch_del_user_conv', 4171, 'batch_delete_user_conversation_uplink_body', {
    conversation_id: [id], delete_all: false, conversation_type: 3,
  })
  const result = data.batch_delete_user_conversation_downlink_body?.result
  if (!result || typeof result[id] !== 'boolean') {
    throw new ProviderError('豆包未确认临时会话的删除结果。', 502, 'conversation_cleanup_failed')
  }
  return true
}

class ConversationLease {
  constructor(session, body) {
    if (!session.uid) throw new Error('临时会话必须绑定已验证的账号。')
    this.session = session
    this.record = {
      localId: body.client_meta.local_conversation_id,
      bot: session.bot,
      uid: session.uid,
      startedAt: Date.now(),
    }
    if (!LOCAL_ID.test(this.record.localId)) throw new Error('临时会话标识格式异常。')
    this.started = false
  }

  async begin() {
    // 补做上次清理失败的孤儿记录（只在内存能追到的范围内）
    const orphans = orphanRecords.get(this.record.uid)
    if (orphans) {
      for (const [localId, record] of [...orphans]) {
        if (activeLeases.has(localId)) continue
        try {
          await removeOwned(this.session, record)
          orphans.delete(localId)
        } catch { /* 下次再补 */ }
      }
    }
    activeLeases.add(this.record.localId)
    this.started = true
  }

  async observe(event, data) {
    if (event !== 'SSE_ACK') return
    const meta = data.ack_client_meta
    if (meta?.local_conversation_id !== this.record.localId) {
      throw new ProviderError('豆包确认的临时会话与本次请求不匹配。', 502, 'conversation_ownership_error')
    }
    const id = String(meta.conversation_id ?? '')
    if (!/^[1-9]\d*$/.test(id)) return
    if (this.record.conversationId && this.record.conversationId !== id) {
      throw new ProviderError('豆包返回了多个临时会话标识。', 502, 'conversation_ownership_error')
    }
    this.record.conversationId = id
  }

  async finish(originalError) {
    if (!this.started) return
    this.cleanup ??= (async () => {
      try {
        await removeOwned(this.session, this.record)
      } catch (cause) {
        // 清理失败留下记录下次补；不该把已经拿到的回复变成错误
        let orphans = orphanRecords.get(this.record.uid)
        if (!orphans) { orphans = new Map(); orphanRecords.set(this.record.uid, orphans) }
        orphans.set(this.record.localId, this.record)
        if (!originalError) throw new ProviderError(`临时会话清理失败：${cause.message}`, 502, 'conversation_cleanup_failed', { cause })
      } finally {
        activeLeases.delete(this.record.localId)
      }
    })()
    return this.cleanup
  }
}

// ── chat（移植 lib/chat.mjs；body 由 hub loader 解析好传入）──────────────

async function chat(credential, { body, signal } = {}) {
  const abort = new AbortController()
  // ⚠️ 只透传调用方 signal + 自己的取消闸，**不挂硬超时**（AGENTS.md）
  const requestSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
  let lease

  try {
    // hub 的 loader 不传 URL 路径：按 body 形状判 Responses 协议（有 input 无 messages）
    const isResponses = body !== null && typeof body === 'object'
      && body.input !== undefined && body.messages === undefined
    const prepared = prepareRequest(isResponses ? responsesToChat(body) : body)

    const session = sessionFor(credential)
    await session.ready(requestSignal)
    const catalog = await session.models(requestSignal)
    const selected = selectModel(catalog, prepared.request)

    // 图片：上游上传入口要前端 a_bogus 签名，纯 HTTP 侧造不出来 —— 明确拒绝
    if (prepared.images?.length) {
      throw new ProviderError(
        '豆包工作这条路暂时发不了图片：上传入口需要前端生成的 a_bogus 签名，纯 HTTP 侧造不出来。需要识图请换一个支持图片的供应商。',
        400, 'image_not_supported',
      )
    }

    const upstream = upstreamBody(session, prepared, selected)

    // 串行：锁只覆盖「建会话 + 拿到响应头」，读流时不占锁（长回复不堵队列）
    lease = new ConversationLease(session, upstream)
    const response = await session.exclusive(async () => {
      await lease.begin()
      return session.request('/chat/completion', upstream, requestSignal, {}, { Accept: 'text/event-stream' })
    })

    async function* tracked() {
      let failure
      try {
        yield* readDoubao(response, requestSignal, (event, data) => lease.observe(event, data))
      } catch (error) {
        failure = error
        throw error
      } finally {
        await lease.finish(failure)
      }
    }

    const source = tracked()
    const meta = { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000), model: prepared.request.model }

    if (!prepared.request.stream) {
      let content = ''
      let reasoning = ''
      for await (const delta of source) {
        content += delta.content ?? ''
        reasoning += delta.reasoning_content ?? ''
      }
      const message = decodeReply(content, prepared)
      if (reasoning) message.reasoning_content = reasoning
      const promptTokens = estimateTokens(prepared.prompt)
      const outputTokens = estimateTokens(content + reasoning)
      const completion = {
        id: meta.id,
        object: 'chat.completion',
        created: meta.created,
        model: meta.model,
        choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: outputTokens,
          total_tokens: promptTokens + outputTokens,
        },
      }
      if (isResponses) return Response.json(chatToResponses(completion, meta.model))
      return Response.json(completion)
    }

    if (isResponses) {
      const finalUsage = (text) => {
        const completionTokens = estimateTokens(text)
        return { input_tokens: estimateTokens(prepared.prompt), output_tokens: completionTokens, total_tokens: estimateTokens(prepared.prompt) + completionTokens }
      }
      return new Response(responsesEventStream(meta, source, finalUsage), {
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
      })
    }

    return sseResponse(source, meta, prepared, abort)
  } catch (error) {
    abort.abort()
    try { await lease?.finish(error) }
    catch (cleanupError) { return errorResponse(cleanupError) }
    return errorResponse(error)
  }
}

/** chat 的流式输出（OpenAI SSE 形状；工具/结构化先缓冲再一次性发）。 */
function sseResponse(source, meta, prepared, abort) {
  const encoder = new TextEncoder()
  let canceled = false
  const iterator = source[Symbol.asyncIterator]()
  const promptTokens = estimateTokens(prepared.prompt)
  let output = ''
  const finalUsage = () => {
    const completionTokens = estimateTokens(output)
    return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
  }

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        // 工具调用和结构化输出需要完整正文才能解析，先缓冲
        const buffered = prepared.tools || prepared.structured
        if (buffered) {
          let content = ''
          let reasoning = ''
          let done = false
          while (!done) {
            const next = await iterator.next()
            if (next.done) { done = true; break }
            content += next.value.content ?? ''
            reasoning += next.value.reasoning_content ?? ''
          }
          if (canceled) return
          if (reasoning) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk(meta, { reasoning_content: reasoning }))}\n\n`))
          }
          const message = decodeReply(content, prepared)
          const delta = { role: 'assistant' }
          if (message.content) delta.content = message.content
          if (message.tool_calls) delta.tool_calls = message.tool_calls.map((call, index) => ({ index, ...call }))
          output = content + reasoning
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk(meta, delta, message.tool_calls ? 'tool_calls' : 'stop', finalUsage()))}\n\n`))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
          return
        }

        const next = await iterator.next()
        if (canceled) return
        if (next.done) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk(meta, {}, 'stop', finalUsage()))}\n\n`))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
          return
        }
        if (next.value.content) output += next.value.content
        if (next.value.reasoning_content) output += next.value.reasoning_content
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk(meta, next.value))}\n\n`))
      } catch (error) {
        abort.abort()
        if (canceled) return
        if (error instanceof ProviderError) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: error.message, type: 'provider_error', code: error.code } })}\n\n`))
          controller.close()
        } else controller.error(error)
      }
    },
    async cancel() {
      canceled = true
      abort.abort()
      try { await iterator.return?.() } catch (error) {
        if (!['AbortError', 'TimeoutError'].includes(error?.name)) throw error
      }
    },
  })
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
  })
}

function chunk(meta, delta, finish = null, usage) {
  const out = { ...meta, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] }
  if (usage) out.usage = usage
  return out
}

// ── 目录（基线兜底 + 在线刷新；转成 hub 的模型形状）─────────────────────

/**
 * 内部目录 → magpie 模型条目。
 * ⚠️ cost 一律 0：豆包给的是相对订阅的扣费倍率，与「每百万 token 价格」量纲
 *    不同，填了就是编造价格。倍率放 magpie 原生 rate 字段（界面渲染成徽章）。
 */
function hubModels(catalog) {
  return Object.fromEntries([...catalog].map(([id, model]) => {
    const context = model.context || 256_000
    const entry = {
      name: model.name,
      limit: { context, output: 0 },
      tool_call: true,
      capabilities: {
        temperature: false,
        reasoning: Object.keys(model.levels).length > 0,
        attachment: false,
        toolcall: true,
        input: { text: true, image: false, audio: false, video: false, pdf: false },
        output: { text: true, image: false, audio: false, video: false, pdf: false },
        interleaved: false,
      },
      options: {},
      headers: {},
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      variants: Object.fromEntries(Object.keys(model.levels).map((effort) => [effort, { reasoningEffort: effort }])),
      status: 'active',
      release_date: '',
    }
    if (model.free) entry.rate = 0
    else if (Number.isFinite(model.rate)) entry.rate = model.rate
    return [id, entry]
  }))
}

/** 兜底目录（对象！聚合层直接 Object.keys() 取数量）。 */
const FALLBACK_MODELS = hubModels(fallbackModels())

async function catalog(credential) {
  const session = sessionFor(credential)
  const models = await session.models()
  return hubModels(models)
}

// ── 额度（三池 → 滚动指针分档；AGENTS.md 第 1 条必走 expiryBandedWindows）──

const SECTIONS = [
  ['window_limit_section', '订阅额度'],
  ['incentive_quota_section', '活动赠送'],
  ['enterprise_window_limit_section', '企业额度'],
]

/** 签到状态做成一条纯展示行（只读；领取限死在电脑版客户端）。 */
function checkinDisplayRow(state) {
  if (!state?.found) return undefined
  const note = state.claimed
    ? `今日已签${state.streak ? ` · 连续 ${state.streak} 天` : ''}`
    : `今日未签${state.points !== undefined ? ` · 可领 ${state.points} 额度` : ''}`
  return {
    name: `每日签到（${note}）`,
    used: 0,
    display: state.claimed ? '已领取' : '需在豆包电脑版领取',
  }
}

async function usage(credential) {
  let session
  try {
    session = sessionFor(credential)
    await session.ready()
  } catch (error) {
    return [{
      name: DISPLAY_NAME,
      used: 0,
      display: error?.signIn ? '登录已失效，请重新粘贴 Cookie' : `额度查询失败：${String(error?.message || error).slice(0, 240)}`,
    }]
  }

  // 两个接口分别取：任一瞬时失败不该让整块额度变成「暂时无法获取」（上游同款重试）
  const settle = async (path, body) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await session.json(path, body) }
      catch (error) {
        if (error?.signIn) throw error
        if (attempt === 1) return undefined
        await new Promise((resolve) => setTimeout(resolve, 400))
      }
    }
    return undefined
  }

  try {
    const summary = await settle('/alice/commerce/sale/subscription/quota/summary/', { product_line: 'membership' })
    if (!summary) {
      return [{ name: DISPLAY_NAME, used: 0, display: '额度汇总暂时取不到，稍后会自动重试' }]
    }
    // overview 只提供套餐名，拿不到就用 summary 里的订阅信息兜底
    await settle('/alice/commerce/sale/subscription/overview/', { product_line: 'membership' })

    // 签到状态一并带上（缓存 10 分钟 —— 签到按天变化，不必每次刷额度都打上游）
    let checkinState = session.checkinCache
    if (!checkinState || Date.now() - (session.checkinAt ?? 0) > 600_000) {
      try {
        const group = campaignGroup(session.launch) || CAMPAIGN_SCENE
        checkinState = readCheckin(await session.json(CHECKIN_DETAIL_PATH, { campaign_group_code: group }))
        session.checkinCache = checkinState
        session.checkinAt = Date.now()
      } catch { /* 签到状态取不到不影响额度 */ }
    }

    const buckets = []
    const plainRows = []
    for (const [key, label] of SECTIONS) {
      const section = summary[key]
      if (!(section?.window_limit_groups?.length > 0)) continue
      for (const group of section.window_limit_groups) {
        const limits = group.window_limits || []
        for (const [index, window] of limits.entries()) {
          const amount = quotaNum(window.used_amount)
          const limit = quotaNum(window.total_amount)
          const name = `${group.feature_group_name || label}${limits.length > 1 ? ` · 窗口${window.window_type ?? index + 1}` : ''}`
          if (amount === undefined || limit === undefined) {
            // 服务端没给计数就不编数字（纯展示行）
            plainRows.push({ name, used: 0, display: '服务端未提供计数' })
            continue
          }
          const expireMs = quotaIsoMs(window.end_time)
          buckets.push({
            label: name,
            remaining: Math.max(0, limit - amount),
            poolTotal: limit,
            expireMs,
            expireRaw: expireMs !== undefined ? new Date(expireMs).toISOString() : '',
            usedAmount: amount,
            lessThanOnePercent: window.less_than_one_percent === true,
          })
        }
      }
    }

    const windows = expiryBandedWindows(buckets)
    // 托盘卡片要 amount（已用）/ limit（总量）/ unit 渲染「x / y」；
    // _qty = 这批剩余量（tierSummarize 求和用，输出前会被剥掉）
    buckets.forEach((bucket, index) => {
      const w = windows[index]
      w.amount = bucket.usedAmount
      w.limit = bucket.poolTotal
      w.unit = '积分'
      w._qty = bucket.remaining
      if (bucket.lessThanOnePercent) w.display += '（不足 1%）'
    })

    const unsupported = ['package_entitlement_groups', 'quota_package_entitlement_groups', 'enterprise_package_entitlement_groups']
      .some((key) => (summary?.[key]?.length ?? 0) > 0)
    if (unsupported) {
      plainRows.push({ name: DISPLAY_NAME, used: 0, display: '账号含额外额度包，其字段尚未验证；这里只显示服务端已识别的窗口' })
    }
    const checkinRow = checkinDisplayRow(checkinState)
    return [...windows, ...plainRows, ...(checkinRow ? [checkinRow] : [])]
  } catch (error) {
    return [{
      name: DISPLAY_NAME,
      used: 0,
      display: error?.signIn ? '登录已失效，请重新粘贴 Cookie' : `额度查询失败：${String(error?.message || error).slice(0, 240)}`,
    }]
  }
}

// ── 每日签到（纯只读；hub 语义：今天已领 = claimed）─────────────────────
//
// 为什么不发领取请求（上游 0.2.0 起的实测结论，照抄）：账号没被投放活动时，
// claim 接口恒回 biz_error.code 3「确认中」——带全套浏览器上下文在页面里调、
// 换 task_status=2 的任务、换活动组都一样。提交必然失败就不提交：
// 高频无效请求正是风控最敏感的模式。

async function checkin(credential) {
  try {
    const session = sessionFor(credential)
    await session.ready()

    // 先读这个账号实际投放的活动组；没投放的账号 launch 返回空串，
    // 直接拿常量去请求会得到 campaign not found
    let group = campaignGroup(session.launch)
    if (!group) {
      try { group = campaignGroup(await session.json('/alice/user/launch', {})) }
      catch { /* 下面按未投放处理 */ }
    }
    if (!group) {
      return { outcome: 'inactive', message: '这个账号当前没有投放签到活动' }
    }

    let state
    try {
      state = readCheckin(await session.json(CHECKIN_DETAIL_PATH, { campaign_group_code: group }))
    } catch (error) {
      if (error?.signIn) {
        return { outcome: 'failed', message: `登录已失效：${error.message}` }
      }
      const text = String(error?.message || '')
      if (/campaign not found/i.test(text)) {
        return { outcome: 'inactive', message: '这个账号当前没有投放签到活动' }
      }
      return { outcome: 'failed', message: `查询签到状态失败：${text.slice(0, 240)}` }
    }

    if (!state.found) return { outcome: 'inactive', message: '活动里没有每日签到任务' }

    const credit = state.points !== undefined ? { credit: state.points } : {}
    const streak = state.streak !== undefined ? { streak: state.streak } : {}

    if (state.claimed) {
      // ⚠️ hub 语义：今天已领过 = claimed（不是 done —— AGENTS.md 第 2 条）
      return { outcome: 'claimed', ...credit, ...streak, message: `今天已签到${state.streak ? `，连续 ${state.streak} 天` : ''}` }
    }
    if (!state.claimable) {
      return {
        outcome: 'ineligible',
        ...credit, ...streak,
        message: '今日签到暂不可领：豆包按账号投放这个活动，你的账号当前没被投放',
      }
    }
    return {
      outcome: 'ineligible',
      ...credit, ...streak,
      message: '今日未签。豆包把领取限死在电脑版客户端，请在那里点一下',
    }
  } catch (error) {
    return { outcome: 'failed', message: String(error?.message || error).slice(0, 300) }
  }
}

// ── 登录①：浏览器登录免粘贴（桌面一次性窗口 / 无界面读外部调试端口）──────

const BROWSER_LOGIN_WINDOW_MS = 5 * 60 * 1000

async function beginBrowserLogin(openBrowser, opts = {}) {
  const options = opts.options ?? {}
  const remoteHost = typeof options.doubaoCdpHost === 'string' && options.doubaoCdpHost.trim() !== ''
    ? options.doubaoCdpHost.trim()
    : ''
  let remotePort = 0
  if (remoteHost) {
    remotePort = Number(options.doubaoCdpPort ?? 9222)
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
      throw new Error('doubaoCdpPort 必须是 1–65535 的整数')
    }
    if (isFetchBadPort(remotePort)) {
      throw new Error(`doubaoCdpPort 不能是 ${remotePort} —— 这是 fetch 规范的禁用端口，换一个`)
    }
  }

  let settleOk, settleFail
  const result = new Promise((resolve, reject) => { settleOk = resolve; settleFail = reject })
  result.catch(() => {})
  let session
  let finished = false
  let timer
  const abort = new AbortController()
  const finish = (ok, value) => {
    if (finished) return
    finished = true
    if (timer !== undefined) clearTimeout(timer)
    abort.abort() // 取消轮询读循环（否则睡眠定时器吊住进程）
    // 远程模式窗口是用户的，不关；桌面一次性窗口用完即关 + 删 profile
    if (session && !remoteHost) void browserHooks.close(session).catch(() => {})
    ok ? settleOk(value) : settleFail(value)
  }
  timer = setTimeout(() => finish(false, new Error('豆包工作浏览器登录超时（5 分钟没检测到登录）')), BROWSER_LOGIN_WINDOW_MS)
  timer.unref?.()

  // ⚠️ 契约：beginLogin 必须立刻返回（await 用户登录会与 magpie 双向死锁）。
  //    拉窗口 → 轮询读 → 验身份 → settle 整条链后台跑，结果走 result。
  void (async () => {
    try {
      if (remoteHost) {
        session = { port: remotePort, host: remoteHost, remote: true }
      } else {
        if (!browserHooks.findBrowser()) {
          throw new Error('本机没找到 Chrome / Edge。无界面环境请用 doubaoCdpHost/doubaoCdpPort 指向外部浏览器调试端口，或改用「粘贴 Cookie 登录」。')
        }
        session = await browserHooks.launch('https://www.doubao.com/chat/')
        if (finished) { // 链启动前已被取消：窗口刚拉起来也要关掉
          if (!remoteHost) void browserHooks.close(session).catch(() => {})
          return
        }
      }
      const cookies = await browserHooks.read({ port: session.port, host: remoteHost || '127.0.0.1' }, { signal: abort.signal })
      const header = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
      // 服务端确认身份后才 settle（顺带 uid / 昵称 / bot），与粘贴路同口径
      const probe = sessionFor({ cookie: header })
      await probe.ready()
      finish(true, {
        cookie: header,
        uid: probe.uid,
        ...(probe.name ? { nickname: probe.name } : {}),
        bot: probe.bot,
      })
    } catch (error) {
      finish(false, error instanceof Error ? error : new Error(String(error)))
    }
  })()

  return {
    url: 'https://www.doubao.com/chat/',
    result,
    // 桌面模式窗口已自己拉起，宿主不要再开；远程模式不关用户窗口也不代开
    ...(remoteHost ? {} : { opened: true }),
    instructions: remoteHost
      ? `正在从外部浏览器调试端口 ${remoteHost}:${remotePort} 读豆包登录态。请在那只浏览器里登录 doubao.com（端口须对本机可达，仅限可信网络）；检测到登录自动完成，无需粘贴。`
      : '已为你打开一次性浏览器窗口，在窗口里扫码 / 短信登录豆包即可自动完成，无需粘贴；登录结束后窗口关闭、临时 profile 删除。',
    close: () => finish(false, new Error('豆包工作浏览器登录已取消')),
  }
}

// ── 登录②：本地载体页粘贴 Cookie ────────────────────────────────────────

function renderLoginPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录豆包工作</title>
<style>
body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;background:#111;color:#eee;
     max-width:560px;margin:40px auto;padding:24px;border-radius:12px;background:#1a1a1a}
h2{margin-top:0}
label{display:block;margin:14px 0 6px;font-size:13px;color:#aaa}
textarea{width:100%;padding:10px;box-sizing:border-box;border:1px solid #333;border-radius:6px;
      background:#0d0d0d;color:#eee;font-family:monospace;min-height:110px}
button{margin-top:14px;width:100%;padding:11px;border:0;border-radius:6px;background:#3b82f6;
       color:#fff;font-size:15px;cursor:pointer}
button:disabled{background:#444;cursor:not-allowed}
#msg{margin-top:14px;font-size:13px;min-height:20px;color:#9ca3af}
ol{font-size:13px;color:#9ca3af;line-height:1.8;padding-left:20px}
a{color:#60a5fa}
</style></head><body>
<h2>登录豆包工作</h2>
<ol>
<li>打开 <a href="https://www.doubao.com/chat/" target="_blank" rel="noopener">doubao.com/chat</a> 并登录（扫码/短信均可）</li>
<li>按 F12 打开开发者工具 → Network（网络）→ 刷新页面 → 点任意一个 doubao.com 请求</li>
<li>在 Request Headers（请求标头）里找到 <b>Cookie</b>，整行复制粘贴到下面</li>
</ol>
<label>Cookie（必须含 sessionid 或 sessionid_ss）</label>
<textarea id="cookie" placeholder="sessionid=…; sessionid_ss=…; ttwid=…"></textarea>
<button id="go">校验并登录</button>
<div id="msg"></div>
<script>
document.getElementById('go').onclick = async () => {
  const msg = document.getElementById('msg')
  const cookie = document.getElementById('cookie').value.trim()
  if (!cookie) { msg.textContent = '请粘贴 Cookie'; return }
  msg.textContent = '校验中…'
  const btn = document.getElementById('go')
  btn.disabled = true
  try {
    const r = await fetch('/cookie', { method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ cookie }) })
    const j = await r.json()
    if (j.ok) {
      msg.textContent = '登录成功' + (j.nickname ? '（' + j.nickname + '）' : '') + '，可以关闭此页面'
      msg.style.color = '#4ade80'
    } else {
      msg.textContent = j.message || '校验失败'
      msg.style.color = '#f87171'
      btn.disabled = false
    }
  } catch (e) { msg.textContent = '提交失败：' + e.message; btn.disabled = false }
}
</script></body></html>`
}

/**
 * 起本地载体页，立刻返回 { url, result }。
 * 用户在页面里粘贴 Cookie → 服务端拿它验身份 + launch → settle 凭据。
 * 形态照抄 loomy.mjs：settleOk/settleFail、timer unref、closeServer、
 * result.catch(()=>{})、listenCallbackPort 包装。
 */
async function beginLogin(openBrowser, opts = {}) {
  if (opts.arg === 'browser') return beginBrowserLogin(openBrowser, opts)
  const redirect = oauthRedirect(opts.options)
  let settleOk, settleFail
  const result = new Promise((resolve, reject) => { settleOk = resolve; settleFail = reject })
  result.catch(() => {})
  let server
  let closed = false
  let timer
  const closeServer = () => new Promise((resolve) => {
    if (closed || !server) return resolve()
    closed = true
    server.close(() => resolve())
  })
  const settle = (ok, value) => {
    if (timer !== undefined) clearTimeout(timer)
    void closeServer()
    ok ? settleOk(value) : settleFail(value)
  }

  timer = setTimeout(() => settle(false, new Error('豆包工作登录超时（超过 10 分钟无操作）')), LOGIN_WINDOW_MS)
  timer.unref?.() // 不吊住宿主退出

  server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const sendJson = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(data))
    }
    try {
      if (pathname === '/' || pathname === '/login') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderLoginPage())
        return
      }
      if (pathname === '/cookie' && req.method === 'POST') {
        const body = await new Response(req).json().catch(() => ({}))
        const cookie = String(body.cookie ?? '').trim()
        try {
          // 校验：身份 + launch 都过才算登录成功（顺带拿到 uid / 昵称 / bot）
          const session = sessionFor({ cookie })
          await session.ready()
          settle(true, {
            cookie,
            uid: session.uid,
            ...(session.name ? { nickname: session.name } : {}),
            bot: session.bot,
          })
          return sendJson(200, { ok: true, nickname: session.name || '' })
        } catch (error) {
          // 校验失败不 settle：用户可以换一份 Cookie 重试
          return sendJson(200, { ok: false, message: error instanceof Error ? error.message : String(error) })
        }
      }
      res.writeHead(404); res.end('not found')
    } catch (error) {
      sendJson(200, { ok: false, message: error instanceof Error ? error.message : String(error) })
    }
  })

  // ⚠️ unref：登录窗口是独立的用户流程，不该吊住宿主进程的退出
  const port = await listenCallbackPort(server, redirect, { unref: true }).catch((error) => {
    settle(false, new Error(`豆包工作回调端口无法监听（${error.message}）`))
    throw error
  })

  const url = `http://${redirect.urlHost}:${port}/`
  if (openBrowser) openBrowser(url)
  const remoteNote = redirect.overridden
    ? `（登录页地址已覆盖为 ${redirect.urlHost}:${port} —— 请在你自己的浏览器里打开）`
    : ''
  return {
    url,
    result,
    instructions: `${remoteNote}在打开的页面里粘贴 doubao.com 的 Cookie 完成登录，完成后本窗口自动继续。`,
    // 取消入口（测试收尾 / 宿主主动关闭载体用）
    close: () => settle(false, new Error('豆包工作登录载体已关闭')),
  }
}

// ── 渠道对象 ────────────────────────────────────────────────────────────

export const doubaoworkChannel = {
  id: CHANNEL_ID,
  displayName: DISPLAY_NAME,
  fallbackModels: FALLBACK_MODELS,
  beginLogin,
  loginMethods: [
    { label: '浏览器登录（自动抓取）', arg: 'browser' },
    { label: '粘贴 Cookie 登录（本地载体页）' },
  ],
  // 粘贴兜底（magpie 原生输入框，存 {type:'api', key} → 翻译成 {cookie}）
  apiAuth: {
    label: '粘贴豆包 Cookie',
    placeholder: 'sessionid=…; sessionid_ss=…（doubao.com 登录后从开发者工具复制完整 Cookie）',
    keyField: 'cookie',
  },
  // ⚠️ 无续期端点（诚实标记）：登录态是网站 Cookie，没有 refresh_token，
  //    过期只能重新粘贴。服务端 710012000/710012001 → 401 标记账号。
  async refresh() {
    throw new Error('豆包工作无自动续期：登录态是网站 Cookie，失效后请重新粘贴')
  },
  expired: (credential) => {
    const raw = Number(credential?.expires_at)
    // 无 expires_at 视为不过期：Cookie 的真实寿命未知，宁可拿去试
    //（服务端回 710012001 我们能识别），也不凭猜测阻止用户使用（loomy 同款取舍）
    return Number.isFinite(raw) && raw > 0 && raw <= Date.now()
  },
  catalog,
  chat,
  checkin,
  usage,
}

/** 供测试：内部入口（不从 index.mjs 导出）。 */
export const _internal = {
  sessionFor,
  /** 测试间清掉会话缓存（ready/目录/签到缓存都挂在会话上）。 */
  resetSessions: () => { sessions.clear(); orphanRecords.clear(); activeLeases.clear() },
  errorResponse,
  parseCookieHeader,
}