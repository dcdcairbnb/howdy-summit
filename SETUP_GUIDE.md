# Howdy Nash Setup Guide

Complete setup documentation for the Nashville tourist chatbot. Reference this whenever you need to remember how something is wired or onboard a partner.

Last updated: May 8, 2026

---

## What This Is

Howdy Nashville is a conversational tourism chatbot for Nashville visitors. Users get restaurant picks, live music listings, festivals, ride-share deep links, food delivery, vacation rentals, hotels, weather, BNA flight tracking, and AI-powered Q&A about the city.

The site is mobile-first, free to use, no signup required.

Live URL: https://howdynash.com

---

## Architecture

Static HTML chatbot served from Vercel.

Vercel serverless functions handle API proxying and the LLM call.

Real-time data pulled from nine integrated services.

GitHub triggers Vercel auto-deploy on every push to main.

Local deploy.sh script automates the push workflow.

Stack summary:

- Frontend: single HTML file with vanilla JavaScript and CSS
- Backend: Vercel serverless functions in /api directory
- LLM: Anthropic Claude Haiku 4.5 via /api/chat endpoint
- Hosting: Vercel hobby plan (free)
- CI/CD: GitHub auto-deploy to Vercel on push
- Domain: howdynash.com (custom domain pending)

---

## Accounts You Need

Required accounts (cannot run without these).

GitHub. Free. Stores the codebase.

Vercel. Free hobby plan. Hosts the live site.

Anthropic. Pay-as-you-go. Powers the AI chat. Min credit $5 to start.

Free API accounts (essential for full functionality).

Foursquare Places. Free tier 1000 requests per day.

Google Cloud Platform. Free tier $200 monthly credit. Used for Places API.

Ticketmaster Developer. Free.

SeatGeek Platform. Free.

Eventbrite Developer. Free.

AviationStack. Free tier 100 requests per month.

Affiliate programs (revenue path).

Viator Partner. Free, instant approval. Pays 8% on tour bookings.

GetYourGuide Partner. Free. Pays 8% on tour bookings.

Awin. Free. Handles Airbnb and Booking.com partnerships.

CJ Affiliate. Free. Handles VRBO partnership.

Expedia Partner Network (EPN). Free, 24-48 hour approval. Pays 4-6% on hotel bookings.

---

## One-Time Setup Steps

### Step 1. Create GitHub repo

Login at github.com.

Create a new repo named "howdynash". Set to public.

Note the repo URL: https://github.com/YOUR_USERNAME/howdynash.git

### Step 2. Create Vercel project

Login at vercel.com using GitHub OAuth.

Click "Add New, Project".

Import your GitHub repo "howdynash".

Use default build settings (no build command needed).

Click Deploy.

Vercel gives you a URL like https://howdynash.com

### Step 3. Get API keys

Foursquare. Sign up at https://foursquare.com/developers. Create a new project. Get the API key. Add new endpoint domain (places-api.foursquare.com).

Google Cloud Console. Sign up at console.cloud.google.com. Create project. Enable Places API (New). Create credentials, API key. Set restrictions to None or specific HTTP referrer.

Ticketmaster. Sign up at developer.ticketmaster.com. Create new app. Get Consumer Key.

SeatGeek. Sign up at https://platform.seatgeek.com. Create app. Get Client ID.

Eventbrite. Sign up at eventbrite.com. Account Settings, Developer Links, API Keys. Generate Private Token.

AviationStack. Sign up at aviationstack.com. Pick Free plan. Get API key from dashboard.

Anthropic. Sign up at console.anthropic.com. Add $5 credit minimum. Settings, API Keys, Create Key. Copy the sk-ant- key immediately.

### Step 4. Add API keys to Vercel

Go to your Vercel project, Settings, Environment Variables.

Add each key with these exact names. Mark all as Sensitive. Apply to Production and Preview.

