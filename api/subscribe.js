// Email signup endpoint. Stores in Postgres, sends welcome email via Resend.
// Required env: RESEND_API_KEY, POSTGRES_URL

import pg from 'pg';
import { Resend } from 'resend';
import crypto from 'crypto';

const { Pool } = pg;

const FROM_EMAIL = 'Howdy Nash <howdy@howdynash.com>';
const SITE_URL = 'https://howdynash.com';
const CHEATSHEET_URL = 'https://howdynash.com/cheatsheet.html';
const BACHELORETTE_URL = 'https://howdynash.com/bachelorette.html';

let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.POSTGRES_URL,
      ssl: { rejectUnauthorized: false },
      max: 3
    });
  }
  return pool;
}

async function ensureTable() {
  const sql = `
    CREATE TABLE IF NOT EXISTS subscribers (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      name VARCHAR(255),
      source VARCHAR(50) DEFAULT 'unknown',
      unsubscribe_token VARCHAR(64) UNIQUE,
      subscribed_at TIMESTAMPTZ DEFAULT NOW(),
      unsubscribed_at TIMESTAMPTZ NULL,
      consent_ip VARCHAR(45),
      saved_spots JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_subscribers_email ON subscribers(email);
    CREATE INDEX IF NOT EXISTS idx_subscribers_token ON subscribers(unsubscribe_token);
  `;
  await getPool().query(sql);
}

const rateLimitStore = new Map();
const RATE_LIMIT_PER_HOUR = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimitStore.get(ip);
  if (!record || now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitStore.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  if (record.count >= RATE_LIMIT_PER_HOUR) return false;
  record.count += 1;
  return true;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

// Bachelorette email body. Short and link-driven so Gmail does not flag the
// email as spam (the word "bachelorette" plus party content otherwise triggers
// filters). Full content lives at /bachelorette.html.
function buildBacheloretteBlock() {
  return `<p style="margin:16px 0;text-align:center;"><a href="${BACHELORETTE_URL}" style="display:inline-block;background:#d62828;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;">Open the planner</a></p>
<p style="margin:16px 0 8px;font-size:14px;color:#444;">Inside you will find a 3-day Nashville plan covering arrival, photo spots, dinner picks, group transport, and recovery tools. Bookmark the link, it loads fast on phones.</p>
<p style="margin:8px 0 16px;font-size:14px;color:#666;">Reply to this email with your trip dates and I will personalize the plan with concerts, weather, and which spots to skip.</p>`;
}

function buildWelcomeEmail({ name, source, unsubscribeUrl, savedSpots }) {
  const greeting = name ? `Howdy ${name.split(' ')[0]}` : 'Howdy';
  let savedSpotsBlock = '';
  if (savedSpots && savedSpots.length) {
    const items = savedSpots.map(s => `<li style="margin:6px 0;"><strong>${escapeHtml(s.name || '')}</strong>${s.note ? ' &mdash; ' + escapeHtml(s.note) : ''}${s.address ? '<br><span style="color:#666;font-size:13px;">' + escapeHtml(s.address) + '</span>' : ''}</li>`).join('');
    savedSpotsBlock = `<h3 style="margin:24px 0 8px;">Your saved Nashville spots</h3><ul style="padding-left:18px;">${items}</ul>`;
  }
  const sourceBlurb = {
    'cheatsheet': 'Your free Nashville 3-Day Cheat Sheet is attached as a link below. Open it on your phone. Save the page. Take it on the road.',
    'saved-spots': 'Here are the spots you starred. Tap any to open them in Maps.',
    'bachelorette': 'Your Nashville group trip planner is ready. Tap the button below to open it.',
    'general': 'You are on the list. Once a week I send a quick Nashville roundup with new restaurants, weekend events, and deals.'
  }[source] || 'Welcome to Howdy Nash. Once a week I send a quick Nashville roundup with new restaurants, weekend events, and deals.';

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Welcome to Howdy Nash</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#222;">
  <div style="max-width:560px;margin:0 auto;padding:24px;background:#fff;">
    <div style="text-align:center;padding:16px 0;border-bottom:3px solid #d62828;">
      <div style="font-size:28px;font-weight:800;color:#d62828;letter-spacing:-0.5px;">Howdy Nash</div>
      <div style="font-size:13px;color:#666;margin-top:4px;">Your free Nashville guide</div>
    </div>
    <div style="padding:24px 0;line-height:1.6;font-size:16px;">
      <p style="margin:0 0 12px;">${greeting},</p>
      <p style="margin:0 0 12px;">${sourceBlurb}</p>
      ${source === 'cheatsheet' ? `<p style="margin:16px 0;"><a href="${CHEATSHEET_URL}" style="display:inline-block;background:#d62828;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Open the Cheat Sheet</a></p>` : ''}
      ${source === 'bachelorette' ? buildBacheloretteBlock() : ''}
      ${savedSpotsBlock}
      <p style="margin:24px 0 12px;">P.S. Every Friday I send a roundup of upcoming Nashville festivals, concerts, and new restaurant openings. Reply to this email anytime, I read every one.</p>
      <p style="margin:0;">Howdy,<br>Howdy Nash</p>
    </div>
    <div style="border-top:1px solid #eee;padding:16px 0;font-size:12px;color:#888;text-align:center;">
      <a href="${SITE_URL}" style="color:#d62828;text-decoration:none;">howdynash.com</a> &middot; <a href="${unsubscribeUrl}" style="color:#888;text-decoration:underline;">Unsubscribe</a>
      <div style="margin-top:8px;">You are receiving this because you signed up at howdynash.com. Unsubscribe anytime.</div>
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ===== WEEKLY NEWSLETTER =====
// Pulls fresh festivals/events and emails to all active subscribers.
// Triggered manually via POST { action: 'newsletter-send', token: ADMIN_TOKEN }
// Or preview HTML with: POST { action: 'newsletter-preview' }

async function fetchEaterOpenings() {
  // Scrapes Eater Nashville (ATOM feed format) for restaurant opening articles.
  try {
    const r = await fetch('https://nashville.eater.com/rss/index.xml', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HowdyNash/1.0)' }
    });
    if (!r.ok) return [];
    const xml = await r.text();
    const cdata = (s) => (s || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const items = [];
    // ATOM uses <entry> tags, RSS uses <item>. Eater Nashville uses ATOM.
    const entries = xml.match(/<entry[\s\S]*?<\/entry>/g) || xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    for (const entry of entries.slice(0, 25)) {
      const title = cdata((entry.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]);
      // ATOM link is an attribute: <link rel="alternate" href="..."/>
      // RSS link is text: <link>...</link>
      let link = '';
      const atomLink = entry.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/);
      const rssLink = entry.match(/<link>([\s\S]*?)<\/link>/);
      if (atomLink) link = atomLink[1];
      else if (rssLink) link = cdata(rssLink[1]);
      // Filter for restaurant openings, debuts, first looks
      if (/\b(open|opens|opening|debut|coming soon|first look|new\s|arrives|launches|launching|expands)/i.test(title)) {
        const isFood = /restaurant|cafe|coffee|bar|brewery|bakery|kitchen|grill|chicken|bbq|pizza|burger|taco|diner|cocktail|food|chef|eatery|deli|donut|ice cream/i.test(title);
        if (isFood && link) {
          items.push({ name: title, url: link, source: 'eater' });
        }
      }
    }
    return items.slice(0, 4);
  } catch (e) {
    return [];
  }
}

