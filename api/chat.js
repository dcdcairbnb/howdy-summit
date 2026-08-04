// Anthropic Claude chat endpoint. Uses Haiku for cost efficiency.
// Required env: ANTHROPIC_API_KEY
// Optional env: DAILY_BUDGET_USD (default 5), BUDGET_ALERT_EMAIL (default howdy@howdynash.com),
//               KV_REST_API_URL + KV_REST_API_TOKEN (Upstash Redis), RESEND_API_KEY

import { Redis } from '@upstash/redis';
import { Resend } from 'resend';

// Per-million-token pricing for both models. Sonnet costs 3x as much as
// Haiku, so the budget guard treats them differently.
const MODELS = {
  haiku: {
    id: 'claude-haiku-4-5-20251001',
    inputCostPerMtok: 1.0,
    outputCostPerMtok: 5.0,
    maxTokens: 350
  },
  sonnet: {
    id: 'claude-sonnet-4-6',
    inputCostPerMtok: 3.0,
    outputCostPerMtok: 15.0,
    maxTokens: 600
  }
};

// Patterns that should auto-promote to Sonnet for better reasoning, even if
// the user hasn't toggled smart mode. Itinerary planning and multi-step
// requests benefit most from the upgrade.
const SMART_MODE_PATTERNS = [
  /plan (me )?(a |my |an? )?(weekend|day|night|trip|itinerary|3.day|3 day|two.day|2.day|four.day|4.day|five.day|5.day|week)/i,
  /build (me )?(a |an? )?(itinerary|plan|schedule|guide)/i,
  /\b(\d+)[- ]day (trip|itinerary|plan|guide)/i,
  /compare\s.+\s(vs|versus|against)\s/i,
  /best (way|order|route) to (do|see|visit|hit|plan)/i,
  /(detailed|step.by.step|full|comprehensive) (plan|guide|itinerary|breakdown)/i
];

function detectSmartMode(message) {
  if (!message) return false;
  return SMART_MODE_PATTERNS.some(re => re.test(message));
}

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

