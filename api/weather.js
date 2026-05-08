// Weather.gov (US National Weather Service). Free, no API key required.
// Returns forecast plus active alerts for the user's location.

const UA = 'HowdyNash/1.0 (contact@howdynash.com)';

async function fetchAlerts(lat, lng) {
  try {
    const r = await fetch(`https://api.weather.gov/alerts/active?point=${lat},${lng}`, {
      headers: { 'User-Agent': UA, 'Accept': 'application/geo+json' }
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

export default async function handler(req, res) {
  const { lat = 36.1627, lng = -86.7816 } = req.query;

  try {
    const [pointsRes, alerts] = await Promise.all([
      fetch(`https://api.weather.gov/points/${lat},${lng}`, {
        headers: { 'User-Agent': UA }
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
      headers: { 'User-Agent': UA }
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
        city: location?.city || 'Nashville',
        state: location?.state || 'TN',
        lat: Number(lat),
        lng: Number(lng)
      },
      forecast: periods,
      alerts,
      updated: forecastData.properties?.updated
    });
  } catch (e) {
    console.error("[weather] error", e); res.status(500).json({ error: "internal server error" });
  }
}
