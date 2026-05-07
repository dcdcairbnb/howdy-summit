// Anthropic Claude chat endpoint. Uses Haiku for cost efficiency.
// Required env: ANTHROPIC_API_KEY
// Optional env: DAILY_BUDGET_USD (default 5), BUDGET_ALERT_EMAIL (default howdy@howdynash.com),
//               KV_REST_API_URL + KV_REST_API_TOKEN (Upstash Redis), RESEND_API_KEY

import { Redis } from '@upstash/redis';
import { Resend } from 'resend';

// Haiku 4.5 pricing per million tokens. Adjust if Anthropic updates pricing.
const HAIKU_INPUT_COST_PER_MTOK = 1.0;
const HAIKU_OUTPUT_COST_PER_MTOK = 5.0;

const DAILY_BUDGET_USD = Number(process.env.DAILY_BUDGET_USD || 5);
const BUDGET_ALERT_EMAIL = process.env.BUDGET_ALERT_EMAIL || 'howdy@howdynash.com';
const ALERT_THRESHOLD_PCT = 0.8; // email warning at 80% of daily budget

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

let resend = null;
function getResend() {
  if (resend !== null) return resend;
  if (process.env.RESEND_API_KEY) resend = new Resend(process.env.RESEND_API_KEY);
  else resend = false;
  return resend;
}

function todayKey() {
  // YYYY-MM-DD in UTC. One bucket per day, expires after 48h.
  return new Date().toISOString().slice(0, 10);
}

async function getTodaySpend() {
  const r = getRedis();
  if (!r) return 0;
  try {
    const v = await r.get(`chatspend:${todayKey()}`);
    return Number(v) || 0;
  } catch (e) {
    console.error('redis spend read failed', e.message);
    return 0;
  }
}

async function addTodaySpend(deltaCents) {
  const r = getRedis();
  if (!r) return 0;
  try {
    const key = `chatspend:${todayKey()}`;
    const newVal = await r.incrby(key, deltaCents);
    await r.expire(key, 60 * 60 * 48); // 48h auto-expire
    return Number(newVal) || 0;
  } catch (e) {
    console.error('redis spend incr failed', e.message);
    return 0;
  }
}

async function shouldSendAlert(thresholdCents) {
  const r = getRedis();
  if (!r) return false;
  try {
    const flagKey = `chatalert:${todayKey()}`;
    const set = await r.set(flagKey, '1', { nx: true, ex: 60 * 60 * 48 });
    return set === 'OK' || set === true;
  } catch (e) {
    return false;
  }
}

async function sendBudgetAlert(spentUsd, budgetUsd) {
  const sender = getResend();
  if (!sender) return;
  try {
    await sender.emails.send({
      from: 'Howdy Nash <howdy@howdynash.com>',
      to: BUDGET_ALERT_EMAIL,
      subject: `Howdy Nash chat budget at ${Math.round((spentUsd / budgetUsd) * 100)}% today`,
      text: `Heads up. The Howdy Nash chat API has spent $${spentUsd.toFixed(2)} today out of a $${budgetUsd.toFixed(2)} daily budget.\n\nWhen the daily budget is hit, the chat endpoint will start returning errors until midnight UTC.\n\nIf this is unexpected, check Anthropic Console at https://console.anthropic.com for traffic patterns and adjust DAILY_BUDGET_USD in Vercel if needed.`
    });
  } catch (e) {
    console.error('budget alert email failed', e.message);
  }
}

