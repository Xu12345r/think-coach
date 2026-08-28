// api/history.js — 对话历史云端存储（GitHub 仓库，按昵称隔离）
// GET  /api/history?nickname=xxx   → 读该昵称的历史
// POST /api/history  {nickname, history} → 存历史
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = 'Xu12345r/think-coach';
const BRANCH = 'main';

function sendJson(res, status, obj) {
  res.status(status).json(obj);
}

function ghHeaders(extra) {
  return Object.assign({
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'think-coach',
  }, extra || {});
}

function fileUrl(nickname) {
  return `https://api.github.com/repos/${REPO}/contents/data/history/${encodeURIComponent(nickname)}.json`;
}

async function readHistory(nickname) {
  const res = await fetch(fileUrl(nickname), { headers: ghHeaders() });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`读历史失败(${res.status})`);
  const data = await res.json();
  try {
    const arr = JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

async function writeHistory(nickname, history) {
  // 先拿现有 sha（文件可能存在，更新需要 sha）
  let sha = null;
  const getRes = await fetch(fileUrl(nickname), { headers: ghHeaders() });
  if (getRes.status === 200) {
    const d = await getRes.json();
    sha = d.sha;
  } else if (getRes.status !== 404) {
    throw new Error(`读取现有文件失败(${getRes.status})`);
  }
  const payload = {
    message: `save history: ${nickname}`,
    content: Buffer.from(JSON.stringify(history)).toString('base64'),
    branch: BRANCH,
  };
  if (sha) payload.sha = sha;
  const putRes = await fetch(fileUrl(nickname), {
    method: 'PUT',
    headers: ghHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  if (!putRes.ok) {
    const t = await putRes.text();
    throw new Error(`保存历史失败(${putRes.status}): ${t.slice(0, 80)}`);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // 解析 body
  let body = {};
  if (req.body) body = req.body;
  else if (typeof req.on === 'function') {
    body = await new Promise(resolve => {
      let d = '';
      req.on('data', c => d += c);
      req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    });
  }

  // 解析 nickname（POST body 或 GET query）
  let nickname = (body.nickname || '').toString().trim();
  if (!nickname) {
    try {
      const u = new URL(req.url, 'http://x');
      nickname = (u.searchParams.get('nickname') || '').trim();
    } catch {}
  }
  if (!nickname) return sendJson(res, 400, { error: '缺少昵称' });

  try {
    if (req.method === 'GET') {
      const history = await readHistory(nickname);
      return sendJson(res, 200, { history });
    }
    if (req.method === 'POST') {
      const history = Array.isArray(body.history) ? body.history : [];
      await writeHistory(nickname, history);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
};