```
FOURSQUARE_API_KEY=your_foursquare_key
GOOGLE_PLACES_KEY=your_google_key
TICKETMASTER_KEY=your_ticketmaster_consumer_key
SEATGEEK_CLIENT_ID=your_seatgeek_client_id
EVENTBRITE_PRIVATE_TOKEN=your_eventbrite_token
AVIATIONSTACK_KEY=your_aviationstack_key
ANTHROPIC_API_KEY=your_anthropic_key
```

After saving, redeploy the project so the variables take effect.

Verify everything connected by visiting: https://howdynash.com/api/health

You should see all services true.

### Step 5. Sign up for affiliate programs

Viator. Apply at https://www.viator.com/partner. Approval often instant. Get Partner ID format U + 8 digits.

GetYourGuide. Apply at https://partner.getyourguide.com. Approval typically same day. Get Partner ID format alphanumeric.

Awin. Apply at https://www.awin.com. After account approved, search for Booking.com and Airbnb advertisers and apply to each. Get Publisher ID.

CJ Affiliate. Apply at https://signup.cj.com. After approval, search VRBO and apply. Get publisher ID and SID.

Expedia Partner Network. Apply at https://partner.expediagroup.com/affiliate. Approval 24-48 hours. Get CID and TPID from dashboard.

### Step 6. Wire affiliate IDs into the code

Open nashville-chatbot.html and locate these constants near the top of the script tags:

```javascript
const VIATOR_PID = 'YOUR_VIATOR_ID';
const GETYOURGUIDE_PID = 'YOUR_GYG_ID';
const AIRBNB_AFFILIATE_TAG = '';
const VRBO_AFFILIATE_TAG = '';
const BOOKING_AFFILIATE_ID = '';
const EXPEDIA_CAMREF = '';
const EXPEDIA_TPID = '8000';
```

Replace empty strings with your actual IDs. Save and deploy.

### Step 7. Set up payment for affiliates

Viator. Login at https://partners.viator.com/login. Settings, Payments. Add ACH (PPD) for personal account. Submit W-9 tax form.

GetYourGuide. Login at https://partner.getyourguide.com. Account, Payment Settings. Add bank or PayPal.

Awin. Settings, Payment Details. Add bank account.

CJ Affiliate. Account, Settings, Payment. Configure direct deposit.

Expedia. Partner Central, Settings, Payment Information. Add ACH.

Submit tax forms (W-9 for US persons) on each platform. None will pay you without it.

---

## Environment Variables Reference

Add these to Vercel project Settings, Environment Variables.

Mark all Sensitive. Apply to Production and Preview environments.

| Key | Source | Required |
|---|---|---|
| FOURSQUARE_API_KEY | foursquare.com/developers | Yes |
| GOOGLE_PLACES_KEY | console.cloud.google.com | Yes |
| TICKETMASTER_KEY | developer.ticketmaster.com | Yes |
| SEATGEEK_CLIENT_ID | platform.seatgeek.com | Recommended |
| EVENTBRITE_PRIVATE_TOKEN | eventbrite.com developer | Recommended |
| AVIATIONSTACK_KEY | aviationstack.com | Recommended |
| ANTHROPIC_API_KEY | console.anthropic.com | Yes for AI chat |

Weather and Nashville Open Data require no keys.

---

## Local Development Setup

You only edit files locally. Vercel runs production. There is no local server.

Required tools.

Mac with Terminal access.

Homebrew. Install at https://brew.sh

Git. Comes with macOS.

GitHub CLI. Install with `brew install gh`.

A code editor like VS Code or TextEdit.

One-time setup commands.

```bash
brew install gh
gh auth login
```

Pick GitHub.com, HTTPS, Login with web browser. Copy the code, authorize in browser.

Clone the repo locally if not already there.

```bash
cd ~/Documents
git clone https://github.com/YOUR_USERNAME/howdynash.git
cd howdynash
chmod +x deploy.sh
```

The deploy.sh script handles everything from this point.

---

## Deployment Workflow

Daily workflow for pushing changes.

```bash
cd /Users/dan/Documents/howdynash
./deploy.sh
```

Or with a custom commit message:

```bash
./deploy.sh "added weather button"
```

What the script does.

Pulls latest from GitHub to avoid conflicts.

