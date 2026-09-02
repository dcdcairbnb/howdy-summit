# Bug scrub: Howdy Summit — 2026-09-01

Modes run: code
Coverage: index.html (router, network layer, state and lifecycle, curated data, platform and iOS compatibility), sw.js, capacitor.config.json, all 12 functions under api/, vercel.json. Every candidate went through an adversarial refutation pass; 9 were dropped and several were scoped down. | Skipped: live mode (no device run), feedback mode (App Store reviews not pulled; app is 3 weeks old), cheatsheet.html beyond seasonForDate, ios/ Swift sources, node_modules.
Commit: 672dc45  App version: 1.0.3 (build 9)  sw: howdysummit-v45

Severity rubric: S1 crash or data loss on a critical path · S2 feature broken or actively misleading · S3 degraded, works but wrong or slow · S4 cosmetic or hygiene. Findings on a config.md critical path were bumped one level.

## Summary

| Sev | Open | Found this run | Fixed this run |
|-----|------|--------------|----------------------|
| S1  | 0    | 3            | 3                    |
| S2  | 2    | 16           | 14                   |
| S3  | 8    | 15           | 7                    |
| S4  | 7    | 7            | 0                    |

S1-S3 counts are BUG entries. S4 is UX-002 plus the six Content accuracy rows. Nine further low-severity router items are listed under Not bugs rather than numbered.

## Top 5 next

1. **BUG-001** Festivals screen throws ReferenceError for anyone standing in a Summit County town with location on — one-character fix, `index.html:9451`
2. **BUG-002** Weather alert banner clips the bottom of the chat off-screen on phones; this is the "Details does nothing in the app" report — `index.html:10758`, `:237-256`
3. **BUG-003** Monsoon rain has never rendered in production; the layer is `display:none` — one CSS selector, `index.html:528`
4. **BUG-004** Group share wipes a live session on any single 5xx from the poll — `index.html:7191`
5. **BUG-005** "avalanche danger" routes to Colorado Avalanche hockey; there is no avalanche safety handler at all — `index.html:2788`

## Open bugs

### BUG-001 — S1 — Festivals list crashes with `s is not defined`
- **Where:** `index.html:9451`
- **Trigger:** Share location while physically in Breckenridge, Frisco, Dillon, Silverthorne, Keystone or Copper, then open Festivals
- **What happens:** Inside `paginateMessages(sorted, f => ...)` the callback reads `s.neighborhood`, but the parameter is `f` and no `s` exists in any enclosing scope. Copy-paste from `renderCuratedCard` at 5241, which correctly uses `s`. The branch `approx && dist < 1` is reachable for anyone in town because no entry in `CURATED_SUMMIT_FESTIVALS` has `coords`, so distance is always the town-centre approximation. `paginateMessages` has no try/catch, so the throw escapes and `navAction` shows "Error loading section."
- **Impact:** Every in-county user with location on loses the entire Festivals screen
- **Evidence:** code scan; refutation agent confirmed no `s` in scope and the branch is reachable
- **Source:** code
- **Confirmed:** suspected (provable ReferenceError, not yet reproduced on device)
- **Status:** fixed (pending push)
- **First seen:** 2026-09-01

### BUG-002 — S1 — Weather banner pushes the chat's bottom edge off-screen on phones
- **Where:** `index.html:10758-10762` (sets `document.body.style.paddingTop`), `:237-242` (`html,body{overflow:hidden;height:100%}` under `@media(max-width:600px)`), `:248-256` (`.container{height:100dvh}`)
- **Trigger:** Any active NWS alert on a phone or in the iOS app, then tap Details
- **What happens:** The fixed banner offsets the page by adding `padding-top` to `body`. But on small screens `body` is `overflow:hidden` and `.container` is a full `100dvh`, so the padding pushes a full-height box down inside a box that cannot scroll. The bottom ~60-110px (input area, bottom nav, tail of `.messages`) is clipped and unreachable. On a notched iPhone the banner is `calc(16px + env(safe-area-inset-top))`, on top of Capacitor's native inset. `showWeather()` appends its cards at the bottom of `.messages`, exactly in the clipped region. Desktop never hits the media query, which is why web works and the app does not. Same defect at `:5165` for the test-time banner.
- **Impact:** Reported by Dan today. Affects every phone user whenever an alert is active, which in Summit County is often.
- **Evidence:** code scan + refutation agent verified all three CSS rules and found no compensating rule
- **Source:** code + user report
- **Confirmed:** suspected (matches the reported symptom exactly; not yet reproduced on device)
- **Status:** fixed (pending push)
- **First seen:** 2026-09-01
- **Compounded by:** BUG-011 (scroll suppression windows), BUG-022 (stale scroll anchor), BUG-031 (weather appends without clearing)

