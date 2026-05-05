# Post-Launch Playbook

What was set up after the v1.0 launch (May 5, 2026) and how to maintain or extend each piece.

## Press page

URL: https://howdynash.com/press

Source file: `press.html` at the project root.

Routes through Vercel rewrite in `vercel.json`: `/press` → `/press.html`.

Listed in `sitemap.xml` at priority 0.6 so Google indexes it.

### What's on it

- Hero with logo and tagline
- Quick facts (launched, location, price, platforms, founder, audience)
- Three pre-written descriptions (short 1-line, medium 50 words, long 130 words)
- Four pull quotes pre-cleared for press use
- Founder bio
- 7 brand assets in PNG with download buttons
- 5 app screenshots with labels
- Key features list
- Press contact card
- Interview availability note

### Brand assets in /press-assets/

- `hn-skyline-icon-notext-1024.png` (App Icon)
- `hn-final-gradient-1024.png` (Logo gradient)
- `hn-final-solid-1024.png` (Logo solid)
- `howdynash-og-1200x630.png` (Open Graph)
- `howdynash-skyline-hero-1920x720.png` (Hero banner)
- `howdynash-social-square-1080.png` (Square social)
- `howdynash-social-vertical-1080x1920.png` (Story/Reel)
- 5 app screenshots from `howdynash-ios/app-store-screenshots/`

### When Apple approves the iOS app

Two TODO comments are in `press.html`. Search for "TODO" to find them. Replace per the comment instructions:
1. Platforms fact: `Web (live), iOS (in App Store review)` becomes `Web + iOS`
2. iOS App link: text becomes `<a href="https://apps.apple.com/app/howdy-nash/id6766404935">Download on the App Store</a>`

Then redeploy.

### Press contact

`howdy@howdynash.com` is the public press email. Make sure it forwards to your real inbox or the address bounces and you miss coverage.

### Sending the press kit

Email subject that works: "Free Nashville guide app for your readers (built by a local)"

Body: 3 sentences max, link to howdynash.com/press, offer to send specific data on bachelorette economy.

Five Nashville-relevant outlets to start with:
- Tennessean (food/lifestyle reporter)
- Nashville Scene
- WPLN All Things Considered
- StyleBlueprint Nashville (bachelorette angle)
- Tennessean tech reporter (covers Nashville startups)

## Domain forwarding

Owned domains: howdynash.com (primary), howdynash.co, howdynash.net, howdynash.org.

The three alternates (.co, .net, .org) redirect to howdynash.com via Vercel, not via Namecheap's URL Redirect. This is important because Namecheap's free redirect doesn't include valid SSL on the source, so https://howdynash.co would hit a browser security warning.

### Setup per alternate domain (one-time)

Repeat for each of howdynash.co, howdynash.net, howdynash.org:

1. In Vercel: Project Settings > Domains > Add Domain
2. Type the domain (e.g., howdynash.co)
3. Pick **Redirect to Another Domain** (not Connect to environment)
4. Set status to **308 Permanent Redirect** (preserves SEO)
5. Destination: www.howdynash.com (or whichever Vercel canonical is)
6. Save
7. Vercel shows the DNS records needed (A record at @ pointing to 216.198.79.1 for apex domains)
8. In Namecheap: MANAGE on the domain > Advanced DNS tab
9. Delete any existing URL Redirect Record that might conflict
10. Add the A record from step 7
11. Wait 5-30 min for DNS propagation
12. In Vercel, click Refresh on the domain row. Status flips from "Invalid Configuration" to a green check. SSL provisions automatically.

### Why not Namecheap URL redirect

- Namecheap's free URL redirect serves the source over plain HTTP only
- Modern browsers and link previews default to https
- Anyone clicking https://howdynash.co would hit an SSL warning and bounce

### Test it works

After save and propagation, in a private browser window:
- https://howdynash.co should land on howdynash.com
- https://howdynash.net should land on howdynash.com
- https://howdynash.org should land on howdynash.com

## Content updates (pattern)

The chatbot content lives in `nashville-chatbot.html`. Most additions go in one or more of these arrays:

