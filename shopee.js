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

// Campos conforme a documentação (não oficial) e SDKs públicos; confirme em affiliate.shopee.com.br/open_api
export async function listProducts({ keyword = '', page = 1, limit = 20 } = {}) {
  const kw = keyword ? `keyword: ${JSON.stringify(String(keyword))},` : '';
  const lim = Math.min(50, Math.max(1, Number(limit) || 20)); // a Shopee rejeita limit > 50
  const data = await gql(`{ productOfferV2(${kw} sortType: 5, page: ${Number(page) || 1}, limit: ${lim}) {
    nodes { itemId productName imageUrl priceMin priceMax priceDiscountRate commissionRate commission sales ratingStar productLink offerLink }
    pageInfo { page limit hasNextPage } } }`);
  const { nodes, pageInfo } = data.productOfferV2;
  return {
    pageInfo,
    items: nodes.map((n) => {
      const sale = Number(n.priceMin) || 0;
      const rate = Number(n.priceDiscountRate) || 0; // % (ex.: 43 = 43%)
      const original = rate > 0 && rate < 100 ? Math.round((sale / (1 - rate / 100)) * 100) / 100 : sale;
      return {
        id: String(n.itemId),
        name: n.productName,
        image: n.imageUrl,
        salePrice: sale,
        originalPrice: original,
        commission: Math.round(Number(n.commissionRate) * 1000) / 10,
        commissionValue: Number(n.commission) || 0,
        sales: Number(n.sales) || 0,
        rating: Number(n.ratingStar) || 0,
        affiliateUrl: n.offerLink || n.productLink,
      };
    }),
  };
}

// A Shopee não informa quantos afiliados divulgam um produto. Aproximação: vendas baixas/médias + boa nota + boa comissão.
export async function findOpportunities({ keyword = '', minSales = 20, maxSales = 1000, minRating = 4.5, minCommission = 10, pages = 4 } = {}) {
  const n = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
  const [lo, hi, rt, cm] = [n(minSales, 20), n(maxSales, 1000), n(minRating, 4.5), n(minCommission, 10)];
  const out = []; let scanned = 0;
  for (let page = 1; page <= Math.min(8, n(pages, 4)); page++) {
    const r = await listProducts({ keyword, page, limit: 50 });
    scanned += r.items.length;
    for (const i of r.items) if (i.sales >= lo && i.sales <= hi && i.rating >= rt && i.commission >= cm) out.push(i);
    if (!r.pageInfo?.hasNextPage) break;
  }
  out.sort((a, b) => b.commissionValue - a.commissionValue);
  return { scanned, items: out };
}

export async function shortLink(originUrl, subIds = []) {
  const ids = subIds.map((s) => JSON.stringify(String(s))).join(',');
  const data = await gql(`mutation { generateShortLink(input: { originUrl: ${JSON.stringify(originUrl)}, subIds: [${ids}] }) { shortLink } }`);
  return data.generateShortLink.shortLink;
}

// Relatório de conversões (vendas/comissões). A API NÃO fornece contagem de cliques: só clickTime de cada conversão.
export function summarize(nodes, days) {
  const num = (v) => Number(v) || 0;
  const day = (t) => new Date((Number(t) - 3 * 3600) * 1000).toISOString().slice(0, 10); // dia em GMT-3
  const byStatus = {}, byDay = {}, prod = {};
  let orders = 0, items = 0, sales = 0, commission = 0;
  for (const c of nodes) {
    const d = day(c.purchaseTime);
    byDay[d] ??= { date: d, orders: 0, commission: 0 };
    byDay[d].commission += num(c.totalCommission);
    commission += num(c.totalCommission);
    for (const o of c.orders || []) {
      orders++; byDay[d].orders++;
      byStatus[o.orderStatus] = (byStatus[o.orderStatus] || 0) + 1;
      for (const it of o.items || []) {
        const q = num(it.qty) || 1;
        items += q; sales += num(it.itemPrice) * q;
        const p = (prod[it.itemId] ??= { name: it.itemName, qty: 0, commission: 0 });
        p.qty += q; p.commission += num(it.itemTotalCommission);
      }
    }
  }
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - 3 * 3600e3 - i * 864e5).toISOString().slice(0, 10);
    const r = byDay[d] || { date: d, orders: 0, commission: 0 };
    out.push({ date: d, orders: r.orders, commission: Math.round(r.commission * 100) / 100 });
  }
  return {
    days, conversions: nodes.length, orders, items,
    sales: Math.round(sales * 100) / 100, commission: Math.round(commission * 100) / 100,
    byStatus, byDay: out,
    topProducts: Object.values(prod).sort((a, b) => b.qty - a.qty).slice(0, 5),
  };
}

export async function conversionReport(days = 7) {
  days = Math.min(90, Math.max(1, Number(days) || 7));
  const end = Math.floor(Date.now() / 1000), start = end - days * 86400;
  const nodes = []; let scroll = '';
  for (let page = 0; page < 10; page++) {
    const sc = scroll ? `, scrollId: ${JSON.stringify(scroll)}` : '';
    const data = await gql(`{ conversionReport(purchaseTimeStart: ${start}, purchaseTimeEnd: ${end}, limit: 500${sc}) {
      nodes { purchaseTime clickTime conversionId totalCommission utmContent
        orders { orderId orderStatus items { itemId itemName itemPrice qty itemTotalCommission } } }
      pageInfo { hasNextPage scrollId } } }`);
    const r = data.conversionReport;
    nodes.push(...(r.nodes || []));
    if (!r.pageInfo?.hasNextPage || !r.pageInfo?.scrollId) break;
    scroll = r.pageInfo.scrollId;
  }
  return summarize(nodes, days);
}