### BUG-003 — S1 — Monsoon mode rain never renders
- **Where:** `index.html:524-529` (`.weather-layer{display:none}`; only `body.powder-mode` and `body.bluebird-mode` get `display:block`) vs `:4672-4674` (`WEATHER_SPECS` defines particles for `powder` and `monsoon`)
- **Trigger:** Turn on Monsoon mode
- **What happens:** 260 `.drop` nodes are built into a layer that stays `display:none`. Palette changes, no rain. Inverse waste: Bluebird gets `display:block` on an empty layer. Introduced 2026-08-27 when Ski Bum was replaced and the display rule was not updated. Dan approved the rain from a browser injection that used its own CSS without the base `display:none`, so it was never seen in the real stylesheet.
- **Impact:** The feature Dan called "perfect" has never shipped
- **Evidence:** code scan; independently verified by grep before the refutation pass
- **Source:** code
- **Confirmed:** yes (grep of the shipped stylesheet)
- **Status:** fixed (pending push)
- **First seen:** 2026-09-01

### BUG-004 — S2 — Group share tears down a live session on any transient server error
- **Where:** `index.html:7191-7197` (poll), `:6892-6903` (`groupApi` returns `{ok, status}` with no 404-vs-5xx distinction)
- **Trigger:** One 500, 502, 503, 429 or 504 from `/api/group` on any 10-second poll tick while a group is live, e.g. a Vercel cold-start failure
- **What happens:** `if (!r.ok)` calls `stopGroupSession()` and `saveGroupSession(null)`, shows "Group ended or expired," and stops location sharing. The file's own comment at 6908-6922 says only definitive gone responses should wipe the session; `showFindGroup` follows that rule, the poller does not.
- **Impact:** A whole group's live map dies on one blip
- **Evidence:** code scan; refutation confirmed no retry and no status branching
- **Source:** code
- **Confirmed:** suspected
- **Status:** fixed (pending push)
- **First seen:** 2026-09-01

### BUG-005 — S2 — "avalanche danger" routes to NHL hockey; no avalanche safety intent exists
- **Where:** `index.html:2788` (sports guard keyword `'avalanche'`)
- **Trigger:** Type "avalanche danger", "avalanche conditions", "avalanche report" or "avalanche forecast"
- **What happens:** `showSports()` renders Colorado Avalanche game data. Simulation confirmed no earlier guard fires. Separately, there is no avalanche or CAIC handler anywhere in `routeIntent`; the only CAIC text is a static string inside the snowmobile card at 6354.
- **Impact:** A safety query in a backcountry county returns a hockey schedule
- **Evidence:** router simulation
- **Source:** code
- **Confirmed:** suspected
- **Status:** fixed (pending push)
- **First seen:** 2026-09-01

### BUG-006 — S2 — `'eat'` and `'food'` substrings hijack seven unrelated intents
- **Where:** `index.html:3012` (restaurant catch-all guard)
- **Trigger:** Type any of: "amphitheater" / "dillon amphitheater" (live music), "uber eats" / "order food" (delivery), "whole foods" (groceries), "cheat sheet" (free guide signup), "iv treatment" (altitude), "off the beaten path" (local gems), "food tour"
- **What happens:** `matches()` is substring-based; `th-EAT-er`, `ch-EAT`, `tr-EAT-ment`, `b-EAT-en` all contain `eat`. All seven land on `showRestaurantOptions()`. Their intended guards at 3029, 3283, 3045, 3162, 3070, 3085, 3318 are unreachable for these phrases. "cheat sheet" is the one that costs signups.
- **Impact:** Highest blast-radius keyword in the router
- **Evidence:** router simulation, each phrase walked in guard order
- **Source:** code
- **Confirmed:** suspected
- **Status:** fixed (pending push)
- **First seen:** 2026-09-01

### BUG-007 — S2 — Chat daily budget guard is dead: per-call cost rounds to zero cents
- **Where:** `api/chat.js:683` (`addTodaySpend(Math.round(callCostUsd * 100))`); `:682` computes `callCostCents` correctly and never uses it
- **Trigger:** Any Haiku call (~$0.001-0.004) → `Math.round(0.3) === 0` → `incrby 0`
- **What happens:** `spentCents` stays at 0, so `spentCents >= budgetCents` at 608 never trips and the 80% alert email at 686 never sends. Sonnet calls accrue 1-3¢, so it leaks rather than fully no-ops.
- **Impact:** `DAILY_BUDGET_USD` is unenforced for the model that handles most traffic
- **Evidence:** code scan; refutation confirmed `callCostCents` is dead
- **Source:** code
- **Confirmed:** suspected
- **Status:** fixed (pending push)
- **First seen:** 2026-09-01

### BUG-008 — S2 — No upstream timeouts in weather, events or festivals; one slow provider stalls the whole response
- **Where:** `api/weather.js:8, 134, 256, 337, 403, 420` (all six upstream calls, 403→420 sequential); `api/events.js:51, 102, 151`; `api/festivals.js:117, 170`; both events and festivals `Promise.all` their sources at `events.js:230`, `festivals.js:317`
- **Trigger:** weather.gov, CDOT, Open-Meteo, SeatGeek, Eventbrite or Ticketmaster latency spike
- **What happens:** A hung upstream burns the full 10s Hobby limit and the client gets Vercel's raw 504, not the handler's friendly catch. In events/festivals the per-source catch-to-`[]` only handles errors, not hangs, so the slowest provider gates everything even when the others returned. `/api/weather` is the highest-traffic path in the app (8 call sites in index.html).
- **Impact:** Weather, roads, snow, storm clock, What's Happening and Festivals all go dark together on a slow upstream
- **Evidence:** static_checks + grep confirmed zero `AbortSignal`/`signal` in weather.js
- **Source:** code
- **Confirmed:** suspected
- **Status:** fixed (pending push)
- **First seen:** 2026-09-01

