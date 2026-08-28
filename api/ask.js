const fs = require('fs');
const path = require('path');

// 读入万维钢·现代思维工具100讲 全文，作为系统提示词
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'system-prompt.md'), 'utf-8');

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-chat';
const DEFAULT_PASSCODE = '5257';

function sendJson(res, status, obj) {
  res.status(status).json(obj);
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (!body && typeof req.on === 'function') {
    body = await new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
      });
    });
  }
  body = body || {};

  const { question, history, passcode } = body;

  // 口令校验（错误用普通 JSON 返回）
  const expected = process.env.PASSCODE || DEFAULT_PASSCODE;
  if (!passcode || String(passcode) !== String(expected)) {
    return sendJson(res, 401, { error: '口令错误' });
  }
  if (!question || !String(question).trim()) {
    return sendJson(res, 400, { error: '问题不能为空' });
  }

  // 组装消息
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  if (Array.isArray(history)) {
    for (const msg of history.slice(-8)) {
      if (msg && (msg.role === 'user' || msg.role === 'assistant') && msg.content) {
        messages.push({ role: msg.role, content: String(msg.content) });
      }
    }
  }
  messages.push({ role: 'user', content: String(question) });

  let upstream;
  try {
    upstream = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.7,
        max_tokens: 4000,
        stream: true,
      }),
    });
  } catch (e) {
    return sendJson(res, 500, { error: `连接模型服务失败: ${e.message}` });
  }

  if (!upstream.ok) {
    const errText = await upstream.text();
    return sendJson(res, upstream.status, { error: `模型服务错误 (${upstream.status}): ${errText.slice(0, 200)}` });
  }

  // 流式转发：解析 SSE，提取 content 增量，以纯文本 chunked 输出
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders && res.flushHeaders();

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (delta) res.write(delta);
        } catch {}
      }
    }
  } catch (e) {
    // 流中断时尽量结束
  }

  res.end();
};
