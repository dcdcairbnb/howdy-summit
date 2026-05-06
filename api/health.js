// Health check endpoint. Used by frontend to determine which features to show.
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ok: true,
    services: {
      foursquare: !!process.env.FOURSQUARE_API_KEY,
      google: !!process.env.GOOGLE_PLACES_KEY,
      ticketmaster: !!process.env.TICKETMASTER_KEY,
      seatgeek: !!process.env.SEATGEEK_CLIENT_ID,
      eventbrite: !!process.env.EVENTBRITE_PRIVATE_TOKEN,
      aviationstack: !!process.env.AVIATIONSTACK_KEY,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      setlistfm: !!process.env.SETLIST_FM_API_KEY,
      weather: true,
      nashville: true
    }
  });
}
