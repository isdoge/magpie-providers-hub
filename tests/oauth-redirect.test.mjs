// issue #3：回调地址覆盖（oauthCallbackHost / oauthCallbackPort）+ 粘贴中转。
//
// 全部离线：上游一律 stub fetch；本地载体页/回调口走真 loopback
// （127.0.0.1 / localhost —— 网络哨兵放行这两个）。
//
// ⚠️ 计时器纪律：lobsterai / astudio / magicrew 的登录计时器**没有 unref**，
//   起过的登录必须 settle（或 cancel）才能退进程 —— 每条用例都走完整登录路。
//   monkeycode / baizhi 的 beginLogin 会真的拉本机 Chromium（副作用），
//   不在这里起 —— 它们的覆盖接线与其余载体页渠道同构（oauthRedirect →
//   listen(bindHost) → url 模板），由 oauthRedirect 单元测试兜底。

import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  oauthRedirect,
  OAUTH_CALLBACK_DEFAULT_HOST,
  renderCallbackRelayPage,
  parsePastedCallbackUrl,
  isFetchBadPort,
  listenCallbackPort,
  headlessCarrierNote,
} = await import('../src/shared.mjs')
const { lobsteraiChannel } = await import('../src/lobsterai.mjs')
const { accioChannel } = await import('../src/accio.mjs')
const { astudioChannel } = await import('../src/astudio.mjs')
const { magicrewChannel } = await import('../src/magicrew.mjs')
const { loomyChannel } = await import('../src/loomy.mjs')

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
})

/** stub fetch：loopback（含 localhost / [::1]）放行给真 fetch，其余按路由表打桩。 */
const stubFetch = (routes, fallback = () => json({ code: 0, msg: 'OK', data: {} })) => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/)/.test(url)) return original(input, init)
    calls.push({ url, headers: init?.headers ?? {}, method: init?.method ?? 'GET', body: init?.body })
    for (const route of routes) {
      if (url.includes(route.match)) return route.respond({ url, calls })
    }
    return fallback()
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

/** 从中转页 HTML 里抠出登录链接（href 已 HTML 转义，先还原再解析）。 */
const loginLinkOf = (pageHtml) => {
  const m = pageHtml.match(/<a href="([^"]+)"/)
  assert.ok(m, '中转页必须有登录链接')
  const href = m[1]
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  return new URL(href)
}

const postJson = (url, body) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

// ── oauthRedirect：配置解析 ─────────────────────────────────────────────

test('oauthRedirect：不填 = 桌面默认（127.0.0.1 回环、随机端口、不覆盖）', () => {
  for (const options of [undefined, {}, { oauthCallbackHost: '' }, { oauthCallbackHost: '   ' }, { oauthCallbackPort: '' }]) {
    const r = oauthRedirect(options)
    assert.deepEqual(r, {
      host: '127.0.0.1', urlHost: '127.0.0.1', port: 0,
      bindHost: '127.0.0.1', overridden: false,
    }, `options=${JSON.stringify(options)} 必须回落默认`)
  }
  assert.equal(OAUTH_CALLBACK_DEFAULT_HOST, '127.0.0.1')
})

test('oauthRedirect：只填 host / 只填 port / 两者都填', () => {
  const hostOnly = oauthRedirect({ oauthCallbackHost: '100.64.0.1' })
  assert.equal(hostOnly.host, '100.64.0.1')
  assert.equal(hostOnly.port, 0, '不填端口 = 随机')
  assert.equal(hostOnly.bindHost, '0.0.0.0', '覆盖后必须绑全网卡，远端回调才进得来')
  assert.equal(hostOnly.overridden, true)

  const portOnly = oauthRedirect({ oauthCallbackPort: 8765 })
  assert.equal(portOnly.host, '127.0.0.1', '只填端口不改 host')
  assert.equal(portOnly.port, 8765)
  assert.equal(portOnly.bindHost, '0.0.0.0')
  assert.equal(portOnly.overridden, true)

  const both = oauthRedirect({ oauthCallbackHost: 'nas.tailnet.example', oauthCallbackPort: '9000' })
  assert.equal(both.host, 'nas.tailnet.example')
  assert.equal(both.urlHost, 'nas.tailnet.example')
  assert.equal(both.port, 9000, '字符串端口也认')

  const zero = oauthRedirect({ oauthCallbackPort: 0 })
  assert.equal(zero.overridden, true, '显式 0 = 覆盖 + 随机端口')
  assert.equal(zero.port, 0)
})

