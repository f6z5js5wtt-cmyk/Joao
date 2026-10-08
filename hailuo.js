// Geração de vídeo pela API oficial da MiniMax (Hailuo). A chave fica só no servidor.
import { range, fetchImage } from './video.js';
export { range };

const { MINIMAX_API_KEY, MINIMAX_VIDEO_MODEL, MINIMAX_BASE_URL } = process.env;
const BASE = MINIMAX_BASE_URL || 'https://api.minimax.io';
const MODEL = MINIMAX_VIDEO_MODEL || 'MiniMax-Hailuo-2.3';
const DURATION = Number(process.env.VIDEO_DURATION) === 10 ? 10 : 6; // a MiniMax aceita 6 ou 10 s
const RESOLUTION = process.env.MINIMAX_RESOLUTION || '768P';          // 10 s só em 768P
const DAILY_LIMIT = Number(process.env.VIDEO_LIMIT_PER_DAY) || 10;

const fail = (message, status = 502) => Object.assign(new Error(message), { status });
export const isConfigured = () => Boolean(MINIMAX_API_KEY);
export const modelName = () => MODEL;
export async function listModels() {
  return { models: [...new Set([MODEL, 'MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-02'])], note: 'Lista fixa da documentação; defina MINIMAX_VIDEO_MODEL para trocar.' };
}

const usage = { start: Date.now(), n: 0 };
const fileIds = new Map(); // id da tarefa -> file_id
const files = new Map();   // id da tarefa -> Buffer (cache curto; o Safari exige Range para tocar vídeo)

async function mm(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${MINIMAX_API_KEY}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60000),
  });
  const j = await res.json().catch(() => ({}));
  const code = j?.base_resp?.status_code;
  if (!res.ok || (code !== undefined && code !== 0)) {
    const msg = j?.base_resp?.status_msg || `MiniMax respondeu ${res.status}`;
    throw fail(code === 1008 ? 'Saldo insuficiente na MiniMax' : `MiniMax: ${msg}`, res.status === 429 ? 429 : 502);
  }
  return j;
}

export async function start({ prompt, imageUrl }) {
  if (!isConfigured()) throw fail('Configure MINIMAX_API_KEY no servidor', 503);
  if (typeof prompt !== 'string' || prompt.trim().length < 20) throw fail('Prompt vazio ou curto demais', 400);
  if (Date.now() - usage.start > 864e5) { usage.start = Date.now(); usage.n = 0; }
  if (usage.n >= DAILY_LIMIT) throw fail(`Limite de ${DAILY_LIMIT} vídeos por dia atingido`, 429);

  const body = {
    model: MODEL,
    prompt: prompt.trim().slice(0, 2000).replace(/10 segundos/g, `${DURATION} segundos`),
    duration: DURATION,
    resolution: DURATION === 10 ? '768P' : RESOLUTION,
  };
  const img = imageUrl ? await fetchImage(imageUrl) : {};
  if (img.image) body.first_frame_image = `data:${img.image.mimeType};base64,${img.image.bytesBase64Encoded}`;

  const j = await mm('/v1/video_generation', { method: 'POST', body: JSON.stringify(body) });
  if (!j.task_id) throw fail('A MiniMax não devolveu o código da tarefa');
  usage.n++;
  return { id: String(j.task_id), note: img.note || '', info: { duration: DURATION, aspect: img.image ? 'igual à foto do produto' : 'padrão do modelo' } };
}

const ID = /^[\w\-]{3,80}$/;
export async function status(id) {
  if (!ID.test(id)) throw fail('Código de tarefa inválido', 400);
  const j = await mm(`/v1/query/video_generation?task_id=${encodeURIComponent(id)}`);
  if (j.status === 'Fail') return { status: 'FAILED', error: j?.base_resp?.status_msg && j.base_resp.status_msg !== 'success' ? j.base_resp.status_msg : 'A MiniMax não conseguiu gerar o vídeo' };
  if (j.status === 'Success' && j.file_id) { fileIds.set(id, String(j.file_id)); return { status: 'COMPLETED' }; }
  return { status: 'PROCESSING' };
}

export async function file(id) {
  if (!ID.test(id)) throw fail('Código de tarefa inválido', 400);
  if (files.has(id)) return files.get(id);
  if (!fileIds.has(id)) await status(id);
  const fid = fileIds.get(id);
  if (!fid) throw fail('Vídeo ainda não está pronto', 404);
  const j = await mm(`/v1/files/retrieve?file_id=${encodeURIComponent(fid)}`);
  const url = j?.file?.download_url;
  if (!url) throw fail('A MiniMax não devolveu o endereço do vídeo');
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw fail(`Falha ao baixar o vídeo (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 80e6) throw fail('Vídeo grande demais');
  files.set(id, buf);
  while (files.size > 5) files.delete(files.keys().next().value);
  return buf;
}
