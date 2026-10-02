import { createHash } from 'node:crypto';

const { SHOPEE_APP_ID, SHOPEE_SECRET, SHOPEE_ENDPOINT } = process.env;

export const isConfigured = () => Boolean(SHOPEE_APP_ID && SHOPEE_SECRET);
export const maskedAppId = () => '••••••••••••' + (SHOPEE_APP_ID || '').slice(-4);

// Assinatura: SHA256(appId + timestamp + payload + secret)
async function gql(query) {
  if (!isConfigured()) throw new Error('Credenciais da Shopee ausentes no .env');
  const payload = JSON.stringify({ query });
  const ts = Math.floor(Date.now() / 1000);
  const signature = createHash('sha256')
    .update(SHOPEE_APP_ID + ts + payload + SHOPEE_SECRET)
    .digest('hex');
  const res = await fetch(SHOPEE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `SHA256 Credential=${SHOPEE_APP_ID}, Timestamp=${ts}, Signature=${signature}`,
    },
    body: payload,
  });
  const json = await res.json();
  if (json.errors?.length) {
    const e = json.errors[0];
    throw new Error(`Shopee: ${e.message} (código ${e.extensions?.code ?? '?'})`);
  }
  return json.data;
}

// ATENÇÃO: confirme nomes de campos na documentação oficial (affiliate.shopee.com.br/open_api).
export async function listProducts({ keyword = '', page = 1, limit = 20 } = {}) {
  const kw = keyword ? `keyword: ${JSON.stringify(String(keyword))},` : '';
  const data = await gql(`{ productOfferV2(${kw} page: ${Number(page)}, limit: ${Number(limit)}) {
    nodes { itemId productName imageUrl price priceMin priceMax commissionRate productLink offerLink }
    pageInfo { page limit hasNextPage } } }`);
  const { nodes, pageInfo } = data.productOfferV2;
  return {
    pageInfo,
    items: nodes.map((n) => ({
      id: String(n.itemId),
      name: n.productName,
      image: n.imageUrl,
      salePrice: Number(n.priceMin || n.price),
      originalPrice: Number(n.priceMax || n.price),
      commission: Number(n.commissionRate) * 100,
      affiliateUrl: n.offerLink || n.productLink,
    })),
  };
}

export async function shortLink(originUrl, subIds = []) {
  const ids = subIds.map((s) => JSON.stringify(String(s))).join(',');
  const data = await gql(`mutation { generateShortLink(input: { originUrl: ${JSON.stringify(originUrl)}, subIds: [${ids}] }) { shortLink } }`);
  return data.generateShortLink.shortLink;
}