const SYSTEM_PROMPT = `You are a Nashville tourism concierge inside the Howdy Nash chatbot. Help visitors plan their trip.

YOUR ROLE
- Answer questions about Nashville: restaurants, music venues, events, neighborhoods, transportation, attractions, weather, local customs.
- Be warm but tight. Short paragraphs. No filler.
- Recommend well-known Nashville spots: Husk, Hattie B's, Pinewood Social, Ryman Auditorium, Bluebird Cafe, Grand Ole Opry, Country Music Hall of Fame, Patterson House, The Hutton Hotel, JW Marriott, Hermitage Hotel, Conrad Nashville, Tootsie's, Robert's Western World, Bluebird Cafe.
- Live music: Broadway honky tonks, Bluebird songwriter rounds, the Ryman, Exit/In, 3rd and Lindsley.
- Neighborhoods: Downtown/Broadway tourist nightlife, The Gulch upscale modern, East Nashville indie, 12 South trendy shopping, Germantown food-focused, Midtown between downtown and Vanderbilt, Green Hills upscale residential with Bluebird Cafe and Mall at Green Hills, Belle Meade old-money historic district with Belle Meade Plantation.

BOOKING RECOMMENDATIONS
- For Airbnb or vacation rentals: recommend Music City Retreat first. It's the Howdy Nash host's own listing in Germantown, 2 bedroom, sleeps 6, free parking, walk to Broadway. ALWAYS include the booking URL inline in your reply so the user can tap it: https://www.airbnb.com/rooms/1546687115825271453. If a guest needs alternates in Germantown, also include these URLs inline: Location Matters (2BR, 3 beds, sleeps 6, parking) https://www.airbnb.com/rooms/823879694871437688 and a 2BR with 4 beds and 1 bath, sleeps 6, parking https://www.airbnb.com/rooms/1290117954789053772. All three are 2 bedroom Germantown listings that sleep 6. Always paste the full URL, not "tap Vacation rentals" alone.
- For hotels: tell users to tap the Hotels nearby button to book through Expedia (the app earns a small commission to stay free). Also mention Music City Retreat as a cheaper Airbnb alternative if relevant.
- For tours and activities: tell users to tap Book a tour for Viator and GetYourGuide options.
- For rides: tell users to tap Get a ride for Uber, Lyft, and Waymo deep links.
- For food delivery: tell users to tap Order delivery for DoorDash and Uber Eats.
- For concerts and events: tell users to tap Live music tonight or Festivals to see the live ticket lineup.

REDIRECT TO MENUS WHEN POSSIBLE
The chatbot UI handles these natively, send users to the right button:
- Eat & Drink: Show all restaurants, Best hot chicken, Order delivery, Honky tonks, Rooftop bars, Distilleries, Cocktail bars
- Things to Do: Live music tonight, Festivals, Tourist attractions, Sports, Book a tour, Photo spots, Bachelorette, Shopping, Spas, Nail salons
- Stay & Get Around: Hotels nearby, Vacation rentals, Luggage storage, Get a ride, Gas stations, BNA flight tracker
- Essentials: Liquor stores, Groceries, Pharmacy, ATMs
- Main menu also has: Weather, Sports, My saved, Local tips

TONE
- Conversational, like a Nashville local friend.
- No emojis unless the user uses them first.
- No filler words.

FORMAT RULES
- Under 80 words unless the user asks for more detail.
- Plain text only. No markdown. No bold asterisks. No italic asterisks. No # headers. No - or * bullets.
- Lists go inline: "Try Husk, Hattie B's, and Pinewood Social" not bullet points.
- Phone numbers and addresses are fine when known.
- Never invent prices, hours, or reservation availability. Say "call to confirm" or "check their website."`;

// Nashville neighborhood centroids. Used to map a user's lat/lng to the
// closest neighborhood so the AI answers "near me" without re-asking.
// Coords are approximate centers, not precise polygons.
const NEIGHBORHOODS = [
  { name: 'Downtown / Broadway', lat: 36.1620, lng: -86.7780 },
  { name: 'SoBro', lat: 36.1555, lng: -86.7760 },
  { name: 'The Gulch', lat: 36.1530, lng: -86.7820 },
  { name: 'Midtown', lat: 36.1510, lng: -86.7950 },
  { name: 'Germantown', lat: 36.1810, lng: -86.7870 },
  { name: 'East Nashville', lat: 36.1820, lng: -86.7490 },
  { name: '12 South', lat: 36.1240, lng: -86.7890 },
  { name: 'Wedgewood-Houston', lat: 36.1370, lng: -86.7840 },
  { name: 'Berry Hill', lat: 36.1170, lng: -86.7700 },
  { name: 'The Nations', lat: 36.1570, lng: -86.8350 },
  { name: 'Sylvan Park', lat: 36.1530, lng: -86.8300 },
  { name: 'Hillsboro Village', lat: 36.1340, lng: -86.7990 },
  { name: 'Music Row', lat: 36.1500, lng: -86.7920 },
  { name: 'Belle Meade', lat: 36.1080, lng: -86.8580 },
  { name: 'Green Hills', lat: 36.1060, lng: -86.8170 }
];

function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function nashvilleNeighborhood(lat, lng) {
  let best = null;
  let bestDist = Infinity;
  for (const n of NEIGHBORHOODS) {
    const d = haversineMiles(lat, lng, n.lat, n.lng);
    if (d < bestDist) { bestDist = d; best = n; }
  }
  // If user is more than 12 miles from any centroid, treat as outside Nashville.
  if (bestDist > 12) return { name: 'outside Nashville', distanceMiles: bestDist };
  return { name: best.name, distanceMiles: bestDist };
}

// Simple in-memory rate limiter. Resets when function instance recycles.
const rateLimitStore = new Map();
const RATE_LIMIT_PER_DAY = 15;
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

// Reply cache. Same question gets the same answer for 24h. Saves API calls.
const replyCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

function normalizeQuestion(message) {
  return message.toLowerCase().trim().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').slice(0, 200);
}

function getCachedReply(message) {
  const key = normalizeQuestion(message);
  if (!key) return null;
  const entry = replyCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.savedAt > CACHE_TTL_MS) {
    replyCache.delete(key);
    return null;
  }
  return entry.reply;
}

