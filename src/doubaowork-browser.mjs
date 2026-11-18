// 豆包工作浏览器登录的 CDP 读取层 —— 移植自上游 miaocell/magpie-doubao-work-auth
// 的 lib/cdp.mjs（MIT，署名见 NOTICE.md）。上游只探本机 127.0.0.1 的调试端口；
// 本仓库为 **无界面 Linux** 适配出远程模式：调试端口可以在用户自己的外部浏览器上，
// 经可信网络（tailscale 等）可达即可，插件只读不拉窗口。
//
// 两种模式（调用方 doubaowork.mjs 按插件选项分流）：
//  · 桌面：magicrew-browser.launchLoginBrowser 拉一次性窗口（spawn 例外，
//    2026-11-17 用户批准，AGENTS.md 已登记），用户扫码/短信登录后读 Cookie；
//  · 无界面：options.doubaoCdpHost/doubaoCdpPort 指向外部浏览器调试端口，
//    用户在那只浏览器里登录，服务端轮询读 Cookie，免粘贴。
//
// ⚠️ 远程模式关键坑：Chrome/Edge 的 /json/list 与 /json/version 报的
//    webSocketDebuggerUrl **恒为 127.0.0.1**（它不知道自己被隧道转发）。
//    不重写 host，服务端会连到自己的回环 → 读不到外部浏览器。必须按配置的
//    host:port 重写 ws 地址。
//
// ⚠️ 安全口径：调试端口等于浏览器完全控制权，只应在可信网络里暴露；
//    选项不填 = 桌面行为一格不变（只探本机一次性窗口）。
// DPAPI 读桌面客户端那条路**仍未移植**（敏感面，等另行批准）。

import { launchLoginBrowser, closeSession, findBrowser } from './magicrew-browser.mjs'

const DEFAULT_HOST = '127.0.0.1'

/** 把调试服务报的 ws 地址重写为我们实际可达的 host:port（见文件头关键坑）。 */
const rewriteWs = (url, host, port) => String(url).replace(/^wss?:\/\/[^/]+/, `ws://${host}:${port}`)

/** 极简 CDP 会话：只用到 Network.getCookies 一条（上游 connect 同构）。 */
function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const pending = new Map()
    let nextId = 1
    const timer = setTimeout(() => {
      try { socket.close() } catch { /* ignore */ }
      reject(new Error('连浏览器调试端口超时。'))
    }, 8_000)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolve({
        send(method, params) {
          const id = nextId++
          return new Promise((resolveCall, rejectCall) => {
            pending.set(id, { resolve: resolveCall, reject: rejectCall })
            socket.send(JSON.stringify({ id, method, params }))
            setTimeout(() => {
              if (!pending.has(id)) return
              pending.delete(id)
              rejectCall(new Error(`${method} 超时。`))
            }, 10_000)
          })
        },
        close() { try { socket.close() } catch { /* ignore */ } },
      })
    })
    socket.addEventListener('message', (event) => {
      let message
      try { message = JSON.parse(String(event.data)) } catch { return }
      const slot = message.id ? pending.get(message.id) : undefined
      if (!slot) return
      pending.delete(message.id)
      if (message.error) slot.reject(new Error(message.error.message || 'CDP 调用失败。'))
      else slot.resolve(message.result)
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('连不上浏览器调试端口。'))
    })
  })
}

/**
 * 读一个站点在浏览器里的 Cookie（Network.getCookies，页面级命令先挂 page target）。
 * host 默认回环（桌面一次性窗口）；远程模式传外部可达 host。
 */
export async function readDoubaoCookies(port, host = DEFAULT_HOST) {
  const httpBase = `http://${host}:${port}`
  let pageUrl
  try {
    const list = await fetch(`${httpBase}/json/list`, { signal: AbortSignal.timeout(2_000) }).then((r) => r.json())
    const page = Array.isArray(list) ? list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) : undefined
    if (page) pageUrl = rewriteWs(page.webSocketDebuggerUrl, host, port)
  } catch { /* 用浏览器级连接兜底 */ }
  if (!pageUrl) {
    const version = await fetch(`${httpBase}/json/version`, { signal: AbortSignal.timeout(2_000) }).then((r) => r.json())
    if (version?.webSocketDebuggerUrl) pageUrl = rewriteWs(version.webSocketDebuggerUrl, host, port)
  }
  if (!pageUrl) throw new Error(`连不上浏览器调试端口 ${host}:${port}（确认浏览器带 --remote-debugging-port 启动且端口可达）。`)
  const session = await connect(pageUrl)
  try {
    const result = await session.send('Network.getCookies', { urls: ['https://doubao.com/', 'https://www.doubao.com/'] })
    const list = Array.isArray(result?.cookies) ? result.cookies : []
    const cookies = list.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: String(cookie.domain || 'doubao.com').replace(/^\./, ''),
      path: cookie.path || '/',
      expires: Math.floor(Number(cookie.expires) || 0),
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
    }))
    if (!cookies.some((c) => (c.name === 'sessionid' || c.name === 'sessionid_ss') && c.value)) {
      throw new Error('这个浏览器里没有登录豆包（找不到 sessionid）。请先在该浏览器登录 doubao.com。')
    }
    return cookies
  } finally {
    session.close()
  }
}

/** 轮询直到用户在浏览器里完成登录（拿到 sessionid）或超时。signal 取消即退
 *  （调用方 close()/settle 后必须 abort，否则睡眠定时器吊住进程）。 */
export async function waitForDoubaoCookies({ port, host = DEFAULT_HOST }, { timeout = 300_000, interval = 2_000, signal } = {}) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    try {
      return await readDoubaoCookies(port, host)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => {
      const t = setTimeout(resolve, interval)
      signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
    })
  }
  signal?.throwIfAborted()
  throw new Error(`等了 5 分钟没检测到豆包登录（${String(lastError?.message || lastError).slice(0, 160)}）。可以重试，或改用「粘贴 Cookie 登录」。`)
}

/** 测试锚点：用例替换 launch/read/close，不真拉浏览器、不真杀进程。 */
export const browserHooks = {
  launch: (url) => launchLoginBrowser(url),
  read: (target, opts) => waitForDoubaoCookies(target, opts),
  close: (session) => closeSession(session),
  findBrowser: () => findBrowser(),
}