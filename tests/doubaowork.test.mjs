// 豆包工作（doubaowork）渠道测试 —— 全部离线：上游按路由打桩，
// 127.0.0.1 本地登录载体页直通真 fetch（setup.mjs 哨兵放行环回）。
// 夹具一律用明显假 token（FAKE_…），绝不落真实凭据。
//
// 覆盖：登录 settle / 校验失败不 settle、apiAuth 兜底、refresh 诚实 throw、
// expired 判据、目录归一（基线 + 在线）、额度滚动分档、签到三态（只读）、
// chat 非流式/流式/工具/Responses 折叠/图片拒绝/错误码映射/临时会话清理。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const { doubaoworkChannel, _internal } = await import('../src/doubaowork.mjs')

// ── 夹具常量（全是假的）─────────────────────────────────────────────────

const UID = '7300000000000000001'
const BOT = '7338286299411103781'
const CONV_ID = '7500000000000000001'
const GROUP = 'pc_incentive_task_mvp_v3'

/** 每个用例独立 Cookie，避免会话缓存（ready/目录/签到）串味。 */
let cookieSeq = 0
const freshCredential = () => {
  cookieSeq += 1
  return { cookie: `sessionid=FAKE_SESSION_${cookieSeq}; sessionid_ss=FAKE_SESSION_${cookieSeq}_SS; ttwid=FAKE_TTWID` }
}

beforeEach(() => _internal.resetSessions())

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
})

/** SSE 帧序列 → Response（event:/data: 形态照上游真机抓包）。 */
const sse = (frames) => new Response(
  frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''),
  { headers: { 'content-type': 'text/event-stream' } },
)

/** 照 loomy 的 stubFetch：环回直通，其余按路由打桩，漏打桩立刻报错。 */
const stubFetch = (routes) => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input.url ?? input.href ?? String(input))
    if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(url)) return original(input, init)
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body })
    for (const route of routes) if (url.includes(route.match)) return route.respond({ url, calls, init })
    throw new Error('未 stub 的请求：' + url)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

// ── 上游路由工厂 ────────────────────────────────────────────────────────

const identityRoute = (data = { user_id_str: UID, screen_name: '测试用户' }) => ({
  match: '/passport/account/info/v2/',
  respond: () => json({ code: 0, data }),
})

const launchRoute = (extra = {}) => ({
  match: '/alice/user/launch',
  respond: () => json({
    code: 0,
    data: {
      assistant_bot_id: BOT,
      country: 'CN',
      config: { web_id: '7400000000000000001', ttwid: 'FAKE_TTWID_FROM_LAUNCH' },
      ug_campaign_info: { campaign_group_code: GROUP },
      ...extra,
    },
  }),
})

/** brief_list 基本只回 entry_list（上游实测）→ 渠道应落基线菜单。 */
const briefListRoute = (data = { entry_list: [] }) => ({
  match: '/alice/slot/action_bar_v3/brief_list',
  respond: () => json({ code: 0, data }),
})

/** IM 两条：认领（recent_conv）+ 删除（batch_del）。从请求体回显，校验归属。 */
function imRoutes(state) {
  return [
    {
      match: '/im/chain/recent_conv',
      respond: ({ init }) => {
        const up = JSON.parse(init.body).uplink_body.pull_recent_conv_chain_uplink_body
        state.pulls.push(up)
        return json({
          status_code: 0,
          downlink_body: {
            pull_recent_conv_chain_downlink_body: {
              user_id: UID,
              cells: state.lastLocalId ? [{
                conversation: {
                  conv_extra: { local_conversation_id: state.lastLocalId },
                  bot_id: BOT,
                  conversation_id: CONV_ID,
                },
              }] : [],
              has_more: false,
              next_conv_version: '0',
            },
          },
        })
      },
    },
    {
      match: '/im/conversation/batch_del_user_conv',
      respond: ({ init }) => {
        const up = JSON.parse(init.body).uplink_body.batch_delete_user_conversation_uplink_body
        state.deletes.push(up)
        return json({
          status_code: 0,
          downlink_body: {
            batch_delete_user_conversation_downlink_body: {
              result: Object.fromEntries(up.conversation_id.map((id) => [id, true])),
            },
          },
        })
      },
    },
  ]
}