async function fetchThisWeekendEvents() {
  const now = new Date();
  const cutoff = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const inWindow = (e) => {
    if (!e.date) return false;
    const d = new Date(e.date);
    return d >= now && d <= cutoff;
  };

  // 1) Curated festivals first (your branded list)
  let festivals = [];
  try {
    const r = await fetch(`${SITE_URL}/api/festivals?source=curated`);
    if (r.ok) {
      const data = await r.json();
      festivals = (data.events || []).filter(inWindow);
    }
  } catch (e) { /* keep going */ }

  // 2) Visit Music City scraper (community festivals not in your curated list)
  let vmcFestivals = [];
  try {
    const r = await fetch(`${SITE_URL}/api/festivals?source=visitmusiccity`);
    if (r.ok) {
      const data = await r.json();
      vmcFestivals = (data.events || []).filter(inWindow);
    }
  } catch (e) { /* keep going */ }

  // 3) Ticketmaster + SeatGeek + Eventbrite for big concerts and events
  let liveEvents = [];
  try {
    const startISO = now.toISOString().split('.')[0] + 'Z';
    const endISO = cutoff.toISOString().split('.')[0] + 'Z';
    const r = await fetch(`${SITE_URL}/api/events?startDateTime=${encodeURIComponent(startISO)}&endDateTime=${encodeURIComponent(endISO)}`);
    if (r.ok) {
      const data = await r.json();
      liveEvents = (data.events || []).slice(0, 12);
    }
  } catch (e) { /* keep going */ }

  // Merge in priority order: curated, Visit Music City, live events. Dedupe by first-30-chars name.
  const merged = [];
  const seen = new Set();
  const push = (arr) => {
    for (const e of arr) {
      const key = (e.name || '').toLowerCase().slice(0, 30);
      if (!seen.has(key) && merged.length < 6) {
        merged.push(e);
        seen.add(key);
      }
    }
  };
  push(festivals);
  push(vmcFestivals);
  push(liveEvents);

  return merged;
}

