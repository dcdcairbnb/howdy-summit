// Events: Ticketmaster Discovery + SeatGeek combined.
// When lat/lng provided, sorts by distance from user.

// Extract the real destination URL from Impact Radius / similar affiliate wrappers.
function unwrapAffiliateUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  if (!/(\.evyy\.net|\.go2cloud\.org|prf\.hn)\//i.test(rawUrl)) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    const u = parsed.searchParams.get('u') || parsed.searchParams.get('url') || parsed.searchParams.get('p');
    if (u) return decodeURIComponent(u);
  } catch (e) { /* fall through */ }
  return rawUrl;
}

function haversineMiles(a, b) {
  if (!a || !b) return null;
  const R = 3958.8;
  const dLat = (b.latitude - a.latitude) * Math.PI / 180;
  const dLng = (b.longitude - a.longitude) * Math.PI / 180;
  const lat1 = a.latitude * Math.PI / 180;
  const lat2 = b.latitude * Math.PI / 180;
  const x = Math.sin(dLat/2)**2 + Math.sin(dLng/2)**2 * Math.cos(lat1) * Math.cos(lat2);
  return Number((R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x))).toFixed(2));
}

async function fetchTicketmaster(keyword, classificationName, startDateTime, endDateTime, lat, lng) {
  if (!process.env.TICKETMASTER_KEY) return [];
  try {
    const url = new URL('https://app.ticketmaster.com/discovery/v2/events.json');
    url.searchParams.set('apikey', process.env.TICKETMASTER_KEY);
    url.searchParams.set('size', '20');
    if (lat && lng) {
      url.searchParams.set('latlong', `${lat},${lng}`);
      url.searchParams.set('radius', '25');
      url.searchParams.set('unit', 'miles');
      url.searchParams.set('sort', 'distance,asc');
    } else {
      // No user location shared: default to Summit County's geographic center
      // (Frisco/Dillon) rather than a single town, so results cover all six towns.
      url.searchParams.set('latlong', '39.5744,-106.0975');
      url.searchParams.set('radius', '30');
      url.searchParams.set('unit', 'miles');
      url.searchParams.set('sort', 'date,asc');
    }
    if (keyword) url.searchParams.set('keyword', keyword);
    if (classificationName) url.searchParams.set('classificationName', classificationName);
    if (startDateTime) url.searchParams.set('startDateTime', startDateTime);
    if (endDateTime) url.searchParams.set('endDateTime', endDateTime);

    const r = await fetch(url);
    if (!r.ok) return [];
    const data = await r.json();
    const userPos = (lat && lng) ? { latitude: Number(lat), longitude: Number(lng) } : null;
    return (data._embedded?.events || []).map(e => {
      const venue = e._embedded?.venues?.[0];
      const venueCoords = venue?.location ? {
        latitude: Number(venue.location.latitude),
        longitude: Number(venue.location.longitude)
      } : null;
      return {
        id: 'tm:' + e.id,
        name: e.name,
        date: e.dates?.start?.localDate,
        time: e.dates?.start?.localTime,
        venue: venue?.name,
        address: venue?.address?.line1,
        coords: venueCoords,
        distanceMiles: userPos && venueCoords ? haversineMiles(userPos, venueCoords) : null,
        url: unwrapAffiliateUrl(e.url),
        image: e.images?.[0]?.url,
        classification: e.classifications?.[0]?.segment?.name,
        genre: e.classifications?.[0]?.genre?.name,
        priceMin: e.priceRanges?.[0]?.min,
        priceMax: e.priceRanges?.[0]?.max,
        source: 'ticketmaster'
      };
    });
  } catch (e) {
    return [];
  }
}

async function fetchSeatGeek(keyword, lat, lng) {
  if (!process.env.SEATGEEK_CLIENT_ID) return [];
  try {
    const url = new URL('https://api.seatgeek.com/2/events');
    url.searchParams.set('client_id', process.env.SEATGEEK_CLIENT_ID);
    url.searchParams.set('per_page', '20');
    if (lat && lng) {
      url.searchParams.set('lat', String(lat));
      url.searchParams.set('lon', String(lng));
      url.searchParams.set('range', '25mi');
    } else {
      url.searchParams.set('lat', '39.5744');
      url.searchParams.set('lon', '-106.0975');
      url.searchParams.set('range', '30mi');
    }
    url.searchParams.set('sort', 'datetime_local.asc');
    if (keyword) url.searchParams.set('q', keyword);

    const r = await fetch(url);
    if (!r.ok) return [];
    const data = await r.json();
    const userPos = (lat && lng) ? { latitude: Number(lat), longitude: Number(lng) } : null;
    return (data.events || []).map(e => {
      const venueCoords = e.venue?.location ? {
        latitude: e.venue.location.lat,
        longitude: e.venue.location.lon
      } : null;
      return {
        id: 'sg:' + e.id,
        name: e.title || e.short_title,
        date: e.datetime_local ? e.datetime_local.split('T')[0] : null,
        time: e.datetime_local ? e.datetime_local.split('T')[1]?.slice(0, 5) : null,
        venue: e.venue?.name,
        address: e.venue?.address,
        coords: venueCoords,
        distanceMiles: userPos && venueCoords ? haversineMiles(userPos, venueCoords) : null,
        url: unwrapAffiliateUrl(e.url),
        image: e.performers?.[0]?.image,
        classification: e.type,
        genre: e.taxonomies?.[0]?.name,
        priceMin: e.stats?.lowest_price,
        priceMax: e.stats?.highest_price,
        source: 'seatgeek'
      };
    });
  } catch (e) {
    return [];
  }
}