/** 默认正文帧：SSE_ACK（回显 local id）→ 两段替换式正文 → 正常结束。 */
function textFrames(localId, text = '答案是 42', { reasoning, end = true, ackId } = {}) {
  const frames = [
    ['SSE_ACK', { ack_client_meta: { local_conversation_id: ackId ?? localId, conversation_id: CONV_ID } }],
  ]
  if (reasoning) {
    frames.push(['STREAM_MSG_NOTIFY', {
      meta: { message_id: 'm1' },
      content: { content_block: [{ block_id: 'b0', block_type: 10040, parent_id: '', content: { text_block: { text: reasoning } } }] },
    }])
  }
  const cut = Math.max(1, Math.floor(text.length / 2))
  for (const piece of [text.slice(0, cut), text]) {
    frames.push(['STREAM_MSG_NOTIFY', {
      meta: { message_id: 'm1' },
      content: { content_block: [{ block_id: 'b1', block_type: 10000, parent_id: '', content: { text_block: { text: piece } } }] },
    }])
  }
  if (end) frames.push(['SSE_REPLY_END', { end_type: 3 }])
  return frames
}

/** chat/completion 路由：记下请求报文，按 opts 回 SSE / JSON 错误。 */
function chatRoute(state, opts = {}) {
  return {
    match: '/chat/completion',
    respond: ({ url, init }) => {
      const body = JSON.parse(init.body)
      state.lastLocalId = body.client_meta.local_conversation_id
      state.chatCalls.push({ url, body, headers: init.headers })
      if (opts.jsonError) return json(opts.jsonError)
      const frames = opts.frames
        ? opts.frames(body.client_meta.local_conversation_id)
        : textFrames(body.client_meta.local_conversation_id, opts.text ?? '答案是 42', opts)
      return sse(frames)
    },
  }
}

/** 一套基础路由（身份/launch/目录/IM），overrides 优先匹配。 */
function baseRoutes(state, overrides = []) {
  return [...overrides, identityRoute(), launchRoute(), briefListRoute(), ...imRoutes(state)]
}

const newState = () => ({ chatCalls: [], pulls: [], deletes: [], lastLocalId: undefined })

const chatBody = (extra = {}) => ({
  model: 'doubao-auto',
  messages: [{ role: 'user', content: '1+1 等于几？' }],
  ...extra,
})

// ── 登录：本地载体页粘贴 Cookie ─────────────────────────────────────────

test('beginLogin：立刻返回载体页 URL；粘贴 Cookie 校验通过后 settle 出凭据', async () => {
  const state = newState()
  const stub = stubFetch(baseRoutes(state))
  try {
    const started = await doubaoworkChannel.beginLogin(undefined, {})
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/$/, '载体页必须绑回环随机端口')
    assert.ok(started.result instanceof Promise, 'result 必须是 Promise（不得 await 用户登录）')

    // 载体页真的能打开（环回直通真 fetch）
    const page = await fetch(started.url)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /登录豆包工作/, '载体页应渲染粘贴说明')

    const credential = freshCredential()
    const post = await fetch(new URL('/cookie', started.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cookie: credential.cookie }),
    })
    const verdict = await post.json()
    assert.equal(verdict.ok, true, `Cookie 校验应通过：${verdict.message ?? ''}`)

    const settled = await started.result
    assert.equal(settled.cookie, credential.cookie)
    assert.equal(settled.uid, UID, 'settle 必须带服务端确认的 uid')
    assert.equal(settled.nickname, '测试用户')
    assert.equal(settled.bot, BOT)
    assert.equal(settled.expires_at, undefined, 'Cookie 寿命未知，不许猜一个到期时间')
  } finally { stub.restore() }
})

test('beginLogin：Cookie 校验失败不 settle（可重试）；close() 能取消', async () => {
  const state = newState()
  // 身份接口回游客（uid=0）→ 校验必失败
  const stub = stubFetch(baseRoutes(state, [identityRoute({ user_id_str: '0', is_visitor_account: true })]))
  let started
  try {
    started = await doubaoworkChannel.beginLogin(undefined, {})
    const post = await fetch(new URL('/cookie', started.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cookie: 'sessionid=FAKE_BAD_COOKIE' }),
    })
    const verdict = await post.json()
    assert.equal(verdict.ok, false, '游客 Cookie 必须被拒')
    assert.match(verdict.message, /失效|重新登录/)

    // 失败后 result 仍悬着（用户可以换一份 Cookie 重试）
    let settled = false
    started.result.then(() => { settled = true }, () => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(settled, false, '校验失败不该把登录流程直接判死')
  } finally {
    started?.close()
    stub.restore()
  }
  await assert.rejects(() => started.result, /已关闭/, 'close() 应以取消收场')
})

