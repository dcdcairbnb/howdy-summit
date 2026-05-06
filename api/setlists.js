// Setlist.fm API proxy. Returns recent setlists for an artist.
// Free API key from https://www.setlist.fm/settings/api

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.SETLIST_FM_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'SETLIST_FM_API_KEY not configured', setlists: [] });
  }

  const artist = String(req.query.artist || '').trim();
  if (!artist) {
    return res.status(400).json({ error: 'artist parameter required', setlists: [] });
  }

  try {
    const url = `https://api.setlist.fm/rest/1.0/search/setlists?artistName=${encodeURIComponent(artist)}&p=1`;
    const r = await fetch(url, {
      headers: {
        'x-api-key': apiKey,
        'Accept': 'application/json',
        'User-Agent': 'HowdyNash/1.0 (+https://howdynash.com)'
      }
    });
    if (!r.ok) {
      return res.status(r.status).json({ error: `setlist.fm returned ${r.status}`, setlists: [] });
    }
    const data = await r.json();
    const raw = Array.isArray(data.setlist) ? data.setlist.slice(0, 5) : [];

    const setlists = raw.map(s => {
      const songs = [];
      const sets = s.sets && Array.isArray(s.sets.set) ? s.sets.set : [];
      for (const sec of sets) {
        if (Array.isArray(sec.song)) {
          for (const song of sec.song) {
            if (song && song.name) songs.push(song.name);
          }
        }
      }
      return {
        date: s.eventDate || '',
        venue: s.venue && s.venue.name ? s.venue.name : '',
        city: s.venue && s.venue.city ? s.venue.city.name : '',
        country: s.venue && s.venue.city && s.venue.city.country ? s.venue.city.country.name : '',
        artist: s.artist && s.artist.name ? s.artist.name : artist,
        url: s.url || '',
        songs
      };
    }).filter(s => s.songs.length > 0);

    return res.status(200).json({ artist, setlists });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e), setlists: [] });
  }
}
