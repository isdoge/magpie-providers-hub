// 豆包工作（Doubao Work）协议层 —— 纯函数，无网络 / 无文件 I/O。
//
// ⚠️ 归属：本文件是 **移植**，不是原创。
//   上游实现：miaocell/magpie-doubao-work-auth（MIT，
//   Copyright (c) 2026 Doubao Work Magpie plugin contributors）。
//   移植范围：lib/protocol.mjs（请求组装 / 回复解析）、lib/stream.mjs（事件流翻译）、
//   lib/responses.mjs（Responses 协议折叠）、lib/models.mjs（菜单解析与基线）、
//   lib/errors.mjs（错误码映射）、lib/cookie-import.mjs（Cookie 解析）、
//   lib/quota.mjs 与 lib/checkin.mjs 的纯解析部分。
//   本仓库新增：hub 渠道形态的接线（见 src/doubaowork.mjs 文件头）。
//
// 协议要点（上游实测，照抄不改）：
//   · 豆包桌面接口不吃原生 tools / response_format —— 历史 + 工具定义编进提示词，
//     回来按 JSON 文本协议解析成 OpenAI tool_calls；
//   · 事件流是补丁语义（STREAM_CHUNK patch_op / CHUNK_DELTA），不是 OpenAI SSE；
//   · 业务失败恒 HTTP 200，成败读 body 的 code；
//   · 图片上传入口要前端 a_bogus 签名，纯 HTTP 侧造不出来 —— 上游明确拒绝，
//     本移植同样明确拒绝（不静默丢图）。

import { randomUUID } from 'node:crypto'

// ── 统一上游错误（移植 lib/errors.mjs）──────────────────────────────────

export class ProviderError extends Error {
  constructor(message, status = 502, code = 'upstream_error', extra = {}) {
    super(message)
    this.name = 'ProviderError'
    this.status = status
    this.code = code
    Object.assign(this, extra)
  }
}

/** 豆包网关错误码 → HTTP 状态码（映射必须准：401 标账号、429 换号、403 不标记）。 */
const CODE_MAP = {
  710012000: [401, 'sign_in_required'], // user invalid
  710012001: [401, 'sign_in_expired'],  // login invalid / 登录已过期
  710010202: [400, 'invalid_param'],    // common invalid param
  710020202: [400, 'invalid_param'],    // 同类业务参数拒绝（常见于会话 id 复用）
  710022004: [403, 'captcha_required'], // 风控验证码
  710012004: [429, 'rate_limited'],
}

/** 上游错误消息对人没用（风控也回 "rate limited"），补一句能照着做的提示。 */
const CODE_HINT = {
  captcha_required: '豆包要求人工验证：打开 https://www.doubao.com/chat/ 手动发一句话，过掉验证后再试。',
  invalid_param: '豆包拒绝了请求参数。如果反复出现，把 magpie 里这次请求的记录一起发到插件仓库。',
  rate_limited: '豆包侧限流，稍等一会儿再试。',
}

export function upstreamError(payload, fallbackStatus) {
  const code = payload?.error?.code ?? payload?.error_code ?? payload?.code
  const message = payload?.error?.message ?? payload?.error_msg ?? payload?.message ?? payload?.msg ?? '豆包返回未知错误'
  const [status, ourCode] = CODE_MAP[code] || [fallbackStatus || 502, 'upstream_error']
  const hint = CODE_HINT[ourCode]
  const text = hint ? `${message}（${hint}）` : String(message)
  const error = new ProviderError(text.slice(0, 500), status, ourCode)
  // 只有登录类错误才让 magpie 标记账号；验证码不标记，避免账号被永久停用
  if (ourCode === 'sign_in_required' || ourCode === 'sign_in_expired') error.signIn = 'expired'
  return error
}

// ── Cookie 解析（移植 lib/cookie-import.mjs）────────────────────────────

/** 把 "a=1; b=2" 或 "Cookie: a=1; b=2" 解析成对象。 */
export function parseCookieHeader(text) {
  const out = {}
  const body = String(text || '').replace(/^\s*cookie\s*:\s*/i, '')
  for (const part of body.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (!name) continue
    out[name] = value
  }
  return out
}

/** 粘贴的 Cookie → 内部格式。缺 sessionid / sessionid_ss 直接报清楚。 */
export function cookiesFromHeader(text, { domain = 'doubao.com' } = {}) {
  const parsed = parseCookieHeader(text)
  if (!parsed.sessionid && !parsed.sessionid_ss) {
    throw new Error('Cookie 里没有 sessionid 或 sessionid_ss。请在豆包网页登录后，从开发者工具复制完整 Cookie。')
  }
  return Object.entries(parsed).map(([name, value]) => ({
    name, value, domain, path: '/', expires: 0, secure: true, httpOnly: false,
  }))
}