- `NASHVILLE_DATA.restaurants` (line ~807) - main restaurants list
- `CURATED_HONKY_TONKS` (line ~2868)
- `CURATED_ROOFTOPS` (line ~2922)
- `CURATED_BREWERIES` (line ~2973)
- `CURATED_DISTILLERIES` (line ~2988)
- `CURATED_FREE_THINGS` (line ~3011)
- `CURATED_LINE_DANCING` (line ~3039)
- `CURATED_FAMILY_FRIENDLY` (line ~3052)
- `CURATED_EAST_NASHVILLE_GEMS` (line ~3070)
- `CURATED_BROADWAY_BARS` (line ~3085)
- `CURATED_COCKTAIL_BARS` (line ~3141)
- `CURATED_SHOPPING` (line ~3179)
- `CURATED_SPAS` (line ~3259)
- `CURATED_NAIL_SALONS` (line ~3284)
- `CURATED_WATERFALLS` (line ~3330)
- `CURATED_NASHVILLE_FESTIVALS` (line ~4975)
- `NEIGHBORHOOD_GUIDES` (line ~5526)

### Object shape per list

Restaurants in NASHVILLE_DATA.restaurants:

```js
{ name: "Restaurant Name", cuisine: "Type", neighborhood: "Area", price: "$ to $$$$", vibe: "short descriptor", phone: "(615) ...", note: "optional walk-in or reservations note", booking: { walkin: true, opentable: "url", resy: "url", yelp: "url", tock: "url" } }
```

Curated lists (most others):

```js
{ name: "Spot Name", neighborhood: "Area", desc: "1-2 sentence description", url: "https://example.com" }
```

Some lists also include `coords: { lat: 36.xx, lng: -86.xx }` for the map.

### Example: Assembly Food Hall (added May 5)

This was added to three lists at once because it fits multiple categories:
1. NASHVILLE_DATA.restaurants - cuisine "Food hall"
2. CURATED_BROADWAY_BARS - because it sits at 5th + Broadway with bar component
3. CURATED_FAMILY_FRIENDLY - works for groups with mixed tastes or kids

Same pattern works for any new spot that fits multiple categories.

### Deploy after content edits

```
cd ~/Documents/howdynash && ./deploy.sh "your commit message"
```

Vercel deploys in ~60 seconds. The iOS app loads the live site so changes appear in both web and iOS immediately, no app re-submission needed.

## Tracking and analytics

App Store Connect Analytics (free, built in) covers iOS downloads. Located at appstoreconnect.apple.com > Howdy Nash > Analytics.

Web analytics: deliberately not set up. The privacy policy promises no analytics, no trackers. Don't break that promise without updating privacy.html first.

### Channel attribution for marketing

When pitching journalists, dropping links in TikTok, or posting to Reddit, use App Store Connect campaign URLs to track which sources drive installs:

App Store Connect > App Analytics > Acquisition > Campaigns > Create Campaign URL.

Apple gives a unique URL per source. Use one per channel:
- howdynash.com/app?ct=tiktok-bio
- howdynash.com/app?ct=tennessean-article
- howdynash.com/app?ct=reddit-asknashville

Apple aggregates installs per campaign so you see channel ROI.

## During Apple review (don't break the wrapper)

The iOS app is a webview pointing at howdynash.com. Apple's reviewers load that URL through the wrapper. If they hit a 500 error during review, automatic rejection.

Rules of thumb while waiting for approval:
- Stick to additive changes (new restaurants, new pages) only
- Don't touch the API contract, deploy.sh, or vercel.json routing
- No external payment links, no new account flows, nothing that smells like circumventing in-app purchase rules

After approval, the rules relax. You can refactor freely. Just don't push breaking changes between submission and approval.

## When to consider expansion

CITY_RECOMMENDATIONS.md has the analysis. Threshold to hit before launching city 2:
- 100 daily active users on Nashville
- $500/month revenue from any combination of paths

Until then, press outreach and bachelorette TikTok comments are higher leverage than building city 2.

Top expansion picks in order: New Orleans, Charleston or Austin, Memphis, Savannah.