test('oauthRedirect：IPv6 带方括号 —— listen 用裸地址，拼 URL 自动补括号', () => {
  const r = oauthRedirect({ oauthCallbackHost: '[fd7a::1]' })
  assert.equal(r.host, 'fd7a::1', 'host 是裸地址（listen 用）')
  assert.equal(r.urlHost, '[fd7a::1]', 'URL 里必须带括号')
  assert.equal(r.bindHost, '0.0.0.0')
})

test('oauthRedirect：非法配置抛可读错误（宁可登录失败提示，不静默用错地址）', () => {
  const badHosts = [
    'http://1.2.3.4',        // 带协议
    '1.2.3.4:8080',          // 带端口（要用 oauthCallbackPort）
    '1.2.3.4/callback',      // 带路径
    '1.2.3.4?q=1',           // 带查询串
    'user:pass@1.2.3.4',     // 带 userinfo
  ]
  for (const h of badHosts) {
    assert.throws(() => oauthRedirect({ oauthCallbackHost: h }), /oauthCallbackHost/, `host「${h}」必须被拒`)
  }
  for (const p of ['abc', 70000, -1, 1.5]) {
    assert.throws(() => oauthRedirect({ oauthCallbackPort: p }), /oauthCallbackPort/, `port「${p}」必须被拒`)
  }
})

// ── fetch 禁用端口：显式配置拒收，随机抽中重抽 ─────────────────────────
//
// 真机事故：全量测试偶发「fetch failed: bad port」—— OS 给 listen(0) 随机派了
// 个 fetch 规范禁用端口（Windows 临时端口段里的 6000/6665–6669 等），浏览器与
// undici 都拒发，回调永远进不来。

test('oauthRedirect：显式端口撞上 fetch 禁用清单要拒收（6000/6666/25…）', () => {
  for (const p of [25, 6000, 6666, 6669, 5060, 10080]) {
    assert.throws(() => oauthRedirect({ oauthCallbackPort: p }), /禁用端口/, `端口 ${p} 必须被拒`)
  }
  assert.equal(isFetchBadPort(6666), true)
  assert.equal(isFetchBadPort('6000'), true, '字符串也认')
  assert.equal(isFetchBadPort(40000), false)
  assert.equal(oauthRedirect({ oauthCallbackPort: 40000 }).port, 40000, '正常端口照旧')
})

/** 假 server：按剧本依次「派端口」，验证重抽逻辑（不用真碰 OS 的随机端口）。 */
const fakeServer = (ports) => {
  let i = 0
  const handlers = {}
  return {
    unrefd: false,
    once(ev, fn) { (handlers[ev] ??= []).push(fn) },
    on(ev, fn) { (handlers[ev] ??= []).push(fn) },
    removeListener(ev, fn) { handlers[ev] = (handlers[ev] ?? []).filter((f) => f !== fn) },
    listen(_port, _host, cb) { this._addr = { port: ports[Math.min(i++, ports.length - 1)] }; cb() },
    address() { return this._addr },
    close(cb) { cb() },
    unref() { this.unrefd = true },
  }
}

test('listenCallbackPort：随机抽中禁用端口 → 关掉重抽；unref 选项生效', async () => {
  const server = fakeServer([6666, 6000, 40000])
  const port = await listenCallbackPort(server, { port: 0, bindHost: '127.0.0.1' }, { unref: true })
  assert.equal(port, 40000, '前两次禁用端口都要重抽')
  assert.equal(server.unrefd, true)
  // 显式端口不重抽（合法性由 oauthRedirect 前置校验负责）
  const fixed = fakeServer([8765])
  assert.equal(await listenCallbackPort(fixed, { port: 8765, bindHost: '0.0.0.0' }), 8765)
  // 连续抽中 → 明确报错而不是死循环
  await assert.rejects(
    () => listenCallbackPort(fakeServer([6000]), { port: 0, bindHost: '127.0.0.1' }, { attempts: 3 }),
    /禁用端口/,
  )
})