function setCachedReply(message, reply) {
  const key = normalizeQuestion(message);
  if (!key || !reply) return;
  // Evict oldest entries if we hit the cap.
  if (replyCache.size >= CACHE_MAX_ENTRIES) {
    const firstKey = replyCache.keys().next().value;
    if (firstKey) replyCache.delete(firstKey);
  }
  replyCache.set(key, { reply, savedAt: Date.now() });
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
    return { allowed: true, remaining: RATE_LIMIT_PER_DAY - 1 };
  }
  if (record.count >= RATE_LIMIT_PER_DAY) {
    return { allowed: false, remaining: 0, retryMs: RATE_LIMIT_WINDOW_MS - (now - record.windowStart) };
  }
  record.count += 1;
  return { allowed: true, remaining: RATE_LIMIT_PER_DAY - record.count };
}

async function fetchWithTimeout(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'chat service not configured' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }

  const { message, history = [], location = null } = body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: 'message too long' });
  }

  // Map the user's lat/lng to the closest Nashville neighborhood. Lets Claude
  // answer "near me" questions without re-asking. Coords come from the
  // browser's Geolocation API so accuracy varies.
  const userNeighborhood = location && location.lat && location.lng
    ? nashvilleNeighborhood(location.lat, location.lng)
    : null;

  // Cache hit: serve without spending tokens or counting against rate limit.
  // Only cache when there is no conversation history AND no location context
  // (location-aware answers should never be cached across users).
  if ((!history || history.length === 0) && !userNeighborhood) {
    const cached = getCachedReply(message);
    if (cached) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json({ reply: cached, stopReason: 'cached' });
    }
  }

  const ip = getClientIp(req);
  const rateCheck = checkRateLimit(ip);
  if (!rateCheck.allowed) {
    res.setHeader('Retry-After', Math.ceil(rateCheck.retryMs / 1000));
    return res.status(429).json({ error: 'You have hit the daily chat limit. Try the menu buttons or come back tomorrow.' });
  }

  // Daily dollar budget check. Stored in Redis as cents to keep ints clean.
  const spentCents = await getTodaySpend();
  const budgetCents = Math.round(DAILY_BUDGET_USD * 100);
  if (spentCents >= budgetCents) {
    return res.status(429).json({ error: 'The chat is taking a quick break. Try again tomorrow or use the menu buttons for now.' });
  }

  const messages = [];
  for (const turn of history.slice(-6)) {
    if (turn.role && turn.content) {
      messages.push({ role: turn.role, content: String(turn.content).slice(0, 800) });
    }
  }
  messages.push({ role: 'user', content: message.slice(0, 2000) });

  // Build a location-aware system prompt addendum. If the user shared their
  // location, tell Claude where they are so "near me" works without re-asking.
  let systemPrompt = SYSTEM_PROMPT;
  if (userNeighborhood) {
    if (userNeighborhood.name === 'outside Nashville') {
      systemPrompt += `\n\nUSER LOCATION
The user shared their location and they appear to be outside Nashville (about ${userNeighborhood.distanceMiles.toFixed(1)} miles from the city). When they ask about "near me", confirm whether they want recommendations near downtown Nashville, or near where they will be staying, before assuming.`;
    } else {
      systemPrompt += `\n\nUSER LOCATION
The user shared their location and is currently in ${userNeighborhood.name}. When they ask about "near me", "close by", "around here", or anything spatial, recommend spots in or adjacent to ${userNeighborhood.name}. Do not ask where they are. Mention the neighborhood naturally in your reply.`;
    }
  }

  try {
    const r = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 350,
        system: systemPrompt,
        messages
      })
    }, 15000);

    if (!r.ok) {
      const errText = await r.text();
      console.error('claude api error', r.status, errText);
      return res.status(r.status).json({ error: 'chat service error' });
    }

    const data = await r.json();
    const reply = data.content?.[0]?.text || '';

    // Cache only fresh, no-history, no-location questions. Location-aware
    // answers vary per user and should not be served from a shared cache.
    if (reply && (!history || history.length === 0) && !userNeighborhood) {
      setCachedReply(message, reply);
    }

    // Tally the real cost of this call from Anthropic's usage block.
    const inTok = Number(data.usage?.input_tokens || 0);
    const outTok = Number(data.usage?.output_tokens || 0);
    const callCostUsd = (inTok / 1_000_000) * HAIKU_INPUT_COST_PER_MTOK
                      + (outTok / 1_000_000) * HAIKU_OUTPUT_COST_PER_MTOK;
    const callCostCents = Math.max(1, Math.round(callCostUsd * 10000) / 100); // store with 0.01 cent precision rounded to whole cent
    const newTotalCents = await addTodaySpend(Math.round(callCostUsd * 100));
    const newTotalUsd = newTotalCents / 100;
    const alertCents = Math.round(DAILY_BUDGET_USD * 100 * ALERT_THRESHOLD_PCT);
    if (newTotalCents >= alertCents) {
      const fire = await shouldSendAlert(alertCents);
      if (fire) await sendBudgetAlert(newTotalUsd, DAILY_BUDGET_USD);
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('X-RateLimit-Remaining', String(rateCheck.remaining));
    res.status(200).json({
      reply,
      stopReason: data.stop_reason
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      console.error('claude api timeout');
      return res.status(504).json({ error: 'chat service timed out' });
    }
    console.error('chat handler error', e.message);
    res.status(500).json({ error: 'chat service error' });
  }
}