test('apiAuth 兜底：keyField=cookie；refresh 诚实 throw；expired 只认显式 expires_at', async () => {
  assert.equal(doubaoworkChannel.apiAuth.keyField, 'cookie', 'magpie 原生粘贴框必须翻译成 {cookie}')
  assert.ok(doubaoworkChannel.loginMethods.length >= 1)
  assert.ok(doubaoworkChannel.loginMethods.length + 1 <= 3, '登录入口总数（含 apiAuth）不得超 3')

  await assert.rejects(() => doubaoworkChannel.refresh({ cookie: 'sessionid=FAKE' }), /无自动续期/,
    '没有续期端点就必须 throw，不许假装能续')

  assert.equal(doubaoworkChannel.expired({ cookie: 'sessionid=FAKE' }), false, '无 expires_at 视为不过期')
  assert.equal(doubaoworkChannel.expired({ expires_at: Date.now() - 1000 }), true)
  assert.equal(doubaoworkChannel.expired({ expires_at: Date.now() + 60_000 }), false)
})

// ── 目录 ────────────────────────────────────────────────────────────────

test('catalog：brief_list 落空 → 基线菜单；id 无斜杠、倍率进 rate、cost 一律 0', async () => {
  const state = newState()
  const stub = stubFetch(baseRoutes(state))
  try {
    const models = await doubaoworkChannel.catalog(freshCredential())
    const ids = Object.keys(models)
    assert.ok(ids.includes('doubao-auto'), '数字键 9 应归一成 doubao-auto')
    assert.ok(ids.every((id) => !id.includes('/')), '模型 id 不许带斜杠')
    assert.ok(ids.every((id) => /^[\x20-\x7e]+$/.test(id)), '模型 id 必须纯 ASCII')

    const auto = models['doubao-auto']
    assert.equal(auto.rate, 0, '「小额免费」→ rate 0')
    assert.deepEqual(auto.cost, { input: 0, output: 0, cache: { read: 0, write: 0 } },
      '豆包倍率与 token 单价量纲不同，cost 不许编价格')
    assert.equal(auto.limit.context, 256000)
    assert.equal(auto.tool_call, true)
    assert.deepEqual(Object.keys(auto.variants).sort(), ['auto', 'high', 'low'], '推理档位来自 levels')
    assert.equal(auto.capabilities.input.image, false, '图片发不了，能力位必须如实')

    const kimi = models['doubao-kimi-k3-1-pro']
    assert.equal(kimi.rate, 0.95, '「0.95x」倍率应进 magpie 原生 rate')
    assert.ok(!ids.includes('doubao-pro'), 'need_upgrade 的条目不该出现在目录里')
  } finally { stub.restore() }
})

test('catalog：在线菜单可用时优先在线（office 模式 + person- 前缀/日期后缀归一）', async () => {
  const state = newState()
  const online = {
    modeSelectData: {
      menuConfV2: {
        mode_list: {
          item_list: [{
            mode_id: '3', agent_mode: 1, default_conversation_mode: 'office',
            model_list: {
              item_list: [{
                model_item_key: 'person-test-model-261111',
                name: '测试模型',
                item_id: 10001,
                conversation_mode_list: ['office'],
                reasoning_effort_config: { option_list: [{ level: 3 }, { level: 5 }], default_level: 5 },
                model_extra_params: { total_window_size: '128000' },
                tag_list: [{ text: '0.5x' }],
              }],
            },
          }],
        },
      },
    },
  }
  const stub = stubFetch(baseRoutes(state, [briefListRoute(online)]))
  try {
    const models = await doubaoworkChannel.catalog(freshCredential())
    const entry = models['doubao-test-model']
    assert.ok(entry, 'person- 前缀与 -261111 日期后缀应被剥掉')
    assert.equal(entry.rate, 0.5)
    assert.equal(entry.limit.context, 128000)
  } finally { stub.restore() }
})

// ── 额度（滚动指针分档）─────────────────────────────────────────────────