/** 从 Cookie 里推断设备标识（s_v_web_id / web_id 等是指纹来源）。 */
export function clientInfoFromCookies(cookies) {
  const map = Object.fromEntries(cookies.map((c) => [c.name, c.value]))
  const pick = (...names) => {
    for (const name of names) {
      const value = map[name]
      if (value && /^[1-9]\d*$/.test(value)) return value
    }
    return ''
  }
  const deviceId = pick('device_id', 'deviceid', 's_v_web_id_number')
  const webId = pick('web_id', 'webid')
  const teaUuid = pick('tea_uuid', 'user_unique_id', 'uuid')
  return {
    deviceId: deviceId || '',
    webId: webId || deviceId || '',
    teaUuid: teaUuid || deviceId || '',
    fingerprint: map.s_v_web_id || map.fp || '',
  }
}

// ── 请求组装（移植 lib/protocol.mjs）────────────────────────────────────

const TOOL_INSTRUCTION = [
  '工具传输协议：需要调用外部工具时，只输出一个完整 JSON 对象，不加 Markdown、不加解释，格式为',
  '{"content":"要说的文字或空字符串","tool_calls":[{"name":"工具名","arguments":{}}]}。',
  '工具名和参数必须严格使用 tools 中给出的名称与 parameters Schema；只能提出调用，不要编造执行结果。',
  'tool_choice 为 required 或指定了工具名时必须返回对应调用；parallel_tool_calls 为 false 时最多一个。',
  'tool_choice 为 auto 且无需调用工具时，直接输出答复正文，不要包成 JSON。',
].join('')

/** 数字档位 → 名字。少数客户端按 3/4/5… 传，跟 EFFORT_NAMES 的编号一致。 */
const EFFORT_BY_NUMBER = { 3: 'low', 4: 'medium', 5: 'high', 6: 'xhigh', 7: 'max', 8: 'auto' }

function effortName(value) {
  if (typeof value === 'string' && value) return value
  if (typeof value === 'number' && EFFORT_BY_NUMBER[value]) return EFFORT_BY_NUMBER[value]
  return undefined
}

export function prepareRequest(input) {
  if (!input || typeof input !== 'object') throw new ProviderError('请求体不是对象。', 400, 'invalid_request')
  if (typeof input.model !== 'string' || !input.model) throw new ProviderError('请求缺少 model。', 400, 'invalid_request')
  if (!Array.isArray(input.messages) || !input.messages.length) throw new ProviderError('请求缺少 messages。', 400, 'invalid_request')

  // 这些采样参数豆包桌面接口没有对应字段，静默忽略但记下来
  const ignored = ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'seed', 'stop', 'logit_bias', 'logprobs', 'top_logprobs']
    .filter((key) => input[key] !== undefined && input[key] !== null)

  const messages = input.messages.map(normalizeMessage)
  const tools = Array.isArray(input.tools) && input.tools.length ? input.tools : undefined
  const toolsEnabled = Boolean(tools) && input.tool_choice !== 'none'
  const format = input.response_format
  const structured = Boolean(format && format.type && format.type !== 'text')

  const instructions = messages.filter((m) => m.role === 'system' || m.role === 'developer')
  const conversation = messages.filter((m) => m.role !== 'system' && m.role !== 'developer')

  let preamble = '你在一次 API 调用中扮演 assistant，只生成下一条回复。下面是一个 JSON，其中 messages 是完整对话历史。'
  preamble += '保留历史中的事实与结论；system 与 developer 角色的内容是指令，tool 角色的内容是外部工具已返回的数据。'
  preamble += '不要复述这个 JSON，也不要输出角色标签。所有工具都由调用方执行，不要尝试使用你自己的内置工具去完成这些操作。\n'

  if (toolsEnabled) preamble += `${TOOL_INSTRUCTION}\n`
  else if (format?.type === 'json_object') preamble += '只输出一个合法 JSON 对象，不加 Markdown。\n'
  else if (format?.type === 'json_schema' && format.json_schema?.schema) {
    preamble += `只输出符合下面这个 JSON Schema 的 JSON，不加 Markdown：${JSON.stringify(format.json_schema.schema)}\n`
  }

  const budget = input.max_completion_tokens ?? input.max_tokens
  if (budget) preamble += `回复长度预算约 ${budget} token。\n`

  const payload = { messages: conversation }
  // system / developer 单独放，和对话分开：模型更容易把它们当约束而不是历史
  if (instructions.length) {
    payload.instructions = instructions.map((item) => ({ role: item.role, content: item.content }))
  }
  if (toolsEnabled) {
    payload.tools = tools
    payload.tool_choice = input.tool_choice ?? 'auto'
    payload.parallel_tool_calls = input.parallel_tool_calls ?? true
  }
  if (structured) payload.response_format = format

  const suffix = toolsEnabled
    ? `\n现在输出下一条 assistant 回复。tool_choice=${JSON.stringify(input.tool_choice ?? 'auto')}；parallel_tool_calls=${input.parallel_tool_calls ?? true}。`
    : ''

  return {
    request: {
      model: input.model,
      stream: input.stream === true,
      reasoning_effort: effortName(input.reasoning_effort),
    },
    prompt: preamble + JSON.stringify(payload) + suffix,
    tools: toolsEnabled ? tools : undefined,
    toolChoice: input.tool_choice,
    parallel: input.parallel_tool_calls ?? true,
    structured,
    schema: format?.type === 'json_schema' ? format.json_schema?.schema : undefined,
    jsonObject: format?.type === 'json_object',
    ignored,
    systemSeen: instructions.length > 0,
    // 只有最后一条用户消息的图片有意义（本移植对图片一律明确拒绝，见 doubaowork.mjs）
    images: lastUserImages(conversation),
  }
}

