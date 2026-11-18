// marvis「粘贴回调地址」登录路（method:'code'）—— 形状锁 + 换取契约
//
// 场景：magpie 跑在无显示的 NAS 容器 / Linux 服务器里。两条原路都不通 ——
//   · 隔离浏览器（CDP 拦回调）在没有浏览器/显示的机器上起不来；
//   · 「从本机 Marvis 导入」只认 Windows 注册表 + 客户端内存。
// 所以接入 MYCF711/magpie-marvis 的手动路：授权页交给用户自己的浏览器，
// 登录完把回调地址整条粘贴回 magpie 的输入框。
//
// 写死的事实（改了就会被拦住）：
//   ① 手动入口必须 method:'code' 且**不带** opened:true（带了宿主不弹授权页）
//   ② guid 必须与授权那次同一个：QQ 的 state 是随机小数，微信的 state 就是 guid
//   ③ callback 参数形态两种都认：callback(粘贴内容) 与 callback(url, 粘贴内容)
//   ④ state→guid 只在**换取成功后**消费：空输入/贴错/换取失败都能原样重试
//   ⑤ 换取请求 redirect:'manual' + query 只带 login_type/code/state（多一个就 -109）
//
// 全部离线：fetch 换成假实现（302 + Set-Cookie 是官方成功形态）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MARVIS_URL = new URL('../src/marvis.mjs', import.meta.url)

