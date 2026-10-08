// Envio do pacote (vídeo + legenda + link) para o seu Telegram. O token fica só no servidor.
const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_API_BASE } = process.env;
const API = `${TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${TELEGRAM_BOT_TOKEN}`;

const fail = (message, status = 502) => Object.assign(new Error(message), { status });
export const hasToken = () => Boolean(TELEGRAM_BOT_TOKEN);
export const isConfigured = () => Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);

// TELEGRAM_CHAT_ID aceita vários destinos separados por vírgula: IDs de pessoas, @canal ou -100... (canal/grupo)
export const targets = () => String(TELEGRAM_CHAT_ID || '').split(/[,\s;]+/).filter(Boolean);
// Envia para todos; só falha se NINGUÉM receber (quem não apertou Start no bot é ignorado).
async function fanout(fn) {
  const ok = [], bad = [];
  for (const id of targets()) {
    try { await fn(id); ok.push(id); } catch (e) { bad.push(`${id}: ${e.message}`); }
  }
  if (!ok.length) throw fail(bad[0] || 'Nenhum destino configurado');
  if (bad.length) console.warn('Telegram: falhou para', bad.join(' | '));
  return { enviados: ok.length, falhas: bad.length };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, body, isForm = false, retry = true) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    ...(isForm ? { body } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120000),
  });
  const j = await res.json().catch(() => ({}));
  if (res.status === 429 && retry) { // limite de envios: espera o tempo pedido e tenta de novo uma vez
    await sleep(Math.min(30, Number(j?.parameters?.retry_after) || 2) * (process.env.TELEGRAM_RETRY_FAST ? 10 : 1000));
    return call(method, body, isForm, false);
  }
  if (!res.ok || !j.ok) throw fail(`Telegram: ${j.description || res.status}`);
  return j.result;
}

// Ajuda a descobrir o ID do chat: mande uma mensagem ao bot e abra /api/telegram/chats
export async function listChats() {
  if (!hasToken()) throw fail('TELEGRAM_BOT_TOKEN não configurado no servidor', 503);
  if (TELEGRAM_CHAT_ID) throw fail('O chat já está configurado. Para listar de novo, apague TELEGRAM_CHAT_ID.', 403);
  const updates = await call('getUpdates', { limit: 50 });
  const chats = new Map();
  for (const u of updates) {
    const c = (u.message || u.edited_message || u.my_chat_member || {}).chat;
    if (c && c.type === 'private') chats.set(c.id, { id: c.id, nome: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || '' });
  }
  return { chats: [...chats.values()] };
}

export async function sendVideo({ buffer, caption, html = false }) {
  if (!isConfigured()) throw fail('Telegram não configurado (TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID)', 503);
  if (buffer.length > 49e6) throw fail('Vídeo maior que 50 MB, o limite do Telegram para bots', 413);
  await fanout(async (id) => {
    const form = new FormData();
    form.append('chat_id', id);
    form.append('caption', html ? String(caption || '') : String(caption || '').slice(0, 1000));
    if (html) form.append('parse_mode', 'HTML');
    form.append('supports_streaming', 'true');
    form.append('video', new Blob([buffer], { type: 'video/mp4' }), 'video.mp4');
    await call('sendVideo', form, true);
  });
  return true;
}

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const spoiler = (t) => `<tg-spoiler>${esc(t)}</tg-spoiler>`; // texto "nublado": toque para revelar

export async function sendMessage(text, { html = false } = {}) {
  if (!isConfigured()) throw fail('Telegram não configurado (TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID)', 503);
  await fanout((id) => call('sendMessage', html ? { chat_id: id, text: String(text), parse_mode: 'HTML', link_preview_options: { is_disabled: true } } : { chat_id: id, text: String(text).slice(0, 3500) }));
  return true;
}

const money = (n) => `R$ ${Number(n).toFixed(2).replace('.', ',')}`;
// Devolve HTML: nome, preço, comissão, #hashtags e link (sem descrição e sem aviso do prompt). Use com { html: true }.
export function formatProductMessage({ product = {}, caption = '' }) {
  const p = product, lines = [];
  if (p.name) lines.push(`📦 ${esc(String(p.name).slice(0, 200))}`);
  if (Number.isFinite(Number(p.sale)) && Number(p.sale) > 0) {
    const old = Number(p.old) > Number(p.sale) ? ` (de ${money(p.old)})` : '';
    lines.push(`💰 ${money(p.sale)}${old}`);
  }
  if (Number.isFinite(Number(p.commission)) && Number(p.commission) > 0) lines.push(`📈 Comissão: ${Number(p.commission)}%`);
  if (caption) { // só as #hashtags (sem o texto da descrição)
    const tags = String(caption).match(/#[\p{L}\p{N}_]+/gu);
    if (tags) lines.push('', esc([...new Set(tags)].slice(0, 12).join(' ')));
  }
  if (/^https:\/\/\S+$/.test(String(p.affiliateUrl || ''))) lines.push('', `🔗 ${esc(String(p.affiliateUrl).slice(0, 300))}`);
  return lines.join('\n');
}

export async function sendPhoto({ photoUrl, caption, html = false }) {
  if (!isConfigured()) throw fail('Telegram não configurado (TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID)', 503);
  if (!/^https:\/\/\S+$/.test(String(photoUrl || ''))) throw fail('Endereço de imagem inválido', 400);
  await fanout((id) => call('sendPhoto', html ? { chat_id: id, photo: photoUrl, caption: String(caption || ''), parse_mode: 'HTML' } : { chat_id: id, photo: photoUrl, caption: String(caption || '').slice(0, 1000) }));
  return true;
}
