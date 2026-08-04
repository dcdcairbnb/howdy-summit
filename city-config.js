// Howdy Summit city configuration. Swap this file to launch in a new market.
// Loaded as a regular script tag, so all values live on window.CITY_CONFIG.
//
// NOTE: as of the Summit County launch nothing loads this file. index.html
// carries its own inline constants and curated data arrays. This config is
// kept as the reference sheet for standing up a new market, and is updated
// alongside the app so it does not drift out of date. If you wire it back in,
// add a <script src="/city-config.js"></script> tag before the main app script.
//
// To launch in a new market (e.g. Jackson Hole):
//   1. Copy this file: city-config.jackson.js
//   2. Update every value below for the new market
//   3. Replace the curated arrays inside index.html with the new market's spots
//   4. Rebrand /logo.jpg, /logo.png, /app-icon.png, manifest.json
//   5. Update api/chat.js SYSTEM_PROMPT, NEIGHBORHOODS, and NEIGHBORHOOD_PICKS
//   6. Repoint the api/* handlers at the new market's lat/lng
//   7. Deploy to a new domain (e.g. howdyjackson.com)
//   8. Submit a new iOS app to the App Store
//
// All market-specific values live here. The HTML and API read from window.CITY_CONFIG.

window.CITY_CONFIG = {
  // Core identity
  cityName: 'Summit County',
  cityShortName: 'Summit',
  state: 'CO',
  stateFull: 'Colorado',
  brandName: 'Howdy Summit',
  brandTitle: 'Howdy Summit: Summit County Guide',
  tagline: "Summit County's Free Travel Concierge",
  domain: 'howdysummitcounty.com',
  url: 'https://howdysummitcounty.com',

  // Visual identity (used by graphics generator and CSS)
  primaryColor: '#d62828',
  secondaryColor: '#f4a200',
  accentColor: '#34a853',

  // Geographic center (used as map default and distance fallback).
  // Frisco/Dillon area, roughly the middle of the six towns.
  centerLat: 39.5744,
  centerLng: -106.0975,

  // Airport. Summit County has no commercial airport of its own; nearly every
  // visitor flies into Denver and drives I-70 west.
  airportCode: 'DEN',
  airportName: 'Denver International Airport',
  airportShortName: 'DEN airport',

  // Towns covered by the app
  towns: ['Breckenridge', 'Frisco', 'Dillon', 'Silverthorne', 'Keystone', 'Copper Mountain'],

  // Ski resorts in and around the county
  skiResorts: ['Breckenridge', 'Keystone', 'Copper Mountain', 'Arapahoe Basin', 'Loveland'],

  // Sports teams (used for the Sports section). No pro teams in the county,
  // so this points at the Denver market that locals actually follow.
  sportsTeams: ['Broncos', 'Nuggets', 'Avalanche', 'Rockies'],

  // Market nicknames and identifiers (used in copy and SEO)
  nicknames: ['Summit County', 'Summit', 'Breck', 'Colorado high country'],

  // What the area is famous for (used in marketing copy)
  signatureFoods: ['craft beer', 'apres-ski', 'green chili'],
  signatureExperiences: ['skiing and snowboarding', 'hiking', 'mountain biking', 'Dillon Reservoir'],

  // Major event categories the area is known for
  eventCategories: ['ski season', 'Oktoberfest', 'snow sculpture championships', 'festivals'],

  // SMS / share message template (use {code} placeholder)
  groupShareMessage: 'Join my Summit County group on Howdy Summit!\nCode: {code}\n\nTap to open and auto-join:\nhttps://howdysummitcounty.com/?join={code}',

  // Email defaults
  fromEmail: 'Howdy Summit <howdy@howdysummitcounty.com>',
  supportEmail: 'howdy@howdysummitcounty.com',

  // App Store / iOS. No published Howdy Summit app yet, so the in-app
  // App Store promo is disabled in index.html until one exists.
  appStoreId: 'com.howdysummit.app',
  appStoreName: 'Howdy Summit',
  iosSchemes: ['https']
};

// Convenience getter for one-liner reads in inline HTML.
// Usage: cityCfg('cityName') returns 'Summit County'
window.cityCfg = function (key, fallback) {
  return (window.CITY_CONFIG && window.CITY_CONFIG[key] != null) ? window.CITY_CONFIG[key] : fallback;
};
