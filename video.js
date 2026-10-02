// Geração de vídeo pela API do Gemini (Veo). A chave fica só no servidor.
const { GEMINI_API_KEY, GEMINI_VIDEO_MODEL, GEMINI_BASE_URL } = process.env;
const BASE = GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
const DURATION = Number(process.env.VIDEO_DURATION) || 8;
const RESOLUTION = process.env.VIDEO_RESOLUTION || '720p';
const MODE = process.env.VIDEO_IMAGE_MODE === 'reference' ? 'reference' : 'image';
const DAILY_LIMIT = Number(process.env.VIDEO_LIMIT_PER_DAY) || 10; // trava de custo (o painel não tem login)

const fail = (message, status = 502) => Object.assign(new Error(message), { status });
const headers = () => ({ 'x-goog-api-key': GEMINI_API_KEY, 'Content-Type': 'application/json' });
export const isConfigured = () => Boolean(GEMINI_API_KEY && GEMINI_VIDEO_MODEL);
export const modelName = () => GEMINI_VIDEO_MODEL || '';

const usage = { start: Date.now(), n: 0 };
const uris = new Map();   // id -> uri do vídeo no Google
const files = new Map();  // id -> Buffer (cache curto; o Safari exige Range para tocar vídeo)

async function g(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(60000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw fail(json?.error?.message || `Google respondeu ${res.status}`, res.status === 429 ? 429 : 502);
  return json;
}

export async function listModels() {
  if (!GEMINI_API_KEY) throw fail('GEMINI_API_KEY não configurada no servidor', 503);
  const names = []; let token = '';
  for (let i = 0; i < 5; i++) {
    const j = await g(`${BASE}/models?pageSize=200${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, { headers: headers() });
    for (const m of j.models || []) if (/veo|omni/i.test(m.name)) names.push(m.name.replace(/^models\//, ''));
    if (!j.nextPageToken) break;
    token = j.nextPageToken;
  }
  return { models: names };
}

// Só baixa imagens de domínios da Shopee (evita usar o servidor para acessar endereços internos)
const HOST_OK = /(^|\.)(shopee\.com(\.br)?|susercontent\.com)$/i;
async function fetchImage(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !HOST_OK.test(u.hostname)) return { note: 'Imagem ignorada: endereço não permitido.' };
    const res = await fetch(u, { signal: AbortSignal.timeout(20000) });
    const type = (res.headers.get('content-type') || '').split(';')[0];
    if (!res.ok || !/^image\/(jpeg|png)$/.test(type)) return { note: `Imagem do produto não usada (formato ${type || 'desconhecido'}); vídeo gerado só pelo texto.` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 7e6) return { note: 'Imagem do produto muito grande; vídeo gerado só pelo texto.' };
    return { image: { bytesBase64Encoded: buf.toString('base64'), mimeType: type } };
  } catch { return { note: 'Não foi possível baixar a imagem do produto; vídeo gerado só pelo texto.' }; }
}

export async function start({ prompt, imageUrl }) {
  if (!isConfigured()) throw fail('Configure GEMINI_API_KEY e GEMINI_VIDEO_MODEL no servidor', 503);
  if (typeof prompt !== 'string' || prompt.trim().length < 20) throw fail('Prompt vazio ou curto demais', 400);
  if (Date.now() - usage.start > 864e5) { usage.start = Date.now(); usage.n = 0; }
  if (usage.n >= DAILY_LIMIT) throw fail(`Limite de ${DAILY_LIMIT} vídeos por dia atingido`, 429);

  const text = prompt.trim().slice(0, 4000).replace(/10 segundos/g, `${DURATION} segundos`);
  const img = imageUrl ? await fetchImage(imageUrl) : {};
  const instance = { prompt: text };
  const parameters = { aspectRatio: '9:16', durationSeconds: DURATION, resolution: RESOLUTION };
  if (img.image) {
    if (MODE === 'reference') instance.referenceImages = [{ image: img.image, referenceType: 'asset' }];
    else instance.image = img.image;
    parameters.personGeneration = 'allow_adult';
  }
  const j = await g(`${BASE}/models/${GEMINI_VIDEO_MODEL}:predictLongRunning`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ instances: [instance], parameters }),
  });
  if (!j.name) throw fail('O Google não devolveu o código da operação');
  usage.n++;
  return { id: j.name, note: img.note || '' };
}

const OP = /^models\/[\w.\-]+\/operations\/[\w\-]+$/;
const findUri = (o) => {
  if (!o || typeof o !== 'object') return '';
  if (typeof o.uri === 'string' && o.uri) return o.uri;
  for (const v of Object.values(o)) { const r = findUri(v); if (r) return r; }
  return '';
};

export async function status(id) {
  if (!OP.test(id)) throw fail('Código de operação inválido', 400);
  const j = await g(`${BASE}/${id}`, { headers: headers() });
  if (!j.done) return { status: 'PROCESSING' };
  if (j.error) return { status: 'FAILED', error: j.error.message || 'A geração falhou' };
  const r = j.response?.generateVideoResponse;
  const uri = findUri(r?.generatedSamples ?? j.response);
  if (!uri) {
    const why = (r?.raiMediaFilteredReasons || []).join(' ');
    return { status: 'FAILED', error: why || 'O Google não gerou o vídeo (possível bloqueio de segurança; nesse caso não há cobrança).' };
  }
  uris.set(id, uri);
  return { status: 'COMPLETED' };
}

export async function file(id) {
  if (!OP.test(id)) throw fail('Código de operação inválido', 400);
  if (files.has(id)) return files.get(id);
  if (!uris.has(id)) await status(id);
  const uri = uris.get(id);
  if (!uri) throw fail('Vídeo ainda não está pronto', 404);
  const res = await fetch(uri, { headers: { 'x-goog-api-key': GEMINI_API_KEY }, redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw fail(`Falha ao baixar o vídeo (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 80e6) throw fail('Vídeo grande demais');
  files.set(id, buf);
  while (files.size > 5) files.delete(files.keys().next().value);
  return buf;
}

// Resposta com suporte a Range (necessário para tocar vídeo no Safari/iPad)
export function range(buf, header) {
  const base = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Disposition': 'inline; filename="video.mp4"', 'Cache-Control': 'private, max-age=3600' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m) return { status: 200, headers: { ...base, 'Content-Length': buf.length }, body: buf };
  let a = m[1] === '' ? buf.length - Number(m[2]) : Number(m[1]);
  let b = m[1] === '' || m[2] === '' ? buf.length - 1 : Number(m[2]);
  b = Math.min(b, buf.length - 1);
  if (!(a >= 0 && a <= b)) return { status: 416, headers: { ...base, 'Content-Range': `bytes */${buf.length}` }, body: Buffer.alloc(0) };
  return { status: 206, headers: { ...base, 'Content-Range': `bytes ${a}-${b}/${buf.length}`, 'Content-Length': b - a + 1 }, body: buf.subarray(a, b + 1) };
}
