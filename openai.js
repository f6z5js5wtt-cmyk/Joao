const { OPENAI_API_KEY, OPENAI_MODEL, OPENAI_BASE_URL } = process.env;
const BASE = OPENAI_BASE_URL || 'https://api.openai.com/v1';
const MODEL = OPENAI_MODEL || 'gpt-4o-mini';

export const isConfigured = () => Boolean(OPENAI_API_KEY);
export const modelName = () => MODEL;

const SYSTEM = `Você é um diretor de criação especialista em vídeos curtos de afiliados Shopee para TikTok, Reels e Shorts.
Escreva UM prompt profissional em português do Brasil para uma IA de geração de vídeo, a partir dos dados do produto e das configurações.
Regras: descreva cena a cena (abertura/gancho, demonstração, resultado, preço e chamada para ação), respeite formato, duração, estilo, voz, tom e legendas informados, inclua iluminação e movimento de câmera, e destaque preço promocional e desconto SOMENTE se existirem nos dados.
Não invente especificações, avaliações, estoque ou promessas que não estejam nos dados. Não use marcas registradas de terceiros. Responda apenas com o prompt, sem títulos nem comentários.`;

const clip = (v, n) => String(v ?? '').slice(0, n);

export async function generateVideoPrompt({ product = {}, settings = {} }) {
  if (!isConfigured()) {
    const e = new Error('OPENAI_API_KEY não configurada no servidor');
    e.status = 503;
    throw e;
  }
  const data = {
    produto: clip(product.name, 200),
    categoria: clip(product.category, 80),
    descricao: clip(product.description, 600),
    preco_original: product.old ?? null,
    preco_promocional: product.sale ?? null,
    desconto_percentual: product.old && product.sale && product.old > product.sale
      ? Math.round((1 - product.sale / product.old) * 100) : null,
    comissao_percentual: product.commission ?? null,
  };
  const cfg = Object.fromEntries(Object.entries(settings).slice(0, 10).map(([k, v]) => [clip(k, 20), clip(v, 40)]));

  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.8,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Dados do produto: ${JSON.stringify(data)}\nConfigurações do vídeo: ${JSON.stringify(cfg)}` },
      ],
    }),
    signal: AbortSignal.timeout(45000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(json?.error?.message || `OpenAI respondeu ${res.status}`);
    e.status = res.status === 401 ? 502 : res.status;
    if (res.status === 401) e.message = 'Chave da OpenAI inválida';
    throw e;
  }
  const text = json?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('A OpenAI não devolveu texto');
  return text;
}