/** 取最后一条 user 消息里的图片 URL。 */
function lastUserImages(conversation) {
  for (let i = conversation.length - 1; i >= 0; i--) {
    const message = conversation[i]
    if (message.role !== 'user') continue
    return Array.isArray(message.images) ? message.images : []
  }
  return []
}

function normalizeMessage(message) {
  if (!message || typeof message !== 'object') throw new ProviderError('messages 里有非对象元素。', 400, 'invalid_request')
  const role = String(message.role ?? 'user')
  let content = ''
  const images = []
  if (typeof message.content === 'string') content = message.content
  else if (Array.isArray(message.content)) {
    content = message.content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part?.type === 'text') return String(part.text ?? '')
        if (part?.type === 'image_url') {
          const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
          if (url) images.push(url)
          return ''
        }
        return ''
      })
      .join('')
  } else if (message.content != null) content = String(message.content)

  const normalized = { role, content }
  if (images.length) normalized.images = images
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    normalized.tool_calls = message.tool_calls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.function?.name, arguments: call.function?.arguments },
    }))
  }
  if (message.tool_call_id) normalized.tool_call_id = message.tool_call_id
  return normalized
}

/** 组装发给 /chat/completion 的请求体（option 结构逐字照抄上游实测）。 */
export function upstreamBody(session, prepared, selected) {
  const localMessage = randomUUID()
  const blocks = [{
    block_type: 10000,
    block_id: randomUUID(),
    parent_id: '',
    content: { text_block: { text: prepared.prompt, icon_url: '', icon_url_dark: '', summary: '' }, pc_event_block: '' },
    meta_info: [],
    extra_info: {},
    append_fields: [],
  }]

  return {
    client_meta: {
      bot_id: session.bot,
      conversation_id: '',
      local_conversation_id: `local_${randomUUID().replaceAll('-', '')}`,
      last_section_id: '',
      last_message_index: 0,
      local_permissions: [],
    },
    messages: [{
      local_message_id: localMessage,
      message_status: 0,
      content_block: blocks,
    }],
    option: {
      need_create_conversation: true,
      send_message_scene: '',
      create_time_ms: Date.now(),
      unique_key: randomUUID(),
      agent_mode: selected.agentMode,
      need_deep_think: selected.itemId,
      conversation_mode: 2,
      conversation_init_option: { need_ack_conversation: true },
      conversation_init_ext: { model_item_key: selected.key, mode_id: selected.modeId, reasoning_effort: String(selected.level) },
      model_config: { model_item_key: selected.key, model_extra_params: selected.extraParams, reasoning_effort: selected.level },
      aggregate_params: {
        conversation_mode: '2',
        mode_id: selected.modeId,
        model_item_key: selected.key,
        agent_mode: String(selected.agentMode),
        reasoning_effort: String(selected.level),
        provider_id: selected.extraParams?.provider_id ?? '',
      },
      sse_recv_event_options: { support_chunk_delta: true },
      support_lazy_fetch_stream: false,
      recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(Date.now() / 1000), append_sse_event_scene: 0 },
      message_from: 0,
      scene_type: 0,
      collect_id: '',
      is_audio: false,
      answer_with_suggest: false,
      tts_switch: false,
      click_clear_context: false,
      from_suggest: false,
      is_regen: false,
      is_replace: false,
      disable_sse_cache: false,
      select_text_action: '',
      start_seq: 0,
      regen_query_id: [],
      edit_query_id: [],
      regen_instruction: '',
      is_ai_playground: false,
      is_old_user: false,
      message_storage_type: 0,
      related_deleted_message_ids: {},
      connector_info_list: [],
    },
    chat_ability: {},
    user_context: [],
    ext: { is_finish: '1', agent_mode: String(selected.agentMode), use_deep_think: String(selected.itemId) },
  }
}

