/**
 * acp-face-check.mjs — **面 E（官方 ACP 面）端到端探针**（V20/V21 的读数器）
 *
 * ## 它回答什么（单测回答不了的那个问题）
 * `tests/acp-face.test.ts` 验的是**函数**（端口表、426、开关、握手）；
 * 这里验的是**真实宿主进程内那条链**：
 *   开关落地 → 自持 listener 起来 → 真 WS 101 → **真 ACP 协议握手** → 建会话 → **模型真答完**。
 *
 * ## 🔴 判据纪律（照本轨既有的血泪，别退回去）
 * ① **"调用没报错"一律降级为"未验证"** —— D138 实测栽过两次：`followup()` 静默接受、
 *    `stopReason=end_turn` 正常返回，**而内容根本没到**。
 *    ⇒ 本探针**必须**在**模型回答的正文**上做断言（`PHRASE` 逐字命中），不看 RPC 成功。
 * ② **剥 `<think>` 段再断言**：模型（尤其带思维链的）会把提示词里的词**抄进思考段**
 *    ⇒ `includes` 必然命中（实测：正文只有 `NONE`，却因 think 里有工具名而报 OK）。
 * ③ **提示词不得含被测词以外的干扰**：提问里写什么，就要预期它可能被回显。
 *
 * ## 用法（由 verify.sh 调用，不直接手跑）
 *   node acp-face-check.mjs            # 读环境变量 ACP_PORT / ACP_PHRASE
 * 退出码：0 = 四相位全过 ｜ 非 0 = 失败（并打印哪一相位）
 * 输出：末行 `ACP_RESULT=<json>`（供 verify.sh 解析）；中间行是逐相位读数。
 */

const PORT = Number(process.env.ACP_PORT || 3200);
/** 要求模型逐字复述的串（**故意与任何注入内容无关**，避免"回显"造成假阳） */
const PHRASE = process.env.ACP_PHRASE || 'ACP-FACE-BENCH-OK';
const TIMEOUT_MS = Number(process.env.ACP_TIMEOUT_MS || 90000);

const phases = [];
const frames = [];
function rec(name, ok, detail) {
  phases.push({ name, ok, detail: String(detail).slice(0, 400) });
  console.log(`[phase] ${name} => ${ok ? 'OK' : 'FAIL'} :: ${String(detail).slice(0, 300)}`);
}
function finish(code) {
  const summary = { phases, okCount: phases.filter((p) => p.ok).length, total: phases.length };
  console.log(`ACP_RESULT=${JSON.stringify(summary)}`);
  process.exit(code);
}

let WebSocket;
try {
  // 🔴 解析锚点 = **被装进 profile 的那个插件自己**（而不是我猜的绝对路径）。
  //    为什么必须这样（2026-10-16 首跑踩到）：我首版硬写 `/root/.dsh/profiles/node_modules/ws` ——
  //    那是**本机宿主**的布局；容器里 `ws` 实际在 `/root/.dsh/profiles/web/node_modules/ws`
  //    ⇒ 探针当场 FAIL「读不到容器内的 ws」，而**面 E 本身是好的**（它监听 3200 正常）。
  //    这正是"读数器自己坏了被误读成被测对象坏了"那一族 ⇒ 锚点必须跟**被测对象同源**：
  //    面 E 是在 `lib/index.js` 里 `await import('ws')` 的 ⇒ 探针也从那个目录解析，
  //    **它解析得到，面就解析得到**（同一条 Node 解析链）。
  const { createRequire } = await import('node:module');
  const req = createRequire('/root/.dsh/profiles/web/node_modules/@shgroup/dsh-serenity-hooks/lib/index.js');
  ({ WebSocket } = req('ws'));
} catch (e) {
  rec('ws_module', false, `从插件目录解析不到 ws：${e.message}`);
  finish(2);
}

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
const pending = new Map();
let step = 0;
let buf = '';

