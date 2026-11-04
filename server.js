'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let Pool = null;
try { Pool = require('pg').Pool; } catch (_) { /* pg missing: DB features disabled */ }

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');
const CLIENT_KEY = process.env.CLIENT_KEY || crypto.randomBytes(12).toString('hex');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const SOFIZ = process.env.SOFIZ_ACCOUNT_ID || '';

const pool = (process.env.DATABASE_URL && Pool)
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false } })
  : null;
async function q(sql, params) {
  if (!pool) { const e = new Error('DB_OFF'); e.code = 'DB_OFF'; throw e; }
  return pool.query(sql, params);
}

/* ---------- helpers ---------- */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jsonForScript = o => JSON.stringify(o).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '');
const TYPES = {
  card: { label: 'بطاقة', cls: 'type-badge-card' },
  account: { label: 'اشتراك', cls: 'type-badge-account' },
  id: { label: 'شحن بالايدي', cls: 'type-badge-id' },
  login: { label: 'شحن بالحساب', cls: 'type-badge-login' }
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8'
};
function baseHeaders(extra) {
  return Object.assign({
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  }, extra || {});
}
function sendJson(res, code, obj) {
  res.writeHead(code, baseHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }));
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/* ---------- database bootstrap ---------- */
async function initDb() {
  if (!pool) { console.warn('[db] DATABASE_URL not set: running in static-only mode'); return; }
  await q(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  const { rows } = await q('SELECT COUNT(*)::int AS n FROM categories');
  if (rows[0].n === 0) {
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-categories.json'), 'utf8'));
    for (const c of seed) await q('INSERT INTO categories (name,color,sort) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [c.name, c.color, c.sort]);
  }
  await q("INSERT INTO settings (key,value) VALUES ('promo_text',''),('flexy','on') ON CONFLICT DO NOTHING");
  console.log('[db] ready');
}

/* ---------- catalog (cached) ---------- */
let cache = null, cacheAt = 0;
const bust = () => { cache = null; };
async function getCatalog() {
  if (cache && Date.now() - cacheAt < 10000) return cache;
  const products = (await q(`SELECT p.*, COALESCE(c.n,0)::int AS codes_left FROM products p
    LEFT JOIN (SELECT product_id, COUNT(*) n FROM product_codes WHERE sold_at IS NULL GROUP BY product_id) c ON c.product_id = p.id
    WHERE p.active ORDER BY p.sort, p.id`)).rows;
  const banners = (await q('SELECT * FROM banners WHERE active ORDER BY sort, id')).rows;
  const settings = {};
  (await q('SELECT key,value FROM settings')).rows.forEach(r => { settings[r.key] = r.value; });
  products.forEach(p => { p.available = p.stock_mode === 'codes' ? p.codes_left > 0 : p.in_stock; });
  cache = { products, banners, settings }; cacheAt = Date.now();
  return cache;
}

/* ---------- HTML fragments (same markup as the original design) ---------- */
function cardInner(p, lang) {
  const t = TYPES[p.type] || TYPES.card;
  const name = p['name_' + lang] || p.name_ar;
  const img = p.image_url ? esc(p.image_url) : '/logo@480.png';
  const oos = !p.available;
  return `<div class="relative aspect-square overflow-hidden rounded-xl bg-black/5"><img alt="${esc(name)}" class="h-full w-full object-cover transition-transform duration-300 ${oos ? 'opacity-35 grayscale' : 'group-hover:scale-105'}" height="220" loading="lazy" src="${img}" width="220"/><div class="absolute inset-x-1.5 top-1.5 flex items-start justify-between gap-1"><span class="type-badge ${t.cls}">${t.label}</span></div>${oos ? '<div class="absolute inset-0 flex items-center justify-center"><span class="rounded-lg bg-black/70 px-2.5 py-1 text-[11px] font-black text-white backdrop-blur-sm">غير متوفر حالياً</span></div>' : ''}</div><div class="px-1 pt-2 pb-1"><h3 class="line-clamp-2 text-xs font-bold leading-snug">${esc(name)}</h3>${!oos && Number(p.price) > 0 ? `<p class="mt-0.5 text-xs font-black text-brand-500">${Number(p.price)} دج</p>` : ''}</div>`;
}
const hrefOf = (p, lang) => (lang === 'ar' ? '' : '/' + lang) + '/product/' + encodeURIComponent(p.slug) + '/';
const homeCard = (p, lang) => `<a class="glass-card reveal group flex flex-col overflow-hidden p-2 transition-transform hover:-translate-y-1 w-36 shrink-0 snap-start sm:w-44" href="${hrefOf(p, lang)}">${cardInner(p, lang)}</a>`;
const catCard = (p, lang) => `<div class="cat-product" data-fast="${p.fast ? 1 : 0}" data-type="${esc(p.type)}"><a class="glass-card reveal group flex flex-col overflow-hidden p-2 transition-transform hover:-translate-y-1" href="${hrefOf(p, lang)}">${cardInner(p, lang)}</a></div>`;

function render(html, lang, cat) {
  const site = SITE_URL || '';
  html = html.split('{{SITE_URL}}').join(site);
  if (!/<!--(CAT:|FEATURED|FLASH|SEARCH_INDEX|BANNERS|BANNER_DOTS|PROMO)/.test(html)) return html;
  const { products, banners, settings } = cat || { products: [], banners: [], settings: {} };
  html = html.replace(/<!--CAT:([^>]*?)-->/g, (_, name) => products.filter(p => p.category === name).map(p => catCard(p, lang)).join(''));
  html = html.replace('<!--FEATURED-->', products.filter(p => p.featured).map(p => homeCard(p, lang)).join(''));
  html = html.replace('<!--FLASH-->', '[]');
  html = html.replace('<!--SEARCH_INDEX-->', jsonForScript(products.map(p => {
    const t = TYPES[p.type] || TYPES.card;
    return { name: p['name_' + lang] || p.name_ar, image: p.image_url || '/logo@480.png', isFast: !!p.fast, typeLabel: t.label, typeClass: t.cls, outOfStock: !p.available, priceLabel: p.available && Number(p.price) > 0 ? Number(p.price) + ' دج' : '', href: hrefOf(p, lang) };
  })));
  html = html.replace('<!--BANNERS-->', banners.map(b => `<div class="aspect-video w-full shrink-0 snap-center overflow-hidden rounded-2xl"><img alt="" class="h-full w-full object-cover" loading="eager" src="${esc(b.image_url)}"/></div>`).join(''));
  html = html.replace('<!--BANNER_DOTS-->', banners.map((_, i) => `<span class="banner-dot h-1.5 w-1.5 rounded-full bg-current opacity-30" data-index="${i}"></span>`).join(''));
  if (!banners.length) html = html.replace('class="banner-slider relative', 'hidden class="banner-slider relative');
  const promo = (settings.promo_text || '').trim();
  html = html.replace('<!--PROMO-->', promo ? `<div class="bg-brand-500 px-4 py-2 text-center text-sm font-bold text-white" id="promo-banner"><div class="mx-auto max-w-6xl"><span>${esc(promo)}</span></div></div>` : '');
  return html;
}

/* ---------- static files ---------- */
const fileCache = new Map();
function readCached(file) {
  let v = fileCache.get(file);
  if (!v) { v = fs.readFileSync(file); fileCache.set(file, v); }
  return v;
}
function notFound(res, msg) {
  res.writeHead(404, baseHeaders({ 'Content-Type': 'text/html; charset=utf-8' }));
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>404</title><body dir="rtl" style="font-family:system-ui;text-align:center;padding:4rem"><h1>404</h1><p>${esc(msg || 'الصفحة غير موجودة')}</p><a href="/">الرئيسية</a>`);
}
async function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (_) { return notFound(res); }
  if (rel.includes('\0')) return notFound(res);
  const langM = rel.match(/^\/(en|fr)(\/|$)/);
  const lang = langM ? langM[1] : 'ar';
  if (/^\/(en\/|fr\/)?product\//.test(rel)) return notFound(res, 'صفحة المنتج قيد الإنشاء');
  let file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return notFound(res);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return notFound(res);
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  if (ext === '.html') {
    let cat = null;
    try { cat = await getCatalog(); } catch (e) { if (e.code !== 'DB_OFF') console.error(e.message); }
    const out = render(readCached(file).toString('utf8'), lang, cat);
    res.writeHead(200, baseHeaders({ 'Content-Type': type, 'Cache-Control': 'no-cache' }));
    return res.end(out);
  }
  if (ext === '.js') {
    const out = readCached(file).toString('utf8')
      .split('__CLIENT_KEY__').join(CLIENT_KEY).split('__SOFIZ_ACCOUNT_ID__').join(SOFIZ).split('__SITE_URL__').join(SITE_URL);
    res.writeHead(200, baseHeaders({ 'Content-Type': type, 'Cache-Control': 'no-cache' }));
    return res.end(out);
  }
  const immutable = /\/_astro\//.test(file) || /\/img\//.test(file);
  res.writeHead(200, baseHeaders({ 'Content-Type': type, 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600' }));
  res.end(readCached(file));
}

/* ---------- /api/gas : endpoint the original front-end talks to ---------- */
async function gas(req, res, url) {
  const params = Object.fromEntries(url.searchParams);
  if (req.method === 'POST') {
    const raw = await readBody(req);
    const ct = (req.headers['content-type'] || '').toLowerCase();
    if (ct.includes('application/x-www-form-urlencoded')) Object.assign(params, Object.fromEntries(new URLSearchParams(raw)));
    else { try { Object.assign(params, JSON.parse(raw)); } catch (_) { /* ignore */ } }
  }
  if (!safeEqual(params.api_key, CLIENT_KEY) && params.action) return sendJson(res, 403, { success: false, status: 'error', message: 'forbidden' });
  switch (params.action) {
    case 'getSettings': {
      let flexy = 'on';
      try { flexy = (await getCatalog()).settings.flexy || 'on'; } catch (_) { /* default */ }
      return sendJson(res, 200, { success: true, flexy });
    }
    case 'getCardStock': {
      const stock = {};
      try { (await getCatalog()).products.forEach(p => { stock[p.slug] = p.stock_mode === 'codes' ? p.codes_left : (p.in_stock ? 999 : 0); }); } catch (_) { /* empty */ }
      return sendJson(res, 200, { success: true, stock });
    }
    case 'getTopUpPlans': return sendJson(res, 200, { success: true, plans: [] });
    case 'getMenuOffers': return sendJson(res, 200, { success: true, offers: [], message: '' });
    case 'getRandomCoupon': return sendJson(res, 200, { success: false });
    case undefined: return sendJson(res, 200, {});
    default:
      // Accounts, wallet, OTP, orders, marketplace: stage 2. Fail closed.
      return sendJson(res, 200, { success: false, status: 'error', message: 'هذه الخدمة غير مفعلة بعد' });
  }
}

/* ---------- admin API ---------- */
const fails = new Map();
function adminAuth(req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const f = fails.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 600000) { f.n = 0; f.t = Date.now(); }
  if (f.n >= 10) return 'locked';
  if (ADMIN_KEY.length >= 16 && safeEqual(req.headers['x-admin-key'], ADMIN_KEY)) return 'ok';
  f.n++; fails.set(ip, f); return 'denied';
}
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const bool = v => v === true || v === 'true' || v === 1 || v === '1';
const IMG_RE = /^(https:\/\/|\/img\/)[^\s"'<>]+$/;
async function admin(req, res, url) {
  const auth = adminAuth(req);
  if (auth !== 'ok') return sendJson(res, auth === 'locked' ? 429 : 401, { error: auth === 'locked' ? 'محاولات كثيرة، حاول لاحقاً' : 'غير مصرح' });
  const p = url.pathname.replace('/api/admin', '');
  const body = (req.method === 'POST') ? JSON.parse((await readBody(req)) || '{}') : {};
  const id = Number((p.match(/\/(\d+)$/) || [])[1]);

  if (req.method === 'GET' && p === '/state') {
    const products = (await q(`SELECT p.*, COALESCE(c.n,0)::int AS codes_left FROM products p
      LEFT JOIN (SELECT product_id, COUNT(*) n FROM product_codes WHERE sold_at IS NULL GROUP BY product_id) c ON c.product_id=p.id ORDER BY p.sort, p.id`)).rows;
    const categories = (await q('SELECT * FROM categories ORDER BY sort, id')).rows;
    const banners = (await q('SELECT * FROM banners ORDER BY sort, id')).rows;
    const settings = {}; (await q('SELECT key,value FROM settings')).rows.forEach(r => { settings[r.key] = r.value; });
    return sendJson(res, 200, { products, categories, banners, settings, types: Object.keys(TYPES) });
  }
  if (req.method === 'POST' && p === '/product') {
    const v = {
      slug: str(body.slug, 60).toLowerCase(), category: str(body.category, 80), type: str(body.type, 10),
      name_ar: str(body.name_ar, 120), name_en: str(body.name_en, 120) || null, name_fr: str(body.name_fr, 120) || null,
      image_url: str(body.image_url, 400) || null, price: Number(body.price),
      stock_mode: body.stock_mode === 'manual' ? 'manual' : 'codes', in_stock: bool(body.in_stock),
      fast: bool(body.fast), featured: bool(body.featured), active: bool(body.active), sort: parseInt(body.sort, 10) || 0
    };
    if (!/^[a-z0-9_-]{2,60}$/.test(v.slug)) return sendJson(res, 400, { error: 'المعرّف (slug): حروف إنجليزية صغيرة وأرقام و _ - فقط' });
    if (!TYPES[v.type]) return sendJson(res, 400, { error: 'نوع غير صالح' });
    if (!v.name_ar) return sendJson(res, 400, { error: 'الاسم بالعربية مطلوب' });
    if (!(v.price >= 0 && v.price <= 10000000)) return sendJson(res, 400, { error: 'سعر غير صالح' });
    if (v.image_url && !IMG_RE.test(v.image_url)) return sendJson(res, 400, { error: 'الصورة: رابط https أو مسار /img/...' });
    if (!(await q('SELECT 1 FROM categories WHERE name=$1', [v.category])).rowCount) return sendJson(res, 400, { error: 'قسم غير موجود' });
    const cols = Object.keys(v), vals = Object.values(v);
    let r;
    if (Number(body.id) > 0) {
      r = await q(`UPDATE products SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(',')} WHERE id=$${cols.length + 1} RETURNING *`, [...vals, Number(body.id)]);
    } else {
      r = await q(`INSERT INTO products (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, vals);
    }
    bust(); return sendJson(res, 200, r.rows[0]);
  }
  if (req.method === 'DELETE' && /^\/product\/\d+$/.test(p)) { await q('DELETE FROM products WHERE id=$1', [id]); bust(); return sendJson(res, 200, { ok: true }); }
  if (req.method === 'POST' && p === '/codes') {
    const pid = Number(body.product_id);
    const codes = [...new Set(String(body.codes || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean))].slice(0, 5000);
    if (!(pid > 0) || !codes.length) return sendJson(res, 400, { error: 'اختر منتجاً وأدخل أكواداً' });
    if (codes.some(c => c.length > 500)) return sendJson(res, 400, { error: 'كود طويل جداً' });
    const r = await q('INSERT INTO product_codes (product_id, code) SELECT $1, UNNEST($2::text[]) ON CONFLICT DO NOTHING', [pid, codes]);
    bust(); return sendJson(res, 200, { added: r.rowCount });
  }
  if (req.method === 'POST' && p === '/category') {
    const name = str(body.name, 80), color = str(body.color, 7);
    if (!name || !/^#[0-9a-fA-F]{6}$/.test(color)) return sendJson(res, 400, { error: 'اسم/لون غير صالح' });
    const r = Number(body.id) > 0
      ? await q('UPDATE categories SET name=$1,color=$2,sort=$3 WHERE id=$4 RETURNING *', [name, color, parseInt(body.sort, 10) || 0, Number(body.id)])
      : await q('INSERT INTO categories (name,color,sort) VALUES ($1,$2,$3) RETURNING *', [name, color, parseInt(body.sort, 10) || 0]);
    bust(); return sendJson(res, 200, r.rows[0]);
  }
  if (req.method === 'DELETE' && /^\/category\/\d+$/.test(p)) {
    const used = await q('SELECT 1 FROM products p JOIN categories c ON c.name=p.category WHERE c.id=$1 LIMIT 1', [id]);
    if (used.rowCount) return sendJson(res, 409, { error: 'القسم يحتوي منتجات' });
    await q('DELETE FROM categories WHERE id=$1', [id]); bust(); return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/banner') {
    const img = str(body.image_url, 400);
    if (!IMG_RE.test(img)) return sendJson(res, 400, { error: 'رابط صورة غير صالح' });
    const r = await q('INSERT INTO banners (image_url, link, sort) VALUES ($1,$2,$3) RETURNING *', [img, str(body.link, 300) || null, parseInt(body.sort, 10) || 0]);
    bust(); return sendJson(res, 200, r.rows[0]);
  }
  if (req.method === 'DELETE' && /^\/banner\/\d+$/.test(p)) { await q('DELETE FROM banners WHERE id=$1', [id]); bust(); return sendJson(res, 200, { ok: true }); }
  if (req.method === 'POST' && p === '/settings') {
    for (const k of ['promo_text', 'flexy']) {
      if (body[k] === undefined) continue;
      const val = k === 'flexy' ? (body[k] === 'off' ? 'off' : 'on') : str(body[k], 200);
      await q('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, val]);
    }
    bust(); return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: 'not found' });
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local');
    if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, db: !!pool });
    if (url.pathname === '/api/gas') return await gas(req, res, url);
    if (url.pathname === '/api/catalog' && req.method === 'GET') {
      const c = await getCatalog();
      return sendJson(res, 200, { products: c.products.map(p => ({ slug: p.slug, category: p.category, type: p.type, name_ar: p.name_ar, name_en: p.name_en, name_fr: p.name_fr, image_url: p.image_url, price: Number(p.price), available: p.available })) });
    }
    if (url.pathname.startsWith('/api/admin/')) return await admin(req, res, url);
    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, baseHeaders()); return res.end(); }
    return await serveStatic(req, res, url.pathname);
  } catch (e) {
    if (e.code === 'DB_OFF') return sendJson(res, 503, { error: 'قاعدة البيانات غير متصلة' });
    console.error('[err]', e.message);
    if (!res.headersSent) sendJson(res, e.status || 500, { error: 'خطأ في السيرفر' });
  }
});
initDb().catch(e => console.error('[db] init failed:', e.message)).finally(() => {
  server.listen(PORT, () => console.log('MP Store DZ server on :' + PORT));
});