/** 把正文解析成 OpenAI 的 message，并按需校验工具调用与结构化输出。 */
export function decodeReply(text, prepared) {
  if (!prepared.tools) {
    return validateStructured({ role: 'assistant', content: text || null }, prepared)
  }
  const trimmed = text.trim()
  const looksJson = trimmed.startsWith('{')
  if (!looksJson) {
    if (prepared.toolChoice === 'required' || typeof prepared.toolChoice === 'object') {
      throw new ProviderError('豆包没有按要求返回工具调用。', 502, 'invalid_tool_response')
    }
    return validateStructured({ role: 'assistant', content: text || null }, prepared)
  }

  let reply
  try { reply = JSON.parse(trimmed) }
  catch (cause) { throw new ProviderError(`豆包的工具回复不是合法 JSON：${cause.message}`, 502, 'invalid_tool_response', { cause }) }

  const calls = Array.isArray(reply?.tool_calls) ? reply.tool_calls : []
  const names = new Set(prepared.tools.map((tool) => tool.function?.name))
  if (prepared.toolChoice === 'required' && !calls.length) throw new ProviderError('豆包没有返回要求的工具调用。', 502, 'invalid_tool_response')
  if (typeof prepared.toolChoice === 'object' && !calls.some((call) => call.name === prepared.toolChoice.function?.name)) {
    throw new ProviderError('豆包没有返回指定的工具调用。', 502, 'invalid_tool_response')
  }
  if (prepared.parallel === false && calls.length > 1) throw new ProviderError('豆包返回了多个工具调用。', 502, 'invalid_tool_response')

  const toolCalls = calls.map((call) => {
    if (!names.has(call.name)) throw new ProviderError(`豆包返回了未声明的工具 ${call.name}。`, 502, 'invalid_tool_response')
    let args = call.arguments
    if (typeof args !== 'string') args = JSON.stringify(args ?? {})
    return { id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function', function: { name: call.name, arguments: args } }
  })

  const message = { role: 'assistant', content: typeof reply.content === 'string' ? reply.content : (reply.content == null ? null : String(reply.content)) }
  if (toolCalls.length) message.tool_calls = toolCalls
  return validateStructured(message, prepared, Boolean(toolCalls.length))
}

function validateStructured(message, prepared, hasToolCalls = false) {
  if (!prepared.structured || hasToolCalls) return message
  let value
  try { value = JSON.parse(message.content ?? '') }
  catch (cause) { throw new ProviderError(`豆包回复不是合法 JSON：${cause.message}`, 502, 'invalid_json_response', { cause }) }
  if (prepared.jsonObject && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    throw new ProviderError('豆包没有返回 JSON 对象。', 502, 'invalid_json_response')
  }
  return message
}

/**
 * 估算 token 用量（移植 lib/chat.mjs 的 estimateTokens）。
 * 豆包事件流不带 usage，但 OpenAI 协议里 usage 必填（Codex 靠它判上下文占用）。
 * 中日韩字符约 1 token/字，其余 4 字符/token —— 只给量级，不用于计费。
 */
export function estimateTokens(text) {
  if (!text) return 0
  let cjk = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if ((code >= 0x3040 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x9fff) ||
        (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xff00 && code <= 0xffef)) cjk += 1
  }
  return Math.ceil(cjk + (text.length - cjk) / 4)
}

// ── 事件流翻译（移植 lib/stream.mjs）────────────────────────────────────

/** 只解析 data: 行的事件流。 */
async function* events(response) {
  if (!response.body) throw new ProviderError('豆包返回了空事件流。', 502, 'empty_stream')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let at
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        const event = parseEvent(raw)
        if (event) yield event
      }
    }
    buffer += decoder.decode()
    const tail = parseEvent(buffer)
    if (tail) yield tail
  } finally {
    try { await reader.cancel() } catch { /* 已结束 */ }
    try { reader.releaseLock() } catch { /* 已释放 */ }
  }
}

function parseEvent(raw) {
  if (!raw.trim()) return undefined
  let name = 'message'
  const data = []
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trim())
  }
  return { event: name, data: data.join('\n') }
}

/**
 * 把豆包事件流翻译成 { content } / { reasoning_content } 增量。
 * 流里报错时抛对应状态码（401/429 让网关做故障切换，而不是当成空回复）。
 */
