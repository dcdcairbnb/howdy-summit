// Howdy Summit usage tracking and statistics.
//
//   POST /api/stats            Public. The app sends anonymous event batches here.
//                              No IP address, no names, no typed text is stored.
//   GET  /api/stats?days=30    Needs "Authorization: Bearer <STATS_PASSWORD or ADMIN_TOKEN>".
//                              Returns the totals the /stats page draws.
//
// Storage: Upstash Redis (KV_REST_API_URL, KV_REST_API_TOKEN), the same store
// chat.js and group.js already use. Day keys use Mountain time.
//
// Keys (all expire after 400 days):
//   hs:d:<day>          hash   session, menu, ask, other, out, newsess, sess_app, sess_web
//   hs:uv:<day>         hyperloglog of anonymous visitor ids
//   hs:uv:<day>:<plat>  same, split by app or web
//   hs:src:<day>        hash   traffic source -> sessions
//   hs:menu:<day>       hash   menu button label -> taps
//   hs:out:<day>        hash   outbound destination -> clicks
//   hs:book:<day>       hash   restaurant booking page opened -> taps
//   hs:call:<day>       hash   tap-to-call button -> taps
//   hs:ride:<day>       hash   ride service -> taps
//   hs:item:<day>       hash   place card link -> taps (site > place name)

import { Redis } from '@upstash/redis';
import crypto from 'node:crypto';

const TZ = 'America/Denver';
const KEEP_SECONDS = 400 * 86400;
const MAX_EVENTS = 20;
const RATE_LIMIT_PER_MIN = 60;
const TYPES = new Set(['session', 'menu', 'ask', 'other', 'out', 'book', 'call', 'ride', 'item']);
const LABELED = ['out', 'book', 'call', 'ride', 'item'];

let redis = null;
function getRedis() {
  if (redis !== null) return redis;
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  } else {
    redis = false; // sentinel: tried, not configured
  }
  return redis;
}

function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}

// Newest first. Built from the calendar date so a daylight saving change
// never skips or repeats a day.
function lastDays(n) {
  const [y, m, d] = today().split('-').map(Number);
  const out = [];
  for (let i = 0; i < n; i++) out.push(new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10));
  return out;
}

function clean(s, max) {
  return String(s == null ? '' : s)
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

async function handleTrack(req, res, r) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).end(); }
  }
  if (!body || typeof body !== 'object') return res.status(400).end();

  const v = String(body.v || '');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(v)) return res.status(400).end();
  const plat = body.p === 'app' ? 'app' : 'web';
  const isNew = body.nu ? 1 : 0;
  const events = Array.isArray(body.e) ? body.e.slice(0, MAX_EVENTS) : [];
  if (!events.length) return res.status(204).end();

  // Per-minute cap per sender. The sender is a salted hash that changes daily
  // and is never stored beyond the 2 minute counter.
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const salt = process.env.ADMIN_TOKEN || 'hs';
  const who = crypto.createHash('sha256').update(ip + salt + today()).digest('hex').slice(0, 16);
  const rlKey = `hs:rl:${who}:${Math.floor(Date.now() / 60000)}`;
  const n = await r.incr(rlKey);
  if (n === 1) await r.expire(rlKey, 120);
  if (n > RATE_LIMIT_PER_MIN) return res.status(429).end();

  const day = today();
  const kDay = `hs:d:${day}`;
  const kSrc = `hs:src:${day}`;
  const kMenu = `hs:menu:${day}`;
  const kOut = `hs:out:${day}`;
  const kType = { out: kOut, book: `hs:book:${day}`, call: `hs:call:${day}`, ride: `hs:ride:${day}`, item: `hs:item:${day}` };
  const kUv = `hs:uv:${day}`;
  const kUvPlat = `hs:uv:${day}:${plat}`;

  const p = r.pipeline();
  const touched = new Set([kUv, kUvPlat]);
  p.pfadd(kUv, v);
  p.pfadd(kUvPlat, v);

  for (const ev of events) {
    const t = ev && ev.t;
    if (!TYPES.has(t)) continue;
    const k = clean(ev.k, 80);
    if (LABELED.includes(t) && !k) continue; // a click with no label is not counted
    p.hincrby(kDay, t, 1);
    touched.add(kDay);
    if (t === 'session') {
      p.hincrby(kDay, plat === 'app' ? 'sess_app' : 'sess_web', 1);
      if (isNew) p.hincrby(kDay, 'newsess', 1);
      p.hincrby(kSrc, k || 'direct', 1);
      touched.add(kSrc);
    } else if (t === 'menu' && k) {
      p.hincrby(kMenu, k, 1);
      touched.add(kMenu);
    } else if (LABELED.includes(t) && k) {
      p.hincrby(kType[t], k, 1);
      touched.add(kType[t]);
    }
  }
  for (const key of touched) p.expire(key, KEEP_SECONDS);

  await p.exec();
  return res.status(204).end();
}

