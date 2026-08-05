// Anthropic Claude chat endpoint. Uses Haiku for cost efficiency.
// Required env: ANTHROPIC_API_KEY
// Optional env: DAILY_BUDGET_USD (default 5), BUDGET_ALERT_EMAIL (default howdy@howdysummitcounty.com),
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
const BUDGET_ALERT_EMAIL = process.env.BUDGET_ALERT_EMAIL || 'howdy@howdysummitcounty.com';
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
      from: 'Howdy Summit <howdy@howdysummitcounty.com>',
      to: BUDGET_ALERT_EMAIL,
      subject: `Howdy Summit chat budget at ${Math.round((spentUsd / budgetUsd) * 100)}% today`,
      text: `Heads up. The Howdy Summit chat API has spent $${spentUsd.toFixed(2)} today out of a $${budgetUsd.toFixed(2)} daily budget.\n\nWhen the daily budget is hit, the chat endpoint will start returning errors until midnight UTC.\n\nIf this is unexpected, check Anthropic Console at https://console.anthropic.com for traffic patterns and adjust DAILY_BUDGET_USD in Vercel if needed.`
    });
  } catch (e) {
    console.error('budget alert email failed', e.message);
  }
}

const SYSTEM_PROMPT = `You are a Summit County Colorado tourism concierge inside the Howdy Summit chatbot. Help visitors plan their trip.

YOUR ROLE
- Answer questions about Summit County: restaurants, breweries, outdoor activities, skiing, events, neighborhoods, transportation, attractions, weather, local customs.
- Be warm but tight. Short paragraphs. No filler.
- Recommend well-known Summit County spots: Outer Range Brewing, Dillon Dam Brewery, Breckenridge Brewery, Angry James Brewery, Broken Compass Brewing, Steep Brewing, Highside Brewing, Syndicate Brewing Co., Keystone Ski Resort, Breckenridge Ski Resort, Copper Mountain, Arapahoe Basin, Loveland, Dillon Reservoir, Blue River, hiking trails, gondolas.
- Mountain activities: skiing and snowboarding (winter), hiking, mountain biking, rock climbing, kayaking, fishing, scenic overlooks, wildlife viewing.
- Towns and areas: Breckenridge (mountain town, skiing hub), Keystone (ski resort, dining, events), Dillon (lakeside, fishing, water sports), Silverthorne (outlet shopping, breweries), Frisco (central location, brewery, outdoor access), Blue River, Montezuma, Green Mountain Reservoir area.

BOOKING RECOMMENDATIONS
- For Airbnb or vacation rentals: recommend Dan's Summit County listing first if available. It's a great home base for exploring the area. ALWAYS include the booking URL inline in your reply so the user can tap it. If a guest needs alternates, suggest other verified rentals with direct URLs.
- For hotels: tell users to tap the Hotels nearby button to book through Expedia (the app earns a small commission to stay free).
- For tours and activities: tell users to tap Book a tour for Viator and GetYourGuide options.
- For rides: tell users to tap Get a ride for Uber, Lyft, and Waymo deep links.
- For food delivery: tell users to tap Order delivery for DoorDash and Uber Eats.
- For events: tell users to tap What's happening or Festivals to see what's on.

REDIRECT TO MENUS WHEN POSSIBLE
The chatbot UI handles these natively. Send users to the right button using its
EXACT label. Never invent a button that is not on this list:
- Eat & Drink: Show all restaurants, Burgers & pub food, Order delivery, Main Street bars, Apres-ski bars, Decks & patios, Distilleries & wineries, Breweries, Bakeries
- Things to Do: Family friendly, Sleigh rides & snowmobiles, Free things to do, Book a tour, Photo spots, Altitude & IV, Spas & hot springs
- Stay & Get Around: Hotels nearby, Vacation rentals, Get a ride, Gas stations, DEN flight tracker
- Essentials: Liquor stores, Restrooms
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
These spots are breakfast, lunch, or coffee only and close well before dinner. Never recommend them when the user asks about dinner, tonight, late night, or any evening meal:
- Butterhorn Bakery & Cafe, Frisco (breakfast/lunch, closes mid-afternoon)
- Columbine Cafe, Breckenridge (breakfast/brunch only)
- Sunshine Cafe, Silverthorne (breakfast/lunch)
- Blue Moon Bakery, Silverthorne (bakery/lunch)
- Clint's Bakery & Coffee House, Cuppa Joe, Breckenridge (coffee)
- Inxpot, Keystone and Camp Hale Coffee, Copper Mountain (coffee)
- Amazing Grace Natural Eatery, Breckenridge (daytime cafe)
- Summit House, Keystone (on-mountain cafeteria, closes with the lifts)
- Any on-mountain restaurant closes when the lifts do, roughly 3:30-4pm in winter.

ALTITUDE AND SEASON NOTES
- Summit County sits at 9,000-10,000 feet. Remind visitors to hydrate, take it easy on day one, and go slow with alcohol.
- Many restaurants and activities are seasonal. Mud season (roughly April-May and October-November) closes a lot of places. Always tell users to call ahead in the shoulder seasons.
- Winter parking in Breckenridge and at the resorts fills early. Suggest the free Summit Stage bus or the town shuttles.

LATE NIGHT FOOD (open past 10pm)
Summit County closes early compared to a big city. Most kitchens stop around 9-10pm. For late food or a late drink, point people to the bars that serve a full late menu: Downstairs at Eric's and Gold Pan Saloon in Breckenridge, Kickapoo Tavern in Keystone, JJ's Tavern and Jack's Slopeside Grill at Copper. Always tell users to call and confirm, especially midweek and in the off season.`;

