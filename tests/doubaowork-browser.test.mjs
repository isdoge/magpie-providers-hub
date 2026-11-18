// 豆包工作浏览器登录（CDP）测试 —— 全离线：假 CDP 服务（HTTP + 最小 WebSocket
// 服务端）跑在环回，哨兵放行；launch/close/findBrowser 经 browserHooks 打桩，
// 不真拉浏览器、不真杀进程。read/waitFor 走真代码（移植核心必须被测到）。
//
// 关键坑锁定：/json/list 报的 ws 地址恒 127.0.0.1（这里故意报不可达的
// 192.0.2.9:9）——不重写 host 就连不上，用例靠它证明重写存在。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

const { doubaoworkChannel, _internal } = await import('../src/doubaowork.mjs')
const { readDoubaoCookies, browserHooks } = await import('../src/doubaowork-browser.mjs')

const UID = '7300000000000000001'
const BOT = '7338286299411103781'

beforeEach(() => _internal.resetSessions())

const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const stubFetch = (routes) => {
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input.url ?? String(input))
    if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(url)) return original(input, init)
    for (const route of routes) if (url.includes(route.match)) return route.respond()
    throw new Error('未 stub 的请求：' + url)
  }
  return { restore: () => { globalThis.fetch = original } }
}
const vendorRoutes = () => [
  { match: '/passport/account/info/v2/', respond: () => json({ code: 0, data: { user_id_str: UID, screen_name: '测试用户' } }) },
  { match: '/alice/user/launch', respond: () => json({ code: 0, data: { assistant_bot_id: BOT, country: 'CN', config: { web_id: '7400000000000000001' } } }) },
]

// ── 最小 WebSocket 服务端（只服务 Network.getCookies 一条）───────────────

const wsFrame = (text) => {
  const payload = Buffer.from(text)
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
  const head = Buffer.alloc(4)
  head[0] = 0x81; head[1] = 126; head.writeUInt16BE(payload.length, 2)
  return Buffer.concat([head, payload])
}