if (!existsSync(MARVIS_URL)) {
  test('marvis 渠道未安装（src/marvis.mjs 不存在）→ 整体跳过', (t) => {
    t.skip('渠道文件不在本机')
  })
} else {
  const sandbox = mkdtempSync(join(tmpdir(), 'dsh-hub-marvis-paste-'))
  process.env.DSH_HUB_SNAPSHOT_PATH = join(sandbox, 'snapshot.js')

  const {
    marvisChannel,
    marvisPastedInputOf,
    MARVIS_LOGIN_METHODS,
  } = await import(MARVIS_URL.href)
  const { makeHubPlugin } = await import('../src/aggregate.mjs')

  test.after(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  const CODE = 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4'
  const OAUTH_PATH = '/marvis_client_login/marvis_oauth'

  /** 官方成功形态：302 + 10 个 Set-Cookie，无 body */
  function ok302() {
    const setCookies = [
      'openid=0A1B2C3D4E5F60718293A4B5C6D7E8F9; Path=/; Domain=.qq.com; HttpOnly',
      'accesstoken=TOKEN_abc123; Path=/; Domain=.qq.com; HttpOnly',
      'refreshtoken=REFRESH_def456; Path=/; Domain=.qq.com; HttpOnly',
      'logintype=QC; Path=/; Domain=.qq.com',
      'nickname=%E9%98%BF%E6%98%8E; Path=/; Domain=.qq.com',
      'head_img_url=https%3A%2F%2Fthirdqq.qlogo.cn%2Fabc%2F100; Path=/; Domain=.qq.com',
      'access_token_expire_time=1793000000; Path=/; Domain=.qq.com',
      'appid=1903794758; Path=/; Domain=.qq.com',
      'scope=all; Path=/; Domain=.qq.com',
      'is_locked=0; Path=/; Domain=.qq.com',
    ]
    const headers = new Headers()
    for (const c of setCookies) headers.append('set-cookie', c)
    headers.set('location', 'https://yybadaccess.3g.qq.com/marvis_client_login/oauth_done')
    return new Response(null, { status: 302, headers })
  }

  /** 替身 fetch：换码 302 + cookie；用户信息回 JSON；其余 404 */
  function stubFetch() {
    const calls = []
    const real = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      const u = String(url)
      calls.push({ url: u, init: init ?? {} })
      if (u.includes(OAUTH_PATH)) return ok302()
      if (u.includes('marvis_get_user_info')) {
        return new Response(JSON.stringify({ ret: 0, nick_name: '阿明', head_img_url: '' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    }
    return { calls, restore: () => { globalThis.fetch = real } }
  }

  /** 起一条粘贴登录流（真实 parseCallback + 假 fetch） */
  const startPaste = (arg) => marvisChannel.beginLogin(undefined, { arg })
  const pasteUrl = (state, loginType = 'QC') =>
    `https://yybadaccess.3g.qq.com${OAUTH_PATH}?login_type=${loginType}&code=${CODE}&state=${state}`
  const stateOf = (url) => new URL(url).searchParams.get('state')

  // ── 入口形状 ──────────────────────────────────────────────────────────

  test('五条登录路：QQ/微信各有一条粘贴入口，authorize 返回 code 形态', async () => {
    assert.equal(MARVIS_LOGIN_METHODS.length, 5)
    for (const [arg, platform] of [['paste-QC', 'QQ'], ['paste-WX', '微信']]) {
      const entry = MARVIS_LOGIN_METHODS.find((m) => m.arg === arg)
      assert.ok(entry, `${arg} 入口应存在`)
      assert.ok(entry.label.includes('粘贴') && entry.label.includes(platform))
      const started = startPaste(arg)
      assert.equal(started.method, 'code', 'method 必须是 code，否则宿主不给输入框')
      assert.notEqual(started.opened, true, 'opened:true 会让 magpie 不弹授权页')
      assert.equal(typeof started.settle, 'function')
      assert.match(started.instructions, /粘贴/)
    }
  })

  test('QQ 粘贴入口：授权页 graph.qq.com，login_type=QC，state 是小数形状', () => {
    const started = startPaste('paste-QC')
    const u = new URL(started.url)
    assert.equal(u.host, 'graph.qq.com')
    assert.match(u.searchParams.get('redirect_uri'), /login_type=QC$/)
    assert.match(u.searchParams.get('state'), /^\d+(\.\d+)?$/)
  })

  test('微信粘贴入口：授权页 open.weixin.qq.com，state 就是 guid 形状', () => {
    const started = startPaste('paste-WX')
    const u = new URL(started.url)
    assert.equal(u.host, 'open.weixin.qq.com')
    assert.match(u.searchParams.get('redirect_uri'), /login_type=WX$/)
    assert.match(u.searchParams.get('state'), /^[0-9a-f]{32}$/)
  })

  // ── 换取契约 ──────────────────────────────────────────────────────────

  test('粘贴整条回调 URL（单参形态）能换到登录态，guid 与授权时一致', async () => {
    const s = stubFetch()
    try {
      const started = startPaste('paste-QC')
      const state = stateOf(started.url)
      const credential = await started.settle(pasteUrl(state))
      assert.equal(credential.type, 'success')
      assert.equal(credential.access, 'TOKEN_abc123')
      assert.equal(credential.accessToken, 'TOKEN_abc123')
      assert.match(credential.nickname, /^QQ·/)
      assert.equal(credential.loginType, '1')
      assert.match(credential.guid, /^[0-9a-f]{32}$/)
      assert.equal(credential.refresh, 'REFRESH_def456')

      // 换码请求：同一个 guid、不跟随重定向、query 只有 login_type/code/state
      const exchange = s.calls.find((c) => c.url.includes(OAUTH_PATH))
      assert.ok(exchange, '应该真的发了一次换码请求')
      assert.equal(exchange.init.redirect, 'manual')
      assert.equal(exchange.init.headers['Ual-Access-Guid'], credential.guid)
      const q = new URL(exchange.url).searchParams
      assert.equal(q.get('code'), CODE)
      assert.equal(q.get('state'), state, 'state 原样回传（小数不许变形）')
      assert.deepEqual([...q.keys()].sort(), ['code', 'login_type', 'state'], '多一个参数上游就 -109')

      // result 同时兑现（aggregate 的反馈链挂在它上面）
      const viaResult = await started.result
      assert.equal(viaResult.access, credential.access)
    } finally { s.restore() }
  })

  test('两参形态 callback(url, input) 也认（宿主签名可能变）', async () => {
    const s = stubFetch()
    try {
      const started = startPaste('paste-QC')
      const credential = await started.settle(started.url, pasteUrl(stateOf(started.url)))
      assert.equal(credential.type, 'success')
    } finally { s.restore() }
  })

  test('微信粘贴路：state=guid 对上，loginType=2', async () => {
    const s = stubFetch()
    try {
      const started = startPaste('paste-WX')
      const state = stateOf(started.url)
      const credential = await started.settle(pasteUrl(state, 'WX'))
      assert.equal(credential.type, 'success')
      assert.equal(credential.guid, state, '微信的 state 就是 guid')
      // cookie 里 logintype=QC 会被 opts.loginType 兜底吗？—— accountFromCookies
      // 优先 cookie 的 logintype；这里上游假响应给的是 QC，渠道按 loginType 键归一
      assert.ok(['1', '2'].includes(credential.loginType))
      assert.match(credential.nickname, /^微信·/)
    } finally { s.restore() }
  })

  // ── 重试语义（#9 评审第 1 点：失败不许作废这次登录）──────────────────

  test('粘贴内容里没有 code → 可读错误，且这次登录不作废（随后贴对仍成功）', async () => {
    const s = stubFetch()
    try {
      const started = startPaste('paste-QC')
      await assert.rejects(() => started.settle('随便写点东西'), /没有 code/)
      const credential = await started.settle(pasteUrl(stateOf(started.url)))
      assert.equal(credential.type, 'success')
    } finally { s.restore() }
  })

  test('两参形态空输入不消耗这次登录，原样重试仍成功', async () => {
    const s = stubFetch()
    try {
      const started = startPaste('paste-QC')
      await assert.rejects(() => started.settle(started.url, ''), /没有 code/)
      const credential = await started.settle(pasteUrl(stateOf(started.url)))
      assert.equal(credential.type, 'success')
    } finally { s.restore() }
  })

  test('裸 code（无 state）→ 可读错误，不是 -109', async () => {
    const started = startPaste('paste-QC')
    await assert.rejects(() => started.settle(CODE), /没有 state/)
  })

  test('state 与本次登录不符 → 拒绝且不消耗本次登录（别混用多个窗口的地址）', async () => {
    const s = stubFetch()
    try {
      const a = startPaste('paste-QC')
      const b = startPaste('paste-QC')
      await assert.rejects(() => a.settle(pasteUrl(stateOf(b.url))), /state 与本次登录不符/)
      const credential = await a.settle(pasteUrl(stateOf(a.url)))
      assert.equal(credential.type, 'success')
    } finally { s.restore() }
  })

  test('换取失败（上游抖动）会把映射放回去，同一条地址重试成功', async () => {
    const real = globalThis.fetch
    let attempt = 0
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.includes(OAUTH_PATH)) {
        attempt += 1
        if (attempt === 1) {
          // 第一次：没有 Set-Cookie 的 302 → exchangeCode 抛错
          return new Response(null, {
            status: 302,
            headers: { location: 'https://yybadaccess.3g.qq.com/marvis_client_login/oauth_done' },
          })
        }
        return ok302()
      }
      if (u.includes('marvis_get_user_info')) {
        return new Response(JSON.stringify({ ret: 0, nick_name: '阿明', head_img_url: '' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    }
    try {
      const started = startPaste('paste-QC')
      const pasted = pasteUrl(stateOf(started.url))
      await assert.rejects(() => started.settle(pasted))
      const credential = await started.settle(pasted)
      assert.equal(credential.type, 'success')
      assert.equal(credential.access, 'TOKEN_abc123')
    } finally { globalThis.fetch = real }
  })

  test('同一个 state 只能换一次（成功后再贴判已失效）', async () => {
    const s = stubFetch()
    try {
      const started = startPaste('paste-QC')
      const pasted = pasteUrl(stateOf(started.url))
      await started.settle(pasted)
      await assert.rejects(() => started.settle(pasted), /登录流程已失效/)
    } finally { s.restore() }
  })

  test('pastedInputOf：优先取带 code 的那个参数', () => {
    const url = pasteUrl('1.5')
    assert.equal(marvisPastedInputOf(url, ''), url)
    assert.equal(marvisPastedInputOf('', url), url)
    assert.equal(marvisPastedInputOf('junk', url), url)
    assert.equal(marvisPastedInputOf(CODE, ''), CODE)
    assert.equal(marvisPastedInputOf(undefined, undefined), '')
  })

  // ── aggregate 接线：method:'code' 透传 + callback 收粘贴 + 落槽 ────────

  test('aggregate：粘贴入口 method=code，callback(粘贴内容) 经宿主 auth.set 落槽', async () => {
    const s = stubFetch()
    try {
      // 插件不直接写宿主的文件（PR #502）：落槽走 client.auth.set —— 注入假宿主收下来
      const saved = []
      const input = { client: { auth: { set: async ({ path, body }) => { saved.push({ path, body }) } } } }
      const plugin = await makeHubPlugin(marvisChannel)(input, { notify: false })
      await plugin.config({})
      assert.equal(plugin.auth.methods.length, 5)
      const manual = plugin.auth.methods.find((m) => m.label.includes('粘贴') && m.label.includes('QQ'))
      assert.ok(manual)
      const handle = await manual.authorize()
      assert.equal(handle.method, 'code')
      assert.notEqual(handle.opened, true)
      const auth = await handle.callback(pasteUrl(stateOf(handle.url)))
      assert.equal(auth.type, 'success')
      assert.equal(auth.channel, 'marvis')
      assert.match(auth.accountId, /^QQ·/)
      assert.equal(auth.guid.length, 32)
      const hit = saved.find(({ body }) => body?.channel === 'marvis')
      assert.ok(hit, '应经宿主 auth.set 写入 marvis 账号槽')
      assert.equal(hit.body.accessToken, 'TOKEN_abc123')
      assert.match(String(hit.path.id), /marvis/)
    } finally { s.restore() }
  })

  // ── UA 合并修复（MYCF711 0.2.56 同款）─────────────────────────────────

  test('chat：调用方小写 user-agent 不与我们的 UA 并存（Headers 逗号拼接 → 风控）', async () => {
    const real = globalThis.fetch
    let sent
    globalThis.fetch = async (url, init) => {
      sent = init
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })
    }
    try {
      const res = await marvisChannel.chat(
        { openid: 'o', accessToken: 't', guid: 'g', loginType: '1' },
        {
          body: { model: 'DeepSeek V4.1 Flash', messages: [{ role: 'user', content: 'hi' }] },
          headers: { 'user-agent': 'magpie/0.1.4342', 'x-custom': 'keep' },
        },
      )
      assert.equal(res.status, 200)
      const uaKeys = Object.keys(sent.headers).filter((k) => k.toLowerCase() === 'user-agent')
      assert.equal(uaKeys.length, 1, '同名 UA 只能有一条（任意大小写）')
      assert.equal(sent.headers[uaKeys[0]], 'AsyncOpenAI/Python 2.32.0', '官方 UA 不被宿主 UA 污染')
      assert.equal(sent.headers['x-custom'], 'keep', '无关头照常保留')
    } finally { globalThis.fetch = real }
  })
}