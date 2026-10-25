// Tiny CORS proxy for the MyAnimeList API (MAL blocks direct browser calls).
// Deploy on Vercel. Only forwards to MAL hosts. Tokens pass through; nothing is stored.
const ALLOW = ['myanimelist.net', 'api.myanimelist.net', 'api.mangadex.org'];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  let target;
  try { target = new URL(req.query.u); } catch { return res.status(400).json({ error: 'bad url' }); }
  if (target.protocol !== 'https:' || !ALLOW.includes(target.hostname)) {
    return res.status(403).json({ error: 'host not allowed' });
  }

  const headers = {};
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;
  let body;
  if (!['GET', 'HEAD'].includes(req.method)) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = typeof req.body === 'string' ? req.body : new URLSearchParams(req.body || {}).toString();
  }

  try {
    const r = await fetch(target, { method: req.method, headers, body });
    const text = await r.text();
    res.status(r.status);
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
};
