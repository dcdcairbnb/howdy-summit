// AviationStack flight tracker. Free tier: 100 requests/month, 1 req/sec.
// Sign up at https://aviationstack.com to get a key.
// Default airport: DEN (Denver International). Summit County has no commercial
// airport, so essentially every visitor flies into DEN and drives I-70 west.

export default async function handler(req, res) {
  if (!process.env.AVIATIONSTACK_KEY) {
    return res.status(503).json({ error: 'AVIATIONSTACK_KEY not configured' });
  }

  const { airport = 'DEN', direction = 'arrivals', limit = 20 } = req.query;

  try {
    const url = new URL('http://api.aviationstack.com/v1/flights');
    url.searchParams.set('access_key', process.env.AVIATIONSTACK_KEY);
    if (direction === 'departures') {
      url.searchParams.set('dep_iata', airport.toUpperCase());
    } else {
      url.searchParams.set('arr_iata', airport.toUpperCase());
    }
    url.searchParams.set('limit', String(limit));

    const r = await fetch(url);
    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: 'aviationstack error', detail: text });
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