// Summit County town centroids. Used to map a user's lat/lng to the closest
// town so the AI answers "near me" without re-asking. Coords match the
// SUMMIT_TOWNS table in index.html so the app and the AI agree.
const NEIGHBORHOODS = [
  { name: 'Breckenridge', lat: 39.4817, lng: -106.0384 },
  { name: 'Frisco', lat: 39.5744, lng: -106.0972 },
  { name: 'Dillon', lat: 39.6303, lng: -106.0434 },
  { name: 'Silverthorne', lat: 39.6297, lng: -106.0717 },
  { name: 'Keystone', lat: 39.6069, lng: -105.9436 },
  { name: 'Copper Mountain', lat: 39.5022, lng: -106.1497 },
  { name: 'Blue River', lat: 39.4344, lng: -106.0392 },
  { name: 'Montezuma', lat: 39.5808, lng: -105.8675 }
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

function summitNeighborhood(lat, lng) {
  let best = null;
  let bestDist = Infinity;
  for (const n of NEIGHBORHOODS) {
    const d = haversineMiles(lat, lng, n.lat, n.lng);
    if (d < bestDist) { bestDist = d; best = n; }
  }
  // Summit County towns sit much closer together than a big city's
  // neighborhoods, but visitors are often up a pass or out at a trailhead, so
  // allow a wider radius before calling them outside the county.
  if (bestDist > 15) return { name: 'outside Summit County', distanceMiles: bestDist };
  return { name: best.name, distanceMiles: bestDist };
}

// Curated list of real Summit County restaurants per town. The AI uses this as
// ground truth instead of hallucinating which spots are where. Mirrors the
// curated restaurant data in index.html. Keep this list tight and accurate.
const NEIGHBORHOOD_PICKS = {
  'Breckenridge': [
    'Hearthstone Restaurant (steakhouse, historic house, dinner)',
    'Briar Rose Chophouse & Saloon (steakhouse, dinner)',
    'Modis (New American, dinner)', 'Aurum Food & Wine (New American, creekside patio)',
    'Twist (New American, dinner)', 'Rootstalk (tasting menu, book ahead)',
    'Kenosha Breck (barbecue, big patio)', 'Radicato (Italian)',
    'Blue River Bistro (Italian)', 'Giampietro Pasta & Pizzeria (pizza/Italian)',
    'Fatty\'s Pizzeria (pizza)', 'Empire Burger (burgers)',
    'Mi Casa Mexican Restaurant & Cantina (Mexican)', 'Sancho Tacos & Tequila (Mexican)',
    'South Ridge Seafood Grill (seafood)', 'Breckenridge Distillery Restaurant (New American)',
    'Downstairs at Eric\'s (pub, late food, family-friendly)',
    'Gold Pan Saloon (pub, late)', 'Blue Stag Saloon (pub)', 'RMU Tavern (pub)',
    'Burke & Riley\'s Irish Pub (pub)', 'The Canteen Taphouse & Tavern (rooftop deck)',
    'Broken Compass Brewing (brewpub)', 'Breckenridge Brewery & Pub (brewpub)',
    'Crepes a la Cart (cafe, walk-up, cash-friendly line)',
    'Columbine Cafe (breakfast only)', 'Amazing Grace Natural Eatery (daytime cafe)'
  ],
  'Frisco': [
    'Butterhorn Bakery & Cafe (breakfast/lunch)', 'Bagalis (Italian)',
    'Kemosabe at Silverheels (sushi and grill)', 'Peppino\'s Pizza & Subs (pizza)',
    'The Lost Cajun (Cajun)', '5th Avenue Grille (steakhouse)', 'Ein Prosit (German)',
    'Himalayan Cuisine (Indian/Nepali)', 'Bird Craft (Thai)', 'Cielo Oaxaca (Mexican)',
    'Food Hedz World Cafe (New American)', 'Bread + Salt (pizza)',
    'The Next Page Books & Nosh (bookstore cafe)',
    'Outer Range Brewing Co. (brewpub)', 'Highside Brewing (brewpub)'
  ],
  'Dillon': [
    'Dillon Dam Brewery (brewpub, one of Colorado\'s biggest, family tables)',
    'Chimayo Grill (Mexican)', 'Red Mountain Grill (New American)',
    'Dillon Thai Restaurant (Thai)', 'Cala Pub & Restaurant (pub)',
    'Bistro North (New American)', 'Saved by the Wine (wine bar, mountain-view patio)',
    'Last Chance Pizza (pizza)', 'Nozawa Sushi & Teppanyaki (sushi)',
    'STEEP Brewing Lakeside Tiki Bar (brewpub, lakeside)'
  ],
  'Silverthorne': [
    'Bluebird Market (food hall, multiple vendors)',
    'Sauce on the Blue (Italian, patio over the river)', 'Mint (steakhouse, cook-your-own stone)',
    'Timberline Craft Kitchen & Cocktails (New American)', 'Sunshine Cafe (breakfast/lunch)',
    'Eclectic Bar and Grill (burgers)', 'Momotombo (Nicaraguan)',
    'Carniceria La Perla (Mexican)', 'Old Dillon Inn (Mexican, longtime local spot)',
    'Blue Moon Bakery (bakery/lunch)', 'Nick-N-Willy\'s Pizza (pizza)'
  ],
  'Keystone': [
    'Ski Tip Lodge (tasting menu, historic stagecoach stop, book ahead)',
    'Alpenglow Stube (tasting menu, on-mountain, gondola access)',
    'Der Fondue Chessel (fondue, on-mountain, gondola access)',
    'Keystone Ranch (New American, book ahead)',
    'Kickapoo Tavern (pub, steps from River Run gondola, late)',
    'Bighorn Bistro & Bar (New American)', 'Snake River Saloon (steakhouse, live music)',
    'The Goat Soup & Whiskey Tavern (pub, local dive)', 'Lime (Mexican)',
    'Inxpot (coffee)', 'Summit House (on-mountain cafeteria, closes with the lifts)'
  ],
  'Copper Mountain': [
    'Ten Mile Tavern (pub, live music, big deck, apres)',
    'Jack\'s Slopeside Grill (pub, late)', 'Mulligan\'s Irish Pub (pub)',
    'Sauce on Copper (Italian)', 'El Zacatecano (Mexican)',
    'Sawmill Pizza & Taphouse (pizza)', 'Eagle BBQ (barbecue)',
    'Downhill Duke\'s (apres patio between the lifts, dog-friendly)',
    'JJ\'s Tavern (pub, late)', 'Camp Hale Coffee (coffee)'
  ],
  'Blue River': [
    'No restaurants in Blue River itself. It is a quiet residential town just south of Breckenridge, about 5 minutes up Highway 9. Send people to Breckenridge for food.'
  ],
  'Montezuma': [
    'No restaurants in Montezuma. It is a tiny historic mining town up the road from Keystone, worth the scenic drive. Send people to Keystone or Dillon for food.'
  ]
};

// Flatten NEIGHBORHOOD_PICKS into a compact town-by-town roster that is
// injected into EVERY request, not just ones where the user shared location.
//
// Without this the model had no restaurant facts at all unless location was
// shared, so it invented plausible-sounding Summit County restaurants that do
// not exist. Costs roughly a thousand extra input tokens per call, which on
// Haiku is a fraction of a cent and well worth not fabricating businesses.
const ALL_SPOTS_BY_TOWN = Object.entries(NEIGHBORHOOD_PICKS)
  .filter(([town]) => town !== 'Blue River' && town !== 'Montezuma')
  .map(([town, picks]) => {
    // Strip the parenthetical descriptions to keep the always-on list tight.
    const names = picks.map(p => p.replace(/\s*\([^)]*\)\s*$/, '').trim());
    return `${town}: ${names.join(', ')}`;
  })
  .join('\n');