export async function* readDoubao(response, signal, observe = async () => {}) {
  const type = response.headers.get('content-type') || ''
  if (!type.includes('text/event-stream')) {
    const text = await response.text()
    let payload
    try { payload = JSON.parse(text) } catch { payload = { message: text.slice(0, 300) } }
    throw upstreamError(payload)
  }

  const blocks = new Map()
  let finished = false
  let produced = false

  function* apply(messageId, updates, operation = 2) {
    for (const block of updates || []) {
      if (!block?.block_id) throw new ProviderError('豆包内容块缺少标识。', 502, 'invalid_stream')
      const key = `${messageId}:${block.block_id}`
      const prior = blocks.get(key)
      const type = block.patch_type ?? operation
      if (type === 3 || block.is_deleted) {
        if (prior?.text) throw new ProviderError('豆包撤回了已发送的内容。', 502, 'replaced_stream')
        blocks.delete(key)
        continue
      }
      if (type !== 1 && type !== 2) throw new ProviderError(`未知的内容块操作 ${type}。`, 502, 'invalid_stream')

      const current = { ...prior, ...block, text: prior?.text ?? '' }
      blocks.set(key, current)
      const text = block.content?.text_block?.text
      if (text === undefined) continue
      if (typeof text !== 'string') throw new ProviderError('豆包文本字段类型发生变化。', 502, 'invalid_stream')

      const next = type === 1 ? current.text + text : text
      if (!next.startsWith(current.text)) throw new ProviderError('豆包改写了已发送的内容。', 502, 'replaced_stream')
      const delta = next.slice(current.text.length)
      current.text = next
      if (!delta) continue

      // 沿 parent 链判断这块属于正文还是思考（10040 = 思考块）
      let reasoning = current.block_type === 10040
      let parent = current
      const seen = new Set()
      while (parent.parent_id) {
        if (seen.has(parent.parent_id)) throw new ProviderError('豆包内容块父级成环。', 502, 'invalid_stream')
        seen.add(parent.parent_id)
        parent = blocks.get(`${messageId}:${parent.parent_id}`)
        if (!parent) break
        reasoning ||= parent.block_type === 10040
      }
      produced = true
      yield reasoning ? { reasoning_content: delta } : { content: delta }
    }
  }

  let lastChunk
  for await (const event of events(response)) {
    signal?.throwIfAborted()
    if (event.event === 'gateway-error') throw upstreamError(safeJson(event.data))
    const data = safeJson(event.data)
    await observe(event.event, data)

    if (event.event === 'STREAM_ERROR' || data.error_code || data.error_details?.has_error) {
      throw upstreamError({ ...data, message: data.error_msg || data.error_details?.error_message })
    }
    if (event.event === 'SSE_REPLY_END' && data.end_type === 3) { finished = true; break }
    if (event.event === 'FULL_MSG_NOTIFY' && data.message?.user_type === 2) {
      yield* apply(data.message.message_id, data.message.content_block)
    }
    if (event.event === 'STREAM_MSG_NOTIFY') {
      yield* apply(data.meta.message_id, data.content.content_block)
    }
    if (event.event === 'STREAM_CHUNK') {
      for (const patch of data.patch_op || []) {
        if (patch.patch_object !== 1) continue
        yield* apply(data.message_id, patch.patch_value.content_block, patch.patch_type)
        const blocks_ = patch.patch_value.content_block
        if (blocks_?.length === 1) lastChunk = { message: data.message_id, block: blocks_[0] }
      }
    }
    if (event.event === 'CHUNK_DELTA') {
      if (!lastChunk?.block?.content?.text_block) throw new ProviderError('豆包增量缺少文本块上下文。', 502, 'invalid_stream')
      yield* apply(lastChunk.message, [{ ...lastChunk.block, patch_type: 1, content: { text_block: data } }], 1)
    }
  }

  if (!finished) throw new ProviderError('豆包事件流提前结束。', 502, 'incomplete_stream')
  if (!produced) throw new ProviderError('豆包事件流没有回复正文。', 502, 'empty_stream')
}

function safeJson(text) {
  if (!text) return {}
  try { return JSON.parse(text) } catch { return { message: text.slice(0, 300) } }
}

// ── Responses 协议折叠（移植 lib/responses.mjs）─────────────────────────
//
// Codex 通道 wire_api = "responses"：请求体是 { input, instructions, … }。
// hub 的 loader 不传 URL 路径，调用方按 **body 形状**（有 input 无 messages）判定。

/** Responses 的 content 数组 → 一段纯文本。 */
function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part?.type === 'input_text' || part?.type === 'output_text' || part?.type === 'text') return part.text ?? ''
      return ''
    })
    .join('')
}