function addInto(target, obj) {
  if (!obj) return;
  for (const [k, val] of Object.entries(obj)) target[k] = (target[k] || 0) + Number(val || 0);
}

function top(obj, limit) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

async function handleReport(req, res, r) {
  // The report opens with STATS_PASSWORD (its own password) or ADMIN_TOKEN.
  const allowed = [process.env.STATS_PASSWORD, process.env.ADMIN_TOKEN].map(v => String(v || '').trim()).filter(Boolean);
  if (!allowed.length) return res.status(503).json({ error: 'STATS_PASSWORD is not set on the server' });
  const auth = String(req.headers.authorization || '');
  const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!given || !allowed.some(a => safeEqual(given, a))) return res.status(401).json({ error: 'wrong password' });

  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
  const list = lastDays(days); // newest first

  const p = r.pipeline();
  for (const d of list) {
    p.hgetall(`hs:d:${d}`);
    p.pfcount(`hs:uv:${d}`);
    p.hgetall(`hs:src:${d}`);
    p.hgetall(`hs:menu:${d}`);
    p.hgetall(`hs:out:${d}`);
    p.hgetall(`hs:book:${d}`);
    p.hgetall(`hs:call:${d}`);
    p.hgetall(`hs:ride:${d}`);
    p.hgetall(`hs:item:${d}`);
  }
  p.pfcount(...list.map(d => `hs:uv:${d}`));
  p.pfcount(...list.map(d => `hs:uv:${d}:app`));
  p.pfcount(...list.map(d => `hs:uv:${d}:web`));
  const out = await p.exec();

  const series = [];
  const totals = { session: 0, menu: 0, ask: 0, other: 0, out: 0, book: 0, call: 0, ride: 0, item: 0, newsess: 0, sess_app: 0, sess_web: 0 };
  const src = {}, menu = {}, outbound = {}, book = {}, calls = {}, rides = {}, items = {};
  let i = 0;
  for (const d of list) {
    const day = out[i++] || {};
    const visitors = Number(out[i++] || 0);
    addInto(src, out[i++]);
    addInto(menu, out[i++]);
    addInto(outbound, out[i++]);
    addInto(book, out[i++]);
    addInto(calls, out[i++]);
    addInto(rides, out[i++]);
    addInto(items, out[i++]);
    const row = { date: d, visitors };
    for (const key of Object.keys(totals)) {
      const val = Number(day[key] || 0);
      row[key] = val;
      totals[key] += val;
    }
    series.push(row);
  }
  series.reverse(); // oldest first for charts

  const uniqueVisitors = Number(out[i++] || 0);
  const uniqueApp = Number(out[i++] || 0);
  const uniqueWeb = Number(out[i++] || 0);

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    generatedAt: new Date().toISOString(),
    days,
    totals: { ...totals, uniqueVisitors, uniqueApp, uniqueWeb },
    series,
    top: { menu: top(menu, 15), out: top(outbound, 15), src: top(src, 15), book: top(book, 15), call: top(calls, 15), ride: top(rides, 15), item: top(items, 40) }
  });
}

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return res.status(204).end();
    const r = getRedis();
    if (!r) {
      // Not configured. Tracking stays silent so it never breaks the app.
      if (req.method === 'POST') return res.status(204).end();
      return res.status(503).json({ error: 'Redis is not configured' });
    }
    if (req.method === 'POST') return await handleTrack(req, res, r);
    if (req.method === 'GET') return await handleReport(req, res, r);
    return res.status(405).end();
  } catch (e) {
    console.error('stats failed', e && e.message);
    if (req.method === 'POST') return res.status(204).end();
    return res.status(500).json({ error: 'stats failed' });
  }
}
