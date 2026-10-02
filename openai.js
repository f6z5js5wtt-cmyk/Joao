const { OPENAI_API_KEY, OPENAI_MODEL, OPENAI_BASE_URL } = process.env;
const BASE = OPENAI_BASE_URL || 'https://api.openai.com/v1';
const MODEL = OPENAI_MODEL || 'gpt-4o-mini';

export const isConfigured = () => Boolean(OPENAI_API_KEY);
export const modelName = () => MODEL;

const MAX = 900; // limite de caracteres aceito pelo YouTube Create
const SYSTEM = 'Você é um redator de prompts para o YouTube Create. Responda somente com o prompt final, em português do Brasil, sem títulos, aspas ou comentários.';
const clip = (v, n) => String(v ?? '').slice(0, n);

async function chat(messages) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: MODEL, temperature: 0.8, max_tokens: 700, messages }),
    signal: AbortSignal.timeout(45000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(res.status === 401 ? 'Chave da OpenAI inválida' : json?.error?.message || `OpenAI respondeu ${res.status}`);
    e.status = res.status === 401 ? 502 : res.status;
    throw e;
  }
  const text = json?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('A OpenAI não devolveu texto');
  return text;
}

// Corta no fim da última frase que cabe no limite
function fit(text) {
  if (text.length <= MAX) return text;
  const cut = text.slice(0, MAX);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('.'));
  return (end > MAX * 0.6 ? cut.slice(0, end + 1) : cut).trim();
}

export async function generateVideoPrompt({ product = {} }) {
  if (!isConfigured()) {
    const e = new Error('OPENAI_API_KEY não configurada no servidor');
    e.status = 503;
    throw e;
  }
  const generic = /^Produto (popular|importado)/i;
  const desc = [clip(product.name, 200), product.description && !generic.test(product.description) ? clip(product.description, 400) : '']
    .filter(Boolean).join(' - ');

  const ask = `Crie um prompt para o YouTube Create para um vídeo de 10 segundos. O prompt precisa ter no máximo ${MAX} caracteres, que é o que a ferramenta aceita (use entre 800 e ${MAX}). ` +
    `O vídeo é UGC: um influenciador falando sobre a qualidade e o funcionamento deste produto: ${desc}. ` +
    `Use seus conhecimentos de marketing para que quem assistir sinta uma imensa vontade de comprar e perceba a necessidade urgente do produto. ` +
    `No final, o influenciador faz a chamada para ação: "acesse o link abaixo e garanta o seu". ` +
    `Sem legendas no vídeo. Mostre também a variedade do produto, se for necessário.`;

  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: ask }];
  let text = await chat(messages);
  if (text.length > MAX) {
    text = await chat([...messages, { role: 'assistant', content: text },
      { role: 'user', content: `O texto tem ${text.length} caracteres. Reescreva com no máximo ${MAX} caracteres, mantendo todas as instruções. Responda só com o prompt.` }]);
  }
  return fit(text);
}
