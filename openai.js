const { OPENAI_API_KEY, OPENAI_MODEL, OPENAI_BASE_URL } = process.env;
const BASE = OPENAI_BASE_URL || 'https://api.openai.com/v1';
const MODEL = OPENAI_MODEL || 'gpt-4o-mini';

export const isConfigured = () => Boolean(OPENAI_API_KEY);
export const modelName = () => MODEL;

const MAX = 900; // limite de caracteres aceito pelo YouTube Create
const SYSTEM = 'Você escreve prompts para ferramentas de geração de vídeo (YouTube Create). O prompt DESCREVE O VÍDEO a ser gerado (cenas, ações da pessoa e uma fala curta entre aspas). Não é texto de propaganda nem roteiro de locução. Responda somente com o prompt final, em português do Brasil, sem títulos, listas, aspas externas ou comentários.';

// Exemplo aprovado pelo usuário: serve de modelo de estrutura e estilo
const EXEMPLO = 'Crie um vídeo UGC vertical realista de 10 segundos mostrando exatamente a pasta clareadora da imagem de referência. Uma influenciadora apresenta a embalagem em close, abre a pasta e coloca uma pequena quantidade na escova de dentes. Em seguida, mostra a aplicação de forma natural, destacando a textura e a rotina de higiene bucal. Ela fala: “Olha essa pasta! Além de cuidar da higiene dos dentes, ela foi feita para ajudar no cuidado com a aparência do sorriso. É superprática para incluir na rotina do dia a dia!” Mostrar o produto e a embalagem em detalhes, sem alterar rótulo, cor ou formato. Não prometer dentes perfeitamente brancos nem resultados instantâneos. Visual UGC natural, sem bugs, sem legendas e sem textos na tela. Finalizar: “Acesse o link abaixo e garanta a sua!”';
const clip = (v, n) => String(v ?? '').slice(0, n);

async function chat(messages) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: MODEL, temperature: 0.6, max_tokens: 700, messages }),
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

  const ask = `Crie um prompt para o YouTube Create (gerador de vídeo) para um vídeo UGC de 10 segundos em que um(a) influenciador(a) fala sobre a qualidade e o funcionamento deste produto: ${desc}.

O prompt deve DESCREVER O VÍDEO, com a mesma estrutura e estilo do exemplo abaixo. Não escreva um texto de propaganda nem um roteiro de locução. Regras:
1. Começar com: "Crie um vídeo UGC vertical realista de 10 segundos mostrando exatamente [o produto] da imagem de referência."
2. Descrever em 2 ou 3 ações o que a pessoa faz com o produto (mostrar a embalagem em close, usar, demonstrar o funcionamento).
3. Incluir uma fala curta do influenciador entre aspas, no formato Ela fala: “...”, com no máximo 25 palavras. Use seus conhecimentos de marketing para destacar a qualidade e o funcionamento e despertar desejo e urgência de compra.
4. Incluir: Mostrar o produto e a embalagem em detalhes, sem alterar rótulo, cor ou formato.
5. Incluir uma frase "Não prometer ..." adaptada ao produto (sem resultados milagrosos, instantâneos ou médicos, e sem inventar funções que o nome do produto não indica).
6. Incluir: Visual UGC natural, sem bugs, sem legendas e sem textos na tela.
7. Se fizer sentido para o produto, mostrar também a variedade (modelos, cores ou tamanhos).
8. Terminar com: Finalizar: “Acesse o link abaixo e garanta o seu!” (use "a sua" se o produto for feminino).
Tamanho: no máximo ${MAX} caracteres (use entre 750 e ${MAX}).

Exemplo, só como modelo de estrutura e estilo (não copie o conteúdo dele):
${EXEMPLO}`;

  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: ask }];
  let text = await chat(messages);
  if (text.length > MAX) {
    text = await chat([...messages, { role: 'assistant', content: text },
      { role: 'user', content: `O texto tem ${text.length} caracteres. Reescreva com no máximo ${MAX} caracteres, mantendo todas as instruções. Responda só com o prompt.` }]);
  }
  return fit(text);
}

export async function generateCaption({ product = {} }) {
  if (!isConfigured()) {
    const e = new Error('OPENAI_API_KEY não configurada no servidor');
    e.status = 503;
    throw e;
  }
  const info = { produto: clip(product.name, 200), categoria: product.category && product.category !== 'Shopee' ? clip(product.category, 80) : '' };
  const ask = `Escreva a legenda de um vídeo curto de afiliado na Shopee Vídeo sobre este produto: ${JSON.stringify(info)}.
Regras: português do Brasil; no máximo 300 caracteres no total, contando as hashtags; comece com uma frase de gancho curta; cite no máximo 2 benefícios que decorram do nome do produto, sem inventar especificações, resultados, preços ou promessas; termine com uma chamada para ação como "Link do produto abaixo"; inclua de 5 a 7 hashtags relevantes (por exemplo #shopee #achadinhos). Responda só com a legenda.`;
  const text = await chat([
    { role: 'system', content: 'Você escreve legendas curtas de redes sociais em português do Brasil. Responda somente com o texto final.' },
    { role: 'user', content: ask },
  ]);
  return text.slice(0, 600);
}