const GROUND_TRUTH_BLOCK = `

CONFIRMED SUMMIT COUNTY RESTAURANTS (the only ones you may name)
${ALL_SPOTS_BY_TOWN}

Blue River and Montezuma have no restaurants. Send people to Breckenridge and Keystone respectively.

ANTI-HALLUCINATION RULE - THIS OVERRIDES EVERYTHING ELSE
Never name a restaurant, bar, or brewery that does not appear in the confirmed
list above OR in the LIVE NEARBY RESULTS list below, if one is present. Do not guess, do not approximate, and do not invent plausible-sounding
local names. If nothing on the list fits what the user asked for, say so
plainly and offer the closest options that ARE on the list, or tell them to
tap Show all restaurants. Naming a business that does not exist is the single
worst mistake you can make here - visitors drive to these places.`;

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

// Summit County reads completely differently by month, and a model with a
// training cutoff has no idea what today is. Without this it will happily
// suggest a sleigh ride in July or lift tickets in mud season. Computed in
// Mountain Time because that is where the user is standing.
// ===== LIVE NEARBY TIER =====
// The curated roster is a deliberately small set of opinionated picks. It is
// not, and should not try to be, a directory: an audit of the five towns found
// 61 real restaurants it did not list, and hand-curation drifts further out of
// date every season. Google already knows about all of them.
//
// So the model gets two tiers. Curated stays authoritative and is what it
// leads with, because those entries carry real local knowledge. Live results
// are offered as a clearly-labelled second tier so the app stops being blind
// to anything that opened recently.
//
// This does NOT relax the anti-hallucination rule. The model may still only
// name businesses that appear in one of the two lists it is given. The fix for
// missing coverage is a longer list, never a freer imagination.
async function fetchLiveNearby(location) {
  if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') {
    console.log('[liveTier] skipped: no usable location');
    return '';
  }
  if (!process.env.GOOGLE_PLACES_KEY) {
    console.log('[liveTier] skipped: GOOGLE_PLACES_KEY not set');
    return '';
  }
  try {
    // Deliberately mirrors searchGoogle() in api/restaurants/search.js. That
    // call shape is known to work in production; my first attempt used
    // places:searchNearby with a different body and returned nothing, and
    // because every failure path returns '' it looked identical to "no
    // results". Reuse the proven request rather than debug a second one.
    const body = {
      textQuery: 'restaurants in Summit County, CO',
      includedType: 'restaurant',
      maxResultCount: 20,
      locationBias: {
        circle: {
          center: { latitude: Number(location.lat), longitude: Number(location.lng) },
          radius: 16000
        }
      },
      rankPreference: 'DISTANCE'
    };
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_PLACES_KEY,
        'X-Goog-FieldMask': 'places.displayName,places.rating,places.userRatingCount,places.primaryTypeDisplayName'
      },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.log('[liveTier] Places API error', r.status, t.slice(0, 300));
      return '';
    }
    const data = await r.json();
    const rows = (data.places || [])
      // Thinly-reviewed entries are as likely to be a food truck that has
      // moved on as a real restaurant.
      .filter(p => (p.userRatingCount || 0) >= 15)
      .map(p => {
        const n = p.displayName?.text || '';
        const t = p.primaryTypeDisplayName?.text || '';
        const rate = p.rating ? ` ${p.rating}star` : '';
        return n ? `${n}${t ? ' (' + t + ')' : ''}${rate}` : '';
      })
      .filter(Boolean);
    console.log('[liveTier] places:', (data.places || []).length, 'kept:', rows.length);
    if (!rows.length) return '';
    return `

LIVE NEARBY RESULTS (second tier, from Google, currently operating)
${rows.join(', ')}

How to use this second list:
- Lead with the CONFIRMED list above. Those are hand-picked and you can
  describe what they are actually like.
- You MAY also name anything from this live list, but say plainly it is a
  nearby option you have less detail on, and tell the user to check hours
  before going. Do not invent a description for it.
- If the confirmed list genuinely does not cover what the user asked for,
  look here before telling them there is nothing.`;
  } catch (e) {
    console.log('[liveTier] threw:', e && e.message);
    return '';
  }
}