test('usage：三池窗口走 expiryBandedWindows；amount/limit/unit 齐全；签到行只读展示', async () => {
  const state = newState()
  const now = Date.now()
  const soonSec = Math.floor((now + 2 * 86_400_000) / 1000) // 秒制
  const farMs = now + 60 * 86_400_000                       // 毫秒制
  const summary = {
    window_limit_section: {
      window_limit_groups: [{
        feature_group_name: '会员积分',
        window_limits: [
          { used_amount: '100', total_amount: '1000', end_time: soonSec, window_type: 1 },
          { used_amount: 0, total_amount: 500, end_time: farMs, window_type: 2 },
        ],
      }],
    },
    incentive_quota_section: {
      window_limit_groups: [{
        feature_group_name: '活动赠送',
        window_limits: [{ used_amount: 10, total_amount: 10, end_time: soonSec }],
      }],
    },
  }
  const detail = {
    tasks: [{
      campaign_code: 'daily_signin', task_status: 2,
      daily_checkin: { checked_in_today: true, continuous_days: 3, reward: { reward_amount: 50 } },
    }],
  }
  const stub = stubFetch(baseRoutes(state, [
    { match: '/alice/commerce/sale/subscription/quota/summary/', respond: () => json({ code: 0, data: summary }) },
    { match: '/alice/commerce/sale/subscription/overview/', respond: () => json({ code: 0, data: { product_name: '会员' } }) },
    { match: '/alice/ug/campaign/v3/detail/', respond: () => json({ code: 0, data: detail }) },
  ]))
  try {
    const rows = await doubaoworkChannel.usage(freshCredential())
    const soon = rows.find((r) => r.name.startsWith('会员积分 · 窗口1'))
    const far = rows.find((r) => r.name.startsWith('会员积分 · 窗口2'))
    const spent = rows.find((r) => r.name.startsWith('活动赠送'))
    assert.ok(soon && far && spent, `三池窗口都应在：${rows.map((r) => r.name).join(' | ')}`)

    assert.match(soon.name, /临期·\d+天/, '最早到期的未耗尽桶必须标临期（滚动指针）')
    assert.match(far.name, /长期/, '晚到期的桶标长期')
    assert.equal(soon.amount, 100, 'amount=已用（magpie 语义）')
    assert.equal(soon.limit, 1000)
    assert.equal(soon.unit, '积分')
    assert.equal(soon._qty, 900, '_qty=这批剩余量（tierSummarize 求和用）')
    assert.match(soon.display, /剩余 900 · \d{2}-\d{2} 到期/)
    assert.ok(soon.resetsAt, '窗口必须带 resetsAt（走势图投影虚线靠它）')
    assert.equal(new Date(soon.resetsAt).getTime(), soonSec * 1000, '秒制 end_time 应归一成绝对毫秒')
    assert.equal(spent.aside, true, '耗尽的桶折叠进 aside')
    assert.match(spent.name, /已耗尽/)

    const checkinRow = rows.find((r) => r.name.startsWith('每日签到'))
    assert.ok(checkinRow, '签到状态应做成一条展示行')
    assert.match(checkinRow.name, /今日已签 · 连续 3 天/)
    assert.equal(checkinRow.display, '已领取')
  } finally { stub.restore() }
})

test('usage：额度汇总取不到 → 明说「暂时取不到」，不编数字', async () => {
  const state = newState()
  const stub = stubFetch(baseRoutes(state, [
    { match: '/alice/commerce/sale/subscription/quota/summary/', respond: () => json({ code: 500, message: 'boom' }) },
    { match: '/alice/commerce/sale/subscription/overview/', respond: () => json({ code: 0, data: {} }) },
  ]))
  try {
    const rows = await doubaoworkChannel.usage(freshCredential())
    assert.equal(rows.length, 1)
    assert.match(rows[0].display, /暂时取不到/)
  } finally { stub.restore() }
})

// ── 签到（纯只读；hub 语义 claimed）─────────────────────────────────────

const campaignDetail = (daily, status = 2) => ({
  tasks: [{ campaign_code: 'daily_signin', task_status: status, daily_checkin: daily }],
})