/** 把 Responses 请求折成 chat completions 请求（只做形状转换，不碰内容语义）。 */
export function responsesToChat(body) {
  const messages = []
  if (typeof body.instructions === 'string' && body.instructions) {
    messages.push({ role: 'system', content: body.instructions })
  }

  const input = body.input
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input })
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue
      const type = item.type ?? (item.role ? 'message' : undefined)

      if (type === 'function_call') {
        // 上一次模型发起的工具调用：并进最近一条 assistant 消息
        const call = {
          id: item.call_id || item.id || `call_${randomUUID().replaceAll('-', '')}`,
          type: 'function',
          function: { name: item.name ?? '', arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}) },
        }
        const last = messages[messages.length - 1]
        if (last?.role === 'assistant') {
          last.tool_calls = [...(last.tool_calls ?? []), call]
        } else {
          messages.push({ role: 'assistant', content: null, tool_calls: [call] })
        }
        continue
      }

      if (type === 'function_call_output') {
        messages.push({ role: 'tool', tool_call_id: item.call_id ?? item.id ?? '', content: contentText(item.output) })
        continue
      }

      const role = item.role === 'developer' ? 'system' : (item.role || 'user')
      messages.push({ role, content: contentText(item.content) })
    }
  }

  const chat = { ...body, messages }
  delete chat.input
  delete chat.instructions
  if (body.max_output_tokens !== undefined && chat.max_tokens === undefined) {
    chat.max_tokens = body.max_output_tokens
    delete chat.max_output_tokens
  }
  // Responses 的 tools 是扁平结构，chat 是嵌套的，折一层
  if (Array.isArray(body.tools)) {
    chat.tools = body.tools
      .filter((tool) => tool && (tool.type === 'function' || tool.name))
      .map((tool) => (tool.function ? tool : { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
  }
  return chat
}

/** chat 的 message → Responses 的 output items。 */
function messageToOutput(message) {
  const items = []
  const text = typeof message?.content === 'string' ? message.content : ''
  if (text) {
    items.push({
      type: 'message',
      id: `msg_${randomUUID().replaceAll('-', '')}`,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    })
  }
  for (const call of message?.tool_calls ?? []) {
    items.push({
      type: 'function_call',
      id: `fc_${randomUUID().replaceAll('-', '')}`,
      call_id: call.id,
      name: call.function?.name ?? '',
      arguments: call.function?.arguments ?? '{}',
      status: 'completed',
    })
  }
  return items
}

/** 非流式：OpenAI chat completion → Responses 对象。 */
export function chatToResponses(completion, model) {
  const message = completion?.choices?.[0]?.message ?? {}
  const usage = completion?.usage ?? {}
  return {
    id: `resp_${randomUUID().replaceAll('-', '')}`,
    object: 'response',
    created_at: completion?.created ?? Math.floor(Date.now() / 1000),
    status: 'completed',
    model: completion?.model ?? model,
    output: messageToOutput(message),
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
    },
  }
}

/** 流式：把 chat 的 delta 转成 Responses 的 SSE 事件序列。 */
export function responsesEventStream(meta, deltas, usageOf) {
  const encoder = new TextEncoder()
  const responseId = `resp_${randomUUID().replaceAll('-', '')}`
  const itemId = `msg_${randomUUID().replaceAll('-', '')}`
  const send = (event, data) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

  return new ReadableStream({
    async start(controller) {
      controller.enqueue(send('response.created', {
        type: 'response.created',
        response: { id: responseId, object: 'response', created_at: meta.created, status: 'in_progress', model: meta.model, output: [] },
      }))
      controller.enqueue(send('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', id: itemId, status: 'in_progress', role: 'assistant', content: [] },
      }))
      controller.enqueue(send('response.content_part.added', {
        type: 'response.content_part.added',
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      }))

      let text = ''
      try {
        for await (const delta of deltas) {
          const piece = delta.content ?? ''
          if (piece) {
            text += piece
            controller.enqueue(send('response.output_text.delta', {
              type: 'response.output_text.delta',
              item_id: itemId,
              output_index: 0,
              content_index: 0,
              delta: piece,
            }))
          }
        }
      } catch (error) {
        controller.enqueue(send('response.failed', {
          type: 'response.failed',
          response: {
            id: responseId, object: 'response', status: 'failed', model: meta.model, output: [],
            error: { code: error?.code ?? 'upstream_error', message: error?.message ?? '豆包返回错误' },
          },
        }))
        controller.close()
        return
      }

      controller.enqueue(send('response.output_text.done', {
        type: 'response.output_text.done', item_id: itemId, output_index: 0, content_index: 0, text,
      }))
      controller.enqueue(send('response.content_part.done', {
        type: 'response.content_part.done', item_id: itemId, output_index: 0, content_index: 0,
        part: { type: 'output_text', text, annotations: [] },
      }))
      controller.enqueue(send('response.output_item.done', {
        type: 'response.output_item.done', output_index: 0,
        item: { type: 'message', id: itemId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] },
      }))
      controller.enqueue(send('response.completed', {
        type: 'response.completed',
        response: {
          id: responseId, object: 'response', created_at: meta.created, status: 'completed', model: meta.model,
          output: [{ type: 'message', id: itemId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }],
          usage: usageOf(text),
        },
      }))
      controller.close()
    },
  })
}

// ── 模型菜单（移植 lib/models.mjs）──────────────────────────────────────
//
// 菜单真身由网页 SSR loader 取，前端接口 brief_list 只回 entry_list（基本落空）
// —— 所以内置基线兜底，登录后仍尝试在线刷新。

/** 从 tag_list 取倍率：type 2 纯倍率（"1.44x"）、type 6 带前缀（"限时优惠 0.01x"）。 */
export function readRate(tags) {
  const list = Array.isArray(tags) ? tags : []
  for (const tag of list) {
    const text = String(tag?.text ?? '').trim()
    if (!text) continue
    const match = text.match(/(\d+(?:\.\d+)?)\s*[xX×]$/)
    if (match) {
      const rate = Number(match[1])
      if (Number.isFinite(rate)) return { rate, free: rate === 0, text }
    }
    if (/免费/.test(text)) return { free: true, text }
  }
  return { text: '' }
}

/** 上游档位 → magpie 推理档位名。8 是「自动」那一档。 */
export const EFFORT_NAMES = { 3: 'low', 4: 'medium', 5: 'high', 6: 'xhigh', 7: 'max', 8: 'auto' }

const ID_PREFIX = 'doubao-'

/**
 * 基线菜单：上游 2026-11 实测自真实账号的 office 模式。
 * need_upgrade 的条目保留在基线里但解析时跳过，账号升级后自动可用。
 */