function buildNewsletterHTML(events, openings) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const festRows = events.map(e => `
    <tr><td style="padding:10px 0;border-bottom:1px solid #eee;">
      <strong style="color:#d62828;font-size:15px;">${(e.name || '').slice(0, 80)}</strong><br>
      <span style="color:#666;font-size:13px;">${e.dates || e.date} · ${e.venue || e.neighborhood || 'Nashville'}</span>
      ${e.url ? `<br><a href="${e.url}" style="color:#d62828;font-size:13px;">Details</a>` : ''}
    </td></tr>
  `).join('');
  const openingsBlock = (openings && openings.length) ? `
    <h3 style="margin:24px 0 8px;color:#d62828;">🍴 Restaurant Openings</h3>
    <table style="width:100%;border-collapse:collapse;">
      ${openings.map(o => `
        <tr><td style="padding:10px 0;border-bottom:1px solid #eee;">
          <strong style="color:#d62828;font-size:15px;">${(o.name || '').slice(0, 100)}</strong><br>
          <a href="${o.url}" style="color:#d62828;font-size:13px;">Read on Eater Nashville</a>
        </td></tr>
      `).join('')}
    </table>
  ` : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>This Weekend in Nashville</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#222;">
  <div style="max-width:560px;margin:0 auto;padding:24px;background:#fff;">
    <div style="text-align:center;padding:16px 0;border-bottom:3px solid #d62828;">
      <div style="font-size:28px;font-weight:800;color:#d62828;">Howdy Nash</div>
      <div style="font-size:13px;color:#666;margin-top:4px;">This Weekend in Nashville · ${today}</div>
    </div>
    <div style="padding:24px 0;line-height:1.6;font-size:16px;">
      <p style="margin:0 0 16px;">Howdy,</p>
      <p style="margin:0 0 16px;">Here is what's happening in Nashville this week. Tap any event for tickets and details.</p>
      <h3 style="margin:24px 0 8px;color:#d62828;">🎵 Festivals & Events</h3>
      <table style="width:100%;border-collapse:collapse;">${festRows || '<tr><td style="padding:12px 0;color:#666;">No major festivals scheduled. Tap below for live music.</td></tr>'}</table>
      ${openingsBlock}
      <p style="margin:24px 0 12px;">For live music tonight, weekend brunch, hot chicken lines, and group location sharing, open the full guide:</p>
      <p style="margin:16px 0;text-align:center;"><a href="${SITE_URL}" style="display:inline-block;background:#d62828;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;">Open Howdy Nash</a></p>
      <p style="margin:24px 0 12px;font-size:14px;color:#666;">Heading to Nashville for a bachelorette? Reply to this email and tell me when. I will send you a personalized planner.</p>
      <p style="margin:0;">Howdy,<br>Howdy Nash</p>
    </div>
    <div style="border-top:1px solid #eee;padding:16px 0;font-size:12px;color:#888;text-align:center;">
      <a href="${SITE_URL}" style="color:#d62828;text-decoration:none;">howdynash.com</a> &middot; <a href="{{UNSUB_URL}}" style="color:#888;text-decoration:underline;">Unsubscribe</a>
      <div style="margin-top:8px;">You are receiving this because you signed up at howdynash.com. Restaurant news from Eater Nashville.</div>
    </div>
  </div>
</body></html>`;
}

async function sendWeeklyNewsletter(resend) {
  await ensureTable();
  const subs = await getPool().query(`SELECT email, name, unsubscribe_token FROM subscribers WHERE unsubscribed_at IS NULL`);
  const [events, openings] = await Promise.all([fetchThisWeekendEvents(), fetchEaterOpenings()]);
  const baseHtml = buildNewsletterHTML(events, openings);
  const subject = `This Weekend in Nashville · ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  let sent = 0, failed = 0;
  for (const row of subs.rows) {
    try {
      const unsubUrl = `${SITE_URL}/api/unsubscribe?token=${row.unsubscribe_token}`;
      const html = baseHtml.replace('{{UNSUB_URL}}', unsubUrl);
      await resend.emails.send({ from: FROM_EMAIL, to: row.email, subject, html });
      sent++;
    } catch (e) {
      failed++;
    }
  }
  return { sent, failed, total: subs.rows.length };
}

