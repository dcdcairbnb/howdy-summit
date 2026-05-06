// Disabled. The cron-based scrape monitor was removed for now.
// Use an external uptime monitor (UptimeRobot, Cronitor) pinging /api/venue-calendars
// to alert when the venue scrapers stop returning data.
export default function handler(req, res) {
  return res.status(410).json({ error: 'Disabled. Use an external uptime monitor.' });
}