export const FALLBACK_MENU = {
  modeId: '3',
  agentMode: 1,
  models: [
    { key: '9', name: '自动', itemId: 9, agentMode: 1, window: 256000, defaultMode: '3', levels: [3, 8, 5], defaultLevel: 8, needUpgrade: false, tag: '小额免费' },
    { key: 'seed-lite-7b', name: '豆包 2.1 Lite', itemId: 10001, agentMode: 1, window: 256000, defaultMode: '3', levels: [3, 4, 5], defaultLevel: 5, needUpgrade: false, tag: '限时优惠 0.01x' },
    { key: '5', name: '豆包 2.1 Pro', itemId: 5, agentMode: 1, window: 256000, defaultMode: '3', levels: [3, 4, 5], defaultLevel: 5, needUpgrade: true, tag: '0.65x' },
    { key: 'person-deepseek-v4-1-flash-261017', name: 'DeepSeek V4.1 Flash', itemId: 10001, agentMode: 1, window: 300000, defaultMode: '3', levels: [3, 4, 5, 6, 7], defaultLevel: 5, needUpgrade: false, tag: '限时优惠 0.01x' },
    { key: 'person-kimi-k3-1-pro-261111', name: 'Kimi K3.1 Pro', itemId: 10001, agentMode: 1, window: 300000, defaultMode: '3', levels: [3, 4, 5, 6, 7], defaultLevel: 5, needUpgrade: false, tag: '0.95x' },
    { key: 'person-kimi-k3-1-pro-highspeed-261111', name: 'Kimi K3.1 Pro 高速', itemId: 10001, agentMode: 1, window: 300000, defaultMode: '3', levels: [3, 4, 5, 6, 7], defaultLevel: 5, needUpgrade: false, tag: '1.44x' },
    { key: 'person-kimi-k3-261111', name: 'Kimi K3', itemId: 10001, agentMode: 1, window: 300000, defaultMode: '3', levels: [3, 4, 5, 6, 7], defaultLevel: 5, needUpgrade: false, tag: '1.48x' },
    { key: 'person-glm-5-3-261111', name: 'GLM 5.3', itemId: 10001, agentMode: 1, window: 300000, defaultMode: '3', levels: [3, 5, 7], defaultLevel: 5, needUpgrade: false, tag: '0.80x' },
    { key: 'person-glm-5-3-flash-261111', name: 'GLM 5.3 Flash', itemId: 10001, agentMode: 1, window: 300000, defaultMode: '3', levels: [3, 5, 7], defaultLevel: 5, needUpgrade: false, tag: '0.08x' },
    { key: 'person-deepseek-v4-pro-ga-260813', name: 'DeepSeek V4 Pro', itemId: 10001, agentMode: 1, window: 300000, defaultMode: '3', levels: [3, 4, 5, 6, 7], defaultLevel: 5, needUpgrade: false, tag: '0.46x' },
  ],
}

function slugify(name, key) {
  // 纯数字键（9 / 5 / 0 / 3）没有语义，优先用别名，别名缺失才用名字派生
  if (/^\d+$/.test(String(key))) {
    const ALIAS = { 0: 'fast', 3: 'expert', 5: 'pro', 9: 'auto' }
    if (ALIAS[Number(key)]) return ALIAS[Number(key)]
    const fromName = String(name)
      .replace(/[^a-zA-Z0-9.]+/g, '-')
      .toLowerCase()
      .replace(/^-+|-+$/g, '')
    return /[a-z]/.test(fromName) ? fromName : `mode-${key}`
  }
  const fromKey = String(key)
    .replace(/^person-/, '')
    .replace(/-(261017|261111|260813|261010|\d{6})$/, '')
  const base = /^[a-z0-9-]+$/i.test(fromKey) ? fromKey : String(name)
  return base.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '')
}

/** 把一条模型配置变成内部结构。 */
function toEntry(item, modeId, modeAgentMode) {
  // 在线结构是 subscribe_config.need_upgrade，基线是扁平 needUpgrade
  if (item.subscribe_config?.need_upgrade || item.needUpgrade) return undefined
  const key = String(item.model_item_key ?? item.key ?? '')
  if (!key) return undefined
  const modesList = Array.isArray(item.conversation_mode_list)
    ? item.conversation_mode_list
    : (Array.isArray(item.modes) ? item.modes : [])
  if (modesList.length && !modesList.includes('office')) return undefined

  const name = String(item.name ?? key)
  const id = ID_PREFIX + slugify(name, key)
  const levels = {}
  const rawLevels = Array.isArray(item.reasoning_effort_config?.option_list)
    ? item.reasoning_effort_config.option_list.map((o) => o.level)
    : (item.levels ?? [])
  for (const level of rawLevels) {
    const effort = EFFORT_NAMES[level]
    if (effort && !(effort in levels)) levels[effort] = level
  }
  const rawDefault = item.reasoning_effort_config?.default_level ?? item.defaultLevel
  const defaultEffort = EFFORT_NAMES[rawDefault]
  const window = Number(item.model_extra_params?.total_window_size ?? item.window ?? 0)
  const extra = item.model_extra_params ?? {}
  // 基线没写 extra_params 时，按在线结构补出最小可用的那份
  if (!extra.total_window_size && window) extra.total_window_size = String(window)
  if (!extra.memory_profile) extra.memory_profile = window >= 300000 ? '300k_230' : '256k'

  const tag = item.tag_list?.[0]?.text ?? item.tag ?? ''
  const rate = readRate(item.tag_list ?? (tag ? [{ text: tag }] : []))

  return [id, {
    id, name, key,
    itemId: Number(item.item_id ?? item.itemId ?? 0),
    modeId: String(modeId ?? ''),
    agentMode: Number(item.agent_mode ?? item.agentMode ?? modeAgentMode ?? 1),
    extraParams: extra,
    levels,
    defaultEffort: defaultEffort && levels[defaultEffort] ? defaultEffort : Object.keys(levels)[0],
    context: Number.isSafeInteger(window) && window > 0 ? window : 0,
    tag,
    rate: rate.rate,
    free: rate.free === true,
    rateText: rate.text,
  }]
}