async function fetchEventbrite(keyword, lat, lng) {
  if (!process.env.EVENTBRITE_PRIVATE_TOKEN) return [];
  try {
    const url = new URL('https://www.eventbriteapi.com/v3/events/search/');
    if (lat && lng) {
      url.searchParams.set('location.latitude', String(lat));
      url.searchParams.set('location.longitude', String(lng));
      url.searchParams.set('location.within', '25mi');
    } else {
      url.searchParams.set('location.latitude', '39.5744');
      url.searchParams.set('location.longitude', '-106.0975');
      url.searchParams.set('location.within', '30mi');
    }
    if (keyword) url.searchParams.set('q', keyword);
    url.searchParams.set('expand', 'venue');
    url.searchParams.set('sort_by', 'date');

    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.EVENTBRITE_PRIVATE_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    if (!r.ok) return [];
    const data = await r.json();
    const userPos = (lat && lng) ? { latitude: Number(lat), longitude: Number(lng) } : null;
    return (data.events || []).map(e => {
      const venue = e.venue;
      const venueCoords = (venue?.latitude && venue?.longitude) ? {
        latitude: Number(venue.latitude),
        longitude: Number(venue.longitude)
      } : null;
      const start = e.start?.local || '';
      return {
        id: 'eb:' + e.id,
        name: e.name?.text || '',
        date: start ? start.split('T')[0] : null,
        time: start ? start.split('T')[1]?.slice(0, 5) : null,
        venue: venue?.name || '',
        address: venue?.address?.localized_address_display || '',
        coords: venueCoords,
        distanceMiles: userPos && venueCoords ? haversineMiles(userPos, venueCoords) : null,
        url: unwrapAffiliateUrl(e.url),
        image: e.logo?.url,
        classification: e.category?.name || 'Event',
        genre: e.subcategory?.name || '',
        priceMin: null,
        priceMax: null,
        source: 'eventbrite'
      };
    });
  } catch (e) {
    return [];
  }
}

function dedupe(events) {
  const seen = new Map();
  for (const e of events) {
    const key = `${(e.name || '').toLowerCase().slice(0, 30)}|${e.date}|${(e.venue || '').toLowerCase().slice(0, 20)}`;
    if (!seen.has(key)) {
      seen.set(key, e);
    } else {
      const existing = seen.get(key);
      if (!existing.priceMin && e.priceMin) existing.priceMin = e.priceMin;
      if (!existing.priceMax && e.priceMax) existing.priceMax = e.priceMax;
      if (!existing.image && e.image) existing.image = e.image;
      if (!existing.distanceMiles && e.distanceMiles) existing.distanceMiles = e.distanceMiles;
    }
  }
  return Array.from(seen.values());
}

// Coordinates arrive as query strings from the browser's Geolocation API, but
// can also be hand-typed or malformed. A string like "notanumber" is truthy,
// so an unvalidated check would treat it as a real location: flipping the
// response into distance-sort mode and forwarding garbage to the upstream
// provider. Return null unless the value is a finite, in-range coordinate.
function validCoord(v, max) {
  // Number('') and Number('   ') both coerce to 0, so an empty ?lat=&lng=
  // would otherwise be read as the valid coordinate 0,0 off West Africa.
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= max ? n : null;
}
function parseLatLng(rawLat, rawLng) {
  const lat = validCoord(rawLat, 90);
  const lng = validCoord(rawLng, 180);
  return (lat === null || lng === null) ? { lat: null, lng: null } : { lat, lng };
}

export default async function handler(req, res) {
  const { keyword = '', classificationName = '', startDateTime, endDateTime } = req.query;
  const { lat, lng } = parseLatLng(req.query.lat, req.query.lng);

  try {
    const [tm, sg, eb] = await Promise.all([
      fetchTicketmaster(keyword, classificationName, startDateTime, endDateTime, lat, lng),
      fetchSeatGeek(keyword, lat, lng),
      fetchEventbrite(keyword, lat, lng)
    ]);

    const combined = dedupe([...tm, ...sg, ...eb]);

    if (lat && lng) {
      combined.sort((a, b) => {
        const da = a.distanceMiles ?? 9999;
        const db = b.distanceMiles ?? 9999;
        return da - db;
      });
    } else {
      combined.sort((a, b) => {
        if (!a.date) return 1;
        if (!b.date) return -1;
        return a.date.localeCompare(b.date);
      });
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    res.status(200).json({
      source: 'combined',
      sources: { ticketmaster: tm.length, seatgeek: sg.length, eventbrite: eb.length, deduped: combined.length },
      sortedBy: (lat && lng) ? 'distance' : 'date',
      events: combined,
      total: combined.length
    });
  } catch (e) {
    console.error('[events] error', e);
    return res.status(500).json({ error: 'internal server error' });
  }
}