/** 起假 CDP：cookies() 返回当前 Cookie 列表（可变，模拟「后来才登录」）。 */
async function startFakeCdp(cookies) {
  const state = { cookies }
  // upgrade 后的 socket 脱离 HTTP server 管理（closeAllConnections 管不到），
  // 自己跟踪、stop 时强毁，否则开着的事件循环吊住测试进程。
  const sockets = new Set()
  const server = createServer((req, res) => {
    const port = server.address().port
    // 故意报不可达 host：证明调用方按实际 host:port 重写 ws 地址
    const ws = `ws://192.0.2.9:9/devtools/page/1`
    if (req.url === '/json/list') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify([{ type: 'page', url: 'https://www.doubao.com/chat/', webSocketDebuggerUrl: ws }]))
    } else if (req.url === '/json/version') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ Browser: 'FakeChrome', webSocketDebuggerUrl: ws.replace('/page/1', '/browser') }))
    } else { res.writeHead(404); res.end() }
  })
  server.on('upgrade', (req, socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.on('data', (buf) => {
      const opcode = buf[0] & 0x0f
      if (opcode === 0x8) { // 客户端 close：回 close 帧并结束
        try { socket.write(Buffer.from([0x88, 0x00])) } catch { /* ignore */ }
        socket.end()
        return
      }
      let offset = 2
      let len = buf[1] & 0x7f
      if (len === 126) { len = buf.readUInt16BE(2); offset = 4 }
      const mask = buf.slice(offset, offset + 4)
      const payload = buf.slice(offset + 4, offset + 4 + len)
      const text = Buffer.from(payload.map((b, i) => b ^ mask[i % 4])).toString('utf8')
      let msg
      try { msg = JSON.parse(text) } catch { return }
      if (msg.method === 'Network.getCookies') {
        socket.write(wsFrame(JSON.stringify({ id: msg.id, result: { cookies: state.cookies } })))
      }
    })
    socket.on('error', () => {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    setCookies: (c) => { state.cookies = c },
    stop: () => new Promise((resolve) => {
      for (const s of sockets) s.destroy()
      server.close(resolve)
      server.closeAllConnections?.()
    }),
  }
}

const CDP_COOKIES = [
  { name: 'sessionid', value: 'FAKE_CDP_SESSION', domain: '.doubao.com', path: '/', expires: 0, secure: true, httpOnly: true },
  { name: 'ttwid', value: 'FAKE_CDP_TTWID', domain: '.doubao.com', path: '/', expires: 0, secure: true, httpOnly: true },
]

/** hook 打桩 + 还原。 */
function stubHooks({ launched, closed, browser = 'fake-exe' }) {
  const original = { ...browserHooks }
  browserHooks.findBrowser = () => browser
  browserHooks.launch = async (url) => { launched.push(url); return { port: launched.port, dir: '', child: { pid: 0 } } }
  browserHooks.close = async (s) => { closed.push(s) }
  return () => Object.assign(browserHooks, original)
}

// ── 用例 ────────────────────────────────────────────────────────────────

test('readDoubaoCookies：ws 地址按可达 host 重写 + 归一；没 sessionid 报清楚', async () => {
  const cdp = await startFakeCdp(CDP_COOKIES)
  try {
    const cookies = await readDoubaoCookies(cdp.port)
    assert.equal(cookies.length, 2)
    assert.equal(cookies[0].domain, 'doubao.com', 'domain 去点')
    assert.equal(cookies[0].httpOnly, true)
    cdp.setCookies([{ name: 'ttwid', value: 'x', domain: '.doubao.com' }])
    await assert.rejects(() => readDoubaoCookies(cdp.port), /没有登录豆包/)
  } finally {
    await cdp.stop()
  }
})

test('浏览器登录（桌面）：拉一次性窗口 → CDP 读到 sessionid → 服务端验身份后 settle', async () => {
  const cdp = await startFakeCdp(CDP_COOKIES)
  const stub = stubFetch(vendorRoutes())
  const launched = []; launched.port = cdp.port
  const closed = []
  const restoreHooks = stubHooks({ launched, closed })
  try {
    const started = await doubaoworkChannel.beginLogin(undefined, { arg: 'browser' })
    assert.equal(started.opened, true, '窗口自己拉了，宿主别重开')
    assert.ok(!started.instructions.includes('http'), 'instructions 不嵌地址')
    assert.match(started.instructions, /一次性|无需粘贴/)
    const credential = await started.result
    assert.equal(credential.uid, UID)
    assert.equal(credential.nickname, '测试用户')
    assert.equal(credential.bot, BOT)
    assert.match(credential.cookie, /sessionid=FAKE_CDP_SESSION/)
    assert.equal(launched.length, 1, '走 hook 拉窗口（测试不真 spawn）')
    assert.equal(closed.length, 1, 'settle 后关一次性窗口')
  } finally {
    restoreHooks(); stub.restore(); await cdp.stop()
  }
})

test('浏览器登录（无界面远程模式）：不拉窗口，读外部调试端口；ws 重写生效', async () => {
  const cdp = await startFakeCdp(CDP_COOKIES)
  const stub = stubFetch(vendorRoutes())
  const launched = []; launched.port = cdp.port
  const closed = []
  const restoreHooks = stubHooks({ launched, closed })
  try {
    const started = await doubaoworkChannel.beginLogin(undefined, {
      arg: 'browser',
      options: { doubaoCdpHost: 'localhost', doubaoCdpPort: cdp.port },
    })
    assert.equal(started.opened, undefined, '远程模式不代开窗口')
    assert.match(started.instructions, /外部浏览器/)
    const credential = await started.result
    assert.equal(credential.uid, UID)
    assert.equal(launched.length, 0, '远程模式绝不拉本机窗口')
    assert.equal(closed.length, 0, '用户的窗口不关')
  } finally {
    restoreHooks(); stub.restore(); await cdp.stop()
  }
})

test('浏览器登录：用户后来才登录 → 轮询等到 sessionid 再 settle', async () => {
  const cdp = await startFakeCdp([])
  const stub = stubFetch(vendorRoutes())
  const launched = []; launched.port = cdp.port
  const closed = []
  const restoreHooks = stubHooks({ launched, closed })
  try {
    const started = await doubaoworkChannel.beginLogin(undefined, { arg: 'browser' })
    setTimeout(() => cdp.setCookies(CDP_COOKIES), 2_300)
    const credential = await started.result
    assert.match(credential.cookie, /sessionid=FAKE_CDP_SESSION/)
  } finally {
    restoreHooks(); stub.restore(); await cdp.stop()
  }
})

test('浏览器登录：close() 取消 → result reject + 关窗口', async () => {
  const cdp = await startFakeCdp([])
  const launched = []; launched.port = cdp.port
  const closed = []
  const restoreHooks = stubHooks({ launched, closed })
  try {
    const started = await doubaoworkChannel.beginLogin(undefined, { arg: 'browser' })
    started.close()
    await assert.rejects(() => started.result, /已取消/)
    assert.equal(closed.length, 1)
  } finally {
    restoreHooks(); await cdp.stop()
  }
})

test('无界面且没配远程端口：明确报错指向 doubaoCdpHost / 粘贴路', async () => {
  const launched = []
  const closed = []
  const restoreHooks = stubHooks({ launched, closed, browser: null })
  try {
    const started = await doubaoworkChannel.beginLogin(undefined, { arg: 'browser' })
    await assert.rejects(() => started.result, /doubaoCdpHost|粘贴 Cookie/)
    assert.equal(launched.length, 0)
  } finally {
    restoreHooks()
  }
})

test('远程端口校验：fetch 禁用端口直接拒收', async () => {
  await assert.rejects(
    () => doubaoworkChannel.beginLogin(undefined, { arg: 'browser', options: { doubaoCdpHost: 'localhost', doubaoCdpPort: 6000 } }),
    /禁用端口/,
  )
})