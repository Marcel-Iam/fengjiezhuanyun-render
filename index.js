// ============================================================
// 凤姐转运 - 微信消息处理服务（部署在 Render）
//
// 环境变量：
//   WECHAT_TOKEN         企业微信验证 Token
//   WECHAT_AES_KEY       企业微信 AES 密钥（43字节base64）
//   WECHAT_CORP_ID       企业微信企业ID
//   WECHAT_CORP_SECRET   自建应用 Secret
//   WECHAT_KF_ID         微信客服账号 open_kfid
//   GEMINI_API_KEY       Gemini API key
//   WORKER_URL           Cloudflare Worker URL
//   ADMIN_TOKEN          Cloudflare Worker 的管理员 token
//   PORT                 端口（Render 自动设置）
// ============================================================

const express = require('express');
const crypto  = require('crypto');
const fetch   = require('node-fetch');

const app = express();
app.use(express.text({ type: 'text/xml' }));
app.use(express.text({ type: 'application/xml' }));

const STATE_TTL = 30 * 60 * 1000; // 30分钟

// 内存状态存储（简单版，单实例够用）
const userStates = new Map();

// ============================================================
// 路由
// ============================================================

// 企业微信域名验证文件
app.get('/WW_verify_tBq5D4siarKD8kCW.txt', (req, res) => {
  res.type('text/plain').send('tBq5D4siarKD8kCW');
});

// 健康检查
app.get('/', (req, res) => res.send('OK'));

// 微信 Webhook GET 验证
app.get('/wx', async (req, res) => {
  const { msg_signature, signature, timestamp, nonce, echostr } = req.query;
  const sig = msg_signature || signature;
  if (!echostr) return res.status(400).send('Bad Request');

  const parts = [process.env.WECHAT_TOKEN, timestamp, nonce, echostr].sort();
  const hash  = crypto.createHash('sha1').update(parts.join('')).digest('hex');
  if (hash !== sig) return res.status(403).send('Invalid signature');

  try {
    const msg = decryptEchostr(echostr);
    res.type('text/plain').send(msg);
  } catch (e) {
    res.type('text/plain').send(echostr);
  }
});

// 微信 Webhook POST 消息
app.post('/wx', async (req, res) => {
  const { msg_signature, timestamp, nonce } = req.query;
  const body = req.body;

  const encryptedContent = extractXmlTag(body, 'Encrypt');
  if (!encryptedContent) return res.send('OK');

  const valid = verifySignature(msg_signature, timestamp, nonce, encryptedContent);
  if (!valid) return res.status(403).send('Invalid signature');

  let plainXml;
  try {
    plainXml = decryptMsg(encryptedContent);
  } catch (e) {
    console.error('Decrypt failed:', e.message);
    return res.send('OK');
  }

  res.send('OK'); // 立即返回，异步处理

  const msgType = extractXmlTag(plainXml, 'MsgType');
  const event   = extractXmlTag(plainXml, 'Event');
  const openKfId = extractXmlTag(plainXml, 'OpenKfId') || process.env.WECHAT_KF_ID;

  if (msgType === 'event' && event === 'kf_msg_or_event') {
    const token = extractXmlTag(plainXml, 'Token');
    syncAndProcessMessages(openKfId, token).catch(console.error);
  }
});

// ============================================================
// 微信消息同步
// ============================================================