const SYSTEM_PROMPT = `You are a Summit County Colorado tourism concierge inside the Howdy Summit chatbot. Help visitors plan their trip.

YOUR ROLE
- Answer questions about Summit County: restaurants, breweries, outdoor activities, skiing, events, neighborhoods, transportation, attractions, weather, local customs.
- Be warm but tight. Short paragraphs. No filler.
- Recommend well-known Summit County spots: Outer Range Brewing, Dillon Dam Brewery, Breckenridge Brewery, Angry James Brewery, Broken Compass Brewing, Steep Brewing, Highside Brewing, Syndicate Brewing Co., keystone Ski Resort, Breckenridge Ski Resort, Loveland, Copper Mountain, Dillon Reservoir, Blue River, hiking trails, gondolas.
- Mountain activities: skiing and snowboarding (winter), hiking, mountain biking, rock climbing, kayaking, fishing, scenic overlooks, wildlife viewing.
- Towns and areas: Breckenridge (mountain town, skiing hub), Keystone (ski resort, dining, events), Dillon (lakeside, fishing, water sports), Silverthorne (outlet shopping, breweries), Frisco (central location, brewery, outdoor access), Blue River, Montezuma, Green Mountain Reservoir area.

BOOKING RECOMMENDATIONS
- For Airbnb or vacation rentals: recommend Dan's Summit County listing first if available. It's a great home base for exploring the area. ALWAYS include the booking URL inline in your reply so the user can tap it. If a guest needs alternates, suggest other verified rentals with direct URLs.
- For hotels: tell users to tap the Hotels nearby button to book through Expedia (the app earns a small commission to stay free).
- For tours and activities: tell users to tap Book a tour for Viator and GetYourGuide options.
- For rides: tell users to tap Get a ride for Uber, Lyft, and Waymo deep links.
- For food delivery: tell users to tap Order delivery for DoorDash and Uber Eats.
- For events: tell users to tap Live music tonight or Festivals to see what's happening.

REDIRECT TO MENUS WHEN POSSIBLE
The chatbot UI handles these natively, send users to the right button:
- Eat & Drink: Show all restaurants, Best breweries, Order delivery, Mountain dining, Rooftop bars, Cocktail bars
- Things to Do: Skiing and snowboarding, Hiking trails, Mountain biking, Fishing, Scenic drives, Book a tour, Photo spots, Water sports, Shopping, Spas
- Stay & Get Around: Hotels nearby, Vacation rentals, Luggage storage, Get a ride, Gas stations, Sky Valley Airport info
- Essentials: Liquor stores, Groceries, Pharmacy, ATMs
- Main menu also has: Weather, Sports, My saved, Local tips

TONE
- Conversational, like a Summit County local friend.
- No emojis unless the user uses them first.
- No filler words.

FORMAT RULES
- Under 80 words unless the user asks for more detail.
- Plain text only. No markdown. No bold asterisks. No italic asterisks. No # headers. No - or * bullets.
- Lists go inline: "Try Outer Range Brewing, Dillon Dam, and Breckenridge Brewery" not bullet points.
- Phone numbers and addresses are fine when known.
- Never invent prices, hours, or reservation availability. Say "call to confirm" or "check their website."

HOURS GUIDANCE - DO NOT RECOMMEND THESE FOR DINNER
These spots close before 7pm. Never recommend them when the user asks about dinner, tonight, late night, or any evening meal:
- Nashville Farmers' Market food hall (closes 6pm daily)
- Pancake Pantry (breakfast/brunch only, closes 4pm)
- Biscuit Love (breakfast/brunch only, closes 3pm)
- Loveless Cafe (closes 9pm but skews early diners)
- Steadfast Coffee, Honest Coffee, Falcon Coffee Bar, Bongo Java (coffee shops, close by 5-6pm)
- Frothy Monkey Germantown locations (coffee, close 6pm weekdays)
- Sky Blue Cafe (breakfast/brunch only)
- Las Paletas (popsicle shop, closes 6pm)
- Five Daughters Bakery (closes 6pm)

LATE NIGHT FOOD (open past 10pm)
For late dinner or post-bar food, recommend: Pearl Diver (Germantown), Robert's Western World (downtown, fried bologna), Tootsie's (downtown bar food), Hattie B's (varies, check), 5 Spot late nights, McDonald's, Waffle House (24/7).`;

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