export default async function handler(req, res) {
  // Vercel Cron support: GET /api/subscribe?cron=newsletter triggers the weekly send.
  // Vercel automatically attaches Authorization: Bearer CRON_SECRET when calling cron paths.
  if (req.method === 'GET' && req.query && req.query.cron === 'newsletter') {
    const auth = req.headers.authorization || '';
    const expected = `Bearer ${process.env.CRON_SECRET || ''}`;
    if (!process.env.CRON_SECRET || auth !== expected) {
      return res.status(403).json({ error: 'cron auth required' });
    }
    if (!process.env.RESEND_API_KEY || !process.env.POSTGRES_URL) {
      return res.status(503).json({ error: 'email or db not configured' });
    }
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const result = await sendWeeklyNewsletter(resend);
      return res.status(200).json({ ok: true, ...result });
    } catch (e) {
      console.error('cron newsletter error', e);
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }
  if (!process.env.RESEND_API_KEY) {
    return res.status(503).json({ error: 'email service not configured' });
  }
  if (!process.env.POSTGRES_URL) {
    return res.status(503).json({ error: 'database not configured' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }

  // Newsletter actions (admin only)
  if (body.action === 'newsletter-preview') {
    const [events, openings] = await Promise.all([fetchThisWeekendEvents(), fetchEaterOpenings()]);
    const html = buildNewsletterHTML(events, openings).replace('{{UNSUB_URL}}', '#preview');
    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(html);
  }
  if (body.action === 'eater-debug') {
    // Test multiple Eater URL variants and Nashville Scene as fallback
    const urls = [
      'https://nashville.eater.com/rss/index.xml',
      'https://nashville.eater.com/rss/current.xml',
      'https://www.eater.com/rss/region/nashville.xml',
      'https://www.nashvillescene.com/feeds/news/rss.xml',
      'https://www.nashvillescene.com/feeds/food-drink/rss.xml'
    ];
    const results = [];
    for (const url of urls) {
      try {
        const r = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HowdyNash/1.0)' }
        });
        const text = r.ok ? await r.text() : '';
        const itemCount = (text.match(/<item>/g) || []).length;
        const entryCount = (text.match(/<entry>/g) || []).length;
        const sample = text.slice(0, 500);
        results.push({ url, status: r.status, items: itemCount, entries: entryCount, sample });
      } catch (e) {
        results.push({ url, error: e.message });
      }
    }
    return res.status(200).json({ results });
  }
  if (body.action === 'newsletter-send') {
    if (!process.env.ADMIN_TOKEN || body.token !== process.env.ADMIN_TOKEN) {
      return res.status(403).json({ error: 'admin token required' });
    }
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const result = await sendWeeklyNewsletter(resend);
      return res.status(200).json(result);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'too many signups, try again later' });
  }

  const email = String(body.email || '').trim().toLowerCase();
  const name = String(body.name || '').trim().slice(0, 100);
  const source = String(body.source || 'general').trim().slice(0, 50);
  const savedSpots = Array.isArray(body.savedSpots) ? body.savedSpots.slice(0, 50) : null;

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'valid email required' });
  }

  try {
    await ensureTable();
    const token = crypto.randomBytes(24).toString('hex');
    const upsert = `
      INSERT INTO subscribers (email, name, source, unsubscribe_token, consent_ip, saved_spots)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (email) DO UPDATE SET
        name = COALESCE(EXCLUDED.name, subscribers.name),
        source = COALESCE(EXCLUDED.source, subscribers.source),
        unsubscribed_at = NULL,
        saved_spots = COALESCE(EXCLUDED.saved_spots, subscribers.saved_spots)
      RETURNING unsubscribe_token, subscribed_at
    `;
    const result = await getPool().query(upsert, [
      email,
      name || null,
      source,
      token,
      ip.slice(0, 45),
      savedSpots ? JSON.stringify(savedSpots) : null
    ]);
    const stored = result.rows[0];
    const unsubscribeToken = stored.unsubscribe_token;
    const unsubscribeUrl = `${SITE_URL}/api/unsubscribe?token=${unsubscribeToken}`;

    const resend = new Resend(process.env.RESEND_API_KEY);
    const subject = {
      'cheatsheet': 'Your free Nashville 3-Day Cheat Sheet',
      'saved-spots': 'Your Nashville saved spots',
      'bachelorette': 'Your Nashville group trip planner',
      'general': 'Welcome to Howdy Nash'
    }[source] || 'Welcome to Howdy Nash';

    await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject,
      html: buildWelcomeEmail({ name, source, unsubscribeUrl, savedSpots }),
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
      }
    });

    res.status(200).json({ ok: true, message: 'check your inbox' });
  } catch (e) {
    console.error('subscribe error:', e.message);
    res.status(500).json({ error: 'signup failed, try again' });
  }
}