### BUG-009 — S2 — Every après bar shows a 2am close, computed in the viewer's own timezone
- **Where:** `index.html:5121` (`defaultClosingTime` returns `'02:00'` for any label containing `apres`); `:5184-5190` and `:8412` (`new Date()` local, no America/Denver normalization)
- **Trigger:** Open Après-ski bars between 00:30 and 02:00; or plan from Eastern time at 11pm ET
- **What happens:** Zero `closesAt` overrides exist in the data (all 10 occurrences of `closesAt` are code). The list mixes 2am Main Street bars with slopeside bars that shut with the lifts (T-Bar, The Maggie, Jack's Slopeside, 6th Alley, The Beach at A-Basin at 5366-5378). Badge window is 90 minutes before close, so at 1am the card says "Last call in 30m" for a bar closed since 5pm. Separately, every open/closed calculation runs on the device clock, so a planner two zones east sees CLOSED badges two hours early and the "Quiet mountain night" greeting at 9pm Mountain.
- **Impact:** Actively wrong at the exact hour someone acts on it
- **Evidence:** code scan; refutation confirmed zero data overrides
- **Source:** code
- **Confirmed:** suspected
- **Status:** fixed (pending push)
- **First seen:** 2026-09-01

### BUG-010 — S2 — Snow report and storm clock cache forever
- **Where:** `index.html:10920, 10927, 10942` (`cachedSnowData`); `:11008, 11015, 11030` (`cachedStormData`)
- **Trigger:** Open either screen, background the app, reopen hours or days later
- **What happens:** Both are `cached || await fetch()` with no TTL, no timestamp, no clear. Neither `visibilitychange` handler touches them and, unlike roads, there is no background refresh interval. The Capacitor webview persists across backgrounding. The storm clock drives a lightning-safety decision, so a 7am `turnaroundHour` is replayed at 11am after NWS upgraded the afternoon.
- **Impact:** Safety content presented as current when it is hours old
- **Evidence:** code scan; grep shows exactly three references each
- **Source:** code
- **Confirmed:** suspected
- **Status:** fixed (pending push)
- **First seen:** 2026-09-01

### BUG-011 — S2 — Scroll suppression windows make banner Details appear to do nothing
- **Where:** `index.html:11134-11144` (`openWeatherDetails` single 300ms retry), `:2676-2677` (`scrollToView` returns early on `suppressAutoScroll`), `:10604`/`:10655` (boot sets it true at +300ms, clears at +2300ms), `:2663`/`:2672` (`navAction` sets it for 2500ms)
- **Trigger:** Tap Details within ~2.3s of app load or within 2.5s of any menu tap
- **What happens:** Cards append, nothing scrolls, and nothing re-scrolls when suppression lifts. `showWeather`'s fetch takes up to 8s, so content lands long after the one retry anyway.
- **Impact:** Second cause of the reported Details bug; independent of BUG-002
- **Evidence:** code scan; refutation confirmed the exact timing values
- **Source:** code + user report
- **Confirmed:** suspected
- **Status:** fixed (pending push)
- **First seen:** 2026-09-01

### BUG-012 — S2 — Weekly newsletter cron is not configured; it has never run automatically
- **Where:** `vercel.json` (no `crons` key; only rewrites and headers); `api/subscribe.js:472` (handler exists and correctly fails closed on missing `CRON_SECRET`)
- **Trigger:** Wait for a Friday
- **What happens:** Nothing calls the path. The only way the newsletter goes out is a manual `POST {action:'newsletter-send'}`.
- **Impact:** Subscribers signed up for a weekly email that does not exist
- **Evidence:** refutation agent confirmed no crons in vercel.json and no .github/workflows
- **Source:** code
- **Confirmed:** yes (config inspection)
- **Status:** needs decision (see note below)
- **First seen:** 2026-09-01

### BUG-013 — S2 — Newsletter send is serial and will be killed mid-loop past ~25 subscribers
- **Where:** `api/subscribe.js:433-451` (serial `for` with awaited `resend.emails.send`), preceded by three un-timed self-fetches at `:329, 341, 353`
- **Trigger:** Subscriber list exceeds a few dozen rows
- **What happens:** At ~200-400ms per send, the 10s Hobby limit hits mid-loop. There is no per-row sent marker, so a retry re-emails everyone already delivered and still never reaches the tail.
- **Impact:** Latent now, certain as the list grows
- **Evidence:** code scan; refutation confirmed no `maxDuration` anywhere in repo
- **Source:** code
- **Confirmed:** suspected
- **Status:** needs decision (see note below)
- **First seen:** 2026-09-01

### BUG-014 — S2 — Trip summary says "Safe to end" even when some emails failed
- **Where:** `index.html:4361` (`summarySentAt` set when `sentCount > 0`), `:4376-4382` (`endTrip` branches on `summarySentAt` alone)
- **Trigger:** 5-person trip, one member's send times out or bounces, then tap End trip
- **What happens:** The failure IS surfaced at 4368 as "N failed," but the destructive confirm then prints "Each person has their email. Safe to end." and clears all expense data. The member whose send failed has no record.
- **Impact:** Money-tracking data loss on a false reassurance
- **Evidence:** code scan; refutation narrowed the claim to this half
- **Source:** code
- **Confirmed:** suspected
- **Status:** fixed (pending push)
- **First seen:** 2026-09-01

### BUG-015 — S2 — "Open in Maps" sends day-trip destinations to Summit County
- **Where:** `index.html:5346` (`maps/search/${s.name} Summit County CO` when no live `mapsUrl`)
- **Trigger:** Tap Open in Maps on Rifle Falls, Hanging Lake, Fish Creek Falls, Booth Falls or Iron Mountain Hot Springs
- **What happens:** These entries are explicitly out of county in their own copy ("Rifle, 2.5 hours west," "Glenwood Canyon," "Steamboat"). The Maps query appends "Summit County CO" and lands nowhere near them. These are exactly the items where navigation matters most.
- **Impact:** Wrong directions on the longest drives in the app
- **Evidence:** code scan; refutation confirmed the render path
- **Source:** code
- **Confirmed:** suspected
- **Status:** fixed (pending push)
- **First seen:** 2026-09-01

### BUG-016 — S2 — Curated festival rows always empty in the newsletter; doubled upstream fan-out on the Festivals screen
- **Where:** `api/festivals.js:292-346` (only special-cases `source==='visitmusiccity'`; combined path returns key `festivals`); `api/subscribe.js:332, 344` (reads `data.events` → always `[]`); `index.html:9369-9376` (reads `data.events` from the `?source=local` call → empty; the second call at 9382 correctly reads `data.festivals`)
- **Trigger:** Build a newsletter; open Festivals
- **What happens:** The `?source=local` response has no `events` key. The newsletter's curated/local section is silently empty. On the Festivals screen the two `Promise.all` calls differ only by lat/lng and both resolve to the same combined handler, so Ticketmaster and Eventbrite are hit twice per page load for one usable result.
- **Impact:** Empty newsletter section; 2× quota burn
- **Evidence:** code scan; refutation corrected the original claim about 9382
- **Source:** code
- **Confirmed:** suspected
- **Status:** fixed (pending push)
- **First seen:** 2026-09-01

### BUG-017 — S2 — `newsletter-preview` and `eater-debug` are unauthenticated and unrated
- **Where:** `api/subscribe.js:524, 530` (handled before the only `checkRateLimit` at 700; no `ADMIN_TOKEN` check, unlike `newsletter-send` at 555-558)
- **Trigger:** `curl -XPOST /api/subscribe -d '{"action":"newsletter-preview"}'` in a loop
- **What happens:** Each preview triggers the full aggregator fan-out (Ticketmaster, SeatGeek, Eventbrite, Summit Daily RSS). `eater-debug` additionally returns a 500-char raw sample of each upstream body.
- **Impact:** Metered upstream spend and a small fetch amplifier, open to anyone
- **Evidence:** code scan; refutation confirmed ordering
- **Source:** code
- **Confirmed:** suspected
- **Status:** fixed (pending push)
- **First seen:** 2026-09-01

### BUG-018 — S2 — Router keyword shadows: five later guards are unreachable for their own phrases
- **Where:** `index.html:2803` (`'tours'` beats 3055 distilleries, 3060 breweries, 3128 jeep for "distillery tours", "brewery tours", "jeep tours"); `:2962` (`'bakery'`/`'pastry'` in breakfast beats 3065 bakeries); `:3098` (`'vail pass'` in snowmobile beats 3234 roads for "is vail pass open"); `:3110` (`'ski shop'` in gear rental beats 3204 shopping, contradicting the comment at 3117-3119); `:2822` (`'powder day'` beats 2827 modes for "powder day mode"); `:3209` (`'where to stay'` beats 3267 towns); `:2798` (`'forecast'` beats 2822 for "snow forecast")
- **Trigger:** Any phrase listed above
- **What happens:** First substring match wins. The later, more specific guard is dead for that phrase. The `'vail pass'` case matters most: a winter closure question returns snowmobile trails.
- **Impact:** Seven common phrasings land on the wrong screen
- **Evidence:** router simulation, every phrase walked in order
- **Source:** code
- **Confirmed:** suspected
- **Status:** fixed (pending push)
- **First seen:** 2026-09-01

### BUG-019 — S2 — Weather and road banners fight over `body.paddingTop`
- **Where:** `index.html:10762` (weather sets own height only), `:10725` (sets `''` when alerts clear), `:10886-10888` (road sets `wxH + roadH`); refresh intervals at `:10665` (5 min) and `:10671` (3 min)
- **Trigger:** Both banners active, wait for the 5-minute weather refresh
- **What happens:** Last writer wins. Padding drops to weather-only height and the fixed road banner (top: `wxH`, z-index 9998) covers the header and back button. If alerts clear while roads stay, padding goes to `''` and the road banner floats over content.
- **Impact:** Header unreachable during exactly the conditions both banners exist for
- **Evidence:** code scan; refutation confirmed
- **Source:** code
- **Confirmed:** suspected
- **Status:** fixed (pending push)
- **First seen:** 2026-09-01

### BUG-020 — S3 — `group.js` leaks raw Redis errors to the client
- **Where:** `api/group.js:339` (`detail: (e && e.message) || 'unknown'`)
- **Trigger:** Any Upstash fault, e.g. a rotated KV token
- **What happens:** Messages like `WRONGPASS invalid or missing auth token` and connection details ship in the 500 body. Every other handler returns a bare "internal server error." Note the earlier startup-crash claim was refuted: the Upstash SDK warns rather than throws on a missing URL, so the 503 guard at 127 does run.
- **Impact:** Information leak
- **Evidence:** code scan
- **Source:** code
- **Confirmed:** suspected
- **Status:** fixed (pending push)
- **First seen:** 2026-09-01

### BUG-021 — S3 — `flights.js` sends the API key over plain HTTP and forwards upstream errors verbatim
- **Where:** `api/flights.js:14-15` (`http://api.aviationstack.com` with `access_key` in query), `:26` (`detail: text`), `:11, 19, 21` (`airport`/`limit` unvalidated; repeated `?airport=` param becomes an array → `.toUpperCase` TypeError → generic 500)
- **Trigger:** Every DEN flight-tracker load; or `?airport=a&airport=b`; or `?limit=99999`
- **What happens:** Key crosses the network in cleartext (AviationStack free tier is http-only, which explains but does not excuse it). Unbounded `limit` burns a 100-request/month quota.
- **Impact:** Credential exposure on hostile networks; quota abuse
- **Evidence:** code scan
- **Source:** code
- **Confirmed:** suspected
- **Status:** open
- **First seen:** 2026-09-01

### BUG-022 — S3 — Weather cards append below a stale scroll anchor
- **Where:** `index.html:2678-2680` (`scrollToView` prefers `scrollAnchor`), `:2637-2639` (anchor is the last USER message; bot messages never update it)
- **Trigger:** Type anything, then tap banner Details
- **What happens:** `scrollIntoView({block:'start'})` scrolls to the old typed message; the new weather cards sit below the fold.
- **Impact:** Third contributor to the Details bug
- **Evidence:** code scan
- **Source:** code
- **Confirmed:** suspected
- **Status:** fixed (pending push)
- **First seen:** 2026-09-01

### BUG-023 — S3 — Banner Details buttons have no debounce
- **Where:** `index.html:10772, 10779, 10905`
- **Trigger:** Double-tap Details (easy on a small fixed button)
- **What happens:** `showWeather()` runs twice: two "Pulling the forecast..." lines and two full sets of alert, forecast and "Next few days" cards.
- **Impact:** Duplicate content
- **Evidence:** code scan
- **Source:** code
- **Confirmed:** suspected
- **Status:** fixed (pending push)
- **First seen:** 2026-09-01

### BUG-024 — S3 — `weather.js` interpolates unvalidated lat/lng into the upstream URL path
- **Where:** `api/weather.js:399-403` and `:8`; contrast `events.js:220`, `festivals.js:278-288`, `places/search.js`, `restaurants/search.js`, which all use `validCoord()`
- **Trigger:** `GET /api/weather?lat=../../x`
- **What happens:** Crafted path reaches weather.gov; upstream 4xx is mirrored to the client at 410; `Number(lat)` echoes back as `NaN`.
- **Impact:** Inconsistent boundary validation; low exploitability
- **Evidence:** grep shows zero `validCoord` in weather.js
- **Source:** code
- **Confirmed:** suspected
- **Status:** open
- **First seen:** 2026-09-01

### BUG-025 — S3 — Chat: Places lookup has no timeout and the 15s Claude abort can never fire under the 10s cap
- **Where:** `api/chat.js:435` (bare fetch), `:624` (awaited before Claude), `:659` (`fetchWithTimeout(..., 15000)`), `:704` (AbortError→504 branch)
- **Trigger:** Slow Google Places or a long Sonnet reply
- **What happens:** No `maxDuration` is configured anywhere, so Hobby's 10s applies. The 15s abort is unreachable; the user gets an opaque platform 504 instead of the handler's "chat service timed out" JSON.
- **Impact:** Wrong error surface on the chatbot
- **Evidence:** code scan; refutation confirmed no maxDuration in repo
- **Source:** code
- **Confirmed:** suspected
- **Status:** open
- **First seen:** 2026-09-01

### BUG-026 — S3 — `daysUntilFestival` reads the day number from the wrong field
- **Where:** `index.html:9349` (`(festival.month || '').match(/(\d{1,2})/)`); day lives in `festival.dates`
- **Trigger:** Any date; visible on Dec 16-31 (NYE bonfire sorts as ~350 days out) and July 1-4
- **What happens:** All 28 entries have a bare month word in `month`, so the regex never matches and every festival is treated as the 15th. Display uses `dates||month` so only sort order is wrong.
- **Impact:** Festivals mis-sorted on the days people want them
- **Evidence:** code scan; refutation confirmed all 28 rows
- **Source:** code
- **Confirmed:** suspected
- **Status:** fixed (pending push)
- **First seen:** 2026-09-01

### BUG-027 — S3 — NWS alert text and third-party names injected into innerHTML unescaped
- **Where:** `index.html:8798-8805` (`a.event`, `a.headline`, `a.areaDesc`, `a.description`, `a.instruction`); `:5341` (`${s.name}` Places), `:5291-5293`, `:9423` (`${f.name}` Ticketmaster), `:9822` (`${e.name}`). Contrast `:10765-10766` and `:10894-10898`, which escape the same class of data with `.replace(/</g,'&lt;')`, and `jsAttr()` which is used consistently for the attribute context.
- **Trigger:** An alert or a business name containing `<`. Places business names are attacker-settable.
- **What happens:** Broken markup at minimum; script execution if the proxy or upstream is compromised.
- **Impact:** Defense-in-depth gap; the escaping exists elsewhere in the file
- **Evidence:** code scan
- **Source:** code
- **Confirmed:** suspected
- **Status:** open
- **First seen:** 2026-09-01

### BUG-028 — S3 — `places/search.js` parses JSON before checking status and forwards Google's raw error
- **Where:** `api/places/search.js:120-121`; contrast `restaurants/search.js:103` which orders it correctly; `:111` also has no timeout
- **Trigger:** Google quota exhaustion, invalid key, or an HTML error page from an edge
- **What happens:** Non-JSON body throws SyntaxError → generic 500 hiding the real cause. JSON error → Google's object (quota state, project identifiers) forwarded to the browser.
- **Impact:** Diagnostics lost; internal details leaked
- **Evidence:** code scan
- **Source:** code
- **Confirmed:** suspected
- **Status:** fixed (pending push)
- **First seen:** 2026-09-01

### BUG-029 — S3 — Nashville remnants: a dead scraper occupies one of 12 function slots and bug reports go to the wrong inbox
- **Where:** `api/venue-calendars.js` (118 lines of Bluebird/Station Inn/Ryman/Opry scrapers, dead-returning at 100, still called from `index.html:9932`); `api/festivals.js:296-305` (serves `?source=visitmusiccity` and echoes the VMC URL), `:208` (`fetchNashvilleSpecialEvents`), `:269` (`nashville-open-data` whitelist); `api/subscribe.js:62` (`ERROR_REPORTER_TO = 'howdynashhq@gmail.com'`), `:341` (fetches visitmusiccity on every newsletter build)
- **Trigger:** Any Summit bug report; any newsletter build; `GET /api/festivals?source=visitmusiccity`
- **What happens:** The 12-function cap is what forced `weather.js` to multiplex roads, snow and storm onto one endpoint. One slot is spent on a Nashville scraper that returns nothing. Every Summit error report lands in Nash's inbox.
- **Impact:** Misrouted reports; a scarce slot wasted
- **Evidence:** code scan; all five sub-claims verified
- **Source:** code
- **Confirmed:** yes (grep)
- **Status:** partially fixed (inbox rerouted; scraper + slot still open)
- **First seen:** 2026-09-01

### BUG-030 — S3 — `venue-calendars` fetch is the only one with no timeout; a hung socket silently drops the always-on venues
- **Where:** `index.html:9932`
- **Trigger:** Captive portal or half-open socket on hotel/lift-line wifi
- **What happens:** Neither `.then` nor `.catch` fires, so `renderAlwaysOnVenues()` never runs. Live Music ends after the API block with no error. A Vercel 504 does recover it; this needs a network-layer stall.
- **Impact:** Bounded, but silent
- **Evidence:** code scan
- **Source:** code
- **Confirmed:** suspected
- **Status:** open
- **First seen:** 2026-09-01

### BUG-031 — S3 — `showWeather` appends without clearing or pushing the menu stack
- **Where:** `index.html:8770-8834`; contrast `navAction` at 2653-2657
- **Trigger:** Tap Details from any section
- **What happens:** Weather cards pile onto whatever was on screen; the back button skips the weather view. Correct behavior when entered from typed text; wrong from the banner. Makes BUG-022 and BUG-023 visible.
- **Impact:** Navigation inconsistency
- **Evidence:** code scan
- **Source:** code
- **Confirmed:** suspected
- **Status:** fixed (pending push)
- **First seen:** 2026-09-01

### BUG-032 — S3 — Report-an-issue button sticks on "Sending..." on a stalled connection
- **Where:** `index.html:2227-2236` (no timeout), `:2223` (`disabled=true`), `:2252` (only re-enabled in catch)
- **Trigger:** Submit while the connection stalls
- **What happens:** Fetch never settles, catch never runs, button stays disabled. Recoverable by closing and reopening the modal (2177 resets it), but there is no feedback telling the user to.
- **Impact:** Bounded
- **Evidence:** code scan
- **Source:** code
- **Confirmed:** suspected
- **Status:** open
- **First seen:** 2026-09-01

### BUG-033 — S3 — Sports screen fetches six teams sequentially, up to 60 seconds
- **Where:** `index.html:8858-8862` (`for...of` with awaited fetch, 10s timeout each); `Promise.all` is used correctly at 9369
- **Trigger:** `/api/events` slow (Ticketmaster outage)
- **What happens:** Cards trickle in one at a time; the last can be a minute out.
- **Impact:** Slow, not broken
- **Evidence:** code scan
- **Source:** code
- **Confirmed:** suspected
- **Status:** open
- **First seen:** 2026-09-01

### BUG-034 — S3 — Holiday typed queries print a past date as upcoming
- **Where:** `index.html:5525` (`holiday.getDate(new Date().getFullYear())`, no rollover); the auto-surfacing path at 5510-5518 is separately guarded
- **Trigger:** Type "mother's day" in September
- **What happens:** "Mother's Day is Sunday, May 10," four months in the past.
- **Impact:** Wrong date
- **Evidence:** code scan
- **Source:** code
- **Confirmed:** suspected
- **Status:** fixed (pending push)
- **First seen:** 2026-09-01

## UX bugs

### UX-001 — S3 — Silent failures leave "no data" indistinguishable from "could not check"
- **Where:** `index.html:10781-10783` (weather banner catch), `:10907-10909` (road banner catch), `:10820` (`refreshRoadPillLabel` returns early on null → pill reads the neutral "🚧 Roads")
- **Trigger:** `/api/weather` down at app launch during an actual I-70 closure
- **What happens:** No banner, and the pill looks exactly like "no closures." Mitigated one tap deeper: `showRoadConditions` does say "Could not reach CDOT." A stale weather banner also survives a failed refresh (10719 `if(!r.ok) return` skips the clear path), which is arguably fail-safe for a warning.
- **Impact:** The single most disruptive condition in the county can be invisible
- **Source:** code
- **Status:** open

### UX-002 — S4 — Group GPS and poll are never stopped on hide
- **Where:** `index.html:7159` (`watchPosition`), `:7273` (10s `setInterval`), cleared only in `stopGroupSession` at 7483-7485; the `visibilitychange` handler at 1481 returns early unless visible
- **Trigger:** Background a web tab during a group session
- **What happens:** On the web, high-accuracy GPS and the poll keep running. On iOS the webview is suspended so this does not drain the battery there; the original claim was downgraded on that basis.
- **Impact:** Hygiene on web only
- **Source:** code
- **Status:** open

## Content accuracy

Wrong listing data found this run.

| Listing | Problem | Source |
|---------|---------|--------|
| Aurum (`index.html:1171` vs `:1202`) | Listed twice as "Aurum Breckenridge" (walk-in only) and "Aurum Food & Wine" (OpenTable). Same restaurant, contradictory booking. `nameKey()` does not dedupe them. | code |
| STEEP tiki bar (`:5404`) | "run by STEEP Brewing since 2026" — the current year; reads as brand-new and goes stale silently. Verify the intended year. | code |
| Cutthroat Anglers (`:5822` vs `:5882`), Blue River Anglers (`:5823` vs `:5884`) | Duplicated with garbled copy: "voted the best outfitter in Summit County River Gold Medal water" is a broken sentence. | code |
| `CURATED_ROOFTOPS` (`:5421, 5423, 5424`) | Aurum creekside patio, Dillon Dam Brewery patio, Sauce on the Blue patio are ground-level, not rooftops. Three of fourteen. | code |
| Summit County race calendar (`:8866`) | `team.keyword.split(' ')[1]` is `undefined` for the single-word keyword `'Breckenridge'`, so `.includes('undefined')` never matches. The row can never show a live event. | code |
| `seasonForDate` (`cheatsheet.html:705`) | Hand-copied duplicate of `currentSeason` (`index.html:4556`); a threshold change in one silently desyncs the other. Comment at 704 admits it. | code |

## Not bugs

Checked and cleared this run:

- `_flightsCache` (`:9044`) is write-only dead state; the filter reads DOM attributes, not the cache. Original claim was a misread.
- The error reporter (`:1348-1368`) dedupes on `message::line` and caps at 5, so the unhandled rejection in the group `watchPosition` callback produces one POST per session, not one per tick.
- `API_BASE` TDZ (`:1362` vs `:1576`): the only code between them is declarations and a fully try/catch-wrapped IIFE; no trigger.
- Road fetch race (`:10800`): the user-tap path only fetches while the cache is null, a sub-2s window with identical upstream data.
- `group.js:21` module-scope `new Redis()`: the installed SDK (`node_modules/@upstash/redis/nodejs.mjs:204-218`) warns on missing config, does not throw. The 503 guard runs.
- Apex vs www origin split: Vercel's domain-level 308 collapses them; the apex strings at 6825/7948/7979/7992 are cosmetic inconsistency.
- Banner intervals (`:10665, :10671`) are registered once in the boot block; no accumulation. `onclick` is assigned, not added.
- `openApp` visibility listener leak (`:1873`) is self-limiting; every accumulated handler fires and removes itself on the next hide.
- Chat catch not pushing `llmHistory` on a failed turn is correct; recording a user turn with no assistant turn would malform the next request.
- Platform scan came back clean: no `structuredClone`, `Array.at`, `findLast`, `Object.hasOwn`, regex lookbehind, `:has()`, `crypto.randomUUID`, `requestIdleCallback`, `URL.canParse`. Every `100dvh` has a `100vh` fallback. All three `navigator.share` sites are guarded. All 13 `window.Capacitor` references are guarded. `getPositionCompat` handles denial. External links open in the system browser via Capacitor's navigation delegate; the narrow `allowNavigation` list is correct.
- `paginateMessages` and `showCuratedListPaged` pagination math is correct; empty lists are guarded.
- Old Dillon Inn: fully absent from both files.
- CORS is applied globally by `vercel.json:55-68` for `/api/*`; handlers without their own headers are covered.
- All four Resend calls in `subscribe.js` correctly destructure and check `error`.
- `unsubscribe.js` and `subscribe.js:783` use parameterized SQL.

Low-severity router items not promoted to bugs: `'pee'` (`:3224`) catches "speed limit"; `'market'` (`:3045`) catches "farmers market" (curated farmers-market data exists at 5606 and is unreachable by name); `'Whiskey'` pill (`:4435`) works only via the `_expectingSearchQuery` flag; `lower === '⛈️ Storm clock'` (`:2815`) can never match (uppercase) and survives only on its keyword array; two sub-blocks of the "catch before LLM" section (`:3313` hotels, `:3328` rentals) are fully shadowed while the others are live; `'share location'` at `:3272` is dead but the guard itself is reachable via other keywords.

## Stale

None; first run.

## Needs a decision, not a fix

**BUG-012 / BUG-013 (newsletter cron and serial send).** Adding a `crons` entry to `vercel.json` would start emailing every subscriber weekly. That is a product call, not a bug fix, and it should not go on until BUG-013 is addressed, because the serial send is killed by the 10s limit past roughly 25 subscribers and has no per-row sent marker, so a retry double-sends. Options: (a) leave off, (b) batch the send via Resend's batch endpoint and add a sent-at column, then enable the cron. Not touched in this pass.

**BUG-029 (Nashville remnants).** The bug-report inbox is rerouted to howdy@howdysummitcounty.com. Deleting `api/venue-calendars.js` to free the function slot needs a decision on whether the live-music venue list should be replaced with something real or removed from the menu.

## Resolved this run

| ID | Title | Fixed in |
|----|-------|----------|
| BUG-001 | Festivals `s is not defined` (three sites, not one: 9451, 10049, 10132) | this commit |
| BUG-002 | Banner clips the chat on phones; `syncBannerOffset()` + container subtracts `--banner-h` | this commit |
| BUG-003 | Monsoon rain never rendered | this commit |
| BUG-004 | Group poll only ends on 404/410 | this commit |
| BUG-005 | Avalanche safety guard + `showAvalancheSafety()` linking CAIC | this commit |
| BUG-006 | `eat`/`food` exclusion; also `uber` no longer swallows "uber eats" | this commit |
| BUG-007 | Chat spend tracked in 1/100-cent units; budget guard now trips | this commit |
| BUG-008 | Timeouts on all 12 upstream fetches in weather, events, festivals | this commit |
| BUG-009 | Après bars get no default countdown; all time logic on Mountain time via `mountainNow()` | this commit |
| BUG-010 | Snow and storm caches expire after 30 min | this commit |
| BUG-011, 022, 023, 031 | Details routes through `navAction` with a debounce | this commit |
| BUG-014 | `summarySentAt` only on a clean sweep | this commit |
| BUG-015 | Maps query uses the entry's own town | this commit |
| BUG-016 | Festivals response carries both `festivals` and `events` | this commit |
| BUG-017 | `newsletter-preview` and `eater-debug` require `ADMIN_TOKEN` | this commit |
| BUG-018 | Seven keyword shadows; `snow forecast` now owned by snow report | this commit |
| BUG-019 | One owner of `body.paddingTop` | this commit |
| BUG-020 | `group.js` no longer echoes Redis errors | this commit |
| BUG-026 | `daysUntilFestival` reads `dates` | this commit |
| BUG-028 | `places/search.js` checks status before parsing | this commit |
| BUG-034 | Holiday date rolls to next year | this commit |

## Fixed during this session, before the scrub

| Issue | Fixed in |
|-------|----------|
| `AbortSignal.timeout` undefined on iOS 15 (13 call sites, deployment target 15.0); every fetch threw before sending | `672dc45` |
| Dispensary lookup passed `null` type, which the API defaulted to `tourist_attraction`; returned zero results with a 200 | `1543af5` |
| Dispensary results included Alma, Avon and Fairplay via the 35-mile radius fallback | `e4716f4` |
| Nash's Colorado Airbnb link pointed at a listing that no longer loads | `bab43b8` (howdynash) |