function send(method, params) {
  const id = ++step;
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  frames.push(`SEND ${msg}`);
  ws.send(`${msg}\n`); // 🔴 必须自带换行（服务端按 NDJSON 读）
  return new Promise((res, rej) => {
    pending.set(id, { res, rej, method });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); rej(new Error(`timeout: ${method}`)); }
    }, TIMEOUT_MS);
  });
}

/** 模型正文的累积（用于内容级断言；**不含任何非 assistant 文本**） */
let assistantText = '';

function onLine(line) {
  if (!line.trim()) return;
  frames.push(`RECV ${line}`);
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m && m.jsonrpc === undefined) return; // 非协议帧（桥/控制帧）
  if (m.id !== undefined && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.rej(new Error(JSON.stringify(m.error)));
    else p.res(m.result);
    return;
  }
  // 通知：`session/update` 里带模型输出的文本块 —— 内容级断言的数据源
  const upd = m && m.params && m.params.update;
  if (upd && upd.sessionUpdate === 'agent_message_chunk' && upd.content && upd.content.type === 'text') {
    assistantText += String(upd.content.text || '');
  }
}

ws.on('message', (d) => {
  buf += d.toString();
  // 剔除不带换行的控制帧（本面不产生，但客户端必须容忍 —— 与官方客户端同要求）
  buf = buf.replace(/\{"type":"(?:connected|reconnect)"[^}]*\}/g, '');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    onLine(line);
  }
});

ws.on('open', async () => {
  rec('ws_upgrade', true, `101 Switching Protocols（面 E 自持 listener 的 'upgrade' 确实接上了）`);

  // ① ACP initialize —— 证明对面是**真 ACP**（不是任意 WS 端点）
  let init;
  try {
    init = await send('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const info = init && init.agentInfo ? init.agentInfo.name : '(无 agentInfo)';
    rec('acp_initialize', !!(init && init.agentInfo), `agentInfo.name=${info}`);
  } catch (e) {
    rec('acp_initialize', false, e.message);
    finish(10);
  }

  // ② session/new —— 证明能建会话
  let sid = null;
  try {
    const s = await send('session/new', { cwd: '/ccc', mcpServers: [] });
    sid = s && s.sessionId;
    rec('acp_session_new', !!sid, `sessionId=${sid}`);
  } catch (e) {
    rec('acp_session_new', false, e.message);
  }
  if (!sid) finish(11);

  // ③ session/prompt —— 真实一轮（这一步才叫"用模型测功能"）
  try {
    const r = await send('session/prompt', {
      sessionId: sid,
      prompt: [{ type: 'text', text: `Reply with exactly: ${PHRASE}` }],
    });
    const stop = r && r.stopReason;
    rec('acp_prompt_stop', stop === 'end_turn', `stopReason=${stop}`);
  } catch (e) {
    rec('acp_prompt_stop', false, e.message);
    finish(12);
  }

  // 🔴 ④ **内容级断言**（本探针的存在理由 —— 见文件头判据纪律 ①）
  //    剥 `<think>…</think>` 再判：防"模型把提示词抄进思考段"造成的假阳。
  const stripped = assistantText.replace(/<think[\s\S]*?<\/think>/gi, '');
  const hit = stripped.includes(PHRASE);
  rec('model_content', hit, hit
    ? `模型正文逐字含 ${PHRASE}（剥 think 后；正文 ${stripped.length} 字）`
    : `模型正文**不含** ${PHRASE} —— 原始 ${assistantText.length} 字 / 剥 think 后 ${stripped.length} 字；` +
      `🔴 这说明轮次"没报错"但**内容没到**（D138 那族假阳）`);

  finish(hit ? 0 : 13);
});

ws.on('error', (e) => {
  rec('ws_upgrade', false, `连接失败：${e.message}（面没起来？端口不是 ${PORT}？）`);
  finish(3);
});
setTimeout(() => {
  rec('guard', false, `总超时 ${TIMEOUT_MS}ms 兜底（防静默挂死）`);
  finish(14);
}, TIMEOUT_MS + 5000);
