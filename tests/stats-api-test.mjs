// Run: node tests/stats-api-test.mjs   (uses an in-memory fake Redis, touches nothing live)
import http from 'node:http';
const db = new Map(); // key -> {type, v}
function exec(cmd) {
  const [c, ...a] = cmd; const name = String(c).toLowerCase();
  const get = (k, t, init) => { if (!db.has(k)) db.set(k, { v: init }); return db.get(k); };
  if (name === 'incr') { const o = get(a[0], 0, 0); o.v++; return o.v; }
  if (name === 'expire') return 1;
  if (name === 'pfadd') { const o = get(a[0], 0, new Set()); o.v.add(a[1]); return 1; }
  if (name === 'pfcount') { const u = new Set(); for (const k of a) if (db.has(k)) db.get(k).v.forEach(x => u.add(x)); return u.size; }
  if (name === 'hincrby') { const o = get(a[0], 0, {}); o.v[a[1]] = (o.v[a[1]] || 0) + Number(a[2]); return o.v[a[1]]; }
  if (name === 'hgetall') { const o = db.get(a[0]); if (!o) return []; return Object.entries(o.v).flat().map(String); }
  throw new Error('unsupported ' + name);
}
const enc = x => Array.isArray(x) ? x.map(enc) : (typeof x === 'string' ? Buffer.from(x).toString('base64') : x);
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    const body = JSON.parse(b);
    const e = req.headers['upstash-encoding'] === 'base64' ? enc : (x => x);
    const out = req.url.includes('pipeline') ? body.map(c => ({ result: e(exec(c)) })) : { result: e(exec(body)) };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(out));
  });
});
await new Promise(r => srv.listen(0, r));
process.env.KV_REST_API_URL = 'http://127.0.0.1:' + srv.address().port;
process.env.KV_REST_API_TOKEN = 'x';
process.env.ADMIN_TOKEN = 'secret123';
process.env.STATS_PASSWORD = 'pw456';
const { default: handler } = await import(new URL('../api/stats.js', import.meta.url).href);
function call(method, { body, headers = {}, query = {} } = {}) {
  return new Promise(resolve => {
    const res = { code: 200, h: {}, setHeader(k, v) { this.h[k] = v; }, status(c) { this.code = c; return this; }, end() { resolve({ code: this.code }); }, json(j) { resolve({ code: this.code, json: j }); } };
    handler({ method, body, headers: { 'x-forwarded-for': '1.2.3.4', ...headers }, query }, res);
  });
}
const ev = (t, k) => ({ t, k });
console.log('track1', (await call('POST', { body: JSON.stringify({ v: 'visitor-aaaa1111', p: 'web', nu: 1, e: [ev('session', 'google.com'), ev('menu', '🍽️ Restaurants'), ev('ask'), ev('out', 'expedia.com')] }) })).code);
console.log('track2', (await call('POST', { body: { v: 'visitor-bbbb2222', p: 'app', nu: 0, e: [ev('session', 'app'), ev('menu', '🍽️ Restaurants'), ev('menu', '❄️ Snow tracker'), ev('other')] } })).code);
console.log('track3', (await call('POST', { body: { v: 'visitor-dddd4444', p: 'web', nu: 0, e: [ev('book', 'Sapphire Room'), ev('call', 'Sapphire Room'), ev('ride', 'uber'), ev('item', 'viator.com > Ghost tour'), ev('item', ''), ev('bogus', 'x')] } })).code);
console.log('bad id', (await call('POST', { body: { v: 'x', e: [ev('session')] } })).code);
console.log('no auth', (await call('GET', { query: { days: '7' } })).code);
console.log('bad auth', (await call('GET', { headers: { authorization: 'Bearer nope' } })).code);
const r = await call('GET', { headers: { authorization: 'Bearer secret123' }, query: { days: '7' } });
console.log('report', r.code, JSON.stringify(r.json.totals), JSON.stringify(r.json.top), r.json.series.length);
const t = r.json.totals, tp = r.json.top;
console.log('new totals ok:', t.book === 1 && t.call === 1 && t.ride === 1 && t.item === 1);
console.log('new top ok:', JSON.stringify(tp.book) === '[["Sapphire Room",1]]' && JSON.stringify(tp.ride) === '[["uber",1]]' && JSON.stringify(tp.item) === '[["viator.com > Ghost tour",1]]' && JSON.stringify(tp.call) === '[["Sapphire Room",1]]');
console.log('stats password ok:', (await call('GET', { headers: { authorization: 'Bearer pw456' }, query: { days: '7' } })).code === 200);
console.log('wrong password rejected:', (await call('GET', { headers: { authorization: 'Bearer pw457' } })).code === 401);
let limited = 0; for (let i = 0; i < 65; i++) { if ((await call('POST', { body: { v: 'visitor-cccc3333', e: [ev('menu', 'x')] } })).code === 429) limited++; }
console.log('rate limited after cap:', limited > 0);
srv.close();