/** 从在线响应解析；格式不符返回 null，不抛错，交给基线兜底。 */
export function parseModels(payload) {
  const data = payload?.data ?? payload
  const conf = data?.modeSelectData?.menuConfV2 ?? data?.menuConfV2
  const modes = conf?.mode_list?.item_list
  if (!Array.isArray(modes) || !modes.length) return null

  const workMode = modes.find((m) => m.default_conversation_mode === 'office' && m.model_list?.item_list?.length)
  if (!workMode) return null

  const catalog = new Map()
  for (const item of workMode.model_list.item_list) {
    const entry = toEntry(item, workMode.mode_id, workMode.agent_mode)
    if (entry && !catalog.has(entry[0])) catalog.set(entry[0], entry[1])
  }
  return catalog.size ? catalog : null
}

/** 基线菜单。 */
export function fallbackModels() {
  const catalog = new Map()
  for (const item of FALLBACK_MENU.models) {
    const entry = toEntry(item, FALLBACK_MENU.modeId, FALLBACK_MENU.agentMode)
    if (entry && !catalog.has(entry[0])) catalog.set(entry[0], entry[1])
  }
  return catalog
}

export function selectModel(catalog, request) {
  const model = catalog.get(request.model)
  if (!model) {
    throw new ProviderError(`当前账号没有模型 ${request.model}，请重新获取模型列表。`, 404, 'unknown_model')
  }
  const effort = request.reasoning_effort ?? model.defaultEffort
  if (effort && !(effort in model.levels)) {
    throw new ProviderError(
      `模型 ${model.name} 不支持推理强度 ${effort}（可选：${Object.keys(model.levels).join(' / ')}）。`,
      400, 'invalid_reasoning_effort',
    )
  }
  return { ...model, effort, level: model.levels[effort] }
}

// ── 额度 / 签到的纯解析（移植 lib/quota.mjs、lib/checkin.mjs）───────────

/** 数字归一：负数 / 非数 → undefined（额度计数不能是负的）。 */
export function quotaNum(value) {
  if (value === undefined || value === null || value === '') return undefined
  const result = Number(typeof value === 'string' ? value.replaceAll(',', '') : value)
  return Number.isFinite(result) && result >= 0 ? result : undefined
}

/** 到期时刻归一成**绝对毫秒**（上游 end_time 秒/毫秒混用；< 1e12 视为秒）。 */
export function quotaIsoMs(value) {
  const n = quotaNum(value)
  if (!n) return undefined
  return n < 1e12 ? n * 1000 : n
}

/** 签到活动组兜底值。实际以 launch 返回的为准。 */
export const CAMPAIGN_SCENE = 'pc_incentive_task_mvp_v3'
/** 签到任务的 campaign_code。 */
export const SIGNIN_TASK = 'daily_signin'
export const CHECKIN_DETAIL_PATH = '/alice/ug/campaign/v3/detail/'

/** 从 launch 里读这个账号实际投放的活动组。 */
export function campaignGroup(launch) {
  return String(launch?.ug_campaign_info?.campaign_group_code ?? '').trim()
}

/**
 * 从活动详情里读签到状态。优先 daily_signin；找不到退而找任何带 daily_checkin 的任务。
 * task_status 2 才可领；1 = 未满足条件（没投放时就是 1）。
 */
export function readCheckin(detail) {
  const data = detail?.data ?? detail
  const tasks = Array.isArray(data?.tasks) ? data.tasks
    : Array.isArray(data?.campaign_group?.tasks) ? data.campaign_group.tasks
      : []
  const withDaily = tasks.filter((t) => t?.campaign_code && t?.daily_checkin)
  const task = withDaily.find((t) => t.campaign_code === SIGNIN_TASK) ?? withDaily[0]
  if (!task) return { found: false }

  const daily = task.daily_checkin
  const status = Number(task.task_status)
  const num = (value) => {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return {
    found: true,
    group: String(task.campaign_group_code ?? CAMPAIGN_SCENE),
    claimed: daily.checked_in_today === true,
    points: num(daily.reward?.reward_amount),
    streak: num(daily.continuous_days),
    lastDate: daily.last_checkin_date ? String(daily.last_checkin_date) : undefined,
    claimable: status === 2,
    status,
  }
}