Stages your local changes.

Commits with timestamp or your custom message.

Pushes to GitHub main branch.

Vercel auto-deploys within 30-90 seconds.

Verify deployment.

Open Vercel dashboard at https://vercel.com/dashboard. Click your project. Check Deployments tab for green Ready status.

Hit https://howdynash.com to confirm changes are live.

Hard refresh browser if you see old content (Cmd+Shift+R on Mac).

---

## Security Hardening

Defense in depth across accounts, infrastructure, and runtime. Walk this list during onboarding or annual audits.

### Account-Level Two-Factor Authentication

Every account that owns infrastructure or codebase has 2FA enabled with Google Authenticator. Backup codes saved offline.

- Vercel (hosts site, owns Postgres, env vars). Enabled at https://vercel.com/account/security
- GitHub (owns codebase, all 9 dcdcairbnb private repos). Enabled at https://github.com/settings/security
- Cloudflare (DNS, WAF, edge protection). Enabled at https://dash.cloudflare.com/profile/authentication
- Gmail jayhawks01@gmail.com (recovery email for everything). Enabled at https://myaccount.google.com/security
- Gmail howdynashhq@gmail.com (brand inbox). Enabled at https://myaccount.google.com/security

Recovery codes for each account are stored in a password manager. Losing the phone alone never locks anyone out.

### Edge and Network Layer

Cloudflare sits in front of howdynash.com on the free plan.

- Nameservers: josh.ns.cloudflare.com and wanda.ns.cloudflare.com (set at Namecheap)
- Origin: Vercel (216.198.79.1) via Proxied A record at @
- WWW: CNAME www proxied to Vercel
- SSL/TLS mode: Full (strict). Cloudflare verifies Vercel's certificate.
- Always Use HTTPS: ON. Auto-redirects http to https.
- Bot Fight Mode: ON. Free bot detection and CAPTCHA challenges.
- AI bot policy: ALLOW. ChatGPT, Gemini, Perplexity, etc. can crawl. Better visibility in AI search.
- DDoS protection: unmetered, automatic on free plan.

Vercel itself adds another HTTPS layer and serves as the origin. Cloudflare-to-Vercel hop is HTTPS verified.

### Email Authentication

DNS records at the domain protect deliverability and prevent spoofing.

- SPF: `v=spf1 include:spf.improvmx.com include:amazonses.com ~all` at @
- DMARC: `v=DMARC1; p=none; rua=mailto:howdynashhq@gmail.com; pct=100` at _dmarc
- DKIM: Resend's signing key at resend._domainkey
- Send subdomain SPF: `v=spf1 include:amazonses.com ~all` at send (Resend fallback)
- MX: mx1.improvmx.com (priority 10) and mx2.improvmx.com (priority 20) for inbound forwarding to howdynashhq@gmail.com

Inbound email to howdy@howdynash.com forwards to howdynashhq@gmail.com via ImprovMX.
Outbound transactional and marketing email sends from howdy@howdynash.com via Resend.

### API and Runtime Protections

Server-side defenses inside the Vercel functions.

- API keys server-side only. Anthropic, Resend, Postgres connection strings live in Vercel environment variables. Browser never sees them.
- Per-IP rate limiting on /api/chat: 15 requests per day per IP, returns 429 after.
- Per-IP rate limiting on /api/subscribe: 10 signups per hour per IP.
- Daily Anthropic budget cap: $5 USD per UTC day. Tracked in Upstash Redis. Chat returns 429 when hit.
- Budget alert email at 80% of cap, sent once per day to howdy@howdynash.com.
- Reply cache for chat: 24-hour TTL, 500-entry max. Same question gets the same answer without burning tokens.
- Cron auth for newsletter: /api/subscribe?cron=newsletter requires Bearer CRON_SECRET. Vercel attaches this automatically; nobody else can trigger sends.
- Admin auth for manual newsletter: action=newsletter-send requires ADMIN_TOKEN body field.

### Database Hygiene

Postgres on Vercel stores subscriber emails only. Minimum data principle.

