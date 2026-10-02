// Envio do pacote (vídeo + legenda + link) para o seu Telegram. O token fica só no servidor.
const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_API_BASE } = process.env;
const API = `${TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${TELEGRAM_BOT_TOKEN}`;

const fail = (message, status = 502) => Object.assign(new Error(message), { status });
export const hasToken = () => Boolean(TELEGRAM_BOT_TOKEN);
export const isConfigured = () => Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);

async function call(method, body, isForm = false) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    ...(isForm ? { body } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120000),
  });
  const j = await res.json().catch(() => ({}));
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

export async function sendVideo({ buffer, caption }) {
  if (!isConfigured()) throw fail('Telegram não configurado (TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID)', 503);
  if (buffer.length > 49e6) throw fail('Vídeo maior que 50 MB, o limite do Telegram para bots', 413);
  const form = new FormData();
  form.append('chat_id', TELEGRAM_CHAT_ID);
  form.append('caption', String(caption || '').slice(0, 1000));
  form.append('supports_streaming', 'true');
  form.append('video', new Blob([buffer], { type: 'video/mp4' }), 'video.mp4');
  await call('sendVideo', form, true);
  return true;
}

export async function sendMessage(text) {
  if (!isConfigured()) throw fail('Telegram não configurado (TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID)', 503);
  await call('sendMessage', { chat_id: TELEGRAM_CHAT_ID, text: String(text).slice(0, 3500) });
  return true;
}

const money = (n) => `R$ ${Number(n).toFixed(2).replace('.', ',')}`;
export function formatProductMessage({ product = {}, caption = '' }) {
  const p = product, lines = [];
  if (p.name) lines.push(`📦 ${String(p.name).slice(0, 200)}`);
  if (Number.isFinite(Number(p.sale)) && Number(p.sale) > 0) {
    const old = Number(p.old) > Number(p.sale) ? ` (de ${money(p.old)})` : '';
    lines.push(`💰 ${money(p.sale)}${old}`);
  }
  if (Number.isFinite(Number(p.commission)) && Number(p.commission) > 0) lines.push(`📈 Comissão: ${Number(p.commission)}%`);
  if (caption) lines.push('', String(caption).slice(0, 650));
  if (/^https:\/\/\S+$/.test(String(p.affiliateUrl || ''))) lines.push('', `🔗 ${String(p.affiliateUrl).slice(0, 300)}`);
  return lines.join('\n');
}

export async function sendPhoto({ photoUrl, caption }) {
  if (!isConfigured()) throw fail('Telegram não configurado (TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID)', 503);
  if (!/^https:\/\/\S+$/.test(String(photoUrl || ''))) throw fail('Endereço de imagem inválido', 400);
  await call('sendPhoto', { chat_id: TELEGRAM_CHAT_ID, photo: photoUrl, caption: String(caption || '').slice(0, 1000) });
  return true;
}
