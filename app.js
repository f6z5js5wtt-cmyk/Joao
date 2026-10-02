import express from 'express';
import cors from 'cors';
import * as shopee from './shopee.js';
import * as openai from './openai.js';
import * as video from './video.js';
import * as telegram from './telegram.js';
import * as auto from './auto.js';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN }));

app.get('/api/shopee/status', (_req, res) =>
  res.json({ configured: shopee.isConfigured(), appId: shopee.maskedAppId() }));

const cache = new Map(); // evita estourar o limite de requisições da Shopee
app.get('/api/report', async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  const hit = cache.get(days);
  if (hit && Date.now() - hit.t < 60e3) return res.json(hit.v);
  try { const v = await shopee.conversionReport(days); cache.set(days, { t: Date.now(), v }); res.json(v); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

const oppCache = new Map();
app.get('/api/opportunities', async (req, res) => {
  const key = JSON.stringify(req.query);
  const hit = oppCache.get(key);
  if (hit && Date.now() - hit.t < 300e3) return res.json(hit.v);
  try { const v = await shopee.findOpportunities(req.query); oppCache.set(key, { t: Date.now(), v }); res.json(v); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

const prodCache = new Map(); // 3 min: atualiza sempre, sem estourar o limite da Shopee
app.get('/api/products', async (req, res) => {
  const key = JSON.stringify(req.query);
  const hit = prodCache.get(key);
  if (hit && Date.now() - hit.t < 180e3) return res.json(hit.v);
  try { const v = await shopee.listProducts(req.query); prodCache.set(key, { t: Date.now(), v }); res.json(v); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/shortlink', async (req, res) => {
  try { res.json({ shortLink: await shopee.shortLink(req.body.url, req.body.subIds) }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});


// Limite simples (o painel não tem login): evita gasto excessivo na OpenAI
const usage = { start: Date.now(), n: 0 };
const LIMIT_PER_HOUR = Number(process.env.PROMPT_LIMIT_PER_HOUR || 30);
app.get('/api/openai/status', (_req, res) =>
  res.json({ configured: openai.isConfigured(), model: openai.modelName() }));
app.post('/api/prompt', async (req, res) => {
  if (Date.now() - usage.start > 3600e3) { usage.start = Date.now(); usage.n = 0; }
  if (++usage.n > LIMIT_PER_HOUR) return res.status(429).json({ error: 'Limite de prompts por hora atingido' });
  try { res.json({ prompt: await openai.generateVideoPrompt(req.body || {}) }); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

app.get('/api/video/status-config', (_req, res) => res.json({ configured: video.isConfigured(), model: video.modelName() }));
app.get('/api/video/models', async (_req, res) => {
  try { res.json(await video.listModels()); } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});
app.post('/api/video/start', async (req, res) => {
  try { res.json(await video.start(req.body || {})); } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});
app.get('/api/video/status', async (req, res) => {
  try { res.json(await video.status(String(req.query.id || ''))); } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});
app.get('/api/video/file', async (req, res) => {
  try { const r = video.range(await video.file(String(req.query.id || '')), req.headers.range); res.status(r.status).set(r.headers).end(r.body); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

app.post('/api/caption', async (req, res) => {
  try { res.json({ caption: await openai.generateCaption(req.body || {}) }); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});
app.get('/api/telegram/status', (_req, res) => res.json({ configured: telegram.isConfigured() }));
app.get('/api/telegram/chats', async (_req, res) => {
  try { res.json(await telegram.listChats()); } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});
const tgUsage = { start: Date.now(), n: 0 };
const tgLimit = (res) => {
  if (Date.now() - tgUsage.start > 3600e3) { tgUsage.start = Date.now(); tgUsage.n = 0; }
  if (++tgUsage.n > 20) { res.status(429).json({ error: 'Limite de envios por hora atingido' }); return true; }
  return false;
};
app.post('/api/telegram/test', async (_req, res) => {
  try { if (tgLimit(res)) return; await telegram.sendMessage('✅ AfiliadoFlow conectado ao Telegram. Os pacotes de vídeo chegarão aqui.'); res.json({ ok: true }); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});
app.post('/api/telegram/message', async (req, res) => {
  try { if (tgLimit(res)) return; await telegram.sendMessage(telegram.formatProductMessage(req.body || {})); res.json({ ok: true }); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});
app.post('/api/telegram/send', async (req, res) => {
  try {
    if (Date.now() - tgUsage.start > 3600e3) { tgUsage.start = Date.now(); tgUsage.n = 0; }
    if (++tgUsage.n > 20) return res.status(429).json({ error: 'Limite de envios por hora atingido' });
    const { id, caption, link } = req.body || {};
    const buffer = await video.file(String(id || ''));
    const url = /^https:\/\/\S+$/.test(String(link || '')) ? `\n\n🔗 ${String(link).slice(0, 300)}` : '';
    await telegram.sendVideo({ buffer, caption: `${String(caption || '').slice(0, 650)}${url}` });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

// ===== Automação =====
const okKey = (k) => {
  const s = process.env.AUTO_SECRET || '';
  if (!s || !k) return false;
  const a = Buffer.from(String(k)), b = Buffer.from(s);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
app.get('/api/ping', (_req, res) => res.json({ ok: true }));
app.get('/api/auto/status', (_req, res) => res.json({ secretSet: Boolean(process.env.AUTO_SECRET), running: auto.isRunning(), last: auto.state.last }));
app.all('/api/auto/run', (req, res) => {
  if (!process.env.AUTO_SECRET) return res.status(503).json({ error: 'AUTO_SECRET não configurado no servidor' });
  if (!okKey(req.query.key || req.headers['x-auto-key'])) return res.status(401).json({ error: 'Chave inválida' });
  if (auto.isRunning()) return res.status(409).json({ error: 'Já está em execução' });
  res.status(202).json({ started: true });
  auto.run({ source: 'cron' });
});
const runNow = { start: Date.now(), n: 0 };
app.post('/api/auto/run-now', (_req, res) => {
  if (Date.now() - runNow.start > 3600e3) { runNow.start = Date.now(); runNow.n = 0; }
  if (++runNow.n > 5) return res.status(429).json({ error: 'Limite de execuções por hora atingido' });
  if (auto.isRunning()) return res.status(409).json({ error: 'Já está em execução' });
  res.status(202).json({ started: true });
  auto.run({ source: 'painel' });
});

app.get('/',(_req,res)=>res.sendFile(fileURLToPath(new URL('./index.html',import.meta.url))));
app.listen(process.env.PORT || 3001, () => console.log('API on :' + (process.env.PORT || 3001)));