- Stored fields: email, name, source, unsubscribe_token, subscribed_at, unsubscribed_at, consent_ip, saved_spots
- No passwords, no payment data, no PII beyond email and first name
- Unsubscribe tokens are 48-character hex strings (random, not guessable)
- One-click unsubscribe via List-Unsubscribe header included in every send
- Consent IP captured for CAN-SPAM compliance
- Trip-summary recipients only added to subscribers table if they explicitly opt in

### Monitoring

- Google Alerts for "howdynash.com" and "Howdy Nash" Nashville. Catches new web mentions, press, clones, social posts.
- Cloudflare Analytics. Real-time traffic, threat-blocked counts, top countries.
- Vercel logs. Function invocations, errors, cron runs.
- Resend dashboard. Email delivery, bounces, complaints.

### Code and Repo Security

- All 9 dcdcairbnb GitHub repos are private.
- Branch protection on main: not enforced (single-developer org). Reconsider if collaborators added.
- No secrets committed. Verified by grepping for API key patterns before each push.
- Vercel deployment protection (preview auth) is OFF intentionally so beta testers can access preview URLs without a Vercel login.

### iOS App Store

- App is signed with the howdynash dev account.
- Apple App Store Connect 2FA required by Apple (always on).
- TestFlight invites limited to known testers.
- Capacitor server.url loads howdynash.com directly. App and web stay in sync, but means a bad web deploy affects iOS users immediately. Mitigation: cache version bump in sw.js + 5-minute Vercel rollback if needed.

### Things Still Open

- Linktree or shortened App Store link in TikTok bio (waiting on Business account or 1k followers).
- Clone detection beyond Google Alerts (no automated affiliate-ID scanner yet).
- Trademark on "Howdy Nash" not filed.
- No formal incident response runbook.
- Postgres backups: Vercel handles daily automated backups by default. Verified retention policy: 7 days on Hobby plan.

### Quick Audit Commands

Verify DNS records propagated correctly:

```
dig +short howdynash.com TXT @8.8.8.8
dig +short _dmarc.howdynash.com TXT @8.8.8.8
dig +short howdynash.com MX @8.8.8.8
dig +short howdynash.com NS @8.8.8.8
```

Verify Cloudflare is fronting traffic:

```
curl -sI https://howdynash.com | grep -i cf-ray
```

If you see a `cf-ray:` header, Cloudflare is in the path.

Verify rate limits work:

```
for i in {1..20}; do curl -s -o /dev/null -w "%{http_code}\n" https://howdynash.com/api/chat -X POST -H "Content-Type: application/json" -d '{"message":"test"}'; done
```

Should return 200s up to the daily limit, then 429s.

---

## File Structure

```
howdynash/
├── nashville-chatbot.html       Main app file (everything in one)
├── deploy.sh                     Deploy script
├── package.json                  Vercel detects Node project
├── vercel.json                   Vercel routing config
├── README.md                     Public-facing readme
├── SETUP_DEPLOY.md               Quick deploy reference
├── SETUP_GUIDE.md                This file
├── MORNING_CHECKLIST.md          Daily checklist
├── api-test.html                 API testing page
├── .env.example                  Documents env vars
├── .gitignore                    Git ignore rules
└── api/                          Vercel serverless functions
    ├── health.js                 Reports which services connected
    ├── chat.js                   Claude LLM endpoint
    ├── events.js                 Ticketmaster + SeatGeek + Eventbrite
    ├── festivals.js              Festival listings
    ├── flights.js                BNA flight tracker
    ├── weather.js                Weather.gov forecast
    ├── nashville/data.js         Nashville Open Data fallback
    ├── places/search.js          Google Places search
    └── restaurants/
        ├── search.js             Foursquare + Google restaurants
        └── [id].js               Restaurant detail
```

---

## Common Commands

Deploy local changes.

```bash
cd /Users/dan/Documents/howdynash && ./deploy.sh
```

Check git status.

```bash
git status
```

See recent commits.

```bash
git log --oneline -5
```

Pull latest from GitHub.