test('checkin：今天已签 → claimed（不是 done）+ credit/streak；绝不发领取请求', async () => {
  const state = newState()
  const stub = stubFetch(baseRoutes(state, [
    {
      match: '/alice/ug/campaign/v3/detail/',
      respond: () => json({ code: 0, data: campaignDetail({ checked_in_today: true, continuous_days: 5, reward: { reward_amount: 50 } }) }),
    },
  ]))
  try {
    const result = await doubaoworkChannel.checkin(freshCredential())
    assert.equal(result.outcome, 'claimed', 'hub 语义：今天已领过 = claimed')
    assert.equal(result.credit, 50)
    assert.equal(result.streak, 5)
    const writes = stub.calls.filter((c) => c.url.includes('/alice/ug/') && !c.url.includes('/detail/'))
    assert.equal(writes.length, 0, '签到必须纯只读，不许发 claim 写请求')
  } finally { stub.restore() }
})

test('checkin：未投放（task_status=1）→ ineligible；无活动组 → inactive', async () => {
  const state = newState()
  const stub = stubFetch(baseRoutes(state, [
    {
      match: '/alice/ug/campaign/v3/detail/',
      respond: () => json({ code: 0, data: campaignDetail({ checked_in_today: false, reward: { reward_amount: 50 } }, 1) }),
    },
  ]))
  try {
    const result = await doubaoworkChannel.checkin(freshCredential())
    assert.equal(result.outcome, 'ineligible', '账号没被投放活动 → ineligible，不是 failed')
    assert.match(result.message, /投放/)
  } finally { stub.restore() }

  // launch 不带活动组 → inactive（无签到绝不 failed）
  const stub2 = stubFetch([
    identityRoute(),
    launchRoute({ ug_campaign_info: { campaign_group_code: '' } }),
    briefListRoute(),
  ])
  try {
    const result = await doubaoworkChannel.checkin(freshCredential())
    assert.equal(result.outcome, 'inactive')
  } finally { stub2.restore() }
})

// ── chat：非流式 + 上游报文 + 临时会话清理 ──────────────────────────────

test('chat 非流式：正文聚合正确；上游报文锁死关键参数；临时会话用完即删', async () => {
  const state = newState()
  const stub = stubFetch(baseRoutes(state, [chatRoute(state)]))
  try {
    const response = await doubaoworkChannel.chat(freshCredential(), { body: chatBody() })
    assert.equal(response.status, 200)
    const completion = await response.json()
    assert.equal(completion.object, 'chat.completion')
    assert.equal(completion.choices[0].message.content, '答案是 42')
    assert.equal(completion.choices[0].finish_reason, 'stop')
    assert.ok(completion.usage.total_tokens > 0, 'usage 必填（Codex 靠它判上下文）')

    assert.equal(state.chatCalls.length, 1)
    const { url, body, headers } = state.chatCalls[0]
    assert.match(url, /aid=497858/, 'aid 必须 497858（1044603 是另一条产品线）')
    assert.match(url, /real_aid=497858/)
    assert.match(headers.Cookie, /FAKE_SESSION_/, '请求必须带上粘贴的 Cookie')
    assert.equal(headers['Agw-Js-Conv'], 'str')
    assert.match(body.client_meta.local_conversation_id, /^local_[a-f0-9]{32}$/, '临时会话标识格式')
    assert.equal(body.option.conversation_mode, 2)
    assert.equal(body.option.model_config.model_item_key, '9', 'doubao-auto → 数字键 9')
    assert.equal(body.option.need_create_conversation, true)
    assert.equal(body.messages[0].content_block[0].block_type, 10000)

    // 清理：SSE_ACK 已带 conversation_id → 直接删，不必再翻历史认领
    assert.equal(state.pulls.length, 0, 'ACK 已给会话 id 时不该多打一次 recent_conv')
    assert.equal(state.deletes.length, 1, '用完即删')
    assert.deepEqual(state.deletes[0].conversation_id, [CONV_ID])
    assert.equal(state.deletes[0].conversation_type, 3)
    assert.equal(state.deletes[0].delete_all, false, '绝不许 delete_all')
  } finally { stub.restore() }
})

test('chat 清理：ACK 没带会话 id 时，走 recent_conv 认领后再删（归属校验）', async () => {
  const state = newState()
  const stub = stubFetch(baseRoutes(state, [chatRoute(state, {
    frames: (localId) => [
      ['SSE_ACK', { ack_client_meta: { local_conversation_id: localId } }],
      ...textFrames(localId).slice(1),
    ],
  })]))
  try {
    const response = await doubaoworkChannel.chat(freshCredential(), { body: chatBody() })
    assert.equal(response.status, 200)
    assert.ok(state.pulls.length >= 1, '没有现成 id 就必须翻历史认领')
    assert.equal(state.deletes.length, 1)
    assert.deepEqual(state.deletes[0].conversation_id, [CONV_ID])
  } finally { stub.restore() }
})

