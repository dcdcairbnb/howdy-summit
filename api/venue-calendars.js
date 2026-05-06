// Scrapes upcoming shows from Nashville's iconic music venues that aren't well
// covered by Ticketmaster: Bluebird Cafe, Station Inn, Ryman Auditorium, Grand
// Ole Opry. Each site has a different HTML structure, so each scraper is a
// separate function. Returns a normalized list and caches at the edge.

const COMMON_HEADERS = {
  'User-Agent': 'HowdyNash/1.0 (+https://howdynash.com)',
  'Accept': 'text/html,application/xhtml+xml',
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
    const r = await fetch(url, { headers: COMMON_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    return await r.text();
  } catch (e) {
    return null;
  }
}

async function scrapeBluebird() {
  const url = 'https://bluebirdcafe.com/shows/';
  const html = await fetchHtml(url);
  if (!html) return [];
  const out = [];
  const cardRe = /<article[^>]*class="[^"]*tribe-events-calendar-list__event[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
  let m;
  while ((m = cardRe.exec(html)) && out.length < 12) {
    const card = m[1];
    const titleM = card.match(/<h3[^>]*tribe-events-calendar-list__event-title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i);
    const title = strip(titleM ? titleM[1] : '');
    const dateM = card.match(/<time[^>]*datetime="([^"]+)"/i);
    const date = dateM ? dateM[1].slice(0, 10) : '';
    const linkM = card.match(/<a[^>]*href="([^"]+)"/i);
    const link = linkM ? linkM[1] : url;
    if (title) out.push({ name: title, date, time: '', venue: 'The Bluebird Cafe', neighborhood: 'Green Hills', url: link, source: 'bluebird' });
  }
  return out;
}

async function scrapeStationInn() {
  const url = 'https://stationinn.com/calendar/';
  const html = await fetchHtml(url);
  if (!html) return [];
  const out = [];
  const cardRe = /<div[^>]*class="[^"]*event[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let m;
  while ((m = cardRe.exec(html)) && out.length < 12) {
    const card = m[1];
    const titleM = card.match(/<(?:h2|h3|a)[^>]*>([^<]+(?:<[^/][^>]*>[^<]+<\/[^>]+>[^<]*)*)<\/(?:h2|h3|a)>/i);
    const title = strip(titleM ? titleM[1] : '');
    const dateM = card.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})|(\w+ \d{1,2},? \d{4})/);
    const date = dateM ? dateM[0] : '';
    const linkM = card.match(/<a[^>]*href="([^"]+)"/i);
    const link = linkM ? linkM[1] : url;
    if (title && title.length > 3) out.push({ name: title, date, time: '', venue: 'Station Inn', neighborhood: 'The Gulch', url: link, source: 'stationinn' });
  }
  return out;
}

async function scrapeRyman() {
  const url = 'https://ryman.com/events/';
  const html = await fetchHtml(url);
  if (!html) return [];
  const out = [];
  const cardRe = /<div[^>]*class="[^"]*event-item[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let m;
  while ((m = cardRe.exec(html)) && out.length < 15) {
    const card = m[1];
    const titleM = card.match(/<(?:h2|h3|h4)[^>]*>([\s\S]*?)<\/(?:h2|h3|h4)>/i);
    const title = strip(titleM ? titleM[1] : '');
    const dateM = card.match(/<time[^>]*datetime="([^"]+)"/i) || card.match(/(\w+ \d{1,2},? \d{4})/);
    const date = dateM ? (dateM[1] || dateM[0]) : '';
    const linkM = card.match(/<a[^>]*href="([^"]+)"/i);
    const link = linkM ? linkM[1] : url;
    if (title) out.push({ name: title, date, time: '', venue: 'Ryman Auditorium', neighborhood: 'Downtown', url: link, source: 'ryman' });
  }
  return out;
}

async function scrapeOpry() {
  const url = 'https://www.opry.com/shows';
  const html = await fetchHtml(url);
  if (!html) return [];
  const out = [];
  const cardRe = /<div[^>]*class="[^"]*show-card[^"]*"[^>]*>([\s\S]*?)<\/article>|<article[^>]*class="[^"]*show[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
  let m;
  while ((m = cardRe.exec(html)) && out.length < 15) {
    const card = m[1] || m[2] || '';
    const titleM = card.match(/<(?:h2|h3|h4)[^>]*>([\s\S]*?)<\/(?:h2|h3|h4)>/i);
    const title = strip(titleM ? titleM[1] : '');
    const dateM = card.match(/<time[^>]*datetime="([^"]+)"/i) || card.match(/(\w+ \d{1,2})/);
    const date = dateM ? (dateM[1] || dateM[0]) : '';
    const linkM = card.match(/<a[^>]*href="([^"]+)"/i);
    const link = linkM ? (linkM[1].startsWith('http') ? linkM[1] : 'https://www.opry.com' + linkM[1]) : url;
    if (title) out.push({ name: title, date, time: '', venue: 'Grand Ole Opry', neighborhood: 'Opry Mills', url: link, source: 'opry' });
  }
  return out;
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