```bash
git pull origin main
```

Verify health endpoint.

```bash
curl https://howdynash.com/api/health
```

Test specific endpoint.

```bash
curl https://howdynash.com/api/weather
curl https://howdynash.com/api/events?keyword=country
```

---

## Troubleshooting

Site shows old content after deploy.

Hard refresh browser. Cmd+Shift+R on Mac, Ctrl+Shift+R on Windows. Mobile: close tab, reopen URL.

API endpoint returns 503.

Means a required env var is missing. Check Vercel Settings, Environment Variables. Confirm key name exactly matches what code expects.

API returns 401.

API key is wrong, expired, or has restrictions. Generate a new key, update Vercel env var, redeploy.

API returns 404.

Model name or endpoint URL is wrong. Check the service's docs for current model names.

Vercel shows DEPLOYMENT_NOT_FOUND.

Project may have been renamed. Trigger a fresh deploy by pushing any commit. Check Vercel dashboard, Domains section, and add new domain alias if needed.

deploy.sh fails with merge conflicts.

You have local changes that diverge from GitHub. Run:

```bash
git pull origin main --no-rebase --strategy-option=ours
```

Then deploy again.

deploy.sh fails on first run with "untracked working tree files".

Run these manual commands once:

```bash
git add -A
git commit -m "initial state" --allow-empty
git pull origin main --no-rebase --allow-unrelated-histories --strategy-option=ours
git push origin main
```

Future runs will work normally.

LLM returns "I had trouble reaching the answer service".

Check Vercel logs for the actual error. Common causes: expired API key, wrong model name, or rate limit.

---

## Cost Tracking

Hosting. Vercel hobby plan. Free.

Domain. None yet. When ready, ~$10-40/year.

API costs.

Anthropic Claude Haiku. ~$1.20 per 1000 conversations.

Google Places (New). $200 free monthly credit, then ~$32 per 1000 requests.

Foursquare. Free tier 1000 requests per day. Plenty for low traffic.

Ticketmaster, SeatGeek, Eventbrite, Weather.gov. Free.

AviationStack. Free 100 requests per month, then $9.99/month for 10k.

Realistic monthly cost at low traffic (under 1000 daily users): $5 to $15.

---

## Revenue Tracking

Affiliate dashboards (check weekly).

Viator: https://partners.viator.com/login

GetYourGuide: https://partner.getyourguide.com

Awin: https://ui.awin.com

CJ Affiliate: https://members.cj.com

Expedia: https://partner.expediagroup.com

Each shows clicks, conversions, and pending commissions.

Payments arrive monthly via direct deposit, typically 30-60 days after the customer takes the trip.

---

## Brand Reference

App name: Howdy Nashville

Tagline: Your Nashville guide

Welcome message: Howdy. I'm your Nashville guide. Restaurants, live music, events, and tourist info. What sounds good?

Brand colors: red gradient (#d62828 to #f77f00) for header, white background for chat.

Font: system default (San Francisco on Mac, Segoe UI on Windows, Roboto on Android).

Domain: howdynash.com

Social handles: @howdynash on Instagram, TikTok, X, Threads, Pinterest.

---

## Future Roadmap (TODO)

Custom domain: howdynash.com (purchased and live).

Add Plausible analytics.

Add PWA features (manifest.json, service worker, install prompt).

Add Phase 2 LLM tool use (Claude calls real APIs instead of using training knowledge).

Build hotel partnership pitch deck.

Pitch 10 Nashville hotels for white-label deals at $200-500/month.

Write SEO blog posts (Best Hot Chicken, First Time in Nashville, Bachelorette Guide).

Add user accounts and saved trips.

Expand to other cities under same brand or franchise model.

---

## Support and Help

If something breaks, check this guide first.

Vercel logs: vercel.com/dashboard, your project, Logs tab.

GitHub commits: github.com/YOUR_USERNAME/howdynash/commits

API status pages: each service has a status page (status.anthropic.com, status.openai.com style).

For code questions, the SETUP_DEPLOY.md and this SETUP_GUIDE.md should cover everything.