test('chat 流式：OpenAI SSE 形状，增量拼回全文，[DONE] 收尾', async () => {
  const state = newState()
  const stub = stubFetch(baseRoutes(state, [chatRoute(state)]))
  try {
    const response = await doubaoworkChannel.chat(freshCredential(), { body: chatBody({ stream: true }) })
    assert.match(response.headers.get('content-type'), /text\/event-stream/)
    const text = await response.text()
    assert.ok(text.endsWith('data: [DONE]\n\n'), '必须以 [DONE] 收尾')
    let content = ''
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ') || line.includes('[DONE]')) continue
      const chunk = JSON.parse(line.slice(6))
      assert.equal(chunk.object, 'chat.completion.chunk')
      content += chunk.choices[0].delta.content ?? ''
    }
    assert.equal(content, '答案是 42')
    assert.equal(state.deletes.length, 1, '流式读完也要清理临时会话')
  } finally { stub.restore() }
})

test('chat：思考块（10040）进 reasoning_content，不混进正文', async () => {
  const state = newState()
  const stub = stubFetch(baseRoutes(state, [chatRoute(state, { reasoning: '先算一下' })]))
  try {
    const response = await doubaoworkChannel.chat(freshCredential(), { body: chatBody() })
    const completion = await response.json()
    assert.equal(completion.choices[0].message.content, '答案是 42')
    assert.equal(completion.choices[0].message.reasoning_content, '先算一下')
  } finally { stub.restore() }
})

// ── chat：工具 / 结构化 / Responses / 图片 ──────────────────────────────

const weatherTool = {
  type: 'function',
  function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
}

test('chat 工具：JSON 文本协议解成 tool_calls；未声明的工具 → 502', async () => {
  const state = newState()
  const reply = JSON.stringify({ content: '', tool_calls: [{ name: 'get_weather', arguments: { city: '北京' } }] })
  const stub = stubFetch(baseRoutes(state, [chatRoute(state, { text: reply })]))
  try {
    const response = await doubaoworkChannel.chat(freshCredential(), { body: chatBody({ tools: [weatherTool] }) })
    assert.equal(response.status, 200)
    const completion = await response.json()
    const message = completion.choices[0].message
    assert.equal(completion.choices[0].finish_reason, 'tool_calls')
    assert.equal(message.tool_calls[0].function.name, 'get_weather')
    assert.deepEqual(JSON.parse(message.tool_calls[0].function.arguments), { city: '北京' })
  } finally { stub.restore() }

  const state2 = newState()
  const badReply = JSON.stringify({ content: '', tool_calls: [{ name: 'not_declared', arguments: {} }] })
  const stub2 = stubFetch(baseRoutes(state2, [chatRoute(state2, { text: badReply })]))
  try {
    const response = await doubaoworkChannel.chat(freshCredential(), { body: chatBody({ tools: [weatherTool] }) })
    assert.equal(response.status, 502, '未声明的工具必须拒绝，不能放行给调用方执行')
    const payload = await response.json()
    assert.equal(payload.error.code, 'invalid_tool_response')
  } finally { stub2.restore() }
})

test('chat Responses 折叠：有 input 无 messages → 按 Responses 协议回 response 对象', async () => {
  const state = newState()
  const stub = stubFetch(baseRoutes(state, [chatRoute(state)]))
  try {
    const response = await doubaoworkChannel.chat(freshCredential(), {
      body: { model: 'doubao-auto', input: '你好', instructions: '简短回答' },
    })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.object, 'response', 'hub loader 不传 URL，只能按 body 形状判 Responses')
    assert.equal(payload.status, 'completed')
    assert.equal(payload.output[0].content[0].text, '答案是 42')
    assert.ok(payload.usage.input_tokens > 0)
    // instructions 应折进上游提示词
    assert.match(state.chatCalls[0].body.messages[0].content_block[0].content.text_block.text, /简短回答/)
  } finally { stub.restore() }
})

