// Senha de acesso ao painel. Defina PANEL_PASSWORD no servidor; sem ela o painel fica aberto (e avisa).
import crypto from 'node:crypto';

const PASS = () => process.env.PANEL_PASSWORD || '';
const SECRET = () => process.env.SESSION_SECRET || crypto.createHash('sha256').update(`afl|${PASS()}`).digest('hex');
export const isProtected = () => Boolean(PASS());

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
export const checkPassword = (p) => isProtected() && crypto.timingSafeEqual(sha(p ?? ''), sha(PASS()));
const mac = (v) => crypto.createHmac('sha256', SECRET()).update(v).digest('base64url');

export function makeToken(days = 30, now = Date.now()) {
  const exp = String(now + days * 864e5);
  return `${exp}.${mac(exp)}`;
}
export function validToken(token, now = Date.now()) {
  const [exp, sig] = String(token || '').split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < now) return false;
  const a = Buffer.from(sig), b = Buffer.from(mac(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export const readCookies = (h = '') =>
  Object.fromEntries(String(h).split(';').map((c) => c.trim().split(/=(.*)/s).slice(0, 2)).filter((x) => x[0]));

// limite de tentativas erradas por IP: 5 em 10 minutos
const fails = new Map();
const blocked = (ip, now) => (fails.get(ip)?.until || 0) > now;
function fail(ip, now) {
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= 5) { f.until = now + 600e3; f.n = 0; }
  fails.set(ip, f);
}

const LOGIN_HTML = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>AfiliadoFlow – Entrar</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#12131c;color:#eceefa;font:16px/1.5 system-ui,sans-serif}
form{width:min(92vw,360px);background:#1b1d2b;border:1px solid #2a2d41;border-radius:18px;padding:28px}
h1{font-size:20px;margin:0 0 4px}p{color:#9aa0c3;margin:0 0 18px;font-size:14px}
input,button{width:100%;font:inherit;border-radius:12px;padding:12px 14px;border:1px solid #2a2d41}
input{background:#12131c;color:#eceefa}button{margin-top:12px;border:0;font-weight:600;color:#fff;cursor:pointer;background:linear-gradient(135deg,#5b5bf0,#8b5cf6)}
#m{color:#ff8a8a;font-size:14px;min-height:20px;margin-top:10px}</style></head><body>
<form onsubmit="return go(event)"><h1>▶ AfiliadoFlow</h1><p>Digite a senha para entrar.</p>
<input id="p" type="password" placeholder="Senha" autocomplete="current-password" autofocus><button>Entrar</button><div id="m"></div></form>
<script>async function go(e){e.preventDefault();const m=document.getElementById('m');m.textContent='';
try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('p').value})});
const j=await r.json().catch(()=>({}));if(r.ok)location.reload();else m.textContent=j.error||'Não foi possível entrar'}catch(x){m.textContent='Sem conexão com o servidor'}return false}</script></body></html>`;

export function install(app) {
  const secure = (req) => req.secure || req.headers['x-forwarded-proto'] === 'https';
  const authed = (req) => !isProtected() || validToken(readCookies(req.headers.cookie).afl_session);

  app.get('/api/auth/status', (req, res) => res.json({ protected: isProtected(), authenticated: authed(req) }));

  app.post('/api/login', (req, res) => {
    if (!isProtected()) return res.json({ ok: true, protected: false });
    const ip = req.ip || 'x', now = Date.now();
    if (blocked(ip, now)) return res.status(429).json({ error: 'Muitas tentativas. Espere 10 minutos.' });
    if (!checkPassword((req.body || {}).password)) { fail(ip, now); return res.status(401).json({ error: 'Senha incorreta' }); }
    fails.delete(ip);
    res.setHeader('Set-Cookie', `afl_session=${makeToken()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${30 * 86400}${secure(req) ? '; Secure' : ''}`);
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', `afl_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure(req) ? '; Secure' : ''}`);
    res.json({ ok: true });
  });

  // tudo abaixo exige login, menos o "acordar" do servidor e a automação agendada (essa tem chave própria)
  const open = new Set(['/api/ping', '/api/auto/run']);
  app.use((req, res, next) => {
    if (authed(req) || open.has(req.path)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Faça login no painel' });
    return res.status(401).type('html').send(LOGIN_HTML);
  });
}