async function syncAndProcessMessages(openKfId, token) {
  const accessToken = await getWxAccessToken();
  if (!accessToken) return;

  // 从 Worker API 读取 cursor（持久化，重启不丢）
  let cursor = '';
  try {
    const cr = await fetch(`${process.env.WORKER_URL}/api/cursor?key=${openKfId}`);
    if (cr.ok) { const cd = await cr.json(); cursor = cd.cursor || ''; }
  } catch(e) {}

  const res = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/kf/sync_msg?access_token=${accessToken}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursor, token, limit: 20, open_kfid: openKfId })
    }
  );

  const data = await res.json();
  if (data.errcode !== 0) { console.error('sync_msg failed:', data); return; }
  if (data.next_cursor) {
    try {
      await fetch(`${process.env.WORKER_URL}/api/cursor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: openKfId, cursor: data.next_cursor })
      });
    } catch(e) {}
  }

  const msgList = data.msg_list || [];
  if (!msgList.length) return;

  // 加载产品列表
  let products = [];
  try {
    const r = await fetch(`${process.env.WORKER_URL}/api/products`);
    products = await r.json();
  } catch (e) { console.error('Failed to load products:', e); }

  // 加载已有订单号
  let existingCodes = [];
  try {
    const r = await fetch(`${process.env.WORKER_URL}/api/orders`);
    const orders = await r.json();
    for (const o of orders) {
      for (const inc of (o.incoming || [])) {
        if (inc.express_code) existingCodes.push(inc.express_code);
        if (inc.pickup_code)  existingCodes.push(inc.pickup_code);
      }
    }
  } catch (e) { console.error('Failed to load orders:', e); }

  const productList = products.map(p => `${p.id}（${p.product_name}）`).join('、');

  for (const msg of msgList) {
    if (msg.msgtype !== 'text' || msg.origin !== 3) continue;
    const text   = msg.text?.content?.trim();
    const userId = msg.external_userid;
    const kfId   = msg.open_kfid || openKfId;
    if (!text || !userId) continue;

    // 防重
    const doneKey = `msg_${msg.msgid}`;
    if (userStates.get(doneKey)) continue;
    userStates.set(doneKey, true);
    setTimeout(() => userStates.delete(doneKey), 7 * 24 * 60 * 60 * 1000);

    await handleUserMessage(text, userId, kfId, productList, existingCodes);
  }
}

// ============================================================
// 用户消息处理（状态机）
// ============================================================

async function handleUserMessage(text, userId, openKfId, productList, existingCodes) {
  const stateKey = `state_${userId}`;

  // 确保会话处于服务中状态
  await ensureSessionActive(userId, openKfId);

  // 取消指令
  if (['取消', '重新来', '重置', '算了'].some(w => text.includes(w))) {
    userStates.delete(stateKey);
    await sendWechatMsg(userId, openKfId, '已清空当前订单，可以重新开始。');
    return;
  }

  const stateEntry = userStates.get(stateKey);
  const state = stateEntry?.data || null;

  // 待确认状态下用户回复"确认"
  if (stateEntry?.awaiting_confirm && ['确认', '是', 'yes', '对', '好'].some(w => text.includes(w))) {
    const order = buildOrder(state, userId);
    try {
      const r = await fetch(`${process.env.WORKER_URL}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(order)
      });
      if (!r.ok) throw new Error(`API error ${r.status}`);
      userStates.delete(stateKey);
      await sendWechatMsg(userId, openKfId, `✅ 订单已提交！\n订单号：${order.incoming.map(i => i.express_code).join('、')}`);
    } catch (e) {
      await sendWechatMsg(userId, openKfId, '提交失败，请稍后再试。');
    }
    return;
  }

  const result = await parseWithState(text, productList, existingCodes, state);

  if (!result) {
    await sendWechatMsg(userId, openKfId, '解析出错，请稍后再试。');
    return;
  }

  if (!result.valid) {
    if (result.partial_data) {
      userStates.set(stateKey, { data: result.partial_data, last_updated: Date.now() });
      setTimeout(() => userStates.delete(stateKey), STATE_TTL);
    }
    await sendWechatMsg(userId, openKfId, result.error_reply);
    return;
  }

  if (result.ready_to_submit) {
    const finalData = result.data || result.partial_data;
    const preview = buildConfirmPreview(finalData);
    await sendWechatMsg(userId, openKfId, preview + '\n\n回复"确认"提交，回复"取消"重新来。');
    userStates.set(stateKey, { data: finalData, awaiting_confirm: true, last_updated: Date.now() });
    setTimeout(() => userStates.delete(stateKey), STATE_TTL);
  }
}

// ============================================================
// Gemini 状态机 Parse
// ============================================================

async function parseWithState(text, productList, existingCodes, currentData) {
  const currentDataStr = currentData
    ? `目前已收集到的信息：\n${JSON.stringify(currentData, null, 2)}`
    : '目前还没有收集到任何信息。';

  const existingCodesStr = existingCodes.length > 0 ? existingCodes.join('、') : '无';

  const prompt = `你是一个转运订单助手，负责通过多轮对话收集订单信息。

可用产品列表（格式：产品ID（产品名称））：
${productList || '暂无产品信息'}

数据库中已有的订单号和取货码（不能重复）：
${existingCodesStr}

${currentDataStr}

客户最新消息：
${text}

请返回以下 JSON 格式，不要有其他文字：
{
  "valid": false,
  "ready_to_submit": false,
  "error_reply": "用口语中文告诉客户还需要提供什么，或者哪里有问题",
  "partial_data": {
    "created_by": "",
    "incoming": [],
    "outgoing": []
  },
  "data": null
}

规则：
- 把客户新消息里的信息合并进已有信息，不要丢弃之前收集到的内容
- 信息完整（有订单号、取货码、至少一个收件人含姓名/电话/地址）且来件和寄件产品总数匹配时：valid=true，ready_to_submit=true，data 填完整数据
- 信息不完整时：valid=false，error_reply 说清楚还缺什么，partial_data 填已收集到的内容
- 产品无法识别先模糊匹配，实在不确定才询问
- 同一次或已有订单号/取货码重复时说明哪个重复了
- 来件和寄件产品总数不匹配时说明哪个产品数量对不上
- 只能用产品列表里有的产品
- 只返回 JSON，不要 markdown 代码块`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1 }
      })
    }
  );

  if (!res.ok) { console.error('Gemini error:', await res.text()); return null; }
  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (e) {
    console.error('Gemini parse failed:', raw);
    return null;
  }
}

// ============================================================
// 辅助函数
// ============================================================