test('chat 图片：明确拒绝 400（a_bogus 签名造不出），不静默丢图', async () => {
  const state = newState()
  const stub = stubFetch(baseRoutes(state, [chatRoute(state)]))
  try {
    const response = await doubaoworkChannel.chat(freshCredential(), {
      body: chatBody({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '看看这张图' },
            { type: 'image_url', image_url: { url: 'https://example.invalid/a.png' } },
          ],
        }],
      }),
    })
    assert.equal(response.status, 400)
    const payload = await response.json()
    assert.equal(payload.error.code, 'image_not_supported')
    assert.match(payload.error.message, /图片/)
    assert.equal(state.chatCalls.length, 0, '拒绝图片时不该打上游')
  } finally { stub.restore() }
})

// ── chat：错误映射（绝不 throw，全部回原始 Response）────────────────────

test('chat 错误码：710012001 → 401 + 登录失效标记；710022004 → 403 不标账号', async () => {
  const state = newState()
  const stub = stubFetch(baseRoutes(state, [chatRoute(state, { jsonError: { error_code: 710012001, error_msg: 'login invalid' } })]))
  try {
    const response = await doubaoworkChannel.chat(freshCredential(), { body: chatBody() })
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('x-magpie-sign-in'), 'expired', '登录失效必须标账号')
    const payload = await response.json()
    assert.equal(payload.error.type, 'provider_error')
    assert.equal(payload.error.code, 'sign_in_expired')
  } finally { stub.restore() }

  const state2 = newState()
  const stub2 = stubFetch(baseRoutes(state2, [chatRoute(state2, { jsonError: { error_code: 710022004, error_msg: 'rate limited' } })]))
  try {
    const response = await doubaoworkChannel.chat(freshCredential(), { body: chatBody() })
    assert.equal(response.status, 403)
    assert.equal(response.headers.get('x-magpie-sign-in'), null, '风控验证码不标账号（过掉验证还能用）')
    const payload = await response.json()
    assert.equal(payload.error.code, 'captcha_required')
    assert.match(payload.error.message, /人工验证/)
  } finally { stub2.restore() }
})

test('chat：STREAM_ERROR / 提前结束 / SSE_ACK 不匹配 / 未知模型 → 对应状态码', async () => {
  // STREAM_ERROR 带登录错误码 → 401
  const state = newState()
  const stub = stubFetch(baseRoutes(state, [chatRoute(state, {
    frames: (localId) => [
      ['SSE_ACK', { ack_client_meta: { local_conversation_id: localId, conversation_id: CONV_ID } }],
      ['STREAM_ERROR', { error_code: 710012001, error_msg: 'expired' }],
    ],
  })]))
  try {
    const response = await doubaoworkChannel.chat(freshCredential(), { body: chatBody() })
    assert.equal(response.status, 401, '流内登录错误也要映射成 401，不能当空回复')
  } finally { stub.restore() }

  // 没有 SSE_REPLY_END → 提前结束 502
  const state2 = newState()
  const stub2 = stubFetch(baseRoutes(state2, [chatRoute(state2, { end: false })]))
  try {
    const response = await doubaoworkChannel.chat(freshCredential(), { body: chatBody() })
    assert.equal(response.status, 502)
    assert.equal((await response.json()).error.code, 'incomplete_stream')
  } finally { stub2.restore() }

  // SSE_ACK 的 local id 与请求不符 → 归属校验失败 502
  const state3 = newState()
  const stub3 = stubFetch(baseRoutes(state3, [chatRoute(state3, { ackId: `local_${'f'.repeat(32)}` })]))
  try {
    const response = await doubaoworkChannel.chat(freshCredential(), { body: chatBody() })
    assert.equal(response.status, 502)
    assert.equal((await response.json()).error.code, 'conversation_ownership_error')
  } finally { stub3.restore() }

  // 未知模型 → 404，不打上游
  const state4 = newState()
  const stub4 = stubFetch(baseRoutes(state4, [chatRoute(state4)]))
  try {
    const response = await doubaoworkChannel.chat(freshCredential(), { body: chatBody({ model: 'doubao-nope' }) })
    assert.equal(response.status, 404)
    assert.equal((await response.json()).error.code, 'unknown_model')
    assert.equal(state4.chatCalls.length, 0)
  } finally { stub4.restore() }
})

test('chat：未登录（无 cookie）→ 401 + 登录标记，绝不 throw', async () => {
  const response = await doubaoworkChannel.chat({}, { body: chatBody() })
  assert.equal(response.status, 401)
  assert.equal(response.headers.get('x-magpie-sign-in'), 'expired')
  const payload = await response.json()
  assert.equal(payload.error.type, 'provider_error')
})