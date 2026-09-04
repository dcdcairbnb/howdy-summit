// AviationStack flight tracker. Free tier: 100 requests/month, 1 req/sec.
// Sign up at https://aviationstack.com to get a key.
// Default airport: DEN (Denver International). Summit County has no commercial
// airport, so essentially every visitor flies into DEN and drives I-70 west.

export default async function handler(req, res) {
  if (!process.env.AVIATIONSTACK_KEY) {
    return res.status(503).json({ error: 'AVIATIONSTACK_KEY not configured' });
  }

  // Validate at the boundary. A repeated ?airport= param arrives as an array
  // (so .toUpperCase() threw), and limit was forwarded raw against a
  // 100-request-per-month free tier.
  const rawAirport = Array.isArray(req.query.airport) ? req.query.airport[0] : req.query.airport;
  const airport = /^[A-Za-z]{3}$/.test(String(rawAirport || '')) ? String(rawAirport).toUpperCase() : 'DEN';
  const direction = req.query.direction === 'departures' ? 'departures' : 'arrivals';
  const limitN = Number(req.query.limit);
  const limit = Number.isInteger(limitN) && limitN >= 1 && limitN <= 50 ? limitN : 20;

  try {
    const url = new URL('http://api.aviationstack.com/v1/flights');
    url.searchParams.set('access_key', process.env.AVIATIONSTACK_KEY);
    if (direction === 'departures') {
      url.searchParams.set('dep_iata', airport);
    } else {
      url.searchParams.set('arr_iata', airport);
    }
    url.searchParams.set('limit', String(limit));

    // AviationStack's free tier is HTTP-only, so the key crosses the wire in
    // clear. That is a provider limit, not a choice; the upgrade is the fix.
    // What this code CAN do is stop echoing the upstream body, which restated
    // the request including the key, back to the browser.
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) {
      console.error('[flights] upstream', r.status, (await r.text().catch(() => '')).slice(0, 200));
      return res.status(502).json({ error: 'flight data unavailable' });
    }
    const data = await r.json();

    const flights = (data.data || []).map(f => ({
      flightNumber: f.flight?.iata || f.flight?.icao || '',
      airline: f.airline?.name || '',
      status: f.flight_status || '',
      departure: {
        airport: f.departure?.airport || '',
        iata: f.departure?.iata || '',
        scheduled: f.departure?.scheduled || '',
        estimated: f.departure?.estimated || '',
        actual: f.departure?.actual || '',
        delay: f.departure?.delay || null,
        gate: f.departure?.gate || '',
        terminal: f.departure?.terminal || ''
      },
      arrival: {
        airport: f.arrival?.airport || '',
        iata: f.arrival?.iata || '',
        scheduled: f.arrival?.scheduled || '',
        estimated: f.arrival?.estimated || '',
        actual: f.arrival?.actual || '',
        delay: f.arrival?.delay || null,
        gate: f.arrival?.gate || '',
        terminal: f.arrival?.terminal || '',
        baggage: f.arrival?.baggage || ''
      }
    }));

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    res.status(200).json({
      source: 'aviationstack',
      airport: airport.toUpperCase(),
      direction,
      total: flights.length,
      flights
    });
  } catch (e) {
    console.error('[flights] error', e);
    return res.status(500).json({ error: 'internal server error' });
  }
}