function buildOrder(data, userId) {
  return {
    id: 'ORD_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
    created_at: new Date().toISOString(),
    created_by: data.created_by || userId || '微信客户',
    source: 'wechat',
    incoming: data.incoming || [],
    outgoing: data.outgoing || [],
  };
}

function buildConfirmPreview(data) {
  const codes = (data.incoming || []).map(i => i.express_code).join('、');
  const lines = ['📋 订单确认', '', `订单号：${codes}`];
  (data.incoming || []).forEach((inc, i) => {
    if (data.incoming.length > 1) lines.push(`\n来件单 ${i + 1}：${inc.express_code}（取货码：${inc.pickup_code}）`);
    else lines.push(`取货码：${inc.pickup_code}`);
    (inc.products || []).forEach(p => lines.push(`  ${p.product_name} × ${p.quantity}`));
  });
  if ((data.outgoing || []).length > 0) {
    lines.push('\n收件人：');
    data.outgoing.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.name}  ${r.phone}`);
      lines.push(`   ${r.address}`);
      (r.products || []).forEach(p => lines.push(`   ${p.product_name} × ${p.quantity}`));
      if (r.notes) lines.push(`   备注：${r.notes}`);
    });
  }
  return lines.join('\n');
}

// ============================================================
// 微信 API
// ============================================================

let cachedToken = null;
let tokenExpiry = 0;

async function getWxAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${process.env.WECHAT_CORP_ID}&corpsecret=${process.env.WECHAT_CORP_SECRET}`
  );
  const data = await res.json();
  if (data.errcode !== 0) { console.error('gettoken failed:', data); return null; }
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + 7000 * 1000;
  return cachedToken;
}

async function ensureSessionActive(userId, openKfId) {
  const token = await getWxAccessToken();
  if (!token) return;
  try {
    // 查询当前会话状态
    const stateRes = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/kf/service_state/get?access_token=${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ open_kfid: openKfId, external_userid: userId })
      }
    );
    const stateData = await stateRes.json();
    console.log('service_state:', stateData);

    const state = stateData.service_state;
    let targetState = null;
    let body = { open_kfid: openKfId, external_userid: userId };

    if (state === 0) {
      // 未处理 → 智能助手接待
      targetState = 1;
      body.service_state = 1;
    } else if (state === 2) {
      // 待接入池 → 人工接待
      targetState = 3;
      body.service_state = 3;
      body.servicer_userid = 'RenKaiLing';
    }

    if (targetState !== null) {
      const transRes = await fetch(
        `https://qyapi.weixin.qq.com/cgi-bin/kf/service_state/trans?access_token=${token}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }
      );
      const transData = await transRes.json();
      console.log('trans_state:', transData);
    }
  } catch(e) {
    console.log('ensureSessionActive error (ignored):', e.message);
  }
}

async function sendWechatMsg(toUser, openKfId, content) {
  const token = await getWxAccessToken();
  if (!token) return;
  const res = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/kf/send_msg?access_token=${token}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ touser: toUser, open_kfid: openKfId, msgtype: 'text', text: { content } })
    }
  );
  const data = await res.json();
  if (data.errcode !== 0) console.error('WeChat send failed:', data);
}

// ============================================================
// 微信加解密
// ============================================================

function decryptEchostr(echostr) {
  const aesKey = Buffer.from(process.env.WECHAT_AES_KEY + '=', 'base64');
  const enc    = Buffer.from(echostr, 'base64');
  const iv     = enc.slice(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
  decipher.setAutoPadding(false);
  const dec = Buffer.concat([decipher.update(enc.slice(16)), decipher.final()]);
  const msgLen = dec.readUInt32BE(0);
  return dec.slice(4, 4 + msgLen).toString('utf-8');
}

function decryptMsg(encryptedB64) {
  const aesKey = Buffer.from(process.env.WECHAT_AES_KEY + '=', 'base64');
  const enc    = Buffer.from(encryptedB64, 'base64');
  const iv     = enc.slice(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
  decipher.setAutoPadding(false);
  const dec = Buffer.concat([decipher.update(enc.slice(16)), decipher.final()]);
  const text = dec.toString('utf-8');
  const xmlStart = text.indexOf('<xml>');
  const xmlEnd   = text.indexOf('</xml>') + 6;
  if (xmlStart >= 0) return text.slice(xmlStart, xmlEnd);
  return text;
}

function verifySignature(signature, timestamp, nonce, encrypt) {
  const parts = [process.env.WECHAT_TOKEN, timestamp, nonce, encrypt].sort();
  const hash  = crypto.createHash('sha1').update(parts.join('')).digest('hex');
  return hash === signature;
}

function extractXmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
}

// ============================================================
// 启动
// ============================================================

app.get('/setup', async (req, res) => {
  try {
    const token = await getWxAccessToken();
    const result = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/kf/servicer/add?access_token=${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          open_kfid: process.env.WECHAT_KF_ID,
          userid_list: ['RenKaiLing']
        })
      }
    );
    const text = await result.text();
    res.send(text);
  } catch(e) {
    res.status(500).send(e.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));