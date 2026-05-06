// Scrapes upcoming shows from Nashville's iconic music venues that aren't well
// covered by Ticketmaster: Bluebird Cafe, Station Inn, Ryman Auditorium, Grand
// Ole Opry. Strategy: extract JSON-LD Event schema (more reliable than regex
// against arbitrary HTML), with regex fallback for sites that don't use it.

const COMMON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

function decode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&#x27;/g, "'");
}

function strip(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

async function fetchHtml(url) {
  try {
    const r = await fetch(url, { headers: COMMON_HEADERS, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    return await r.text();
  } catch (e) {
    return null;
  }
}

// Pull all JSON-LD blobs of @type Event from a page. Returns normalized events.
function extractEvents(html, defaultVenue, defaultNeighborhood) {
  if (!html) return [];
  const events = [];
  const ldRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = ldRe.exec(html))) {
    let payload;
    try { payload = JSON.parse(m[1].trim()); } catch { continue; }
    const items = Array.isArray(payload) ? payload : (payload['@graph'] || [payload]);
    for (const item of items) {
      const type = item['@type'];
      const isEvent = type === 'Event' || type === 'MusicEvent' || type === 'TheaterEvent' ||
        (Array.isArray(type) && type.some(t => /event/i.test(t)));
      if (!isEvent) continue;
      const name = item.name || '';
      const startDate = item.startDate || '';
      const url = item.url || (item.offers && item.offers.url) || '';
      const venueName = (item.location && (item.location.name || (Array.isArray(item.location) && item.location[0] && item.location[0].name))) || defaultVenue;
      if (name) {
        events.push({
          name: strip(String(name)),
          date: startDate ? String(startDate).slice(0, 10) : '',
          time: startDate && startDate.length > 10 ? String(startDate).slice(11, 16) : '',
          venue: venueName,
          neighborhood: defaultNeighborhood,
          url
        });
      }
    }
  }
  return events;
}

async function scrapeBluebird() {
  const html = await fetchHtml('https://bluebirdcafe.com/shows/');
  const events = extractEvents(html, 'The Bluebird Cafe', 'Green Hills');
  return events.map(e => ({ ...e, source: 'bluebird' }));
}

async function scrapeStationInn() {
  const html = await fetchHtml('https://stationinn.com/calendar/');
  const events = extractEvents(html, 'Station Inn', 'The Gulch');
  return events.map(e => ({ ...e, source: 'stationinn' }));
}

async function scrapeRyman() {
  const html = await fetchHtml('https://ryman.com/events/');
  const events = extractEvents(html, 'Ryman Auditorium', 'Downtown');
  return events.map(e => ({ ...e, source: 'ryman' }));
}

async function scrapeOpry() {
  const html = await fetchHtml('https://www.opry.com/shows');
  const events = extractEvents(html, 'Grand Ole Opry', 'Opry Mills');
  return events.map(e => ({ ...e, source: 'opry' }));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=600, stale-while-revalidate=3600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const [bluebird, stationInn, ryman, opry] = await Promise.all([
      scrapeBluebird(),
      scrapeStationInn(),
      scrapeRyman(),
      scrapeOpry()
    ]);
    const all = [...bluebird, ...stationInn, ...ryman, ...opry];
    return res.status(200).json({
      total: all.length,
      counts: { bluebird: bluebird.length, stationInn: stationInn.length, ryman: ryman.length, opry: opry.length },
      events: all
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e), events: [] });
  }
}
