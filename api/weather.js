// Weather.gov (US National Weather Service). Free, no API key required.
// Returns forecast plus active alerts for the user's location.

const UA = 'HowdySummit/1.0 (contact@howdysummitcounty.com)';

async function fetchAlerts(lat, lng) {
  try {
    const r = await fetch(`https://api.weather.gov/alerts/active?point=${lat},${lng}`, {
      headers: { 'User-Agent': UA, 'Accept': 'application/geo+json' },
      signal: AbortSignal.timeout(6000)
    });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.features || []).map(f => ({
      id: f.id,
      event: f.properties?.event || 'Alert',
      headline: f.properties?.headline || '',
      description: f.properties?.description || '',
      instruction: f.properties?.instruction || '',
      severity: f.properties?.severity || '',
      urgency: f.properties?.urgency || '',
      areaDesc: f.properties?.areaDesc || '',
      effective: f.properties?.effective,
      expires: f.properties?.expires,
      onset: f.properties?.onset,
      ends: f.properties?.ends
    }));
  } catch (e) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// CDOT road conditions
//
// Lives in weather.js rather than api/roads.js on purpose. Vercel's Hobby plan
// caps a project at 12 serverless functions and this project sits at exactly
// 12, so a new file under api/ breaks the deploy outright. Road conditions are
// the closest sibling to weather anyway: both answer "what is it like out
// there right now".
//
// Reached at /api/weather?feed=roads
// ---------------------------------------------------------------------------

// Roads worth surfacing for Summit County. I-70 is the artery: close the
// Eisenhower Tunnel and the county is effectively cut off from Denver. CO-9
// links Frisco to Breckenridge and south to Fairplay. US-6 over Loveland Pass
// matters because it is the detour when the tunnel shuts, and CO-91 over
// Fremont Pass is the route to Leadville.
// Matched against CDOT's `routeName` field ONLY, never the message text.
//
// routeName looks like "I-70W", "US-50E", "CO-9N": route plus an optional
// single-letter direction. Anchoring both ends matters. "CO-9" unanchored also
// matches "CO-91", and matching against the message text is what produced the
// first version's bug: two I-70 closures were labelled CO-9 because their
// traveler messages named "CO 9 (Silverthorne)" as a landmark. The result was
// i70Closed:false while I-70 was actually shut, which is the worst possible
// way for this feature to fail.
const WATCHED_ROUTES = [
  { match: /^I-70[NSEW]?$/i,  label: 'I-70',               primary: true },
  { match: /^CO-9[NSEW]?$/i,  label: 'CO-9',               primary: true },
  { match: /^US-6[NSEW]?$/i,  label: 'US-6 Loveland Pass', primary: true },
  { match: /^CO-91[NSEW]?$/i, label: 'CO-91 Fremont Pass', primary: false }
];

// Only the mountain corridor, not the whole 450 miles of I-70 across Colorado.
// A closure in Kansas-adjacent Burlington is not a Summit County problem.
// Mile markers: Floyd Hill ~247, Glenwood Springs ~116.
const I70_MIN_MILE = 110;
const I70_MAX_MILE = 260;

function pickRoute(text) {
  if (!text) return null;
  for (const r of WATCHED_ROUTES) if (r.match.test(text)) return r;
  return null;
}

// CDOT has shipped several response shapes over the years and the docs sit
// behind a JavaScript wall, so read defensively: try the documented GeoJSON
// FeatureCollection first, then a bare array, then a wrapped list.
function extractFeatures(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.features)) return payload.features;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}