// Curated list of real Nashville restaurants per neighborhood. The AI uses
// this as ground truth instead of hallucinating which spots are where.
// Each entry: name, optional cuisine. Keep this list tight and accurate.
const NEIGHBORHOOD_PICKS = {
  'Downtown / Broadway': [
    'Husk (Southern, in SoBro just south)',
    'Pinewood Social (modern American, in SoBro)',
    'Bourbon Steak (steakhouse, JW Marriott)',
    'The Listening Room Cafe (live music dinner, SoBro)',
    'Hattie B\'s (hot chicken, walk to SoBro)',
    'Eric Church\'s Chief\'s (Southern, Lower Broadway)',
    'Acme Feed & Seed (rooftop, Lower Broadway)'
  ],
  'SoBro': [
    'Husk', 'Pinewood Social', 'Hattie B\'s SoBro', 'The Listening Room Cafe',
    'Mastro\'s Steakhouse', 'Adele\'s', 'The Diner'
  ],
  'The Gulch': [
    'Biscuit Love', 'Otaku Ramen', 'Saint Anejo', 'Bakersfield', 'Peg Leg Porker (BBQ)',
    'Kayne Prime (steakhouse)', 'Hal\'s Steakhouse', 'L.A. Jackson rooftop',
    'The Band Box', 'Yolan (Italian)'
  ],
  'Midtown': [
    'Pancake Pantry', 'The Catbird Seat (fine dining)', 'Hattie B\'s Midtown (original)',
    'Kayne Prime', 'Ruth\'s Chris', 'The Capital Grille', 'Fleming\'s', 'Patterson House (cocktails)',
    'White Limozeen rooftop', 'Bastion'
  ],
  'Germantown': [
    'Rolf and Daughters (Italian, dinner)', 'City House (wood-fired Italian, dinner)',
    'Henrietta Red (seafood, dinner)', 'Butcher and Bee (Mediterranean, lunch+dinner)',
    '5th & Taylor (modern American, dinner)', 'The Optimist (seafood, dinner)',
    'Geist (modern American, dinner)', 'Pearl Diver (cocktails+late night food)',
    'Von Elrod\'s Beer Hall (German, lunch+dinner)', 'Otaku Ramen Germantown (lunch+dinner)',
    'Monell\'s (Southern family-style, lunch+dinner, closes ~8pm)',
    'Hampton Social (Coastal American, lunch+dinner)',
    'Steadfast Coffee (coffee, closes 5pm)', 'Honest Coffee (coffee, closes 5pm)',
    'Nashville Farmers\' Market food hall (lunch only, closes 6pm)'
  ],
  'East Nashville': [
    'Mas Tacos Por Favor', 'Margot Cafe', 'Folk (pizza)', 'Five Points Pizza',
    'Lockeland Table', 'Two Ten Jack (ramen/izakaya)', 'Rosepepper Cantina',
    'The 5 Spot (live music)', 'Prince\'s Hot Chicken (original location)',
    'Nicoletto\'s Italian'
  ],
  '12 South': [
    'Burger Up', 'Locust (tasting menu)', 'Le Sel (French)', 'Las Paletas',
    'Edley\'s BBQ', 'Bartaco', 'Five Daughters Bakery', 'I Believe In Nashville mural'
  ],
  'Wedgewood-Houston': [
    'Bastion', 'Detroit Cowboy (pizza)', 'Falcon Coffee Bar', 'Tennessee Brew Works',
    'Jackalope Brewing', '3rd & Lindsley (live music)', 'Diskin Cider'
  ],
  'Berry Hill': [
    'Sky Blue Cafe (breakfast)', 'Edley\'s BBQ (Berry Hill)', 'Patsy Cline mural'
  ],
  'The Nations': [
    'The Picnic Tap', 'Local Distro', 'Sinema', 'Centennial', 'Riverside Grillshack'
  ],
  'Sylvan Park': [
    'Mas Tacos (sister location)', 'Park Cafe', 'Local Taco', 'Sylvan Park Restaurant'
  ],
  'Hillsboro Village': [
    'Pancake Pantry', 'Jinya Ramen Bar', 'Fido (coffee)', 'Sunflower Cafe', 'Cabana'
  ],
  'Music Row': [
    'White Limozeen rooftop', 'Conrad Nashville hotel bar'
  ],
  'Belle Meade': [
    'Sperry\'s Restaurant (steakhouse)', 'Belle Meade Plantation', 'Cheekwood Estate (gardens)'
  ],
  'Green Hills': [
    'Bluebird Cafe (songwriter rounds, book early)', 'Edley\'s BBQ (Green Hills location)',
    'The Mall at Green Hills (Apple, luxury shops)', 'Shabu Shabu (hot pot)'
  ]
};

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
    // Reject oversized payloads up front. 50KB is way more than any legitimate
    // chat message + history needs. Stops attackers from tying up the function.
    if (body.length > 50000) {
      return res.status(413).json({ error: 'request body too large' });
    }
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }

  const { message, history = [], location = null, smartMode = false } = body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: 'message too long' });
  }
  // Validate history is an array of well-formed turns. Untrusted input could
  // try to inject extra system messages or oversized strings.
  if (!Array.isArray(history) || history.length > 20) {
    return res.status(400).json({ error: 'invalid history' });
  }
  for (const turn of history) {
    if (!turn || typeof turn !== 'object' || typeof turn.role !== 'string' || typeof turn.content !== 'string') {
      return res.status(400).json({ error: 'invalid history turn' });
    }
    if (turn.content.length > 5000) {
      return res.status(400).json({ error: 'history turn too long' });
    }
    if (turn.role !== 'user' && turn.role !== 'assistant') {
      return res.status(400).json({ error: 'invalid history role' });
    }
  }

  // Decide which model to use. Explicit smartMode flag wins; otherwise auto-
  // detect trip-planning patterns that benefit from Sonnet's longer reasoning.
  const useSonnet = smartMode === true || detectSmartMode(message);
  const model = useSonnet ? MODELS.sonnet : MODELS.haiku;

  // Map the user's lat/lng to the closest Nashville neighborhood. Lets Claude
  // answer "near me" questions without re-asking. Coords come from the
  // browser's Geolocation API so accuracy varies. Validate ranges so a
  // malformed payload can't trigger NaN or huge bbox lookups.
  let userNeighborhood = null;
  if (location && typeof location === 'object') {
    const lat = Number(location.lat);
    const lng = Number(location.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)
        && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      userNeighborhood = nashvilleNeighborhood(lat, lng);
    }
  }

  // Cache hit: serve without spending tokens or counting against rate limit.
  // Only cache when there is no conversation history AND no location context
  // AND not in smart mode. Smart mode answers vary in depth and shouldn't
  // be served from a Haiku cache.
  if ((!history || history.length === 0) && !userNeighborhood && !useSonnet) {
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
  // Also inject a curated list of REAL spots in that neighborhood as ground
  // truth so Claude does not invent which restaurants belong where.
  let systemPrompt = SYSTEM_PROMPT;
  if (userNeighborhood) {
    if (userNeighborhood.name === 'outside Nashville') {
      systemPrompt += `\n\nUSER LOCATION
The user shared their location and they appear to be outside Nashville (about ${userNeighborhood.distanceMiles.toFixed(1)} miles from the city). When they ask about "near me", confirm whether they want recommendations near downtown Nashville, or near where they will be staying, before assuming.`;
    } else {
      const picks = NEIGHBORHOOD_PICKS[userNeighborhood.name];
      const groundTruth = picks && picks.length
        ? `\n\nCONFIRMED SPOTS IN ${userNeighborhood.name.toUpperCase()}
These are real, verified picks in this neighborhood. Use ONLY these (or other places you are confident are in ${userNeighborhood.name}) when giving "near me" recommendations:
- ${picks.join('\n- ')}

Do NOT invent restaurant locations. If a user asks for a type of food that is not on this list, either suggest the closest match from the list, or be honest and say "I'd need to double-check that, but in ${userNeighborhood.name} you have..." and then list confirmed spots from above.`
        : '';
      systemPrompt += `\n\nUSER LOCATION
The user shared their location and is currently in ${userNeighborhood.name}. When they ask about "near me", "close by", "around here", or anything spatial, recommend spots in or adjacent to ${userNeighborhood.name}. Do not ask where they are. Mention the neighborhood naturally in your reply.${groundTruth}`;
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
        model: model.id,
        max_tokens: model.maxTokens,
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

    // Cache only fresh, no-history, no-location, no-smart questions.
    // Location-aware and smart-mode answers vary per user / per session.
    if (reply && (!history || history.length === 0) && !userNeighborhood && !useSonnet) {
      setCachedReply(message, reply);
    }

    // Tally the real cost of this call. Sonnet costs 3x Haiku, so the budget
    // guard hits sooner if smart mode is in heavy use.
    const inTok = Number(data.usage?.input_tokens || 0);
    const outTok = Number(data.usage?.output_tokens || 0);
    const callCostUsd = (inTok / 1_000_000) * model.inputCostPerMtok
                      + (outTok / 1_000_000) * model.outputCostPerMtok;
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
    res.setHeader('X-Model', useSonnet ? 'sonnet' : 'haiku');
    res.setHeader('X-RateLimit-Remaining', String(rateCheck.remaining));
    res.status(200).json({
      reply,
      stopReason: data.stop_reason,
      modelUsed: useSonnet ? 'sonnet' : 'haiku'
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
