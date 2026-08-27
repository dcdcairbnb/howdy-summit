// Google Places API (New). Geolocation-aware.
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

// Google's locationBias is a bias, not a restriction. For niche queries with
// few local matches (sleigh rides, for one) it happily widens the net and
// returns results from the Front Range. "Ken Caryl Sledding Hill" is in
// Littleton, roughly 65 miles from Breckenridge, and it was showing up under
// "More nearby" in the sleigh ride list.
//
// So restrict server-side. Anything beyond a sane day-trip radius of the
// county is not what someone standing in Frisco means by "nearby".
const SUMMIT_CENTER = { latitude: 39.5500, longitude: -106.0500 };
const MAX_MILES_FROM_COUNTY = 35;

// Places that are genuinely worth listing but sit just outside the county
// line, so the radius alone would cut them.
const ALLOWED_OUTSIDE = /loveland ski|arapahoe basin|a-basin|cataract|hanging lake|rifle falls|georgetown|idaho springs|kremmling|leadville|vail|minturn|red cliff/i;

/* Strict mode: county line only, no radius fallback and no ALLOWED_OUTSIDE.
   The 35-mile net is right for things people will drive to on purpose, like
   hot springs or a jeep trail just over the line. It is wrong for errands.
   A dispensary in Fairplay is 25 miles away over Hoosier Pass, and one in
   Avon is in Eagle County; neither is any use to somebody standing in Frisco
   looking for the nearest shop. Callers opt in with ?strict=1. */
function strictlySummitCounty(place) {
  const addr = place.address || place.formattedAddress || '';
  if (/\b(breckenridge|frisco|dillon|silverthorne|keystone|copper mountain|blue river|montezuma|heeney)\b/i.test(addr)) return true;
  if (/\b(80424|80443|80435|80498|80497)\b/.test(addr)) return true;
  return false;
}

function withinSummitCounty(place) {
  const addr = place.address || place.formattedAddress || '';
  // Fast path: a Summit County town or ZIP in the address is proof enough.
  if (/\b(breckenridge|frisco|dillon|silverthorne|keystone|copper mountain|blue river|montezuma|heeney)\b/i.test(addr)) return true;
  if (/\b(80424|80443|80435|80498|80497)\b/.test(addr)) return true;
  if (ALLOWED_OUTSIDE.test(addr) || ALLOWED_OUTSIDE.test(place.name || '')) return true;
  const c = place.coords || place.location;
  if (!c) return false; // no coordinates and no local address: drop it
  return haversineMiles(SUMMIT_CENTER, c) <= MAX_MILES_FROM_COUNTY;
}

export default async function handler(req, res) {
  if (!process.env.GOOGLE_PLACES_KEY) {
    return res.status(503).json({ error: 'GOOGLE_PLACES_KEY not configured' });
  }
  const { q = '', type = 'tourist_attraction' } = req.query;
  const { lat, lng } = parseLatLng(req.query.lat, req.query.lng);

  // Google Places (New) only accepts a fixed list of includedType values.
  // If we're handed something invalid or empty, drop the type filter rather
  // than 400ing the whole request.
  const VALID_TYPES = new Set([
    'restaurant', 'bar', 'cafe', 'bakery', 'meal_takeaway', 'meal_delivery',
    'tourist_attraction', 'museum', 'art_gallery', 'park', 'zoo', 'aquarium',
    'amusement_park', 'stadium', 'movie_theater', 'night_club',
    'store', 'shopping_mall', 'clothing_store', 'department_store', 'book_store',
    'hardware_store', 'liquor_store', 'convenience_store', 'supermarket',
    'beauty_salon', 'hair_care', 'spa',
    'lodging', 'campground', 'rv_park',
    'gas_station', 'parking', 'taxi_stand', 'transit_station', 'bus_station',
    'pharmacy', 'doctor', 'hospital', 'dental_clinic',
    'church', 'mosque', 'synagogue', 'place_of_worship',
    'gym', 'bowling_alley'
  ]);
  const safeType = VALID_TYPES.has(type) ? type : null;

  try {
    const body = {
      textQuery: `${q} in Summit County, CO`,
      maxResultCount: 20
    };
    if (safeType) body.includedType = safeType;
    if (lat && lng) {
      body.locationBias = {
        circle: {
          center: { latitude: Number(lat), longitude: Number(lng) },
          radius: 16000
        }
      };
      body.rankPreference = 'DISTANCE';
    }

    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_PLACES_KEY,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.location,places.types,places.googleMapsUri,places.websiteUri,places.id'
      },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);

    const userPos = (lat && lng) ? { latitude: Number(lat), longitude: Number(lng) } : null;
    const results = (data.places || []).map(p => ({
      id: p.id,
      name: p.displayName?.text,
      address: p.formattedAddress,
      rating: p.rating,
      reviewCount: p.userRatingCount,
      coords: p.location,
      distanceMiles: userPos && p.location ? haversineMiles(userPos, p.location) : null,
      types: p.types,
      mapsUrl: p.googleMapsUri,
      website: p.websiteUri
    }));

    // Drop anything Google returned from outside the county.
    const strict = req.query.strict === '1' || req.query.strict === 'true';
    const localResults = results.filter(strict ? strictlySummitCounty : withinSummitCounty);
    const dropped = results.length - localResults.length;
    if (dropped) console.log(`[places_search] dropped ${dropped} out-of-county result(s) for "${q}"`);

    if (lat && lng) {
      localResults.sort((a, b) => (a.distanceMiles ?? 9999) - (b.distanceMiles ?? 9999));
    }

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');
    res.status(200).json({
      source: 'google',
      sortedBy: (lat && lng) ? 'distance' : 'relevance',
      results: localResults
    });
  } catch (e) {
    console.error("[places_search] error", e); res.status(500).json({ error: "internal server error" });
  }
}