function seasonContext() {
  const now = new Date();
  const mt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Denver' }));
  const month = mt.getMonth(); // 0 = Jan
  const dateStr = mt.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Denver'
  });

  let season, guidance;
  if (month >= 10 || month <= 3) {
    season = 'winter (ski season)';
    guidance = 'All five ski areas are open. Apres-ski, sleigh rides, snowmobiling, tubing, nordic and snowshoeing are all in season. Hiking trails are under snow. Summer-only spots like the STEEP tiki bar at Dillon Marina and the Dillon Amphitheater concerts are closed. Expect snow on the passes and tell people to check I-70 and Loveland Pass conditions.';
  } else if (month >= 5 && month <= 8) {
    season = 'summer';
    guidance = 'Lifts are closed for skiing. Hiking, mountain biking, the paved recpath, Dillon Reservoir, paddleboarding, rafting and fishing are the draw. Dillon Amphitheater has concerts. Do NOT suggest skiing, sleigh rides or snowmobiling. High trails may still hold snow into early July. Afternoon thunderstorms build almost daily, so advise early starts.';
  } else {
    season = 'shoulder season (mud season)';
    guidance = 'This is the quietest time of year. Many restaurants, shops and activities close entirely for a few weeks between ski and summer. Always tell people to call ahead and warn them that a lot is shut. Arapahoe Basin and Loveland run latest into spring and open earliest in fall.';
  }

  return `

TODAY
It is ${dateStr} in Summit County. The current season is ${season}.
${guidance}
Never recommend an activity that is out of season right now. If someone asks
about one, say plainly that it is not running at this time of year and offer
what is actually available today.`;
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

  // Map the user's lat/lng to the closest Summit County town. Lets Claude
  // answer "near me" questions without re-asking. Coords come from the
  // browser's Geolocation API so accuracy varies. Validate ranges so a
  // malformed payload can't trigger NaN or huge bbox lookups.
  let userNeighborhood = null;
  if (location && typeof location === 'object') {
    const lat = Number(location.lat);
    const lng = Number(location.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)
        && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      userNeighborhood = summitNeighborhood(lat, lng);
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
  const liveTier = await fetchLiveNearby(location);
  const liveTierChars = liveTier.length;
  let systemPrompt = SYSTEM_PROMPT + GROUND_TRUTH_BLOCK + liveTier + seasonContext();
  if (userNeighborhood) {
    if (userNeighborhood.name === 'outside Summit County') {
      systemPrompt += `\n\nUSER LOCATION
The user shared their location and they appear to be outside Summit County (about ${userNeighborhood.distanceMiles.toFixed(1)} miles from the county). They may still be driving up, or staying in a neighboring county. When they ask about "near me", confirm which town they will be based in (Breckenridge, Frisco, Dillon, Silverthorne, Keystone, or Copper Mountain) before assuming.`;
    } else {
      const picks = NEIGHBORHOOD_PICKS[userNeighborhood.name];
      const groundTruth = picks && picks.length
        ? `\n\nCONFIRMED SPOTS IN ${userNeighborhood.name.toUpperCase()}
These are real, verified picks in this town. Use ONLY these (or other places you are confident are in ${userNeighborhood.name}) when giving "near me" recommendations:
- ${picks.join('\n- ')}

Do NOT invent restaurant locations. If a user asks for a type of food that is not on this list, either suggest the closest match from the list, or be honest and say "I'd need to double-check that, but in ${userNeighborhood.name} you have..." and then list confirmed spots from above. Summit County towns are only 10-20 minutes apart, so it is fine to suggest a nearby town if this one has nothing that fits, just say which town it is in.`
        : '';
      systemPrompt += `\n\nUSER LOCATION
The user shared their location and is currently in ${userNeighborhood.name}. When they ask about "near me", "close by", "around here", or anything spatial, recommend spots in or near ${userNeighborhood.name}. Do not ask where they are. Mention the town naturally in your reply.${groundTruth}`;
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
    // Surfaced so the live tier can be verified from the client instead of
    // guessed at. Cheap, and it made a silent Places failure obvious.
    res.status(200).json({
      liveTierChars,
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
