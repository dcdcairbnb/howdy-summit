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

// Error reporter dedupe + rate limit. Stops a buggy page from spamming inbox.
const errorRateLimitStore = new Map();
const ERROR_RATE_LIMIT_PER_HOUR = 20;
const recentErrorFingerprints = new Map();
const ERROR_REPORTER_TO = 'howdynashhq@gmail.com';

function checkErrorRateLimit(ip) {
  const now = Date.now();
  const record = errorRateLimitStore.get(ip);
  if (!record || now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
    errorRateLimitStore.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  if (record.count >= ERROR_RATE_LIMIT_PER_HOUR) return false;
  record.count += 1;
  return true;
}

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

// Bachelorette email body. Plain-text style with a single text link so Gmail
// keeps it in Primary instead of Promotions tab. Full content lives at
// /bachelorette.html.
function buildBacheloretteBlock() {
  return `<p style="margin:16px 0 12px;">Here is the planner I put together for your trip:</p>
<p style="margin:16px 0;"><a href="${BACHELORETTE_URL}" style="color:#d62828;font-weight:600;">${BACHELORETTE_URL}</a></p>
<p style="margin:16px 0 12px;">It covers arrival, photo spots, dinner picks, group transport, and recovery tools across 3 days. Loads fast on phones. Bookmark the link.</p>
<p style="margin:16px 0 12px;">If you reply to this email with your trip dates I will personalize the plan with concerts, weather, and which spots to skip that weekend.</p>`;
}

// Title-case a single name word so "DAN" or "dan" both render as "Dan".
function titleCase(s) {
  return String(s || '').toLowerCase().replace(/(^|\s|-)([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}
// Trip summary email body for the Split Costs feature. Each member gets a
// personalized email showing what they owe (or that they're the payer) with
// one-tap pay deeplinks for Venmo, Cash App, and PayPal. Generated from
// tripData payload sent by the client.
// Build pay-link buttons for one creditor with one debt amount. Returns a
// span containing each available platform button. Used per-settlement.
function buildPayButtonsForCreditor(creditor, amount, tripName) {
  const note = encodeURIComponent(tripName || 'Nashville trip');
  const safeAmount = Math.max(0, Number(amount || 0)).toFixed(2);
  const buttons = [];
  if (creditor.venmo) {
    const handle = String(creditor.venmo).replace(/^@/, '').trim();
    const url = `https://venmo.com/${encodeURIComponent(handle)}?txn=pay&amount=${safeAmount}&note=${note}`;
    buttons.push(`<a href="${url}" style="color:#3D95CE;font-weight:700;text-decoration:none;">Venmo</a>`);
  }
  if (creditor.cashapp) {
    const handle = String(creditor.cashapp).replace(/^\$/, '').trim();
    const url = `https://cash.app/$${encodeURIComponent(handle)}/${safeAmount}`;
    buttons.push(`<a href="${url}" style="color:#00D632;font-weight:700;text-decoration:none;">Cash App</a>`);
  }
  if (creditor.paypal) {
    let handle = String(creditor.paypal).trim();
    handle = handle.replace(/^https?:\/\/(www\.)?paypal\.me\//i, '').replace(/^@/, '');
    const url = `https://paypal.me/${encodeURIComponent(handle)}/${safeAmount}`;
    buttons.push(`<a href="${url}" style="color:#0070BA;font-weight:700;text-decoration:none;">PayPal</a>`);
  }
  return buttons.length ? buttons.join(' &middot; ') : '<span style="color:#888;">No payment handle on file. Pay outside the app.</span>';
}

// Trip summary email body for the Split Costs feature. Each member gets a
// personalized email showing what they owe (or that they're the payer) with
// one-tap pay deeplinks for Venmo, Cash App, and PayPal. Generated from
// tripData payload sent by the client.
function buildTripSummaryBlock(tripData) {
  if (!tripData) return '';
  const {
    tripName, payerName, payerVenmo, payerCashapp, payerPaypal,
    memberOwes, memberOwed, isPayer, totalSpent, expenses,
    settlements, incoming, isUpdate, summaryVersion
  } = tripData;
  // Big visible "UPDATED" banner so the recipient knows this email replaces
  // any earlier summary they got. Version number lets them confirm they have
  // the latest if multiple corrections went out.
  const updateBanner = isUpdate ? `<div style="background:#fff5d4;border:2px solid #f0c060;border-radius:8px;padding:12px;margin:0 0 16px;">
    <div style="font-weight:700;color:#a06000;font-size:15px;">⚠️ Updated summary (v${summaryVersion || 2})</div>
    <div style="color:#444;font-size:14px;margin-top:4px;">This replaces the previous email${summaryVersion && summaryVersion > 2 ? 's' : ''}. The amounts below are the latest.</div>
  </div>` : '';
  const expList = (expenses || []).slice(0, 30).map(e => `<li style="margin:4px 0;"><strong>$${Number(e.amount).toFixed(2)}</strong> ${escapeHtml(e.description || '')} <span style="color:#888;">(paid by ${escapeHtml(e.paidByName || '')}, split ${e.splitCount} ways)</span></li>`).join('');
  // PAYER (trip starter) view
  if (isPayer) {
    let owedSection = '';
    if (Array.isArray(incoming) && incoming.length) {
      const lines = incoming.map(i => `<li style="margin:4px 0;"><strong>${escapeHtml(i.debtorName || 'Someone')}</strong> owes you $${Number(i.amount).toFixed(2)}</li>`).join('');
      owedSection = `<p style="margin:14px 0 6px;font-weight:600;">Coming in to you:</p>
<ul style="padding-left:18px;margin:0 0 14px;font-size:14px;">${lines}</ul>`;
    }
    let outgoingSection = '';
    if (Array.isArray(settlements) && settlements.length) {
      const lines = settlements.map(s => `<li style="margin:6px 0;"><strong>$${Number(s.amount).toFixed(2)}</strong> to ${escapeHtml(s.creditorName || 'a member')} &middot; ${buildPayButtonsForCreditor(s, s.amount, tripName)}</li>`).join('');
      outgoingSection = `<p style="margin:14px 0 6px;font-weight:600;">You also owe (someone else fronted these):</p>
<ul style="padding-left:18px;margin:0 0 14px;font-size:14px;">${lines}</ul>`;
    }
    return `${updateBanner}<p style="margin:14px 0 8px;"><strong>${escapeHtml(tripName || 'Your trip')} summary</strong></p>
<p style="margin:8px 0;">You started this trip. Total tracked: $${Number(totalSpent || 0).toFixed(2)}.</p>
<p style="margin:8px 0;">Each person on the trip got their own email with what they owe and one-tap pay buttons to whoever fronted the bill.</p>
${owedSection}
${outgoingSection}
<p style="margin:14px 0 6px;font-weight:600;">All expenses tracked:</p>
<ul style="padding-left:18px;margin:0 0 14px;font-size:14px;">${expList || '<li>No expenses</li>'}</ul>`;
  }
  // MEMBER view: show per-creditor settlements with the right pay buttons
  // for each. If they're net-positive (owed money), show who owes them.
  let settlementsBlock = '';
  if (Array.isArray(settlements) && settlements.length) {
    const lines = settlements.map(s => `<li style="margin:8px 0;"><strong>$${Number(s.amount).toFixed(2)}</strong> to <strong>${escapeHtml(s.creditorName || 'a member')}</strong><br><span style="font-size:14px;">${buildPayButtonsForCreditor(s, s.amount, tripName)}</span></li>`).join('');
    settlementsBlock = `<p style="margin:8px 0;">You owe a total of <strong>$${Number(memberOwes || 0).toFixed(2)}</strong>, broken down below:</p>
<ul style="padding-left:18px;margin:0 0 14px;font-size:15px;list-style:none;">${lines}</ul>`;
  } else if (Number(memberOwes || 0) > 0) {
    // Backward compatibility path: old client sent only memberOwes without settlements.
    const handle = { venmo: payerVenmo, cashapp: payerCashapp, paypal: payerPaypal };
    settlementsBlock = `<p style="margin:8px 0;">You owe ${escapeHtml(payerName || 'the payer')}: <strong>$${Number(memberOwes).toFixed(2)}</strong></p>
<p style="margin:14px 0;">${buildPayButtonsForCreditor(handle, memberOwes, tripName)}</p>`;
  } else {
    settlementsBlock = `<p style="margin:8px 0;">You're square. Nothing to pay.</p>`;
  }
  let incomingBlock = '';
  if (Array.isArray(incoming) && incoming.length) {
    const lines = incoming.map(i => `<li style="margin:4px 0;"><strong>${escapeHtml(i.debtorName || 'Someone')}</strong> owes you $${Number(i.amount).toFixed(2)}</li>`).join('');
    incomingBlock = `<p style="margin:14px 0 6px;font-weight:600;">Money coming back to you:</p>
<ul style="padding-left:18px;margin:0 0 14px;font-size:14px;">${lines}</ul>
<p style="margin:8px 0;font-size:14px;color:#666;">They each got an email with your payment links.</p>`;
  } else if (Number(memberOwed || 0) > 0.01) {
    incomingBlock = `<p style="margin:14px 0 8px;">You're owed <strong>$${Number(memberOwed).toFixed(2)}</strong> from the group. They each got an email with your payment links.</p>`;
  }
  return `${updateBanner}<p style="margin:14px 0 8px;"><strong>${escapeHtml(tripName || 'Nashville trip')} summary</strong></p>
${settlementsBlock}
${incomingBlock}
<p style="margin:14px 0 6px;font-weight:600;">Trip expenses:</p>
<ul style="padding-left:18px;margin:0 0 14px;font-size:14px;">${expList || '<li>No expenses</li>'}</ul>
<p style="margin:8px 0;font-size:14px;color:#666;">Split evenly across the people in each line item. Total trip: $${Number(totalSpent || 0).toFixed(2)}.</p>`;
}

function buildWelcomeEmail({ name, source, unsubscribeUrl, savedSpots, tripData }) {
  const firstName = name ? titleCase(name.split(' ')[0]) : '';
  const greeting = firstName ? `Howdy ${firstName}` : 'Howdy';
  let savedSpotsBlock = '';
  if (savedSpots && savedSpots.length) {
    const items = savedSpots.map(s => `<li style="margin:6px 0;"><strong>${escapeHtml(s.name || '')}</strong>${s.note ? ' &mdash; ' + escapeHtml(s.note) : ''}${s.address ? '<br><span style="color:#666;font-size:13px;">' + escapeHtml(s.address) + '</span>' : ''}</li>`).join('');
    savedSpotsBlock = `<h3 style="margin:24px 0 8px;">Your saved Nashville spots</h3><ul style="padding-left:18px;">${items}</ul>`;
  }
  const sourceBlurb = {
    'cheatsheet': 'Your free Nashville 3-Day Cheat Sheet is attached as a link below. Open it on your phone. Save the page. Take it on the road.',
    'saved-spots': 'Here are the spots you starred. Tap any to open them in Maps.',
    'bachelorette': 'Thanks for signing up. I built a Nashville group trip planner page just for trips like yours.',
    'trip-summary': tripData && tripData.isPayer ? `Here is the summary from your ${tripData.tripName || 'Nashville trip'}. Each person on the trip got their own email with what they owe.` : `Here is your share from the ${tripData && tripData.tripName || 'Nashville trip'}. Tap a payment button below to settle up in seconds.`,
    'general': 'You are on the list. Once a week I send a quick Nashville roundup with new restaurants, weekend events, and deals.'
  }[source] || 'Welcome to Howdy Nash. Once a week I send a quick Nashville roundup with new restaurants, weekend events, and deals.';

  // Subtle branding (small logo) plus plain-text body. Logo helps the email
  // feel polished without triggering Gmail's Promotions classifier (no big CTA
  // buttons, no colored headers, no marketing copy).
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Howdy Nash</title></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#222;font-size:16px;line-height:1.55;">
  <div style="max-width:560px;margin:0 auto;padding:20px 18px;">
    <div style="margin-bottom:18px;"><img src="${SITE_URL}/logo.png" alt="Howdy Nash" width="56" height="56" style="border-radius:12px;display:block;" /></div>
    <p style="margin:0 0 14px;">${greeting},</p>
    <p style="margin:0 0 14px;">${sourceBlurb}</p>
    ${source === 'cheatsheet' ? `<p style="margin:14px 0;"><a href="${CHEATSHEET_URL}" style="color:#d62828;font-weight:600;">${CHEATSHEET_URL}</a></p>` : ''}
    ${source === 'bachelorette' ? buildBacheloretteBlock() : ''}
    ${source === 'trip-summary' ? buildTripSummaryBlock(tripData) : ''}
    ${savedSpotsBlock}
    <p style="margin:18px 0 14px;">Reply anytime. I read every email and I am happy to point you to the right spot for whatever you are looking for in Nashville.</p>
    <p style="margin:0 0 4px;">Dan</p>
    <p style="margin:0;color:#666;font-size:14px;">Howdy Nash · Nashville's Free Travel Concierge</p>
    <p style="margin:24px 0 0;font-size:12px;color:#999;">Sent because you signed up at howdynash.com. <a href="${unsubscribeUrl}" style="color:#999;">Unsubscribe</a></p>
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
      return console.error("[subscribe] error", e); res.status(500).json({ error: "internal server error" });
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
    // Cap body size at 100KB. Trip-summary payloads with expense lists are
    // the largest legitimate use case and they fit easily under this cap.
    if (body.length > 100000) {
      return res.status(413).json({ error: 'request body too large' });
    }
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'invalid body' });
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
      return console.error("[subscribe] error", e); res.status(500).json({ error: "internal server error" });
    }
  }

  // Client-side error reporter. Browser POSTs window.onerror events here.
  // Dedupes by error fingerprint over a 1-hour window to avoid email floods.
  // Quiet in production logs (no console.error spam) but emails on first hit.
  if (body.action === 'log-error') {
    const ipAddr = getClientIp(req);
    if (!checkErrorRateLimit(ipAddr)) {
      return res.status(429).json({ ok: false });
    }
    const errMsg = String(body.message || '').slice(0, 500);
    const errStack = String(body.stack || '').slice(0, 2000);
    const errUrl = String(body.url || '').slice(0, 500);
    const errLine = Number(body.line) || 0;
    const errCol = Number(body.col) || 0;
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 300);
    if (!errMsg) return res.status(200).json({ ok: true });

    // Dedupe key: same message + same line. Reduces email count for repeated errors.
    const fingerprint = `${errMsg}::${errLine}`;
    if (recentErrorFingerprints.has(fingerprint)) {
      return res.status(200).json({ ok: true, dedup: true });
    }
    recentErrorFingerprints.set(fingerprint, Date.now());
    // Trim the fingerprint cache periodically
    if (recentErrorFingerprints.size > 200) {
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const [k, t] of recentErrorFingerprints) {
        if (t < cutoff) recentErrorFingerprints.delete(k);
      }
    }

    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: FROM_EMAIL,
        to: ERROR_REPORTER_TO,
        subject: `Howdy Nash JS error: ${errMsg.slice(0, 80)}`,
        text: `A new client-side error fired on howdynash.com.\n\n` +
          `Message: ${errMsg}\n` +
          `URL: ${errUrl}\n` +
          `Line: ${errLine}, Column: ${errCol}\n` +
          `User Agent: ${userAgent}\n` +
          `IP: ${ipAddr}\n\n` +
          `Stack trace:\n${errStack}\n\n` +
          `This is the first occurrence in the last hour. Repeats are silenced.`
      });
    } catch (e) {
      console.error('error-report email failed', e.message);
    }
    return res.status(200).json({ ok: true });
  }

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'too many signups, try again later' });
  }

  const email = String(body.email || '').trim().toLowerCase().slice(0, 254);
  const name = String(body.name || '').trim().slice(0, 100);
  const source = String(body.source || 'general').trim().slice(0, 50);
  const optIn = !!body.optIn;
  // Sanitize savedSpots: cap each field so an attacker can't store huge blobs.
  const savedSpots = Array.isArray(body.savedSpots)
    ? body.savedSpots.slice(0, 50).map(s => ({
        name: String(s && s.name || '').slice(0, 200),
        note: String(s && s.note || '').slice(0, 500),
        address: String(s && s.address || '').slice(0, 300),
        phone: String(s && s.phone || '').slice(0, 30)
      }))
    : null;
  // Sanitize tripData: validate structure, cap each field, drop unexpected keys.
  let tripData = null;
  if (source === 'trip-summary' && body.tripData && typeof body.tripData === 'object') {
    const t = body.tripData;
    tripData = {
      tripName: String(t.tripName || 'Nashville trip').slice(0, 100),
      payerName: String(t.payerName || '').slice(0, 100),
      payerVenmo: String(t.payerVenmo || '').slice(0, 50),
      payerCashapp: String(t.payerCashapp || '').slice(0, 50),
      payerPaypal: String(t.payerPaypal || '').slice(0, 200),
      memberOwes: Math.max(0, Math.min(100000, Number(t.memberOwes) || 0)),
      memberOwed: Math.max(0, Math.min(1000000, Number(t.memberOwed) || 0)),
      isPayer: !!t.isPayer,
      isUpdate: !!t.isUpdate,
      summaryVersion: Math.max(1, Math.min(99, Number(t.summaryVersion) || 1)),
      totalSpent: Math.max(0, Math.min(1000000, Number(t.totalSpent) || 0)),
      expenses: Array.isArray(t.expenses)
        ? t.expenses.slice(0, 100).map(e => ({
            amount: Math.max(0, Math.min(100000, Number(e && e.amount) || 0)),
            description: String(e && e.description || '').slice(0, 80),
            paidByName: String(e && e.paidByName || '').slice(0, 100),
            splitCount: Math.max(1, Math.min(50, Number(e && e.splitCount) || 1))
          }))
        : [],
      // New per-pair settlements: who this member owes, with each creditor's
      // payment handles so the email can render the correct pay buttons.
      settlements: Array.isArray(t.settlements)
        ? t.settlements.slice(0, 50).map(s => ({
            creditorName: String(s && s.creditorName || '').slice(0, 100),
            amount: Math.max(0, Math.min(100000, Number(s && s.amount) || 0)),
            venmo: String(s && s.venmo || '').slice(0, 50),
            cashapp: String(s && s.cashapp || '').slice(0, 50),
            paypal: String(s && s.paypal || '').slice(0, 200)
          }))
        : [],
      // Reverse direction: who owes this member, for net-positive members.
      incoming: Array.isArray(t.incoming)
        ? t.incoming.slice(0, 50).map(i => ({
            debtorName: String(i && i.debtorName || '').slice(0, 100),
            amount: Math.max(0, Math.min(100000, Number(i && i.amount) || 0))
          }))
        : []
    };
  }

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'valid email required' });
  }

  try {
    await ensureTable();
    let unsubscribeUrl = `${SITE_URL}`;
    // For trip-summary source, only add to the marketing subscribers table if
    // the user explicitly opted in. The summary email itself is transactional
    // and goes out regardless. This keeps us CAN-SPAM compliant.
    const shouldStoreSubscriber = source !== 'trip-summary' || optIn;
    if (shouldStoreSubscriber) {
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
      unsubscribeUrl = `${SITE_URL}/api/unsubscribe?token=${stored.unsubscribe_token}`;
    }

    const resend = new Resend(process.env.RESEND_API_KEY);
    const subject = {
      'cheatsheet': 'Your free Nashville 3-Day Cheat Sheet',
      'saved-spots': 'Your Nashville saved spots',
      'bachelorette': 'Your Nashville group trip planner',
      'trip-summary': (tripData && tripData.isUpdate ? 'UPDATED: ' : '') + (tripData && tripData.isPayer ? `Your ${tripData.tripName || 'Nashville trip'} summary` : `Your share of the ${tripData && tripData.tripName || 'Nashville trip'}`),
      'general': 'Welcome to Howdy Nash'
    }[source] || 'Welcome to Howdy Nash';

    await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject,
      html: buildWelcomeEmail({ name, source, unsubscribeUrl, savedSpots, tripData }),
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
