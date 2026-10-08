// Automação: busca produtos na Shopee → gera prompt e legenda (OpenAI) → envia ao Telegram (foto + info + prompt).
// Opcional: AUTO_VIDEO=true também gera o vídeo (Veo) e envia o arquivo.
import fs from 'node:fs';
import * as shopee from './shopee.js';
import * as openai from './openai.js';
import * as video from './videoProvider.js';
import * as telegram from './telegram.js';

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const SENT_FILE = env('SENT_FILE', './sent-products.json'); // no plano gratuito do Render o arquivo se perde ao reiniciar
let sent = new Set();
try { sent = new Set(JSON.parse(fs.readFileSync(SENT_FILE, 'utf8'))); } catch { /* primeira execução */ }
const saveSent = () => { try { fs.writeFileSync(SENT_FILE, JSON.stringify([...sent].slice(-500))); } catch { /* sem disco */ } };

let running = false;
export const state = { last: null, progress: null };
export const isRunning = () => running;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeVideo(p, prompt, head) {
  const { id } = await video.start({ prompt, imageUrl: p.image });
  const poll = Number(env('AUTO_POLL_MS', 10000));
  for (let i = 0; i < 60; i++) {
    await sleep(poll);
    const s = await video.status(id);
    if (s.status === 'FAILED') throw new Error(`Vídeo: ${s.error}`);
    if (s.status === 'COMPLETED') { await telegram.sendVideo({ buffer: await video.file(id), caption: head, html: true }); return; }
  }
  throw new Error('Vídeo demorou demais');
}

// devolve true quando o produto ficou "completo" (com prompt) e pode ser marcado como enviado
async function processProduct(p, report, { video: withVideo = true } = {}) {
  const product = { name: p.name, sale: p.salePrice, old: p.originalPrice, commission: p.commission, affiliateUrl: p.affiliateUrl };
  let prompt = '', caption = '';
  try { prompt = await openai.generateVideoPrompt({ product: { name: p.name } }); }
  catch (e) { report.errors.push(`Prompt (${(p.name || '').slice(0, 30)}): ${e.message}`); }
  try { caption = await openai.generateCaption({ product: { name: p.name, category: p.category } }); } catch { /* segue sem legenda */ }

  const head = telegram.formatProductMessage({ product, caption });
  if (p.image) { try { await telegram.sendPhoto({ photoUrl: p.image, caption: head, html: true }); } catch { await telegram.sendMessage(head, { html: true }); } }
  else await telegram.sendMessage(head, { html: true });
  if (prompt) await telegram.sendMessage(prompt);

  if (withVideo && prompt && env('AUTO_VIDEO', 'false') === 'true' && video.isConfigured()) {
    try { await makeVideo(p, prompt, head); } catch (e) { report.errors.push(e.message); }
  }
  return Boolean(prompt);
}

export async function run({ source = 'cron' } = {}) {
  if (running) return { skipped: 'já está em execução' };
  running = true;
  const report = { at: new Date().toISOString(), source, products: 0, sent: 0, errors: [] };
  try {
    if (!telegram.isConfigured()) throw new Error('Telegram não configurado');
    const keywords = env('AUTO_KEYWORDS', '').split(',').map((s) => s.trim()).filter(Boolean);
    const keyword = keywords.length ? keywords[Math.floor(Math.random() * keywords.length)] : '';
    const { items } = await shopee.findOpportunities({
      keyword, pages: 4,
      minSales: env('AUTO_MIN_SALES', 20), maxSales: env('AUTO_MAX_SALES', 1000),
      minRating: env('AUTO_MIN_RATING', 4.5), minCommission: env('AUTO_MIN_COMMISSION', 10),
    });
    const fresh = items.filter((p) => !sent.has(p.id)).slice(0, Number(env('AUTO_COUNT', 3)));
    Object.assign(report, { keyword, products: fresh.length });
    if (!fresh.length) await telegram.sendMessage(`ℹ️ Automação: nenhum produto novo com os filtros atuais${keyword ? ` (palavra-chave: ${keyword})` : ''}.`);
    for (const p of fresh) {
      try { if (await processProduct(p, report)) { sent.add(p.id); saveSent(); } report.sent++; }
      catch (e) { report.errors.push(`${(p.name || '').slice(0, 30)}: ${e.message}`); }
    }
    if (report.errors.length) await telegram.sendMessage(`⚠️ Automação com avisos:\n- ${report.errors.slice(0, 5).join('\n- ')}`).catch(() => {});
  } catch (e) {
    report.errors.push(e.message);
    try { await telegram.sendMessage(`⚠️ Automação falhou: ${e.message}`); } catch { /* sem Telegram */ }
  } finally { running = false; state.progress = null; state.last = report; }
  return report;
}

// Envio em lote: manda ao Telegram todos os produtos recebidos (foto + informações + legenda + prompt).
// Não gera vídeo (evita custo) e não usa a lista de "já enviados".
const BULK_MAX = () => Math.max(1, Number(env('AUTO_BULK_MAX', 30)));
const https = (u) => (/^https:\/\/\S+$/.test(String(u || '')) ? String(u).slice(0, 500) : '');
export function normalizeList(list) {
  if (!Array.isArray(list)) return [];
  return list.map((p) => ({
    id: '', name: String(p?.name || '').slice(0, 200), category: String(p?.category || '').slice(0, 80),
    image: https(p?.image), salePrice: Number(p?.salePrice) || 0, originalPrice: Number(p?.originalPrice) || 0,
    commission: Number(p?.commission) || 0, affiliateUrl: https(p?.affiliateUrl),
  })).filter((p) => p.name).slice(0, BULK_MAX());
}

export async function runList(list, { source = 'painel' } = {}) {
  if (running) return { skipped: 'já está em execução' };
  const items = normalizeList(list);
  running = true;
  const report = { at: new Date().toISOString(), source, products: items.length, sent: 0, errors: [], keyword: '(lista do painel)' };
  state.progress = { done: 0, total: items.length };
  try {
    if (!telegram.isConfigured()) throw new Error('Telegram não configurado');
    await telegram.sendMessage(`📦 Enviando ${items.length} produto(s) com foto, legenda e prompt do vídeo. Pode levar alguns minutos.`);
    for (const p of items) {
      try { await processProduct(p, report, { video: false }); report.sent++; }
      catch (e) { report.errors.push(`${p.name.slice(0, 30)}: ${e.message}`); }
      state.progress.done++;
      await sleep(Number(env('AUTO_BULK_DELAY_MS', 1200)));
    }
    await telegram.sendMessage(`✅ Envio concluído: ${report.sent} de ${items.length} produto(s).${report.errors.length ? `\n⚠️ Avisos:\n- ${report.errors.slice(0, 5).join('\n- ')}` : ''}`).catch(() => {});
  } catch (e) {
    report.errors.push(e.message);
    try { await telegram.sendMessage(`⚠️ Envio em lote falhou: ${e.message}`); } catch { /* sem Telegram */ }
  } finally { running = false; state.progress = null; state.last = report; }
  return report;
}