function normalise(feature) {
  const p = feature.properties || feature.attributes || feature || {};

  // routeName only. See the comment on WATCHED_ROUTES for why the message text
  // must not be used to decide which road an incident is on.
  const route = pickRoute(String(p.routeName || '').trim());
  if (!route) return null;

  // CDOT keeps cleared events in the feed. Reporting a crash that was tidied
  // up an hour ago as a live closure would be worse than silence.
  const status = String(p.status || '').toLowerCase();
  if (status.includes('cleared')) return null;

  const message = String(p.travelerInformationMessage || p.description || '').trim();

  const startMile = Number(p.startMarker ?? NaN);
  if (route.label === 'I-70' && Number.isFinite(startMile)) {
    if (startMile < I70_MIN_MILE || startMile > I70_MAX_MILE) return null;
  }

  // "Road closed" in the traveler message is CDOT's own wording for a full
  // closure. Exclude ramp-only closures, which do not strand anyone.
  const blob = `${message} ${p.type || ''} ${p.category || ''}`.toLowerCase();
  const closed = /\broad closed\b|\bfull closure\b|\bclosure\b/.test(blob)
    && !/ramp closed|ramp closure/.test(blob);
  const chains = /chain law|traction law|chains required|code \d/.test(blob);

  return {
    route: route.label,
    routeName: p.routeName || '',
    primary: route.primary,
    severity: closed ? 'closed' : chains ? 'chains' : 'info',
    cdotSeverity: p.severity || '',
    message: message.slice(0, 400),
    direction: p.direction || '',
    startMile: Number.isFinite(startMile) ? startMile : null,
    endMile: Number.isFinite(Number(p.endMarker)) ? Number(p.endMarker) : null,
    type: p.type || '',
    category: p.category || '',
    lastUpdated: p.lastUpdated || null
  };
}