test('listenCallbackPort：真 server 冒烟 —— 拿到的端口不在禁用清单', async () => {
  const { createServer } = await import('node:http')
  const server = createServer()
  try {
    const port = await listenCallbackPort(server, { port: 0, bindHost: '127.0.0.1' })
    assert.ok(port > 0 && !isFetchBadPort(port))
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

// ── 中转页 / 粘贴解析（shared 助手）─────────────────────────────────────

test('中转页：登录链接进 href 且 HTML 转义；粘贴走相对路径 /paste-callback', () => {
  const page = renderCallbackRelayPage({
    displayName: 'X&Y',
    loginUrl: 'https://vendor.example/login?a=1&b=<2>"\'',
  })
  assert.match(page, /X&amp;Y/, '显示名要转义')
  assert.match(page, /a=1&amp;b=&lt;2&gt;&quot;&#39;/, 'URL 里的 & < > " \' 全要转义')
  assert.match(page, /fetch\('\/paste-callback'/, '页面脚本只用相对路径（host 覆盖透明生效）')
  assert.match(page, /<textarea id="cb"/, '要有粘贴框')
})

test('parsePastedCallbackUrl：空串/非法 URL/路径不符都抛可读错误；host 不同是预期情形', () => {
  assert.throws(() => parsePastedCallbackUrl('', '/auth/callback'), /请粘贴完整的回调地址/)
  assert.throws(() => parsePastedCallbackUrl('   ', '/auth/callback'), /请粘贴完整的回调地址/)
  assert.throws(() => parsePastedCallbackUrl('不是URL', '/auth/callback'), /不是合法的 URL/)
  assert.throws(() => parsePastedCallbackUrl('http://127.0.0.1:1/other?code=x', '/auth/callback'), /路径应为 \/auth\/callback/)
  // ⚠️ 回调落在用户自己机器的回环上（host 与覆盖 host 不同）必须放行
  const parsed = parsePastedCallbackUrl('http://127.0.0.1:54321/auth/callback?code=C1&state=S1', '/auth/callback')
  assert.equal(parsed.searchParams.get('code'), 'C1')
  assert.equal(parsed.searchParams.get('state'), 'S1')
})

// ── lobsterai：覆盖模式中转页 + 粘贴路 + 自动路 ─────────────────────────

const LOBSTER_ROUTES = [
  { match: '/api/auth/exchange', respond: () => json({ code: 0, data: { accessToken: 'at_new', refreshToken: 'rt_new', expiresIn: 3600 } }) },
  { match: '/api/user/profile-summary', respond: () => json({ code: 0, data: { id: 169340, nickname: ' mzzhcc ' } }) },
]

test('lobsterai 覆盖：入口换中转页；贴错不终结会话，贴对在服务端完成交换', async () => {
  const stub = stubFetch(LOBSTER_ROUTES)
  try {
    const started = await lobsteraiChannel.beginLogin(undefined, { options: { oauthCallbackHost: 'localhost' } })
    assert.match(started.url, /^http:\/\/localhost:\d+\/relay$/, '覆盖模式入口必须是中转页')
    assert.match(started.instructions, /中转页/, 'instructions 要讲清远程用法')

    const page = await (await fetch(started.url)).text()
    const link = loginLinkOf(page)
    assert.equal(link.origin + link.pathname, 'https://lobsterai.youdao.com/portal')
    const query = new URLSearchParams(link.hash.split('?')[1] ?? '')
    const redirectUri = query.get('redirect_uri')
    const state = query.get('state')
    assert.ok(redirectUri.startsWith('http://localhost:'), 'redirect_uri 用覆盖 host')
    assert.match(redirectUri, /\/auth\/callback$/)
    assert.ok(state, 'state 必须下发')

    const pasteUrl = started.url.replace('/relay', '/paste-callback')
    // ① 垃圾粘贴 → 报错但会话活着
    const junk = await (await postJson(pasteUrl, { url: '随便贴的' })).json()
    assert.equal(junk.ok, false)
    assert.match(junk.message, /不是合法的 URL/)
    // ② state 不符 → 报错但会话活着（与自动路的「一击终结」不同）
    const wrong = await (await postJson(pasteUrl, { url: `http://127.0.0.1:9/auth/callback?code=X&state=WRONG` })).json()
    assert.equal(wrong.ok, false)
    assert.match(wrong.message, /state 不匹配/)
    // ③ 贴对：回调落在「用户机器」的 127.0.0.1 上（host 与覆盖不同是预期）
    const okRes = await (await postJson(pasteUrl, { url: `http://127.0.0.1:9/auth/callback?code=CODE-P&state=${state}` })).json()
    assert.equal(okRes.ok, true)
    const credential = await started.result
    assert.equal(credential.access_token, 'at_new')
    assert.equal(credential.uid, '169340', '粘贴路也要补身份（多账号分槽）')
    assert.equal(credential.nickname, 'mzzhcc')
    const exchange = stub.calls.find((c) => c.url.includes('/api/auth/exchange'))
    assert.ok(exchange, '交换必须在服务端发生')
    assert.equal(JSON.parse(exchange.body).authCode, 'CODE-P')
  } finally {
    stub.restore()
  }
})

test('lobsterai 覆盖：自动回调路照常并行可用（回调直达本机时不需要粘贴）', async () => {
  const stub = stubFetch(LOBSTER_ROUTES)
  try {
    const started = await lobsteraiChannel.beginLogin(undefined, { options: { oauthCallbackHost: 'localhost' } })
    const page = await (await fetch(started.url)).text()
    const query = new URLSearchParams(loginLinkOf(page).hash.split('?')[1] ?? '')
    const callback = `${query.get('redirect_uri')}?code=CODE-A&state=${query.get('state')}`
    await fetch(callback)
    const credential = await started.result
    assert.equal(credential.access_token, 'at_new')
  } finally {
    stub.restore()
  }
})

test('lobsterai 默认：入口仍是厂商登录链接；/relay 与 /paste-callback 不存在（一个字节都不加）', async () => {
  const stub = stubFetch(LOBSTER_ROUTES)
  try {
    let opened
    const started = await lobsteraiChannel.beginLogin((url) => { opened = url })
    assert.equal(started.url, opened)
    assert.ok(started.url.startsWith('https://lobsterai.youdao.com/portal#/login?'), '默认入口不变')
    assert.ok(!started.instructions.includes('http'), 'instructions 不嵌地址（宿主可编辑框已渲染 url，嵌了是重复信息）')
    const query = new URLSearchParams(started.url.split('?')[1] ?? '')
    const redirectUri = query.get('redirect_uri')
    assert.ok(redirectUri.startsWith('http://127.0.0.1:'), '默认仍绑回环')
    const origin = new URL(redirectUri).origin
    assert.equal((await fetch(`${origin}/relay`)).status, 404, '默认模式没有中转页')
    assert.equal((await postJson(`${origin}/paste-callback`, { url: 'x' })).status, 404, '默认模式没有粘贴口')
    // 自动回调 settle（计时器没 unref，必须走完）
    await fetch(`${redirectUri}?code=CODE-D&state=${query.get('state')}`)
    const credential = await started.result
    assert.equal(credential.access_token, 'at_new')
  } finally {
    stub.restore()
  }
})

// ── accio：覆盖模式中转页 + 粘贴路（PKCE 交换在服务端）──────────────────

const ACCIO_ROUTES = [
  {
    match: '/api/oauth/token',
    respond: () => json({
      success: true,
      data: { accessToken: 'at_a', refreshToken: 'rt_a', expiresAt: Math.floor(Date.now() / 1000) + 3600 },
    }),
  },
]

test('accio 覆盖：中转页粘贴路走通（error 参数/错 state 不终结会话）', async () => {
  const stub = stubFetch(ACCIO_ROUTES)
  const started = await accioChannel.beginLogin(undefined, { arg: 'cn', options: { oauthCallbackHost: 'localhost' } })
  try {
    assert.match(started.url, /^http:\/\/localhost:\d+\/relay$/)
    const page = await (await fetch(started.url)).text()
    const link = loginLinkOf(page)
    assert.equal(link.origin + link.pathname, 'https://www.accio-ai.com/login')
    const returnUrl = link.searchParams.get('return_url')
    const state = link.searchParams.get('state')
    assert.ok(returnUrl.startsWith('http://localhost:'), 'return_url 用覆盖 host')
    assert.match(returnUrl, /\/auth\/callback$/)
    assert.ok(link.searchParams.get('code_challenge'), 'PKCE 参数照旧齐全')

    const pasteUrl = started.url.replace('/relay', '/paste-callback')
    const wrong = await (await postJson(pasteUrl, { url: `http://127.0.0.1:9/auth/callback?code=X&state=WRONG` })).json()
    assert.equal(wrong.ok, false)
    assert.match(wrong.message, /state 不匹配/)
    const denied = await (await postJson(pasteUrl, { url: `http://127.0.0.1:9/auth/callback?error=access_denied&state=${state}` })).json()
    assert.equal(denied.ok, false)
    assert.match(denied.message, /授权被拒绝/)

    const okRes = await (await postJson(pasteUrl, { url: `http://127.0.0.1:9/auth/callback?code=CODE-A&state=${state}` })).json()
    assert.equal(okRes.ok, true)
    const credential = await started.result
    assert.equal(credential.access_token, 'at_a')
    assert.equal(credential.region, 'cn')
    assert.ok(credential.expires_at > Date.now(), 'expiresAt 秒→毫秒')
    const exchange = stub.calls.find((c) => c.url.includes('/api/oauth/token'))
    const body = JSON.parse(exchange.body)
    assert.equal(body.code, 'CODE-A')
    assert.ok(body.codeVerifier, 'PKCE verifier 必须在服务端交换里')
    assert.equal(body.redirectUri, returnUrl, 'redirectUri 与授权页下发的一致')
  } finally {
    started.cancel()
    await started.result.catch(() => {})
    stub.restore()
  }
})

test('accio 默认：入口仍是厂商授权链接，中转路由不存在；cancel 可收场', async () => {
  const started = await accioChannel.beginLogin(undefined)
  try {
    assert.ok(started.url.startsWith('https://www.accio-ai.com/login?'), '默认入口不变')
    assert.ok(!started.instructions.includes('http'), 'instructions 不嵌地址（宿主可编辑框已渲染 url，嵌了是重复信息）')
    const returnUrl = new URL(started.url).searchParams.get('return_url')
    assert.ok(returnUrl.startsWith('http://127.0.0.1:'), '默认仍绑回环')
    const origin = new URL(returnUrl).origin
    assert.equal((await fetch(`${origin}/relay`)).status, 404)
    assert.equal((await postJson(`${origin}/paste-callback`, { url: 'x' })).status, 404)
  } finally {
    started.cancel()
    await started.result.catch(() => {})
  }
})

// ── 载体页渠道：覆盖后入口 host 跟着走，页内登录路照常 settle ───────────

test('astudio 覆盖：载体页入口换覆盖 host；密码登录路 settle（计时器清掉）', async () => {
  const stub = stubFetch([
    { match: '/login/check-account', respond: () => json({ code: 0, data: { uid: 'U1', ssoSessionId: 'SSO1', nickname: '测' } }) },
    { match: '/bot/models/configs', respond: () => json({ code: 0, data: [{ model: 'spark', base_url: 'https://maas.example/v1', api_key: 'sk-astudio' }] }) },
  ])
  try {
    const started = await astudioChannel.beginLogin(undefined, { options: { oauthCallbackHost: 'localhost' } })
    assert.match(started.url, /^http:\/\/localhost:\d+\/login$/)
    const page = await (await fetch(started.url)).text()
    assert.match(page, /登录 AStudio/, '载体页照常渲染（页内请求全是相对路径）')
    const login = await (await postJson(started.url.replace('/login', '/password/login'), {
      accountName: 'u@example.com', accountPwd: 'pw',
      geetestChallenge: 'c', geetestValidate: 'v', geetestSeccode: 's',
    })).json()
    assert.equal(login.ok, true)
    const credential = await started.result
    assert.equal(credential.accessToken, 'sk-astudio')
    assert.equal(credential.loginMethod, 'password')
  } finally {
    stub.restore()
  }
})

test('magicrew 覆盖：载体页入口换覆盖 host；粘贴 JWT 路 settle', async () => {
  const stub = stubFetch([
    { match: '/api/v1/quota/points/total', respond: () => json({ code: 1000, data: { total_points: 100 } }) },
    { match: '/api/v1/model-gateway/tokens', respond: () => json({ code: 1000, data: { api_key: 'mgw_x', refresh_token: 'rt_1', api_key_expires_at: Date.now() + 3600_000 } }) },
  ], () => json({ code: 1000, data: {} }))
  try {
    const started = await magicrewChannel.beginLogin(undefined, { options: { oauthCallbackHost: 'localhost' } })
    assert.match(started.url, /^http:\/\/localhost:\d+\/login$/)
    const page = await (await fetch(started.url)).text()
    assert.match(page, /<html/i, '载体页照常渲染')
    const login = await (await postJson(started.url.replace('/login', '/api/login-jwt'), {
      token: 'JWT-ABC', organizationCode: 'ORG-1',
    })).json()
    assert.equal(login.ok, true)
    const credential = await started.result
    assert.equal(credential.apiKey, 'mgw_x')
    assert.equal(credential.organizationCode, 'ORG-1')
  } finally {
    stub.restore()
  }
})

test('loomy 覆盖：载体页入口换覆盖 host；短信登录路 settle', async () => {
  const stub = stubFetch([
    { match: 'open.weixin.qq.com/connect/qrconnect', respond: () => new Response('<img src="/connect/qrcode/QRUUID">') },
    { match: 'open.weixin.qq.com/connect/qrcode', respond: () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } }) },
    { match: '/login/phone/sendMsgCode', respond: () => json({ code: '000000', data: { msgid: 'MSG1' } }) },
    { match: '/login/phone/checkCode', respond: () => json({ code: '000000', data: { session: 'SESS3', userid: 'U3' } }) },
    { match: '/points/records', respond: () => json({ code: '000000', data: { balance: 100, dailyBalance: 5000 } }) },
  ])
  try {
    const started = await loomyChannel.beginLogin(undefined, { options: { oauthCallbackHost: 'localhost' } })
    assert.match(started.url, /^http:\/\/localhost:\d+\/login$/)
    assert.match(started.instructions, /远程|覆盖/, '覆盖模式要有远程提示')
    const page = await (await fetch(started.url)).text()
    assert.match(page, /微信扫码/)
    const send = await (await postJson(started.url.replace('/login', '/sms/send'), { mobile: '13900000000' })).json()
    assert.equal(send.msgid, 'MSG1')
    await postJson(started.url.replace('/login', '/sms/login'), { mobile: '13900000000', code: '654321', msgid: send.msgid })
    const credential = await started.result
    assert.equal(credential.access_token, 'SESS3')
  } finally {
    stub.restore()
  }
})
// ── 无界面载体页提示（2026-11-18 真机报障配套）─────────────────────────

test('headlessCarrierNote：Linux 无 DISPLAY 且未覆盖 → 提示配置覆盖；其余零噪音', () => {
  const linuxHeadless = { DISPLAY: '', WAYLAND_DISPLAY: '' }
  assert.match(headlessCarrierNote({ overridden: false }, linuxHeadless, 'linux'), /oauthCallbackHost/)
  assert.match(headlessCarrierNote({ overridden: false }, linuxHeadless, 'linux'), /回环/)
  // 已覆盖 → 不啰嗦
  assert.equal(headlessCarrierNote({ overridden: true }, linuxHeadless, 'linux'), '')
  // 有显示器的 Linux 桌面 → 不啰嗦
  assert.equal(headlessCarrierNote({ overridden: false }, { DISPLAY: ':0' }, 'linux'), '')
  // Windows 桌面 → 不啰嗦
  assert.equal(headlessCarrierNote({ overridden: false }, {}, 'win32'), '')
  // 显式声明（测试/其它平台）→ 提示
  assert.match(headlessCarrierNote({ overridden: false }, { MAGPIE_HUB_HEADLESS: '1' }, 'win32'), /oauthCallbackHost/)
})
