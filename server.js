import express from 'express';
import cors from 'cors';
import * as shopee from './shopee.js';

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN }));

app.get('/api/shopee/status', (_req, res) =>
  res.json({ configured: shopee.isConfigured(), appId: shopee.maskedAppId() }));

app.get('/api/products', async (req, res) => {
  try { res.json(await shopee.listProducts(req.query)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/shortlink', async (req, res) => {
  try { res.json({ shortLink: await shopee.shortLink(req.body.url, req.body.subIds) }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.use(express.static(new URL('./public',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')));
app.listen(process.env.PORT || 3001, () => console.log('API on :' + (process.env.PORT || 3001)));