async function fetchCdot(path, key) {
  const url = `https://data.cotrip.org/api/v1/${path}?apiKey=${encodeURIComponent(key)}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`${path} returned ${r.status}`);
  return r.json();
}

async function roadConditions(req, res) {
  const key = process.env.CDOT_API_KEY;
  if (!key) {
    return res.status(503).json({
      ok: false,
      error: 'CDOT_API_KEY not configured',
      hint: 'Register free at https://manage-api.cotrip.org/ and add CDOT_API_KEY in Vercel.'
    });
  }

  const debug = req.query.debug === '1';

  try {
    // Settled promises, not Promise.all: if one feed is down we still want the
    // other. A partial answer beats a blank screen when I-70 is shut.
    const [incidentsR, conditionsR] = await Promise.allSettled([
      fetchCdot('incidents', key),
      fetchCdot('roadConditions', key)
    ]);

    const raw = [];
    const feedErrors = [];
    for (const [name, r] of [['incidents', incidentsR], ['roadConditions', conditionsR]]) {
      if (r.status === 'fulfilled') raw.push(...extractFeatures(r.value));
      else feedErrors.push(`${name}: ${r.reason?.message || 'failed'}`);
    }

    if (!raw.length && feedErrors.length) {
      console.error('[roads] both CDOT feeds failed:', feedErrors.join('; '));
      return res.status(502).json({ ok: false, error: 'CDOT unavailable', feedErrors });
    }

    const items = raw.map(normalise).filter(Boolean);
    const rank = { closed: 0, chains: 1, info: 2 };
    items.sort((a, b) =>
      (rank[a.severity] - rank[b.severity]) || (b.primary - a.primary)
    );

    const closures = items.filter(i => i.severity === 'closed');
    const chainLaws = items.filter(i => i.severity === 'chains');
    const i70Closed = closures.some(i => i.route === 'I-70');

    res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=600');
    return res.status(200).json({
      ok: true,
      source: 'CDOT COtrip',
      checkedAt: new Date().toISOString(),
      i70Closed,
      alert: i70Closed
        ? 'I-70 is closed in the mountain corridor'
        : chainLaws.length ? 'Chain or traction law in effect' : null,
      counts: { closures: closures.length, chainLaws: chainLaws.length, total: items.length },
      items: items.slice(0, 25),
      feedErrors: feedErrors.length ? feedErrors : undefined,
      // debug=1 returns untouched CDOT objects so the parser can be checked
      // against reality instead of against an assumption about the schema.
      debugRaw: debug ? raw.slice(0, 3) : undefined,
      debugRawCount: debug ? raw.length : undefined
    });
  } catch (e) {
    console.error('[roads] error', e);
    return res.status(500).json({ ok: false, error: 'internal server error' });
  }
}

/* ---- Snow tracker ---------------------------------------------------------
   Powers the snow report card and Powder Day mode. Rides on this function via
   ?feed=snow because the Hobby plan caps us at 12 serverless functions.

   TWO SOURCES, and the distinction is the whole feature:

   1. MEASURED: USDA NRCS SNOTEL stations. These are automated snow pillows on
      the mountains themselves, public domain, updated daily. Copper Mountain
      SNOTEL is 1.3 miles from Copper. Grizzly Peak is 0.3 miles from A-Basin.
      Loveland Basin is half a mile from Loveland. Hoosier Pass is the classic
      Breckenridge proxy. New overnight snow is today's depth minus yesterday's,
      which is the same proxy the resorts' own reports are built on. This is
      the number people want when they ask "how much fell last night".

   2. FORECAST: Open-Meteo, modeled at mid-mountain elevation. Useful for
      "how much more is coming", useless for "how much fell". Kept as the
      secondary line.

   OPEN-STATUS GATE: the card only shows resorts that are open. Opening dates
   are announced days ahead and shift with weather; three of the five have no
   fixed date at all ("when conditions allow"). So each resort carries:
     opens   ISO date, or null for "not announced yet"  -> treated as closed
     closes  ISO date, or null                          -> open through June 30
     status  'auto' | 'open' | 'closed'                 -> manual override wins
   Update `opens` the day a resort announces. That is a one-line edit.
   Closing dates below are typical for each mountain, not confirmed; tighten
   them in spring.
--------------------------------------------------------------------------- */
const SNOW_RESORTS = [
  { name: 'Keystone',        lat: 39.6053, lng: -105.9437, elevation: 3353,
    station: '505:CO:SNTL', stationName: 'Grizzly Peak', stationFt: 11110,
    opens: null, closes: '2027-04-12', status: 'auto',
    report: 'https://www.keystoneresort.com/the-mountain/mountain-conditions/snow-and-weather-report.aspx' },
  { name: 'Arapahoe Basin',  lat: 39.6425, lng: -105.8719, elevation: 3627,
    station: '505:CO:SNTL', stationName: 'Grizzly Peak', stationFt: 11110,
    opens: null, closes: '2027-06-07', status: 'auto',
    report: 'https://www.arapahoebasin.com/snow-conditions/' },
  { name: 'Breckenridge',    lat: 39.4800, lng: -106.0680, elevation: 3444,
    station: '531:CO:SNTL', stationName: 'Hoosier Pass', stationFt: 11600,
    opens: '2026-11-06', closes: '2027-04-19', status: 'auto',
    report: 'https://www.breckenridge.com/the-mountain/mountain-conditions/snow-and-weather-report.aspx' },
  { name: 'Copper Mountain', lat: 39.5010, lng: -106.1520, elevation: 3353,
    station: '415:CO:SNTL', stationName: 'Copper Mountain', stationFt: 10500,
    opens: '2026-11-06', closes: '2027-04-19', status: 'auto',
    report: 'https://www.coppercolorado.com/the-mountain/mountain-conditions/snow-report' },
  { name: 'Loveland',        lat: 39.6800, lng: -105.8975, elevation: 3475,
    station: '602:CO:SNTL', stationName: 'Loveland Basin', stationFt: 11410,
    opens: null, closes: '2027-05-03', status: 'auto',
    report: 'https://skiloveland.com/snow-report/' }
];

// Enough fresh snow that a normal person would change their plans.
const POWDER_THRESHOLD_INCHES = 6;

function isoDay(d = new Date()) {
  // Mountain-time calendar day, so the gate flips at midnight in Colorado,
  // not midnight UTC (which is 5-6pm the previous evening in Summit County).
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function resortOpen(r, today = isoDay()) {
  if (r.status === 'open') return true;
  if (r.status === 'closed') return false;
  if (!r.opens) return false;                       // not announced = not open
  const closes = r.closes || `${today.slice(0, 4)}-06-30`;
  return today >= r.opens && today <= closes;
}

function sumWindow(times, values, fromMs, toMs) {
  let total = 0;
  for (let i = 0; i < times.length; i++) {
    // Open-Meteo returns local wall-clock stamps with no offset, e.g.
    // "2026-08-25T04:00". Date.parse treats those as local to the server,
    // which on Vercel is UTC. Compare in the same frame by parsing both ends
    // the same way rather than trying to reconstruct a timezone here.
    const t = Date.parse(times[i] + 'Z');
    if (!Number.isFinite(t) || t < fromMs || t > toMs) continue;
    const v = Number(values[i]);
    if (Number.isFinite(v)) total += v;
  }
  return Math.round(total * 10) / 10;
}

/* SNOTEL daily values for every station we use, one call. Returns a map of
   stationTriplet -> { depths: [{date, in}], temps: [{date, f}] }, last 8 days. */
async function fetchSnotel() {
  const triplets = [...new Set(SNOW_RESORTS.map(r => r.station))].join(',');
  const end = isoDay();
  const begin = isoDay(new Date(Date.now() - 8 * 86400000));
  const url = new URL('https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data');
  url.searchParams.set('stationTriplets', triplets);
  url.searchParams.set('elements', 'SNWD,TOBS');
  url.searchParams.set('duration', 'DAILY');
  url.searchParams.set('beginDate', begin);
  url.searchParams.set('endDate', end);
  url.searchParams.set('periodRef', 'END');
  const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`snotel ${r.status}`);
  const body = await r.json();
  const out = {};
  for (const st of (Array.isArray(body) ? body : [])) {
    const entry = { depths: [], temps: [] };
    for (const d of (st.data || [])) {
      const code = d.stationElement?.elementCode;
      const vals = (d.values || []).filter(v => v && v.value != null && Number.isFinite(Number(v.value)));
      if (code === 'SNWD') entry.depths = vals.map(v => ({ date: v.date, in: Number(v.value) }));
      if (code === 'TOBS') entry.temps  = vals.map(v => ({ date: v.date, f: Number(v.value) }));
    }
    out[st.stationTriplet] = entry;
  }
  return out;
}

/* Turn a station's daily depth series into the numbers a skier wants. */
function measuredFromDepths(depths) {
  if (!depths || depths.length < 2) return { base: depths?.[0]?.in ?? null, new24: null, new7: null, asOf: depths?.[0]?.date ?? null };
  const last = depths[depths.length - 1], prev = depths[depths.length - 2];
  // Depth can DROP overnight from settling and melt; only count gains as new.
  const new24 = Math.max(0, Math.round(last.in - prev.in));
  let new7 = 0;
  for (let i = Math.max(1, depths.length - 7); i < depths.length; i++) new7 += Math.max(0, depths[i].in - depths[i - 1].in);
  return { base: Math.round(last.in), new24, new7: Math.round(new7), asOf: last.date };
}

async function snowfall(req, res) {
  try {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude',  SNOW_RESORTS.map(r => r.lat).join(','));
    url.searchParams.set('longitude', SNOW_RESORTS.map(r => r.lng).join(','));
    url.searchParams.set('elevation', SNOW_RESORTS.map(r => r.elevation).join(','));
    url.searchParams.set('hourly', 'snowfall');
    url.searchParams.set('past_days', '1');
    url.searchParams.set('forecast_days', '2');
    url.searchParams.set('timezone', 'UTC');
    url.searchParams.set('precipitation_unit', 'inch');

    // Both sources in parallel, settled not all: if SNOTEL is down we still
    // have the forecast, and vice versa. Neither failure blanks the card.
    const [meteoR, snotelR] = await Promise.allSettled([
      fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) }).then(r => r.ok ? r.json() : Promise.reject(new Error(`open-meteo ${r.status}`))),
      fetchSnotel()
    ]);
    const meteo  = meteoR.status  === 'fulfilled' ? (Array.isArray(meteoR.value) ? meteoR.value : [meteoR.value]) : [];
    const snotel = snotelR.status === 'fulfilled' ? snotelR.value : {};
    if (!meteo.length && !Object.keys(snotel).length) {
      return res.status(502).json({ ok: false, error: 'snow feeds unavailable' });
    }

    const now = Date.now();
    const DAY = 86400000;
    const today = isoDay();

    const all = SNOW_RESORTS.map((meta, i) => {
      const loc = meteo[i];
      const times = loc?.hourly?.time || [];
      const vals  = loc?.hourly?.snowfall || [];
      const st = snotel[meta.station] || {};
      const m = measuredFromDepths(st.depths);
      const lastTemp = st.temps?.length ? st.temps[st.temps.length - 1].f : null;
      return {
        name: meta.name,
        open: resortOpen(meta, today),
        opens: meta.opens,
        // measured
        newSnowIn: m.new24,
        new7DayIn: m.new7,
        baseDepthIn: m.base,
        tempF: lastTemp,
        measuredAsOf: m.asOf,
        station: meta.stationName,
        stationFt: meta.stationFt,
        // forecast
        forecastPast24h: loc ? sumWindow(times, vals, now - DAY, now) : null,
        forecastNext24h: loc ? sumWindow(times, vals, now, now + DAY) : null,
        elevationMeters: loc?.elevation ?? meta.elevation ?? null,
        report: meta.report
      };
    });

    // The card shows OPEN resorts only. Closed ones are listed by name so the
    // client can say "opens Nov 6" instead of silently omitting them.
    const resorts = all.filter(r => r.open);
    const closed  = all.filter(r => !r.open).map(r => ({ name: r.name, opens: r.opens }));

    const pick = (arr, key) => arr.reduce((a, b) => ((b[key] ?? -1) > (a?.[key] ?? -1) ? b : a), null);
    const best     = pick(resorts, 'newSnowIn');
    const incoming = pick(resorts, 'forecastNext24h');

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
    return res.status(200).json({
      ok: true,
      sources: { measured: snotelR.status === 'fulfilled' ? 'usda-snotel' : null, forecast: meteoR.status === 'fulfilled' ? 'open-meteo' : null },
      disclaimer: 'Measured depth comes from USDA SNOTEL stations near each mountain, not the resort\'s own plot. Forecast is a weather model.',
      thresholdInches: POWDER_THRESHOLD_INCHES,
      anyOpen: resorts.length > 0,
      isPowderDay: !!best && (best.newSnowIn ?? 0) >= POWDER_THRESHOLD_INCHES,
      stormComing: !!incoming && (incoming.forecastNext24h ?? 0) >= POWDER_THRESHOLD_INCHES,
      best: best ? { name: best.name, inches: best.newSnowIn } : null,
      incoming: incoming ? { name: incoming.name, inches: incoming.forecastNext24h } : null,
      resorts,
      closed,
      updated: new Date().toISOString()
    });
  } catch (e) {
    console.error('[snow] error', e);
    return res.status(500).json({ ok: false, error: 'internal server error' });
  }
}

/* ---- Storm clock ----------------------------------------------------------
   Powers Monsoon mode, and it is the summer counterpart to the snow report.

   Colorado's monsoon runs roughly mid-June to early September: clear mornings,
   storms building over the high country through the afternoon. The hazard is
   lightning above treeline, and the local habit is to summit early and be
   heading down by early afternoon. Visitors do not know that clock.

   Risk is taken as the WORST of the four high-country points rather than an
   average. If it is going to thunder at A-Basin and someone is hiking near
   A-Basin, an average that includes three calmer spots is the wrong number.
   Safety readouts should round toward caution.

   WMO weather codes 95, 96 and 99 are thunderstorm. Those matter more than
   rain probability, because rain is uncomfortable and lightning is not.
--------------------------------------------------------------------------- */
const THUNDER_CODES = new Set([95, 96, 99]);
const STORM_POP_THRESHOLD = 30;   // percent, "likely enough to plan around"

async function stormClock(req, res) {
  try {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude',  SNOW_RESORTS.map(r => r.lat).join(','));
    url.searchParams.set('longitude', SNOW_RESORTS.map(r => r.lng).join(','));
    url.searchParams.set('elevation', SNOW_RESORTS.map(r => r.elevation).join(','));
    url.searchParams.set('hourly', 'precipitation_probability,weathercode');
    url.searchParams.set('forecast_days', '1');
    url.searchParams.set('timezone', 'America/Denver');

    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return res.status(502).json({ ok: false, error: 'storm feed unavailable' });

    const body = await r.json();
    const list = Array.isArray(body) ? body : [body];
    const base = list[0]?.hourly;
    if (!base?.time?.length) {
      return res.status(502).json({ ok: false, error: 'no hourly data' });
    }

    // Daylight hours only. Nobody is planning a 3am summit push around this.
    const hours = [];
    for (let i = 0; i < base.time.length; i++) {
      const hr = Number(base.time[i].slice(11, 13));
      if (hr < 6 || hr > 21) continue;

      let pop = 0, thunder = false;
      for (const loc of list) {
        const p = Number(loc?.hourly?.precipitation_probability?.[i]);
        if (Number.isFinite(p) && p > pop) pop = p;
        const wc = Number(loc?.hourly?.weathercode?.[i]);
        if (THUNDER_CODES.has(wc)) thunder = true;
      }
      hours.push({ hour: hr, time: base.time[i].slice(11, 16), pop, thunder });
    }

    const firstRisk = hours.find(h => h.pop >= STORM_POP_THRESHOLD || h.thunder) || null;
    const firstThunder = hours.find(h => h.thunder) || null;
    const peak = hours.reduce((a, b) => (b.pop > (a?.pop ?? -1) ? b : a), null);

    // Turnaround is one hour before risk starts, floored at 9am. A forecast
    // that says "be down by 7am" is not advice anyone can use, and a storm
    // that early is not the monsoon pattern anyway.
    let turnaround = null;
    if (firstRisk) turnaround = Math.max(9, firstRisk.hour - 1);

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
    return res.status(200).json({
      ok: true,
      source: 'open-meteo',
      disclaimer: 'Modeled forecast. Mountain storms build faster than any model predicts. Treat this as a floor, not a guarantee.',
      popThreshold: STORM_POP_THRESHOLD,
      anyRisk: !!firstRisk,
      anyThunder: !!firstThunder,
      firstRisk: firstRisk ? { time: firstRisk.time, hour: firstRisk.hour, pop: firstRisk.pop } : null,
      firstThunder: firstThunder ? { time: firstThunder.time, hour: firstThunder.hour } : null,
      peak: peak ? { time: peak.time, hour: peak.hour, pop: peak.pop } : null,
      turnaroundHour: turnaround,
      hours,
      updated: new Date().toISOString()
    });
  } catch (e) {
    console.error('[storm] error', e);
    return res.status(500).json({ ok: false, error: 'internal server error' });
  }
}

export default async function handler(req, res) {
  if (req.query.feed === 'roads') return roadConditions(req, res);
  if (req.query.feed === 'snow') return snowfall(req, res);
  if (req.query.feed === 'storm') return stormClock(req, res);

  // Validate before the values reach the weather.gov URL path. Every other
  // handler does this; this one interpolated req.query straight in.
  const validCoord = (v, max) => {
    if (v === undefined || v === null || String(v).trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && Math.abs(n) <= max ? n : null;
  };
  const latIn = validCoord(req.query.lat, 90);
  const lngIn = validCoord(req.query.lng, 180);
  const lat = latIn !== null && lngIn !== null ? latIn : 39.5744;
  const lng = latIn !== null && lngIn !== null ? lngIn : -106.0975;

  try {
    const [pointsRes, alerts] = await Promise.all([
      // points -> forecast is sequential, so each leg gets 4s to stay
      // inside the 10s Hobby limit with room for the alerts call.
      fetch(`https://api.weather.gov/points/${lat},${lng}`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(4000)
      }),
      fetchAlerts(lat, lng)
    ]);

    if (!pointsRes.ok) {
      return res.status(pointsRes.status).json({ error: 'weather points lookup failed' });
    }
    const pointsData = await pointsRes.json();
    const forecastUrl = pointsData.properties?.forecast;
    const location = pointsData.properties?.relativeLocation?.properties;

    if (!forecastUrl) {
      return res.status(404).json({ error: 'forecast unavailable for this location' });
    }

    const forecastRes = await fetch(forecastUrl, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(4000)
    });
    if (!forecastRes.ok) {
      return res.status(forecastRes.status).json({ error: 'forecast fetch failed' });
    }
    const forecastData = await forecastRes.json();
    const periods = (forecastData.properties?.periods || []).slice(0, 7).map(p => ({
      name: p.name,
      startTime: p.startTime,
      isDaytime: p.isDaytime,
      temperature: p.temperature,
      temperatureUnit: p.temperatureUnit,
      windSpeed: p.windSpeed,
      windDirection: p.windDirection,
      shortForecast: p.shortForecast,
      detailedForecast: p.detailedForecast,
      icon: p.icon,
      probabilityOfPrecipitation: p.probabilityOfPrecipitation?.value
    }));

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');
    res.status(200).json({
      source: 'weather.gov',
      location: {
        city: location?.city || 'Frisco',
        state: location?.state || 'CO',
        lat: Number(lat),
        lng: Number(lng)
      },
      forecast: periods,
      alerts,
      updated: forecastData.properties?.updated
    });
  } catch (e) {
    console.error('[weather] error', e);
    return res.status(500).json({ error: 'internal server error' });
  }
}
