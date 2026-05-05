# Howdy Nashville

A free conversational tourism chatbot for Nashville visitors. Get restaurant picks, live music, festivals, ride-share deep links, food delivery, vacation rentals, weather, and AI-powered Q&A about Music City. Mobile-first, no signup.

Live: https://howdynash.com

## What's inside

```
howdynash/
├── nashville-chatbot.html       Main app (frontend, single file)
├── deploy.sh                    Push to GitHub and trigger Vercel deploy
├── vercel.json                  Vercel routing and CORS
├── package.json
├── .env.example                 Required env vars
├── api/                         Vercel serverless functions
│   ├── health.js                GET /api/health
│   ├── chat.js                  POST /api/chat (Claude LLM)
│   ├── restaurants/search.js    GET /api/restaurants/search
│   ├── restaurants/[id].js      GET /api/restaurants/:id
│   ├── places/search.js         GET /api/places/search
│   ├── events.js                GET /api/events
│   ├── festivals.js             GET /api/festivals
│   ├── flights.js               GET /api/flights
│   ├── weather.js               GET /api/weather
│   └── nashville/data.js        GET /api/nashville/data
└── docs/                        Strategy and reference docs
    ├── SETUP_GUIDE.md           Complete setup walkthrough
    ├── BEST_PRACTICES.md        Patterns and pitfalls
    ├── EVALUATION.md            Honest project review
    ├── NEXT_CITY_PLAYBOOK.md    Replication guide
    ├── FINANCIAL_PROJECTIONS.md Costs and revenue
    ├── CITY_RECOMMENDATIONS.md  Where to expand next
    └── MARKETING_PLAN.md        Traffic and revenue strategy
```

## Get the API keys (all free or free-tier)

1. Foursquare: https://foursquare.com/developers (1,000 calls/day)
2. Google Places: https://console.cloud.google.com/apis/library/places.googleapis.com ($200/month free credit)
3. Ticketmaster: https://developer.ticketmaster.com (5,000 calls/day)
4. SeatGeek: https://seatgeek.com/account/develop
5. Eventbrite: https://www.eventbrite.com (Account, Developer Links, API Keys)
6. AviationStack: https://aviationstack.com (100 calls/month free)
7. Anthropic Claude: https://console.anthropic.com (~$1.20 per 1,000 chats)

## Deploy

### One-time setup

```bash
brew install gh
gh auth login
chmod +x deploy.sh
```

### Daily workflow

```bash
cd /path/to/howdynash
./deploy.sh "your commit message"
```

Vercel auto-deploys within 60 seconds.

## Local development

```bash
cp .env.example .env.local
# paste your keys
npx vercel dev
```

Open http://localhost:3000

## Custom domain

Vercel project, Settings, Domains. Add domain, update DNS, free.

## API endpoints

- `GET /api/health` - service availability
- `POST /api/chat` - Claude LLM chat
- `GET /api/restaurants/search?term=hot+chicken&lat=&lng=` - restaurants
- `GET /api/places/search?q=museum&type=museum` - generic places
- `GET /api/events?keyword=country&classificationName=Music` - events
- `GET /api/festivals` - Nashville festivals and special events
- `GET /api/flights?airport=BNA&direction=arrivals` - BNA flight tracker
- `GET /api/weather?lat=&lng=` - Weather.gov forecast

## Cost

Hosting: free on Vercel Hobby. Pro is $20/month for commercial use.

API costs: roughly $5 to $30 per month at low traffic.

## Documentation

- `SETUP_GUIDE.md` - first-time setup walkthrough
- `SETUP_DEPLOY.md` - deploy script setup
- `POST_LAUNCH_PLAYBOOK.md` - press page, domain forwarding, content updates, channel attribution (added May 5, 2026)
- `BEST_PRACTICES.md` - patterns and pitfalls
- `EVALUATION.md` - honest project review
- `NEXT_CITY_PLAYBOOK.md` - replication guide
- `CITY_RECOMMENDATIONS.md` - which cities to expand to next
- `FINANCIAL_PROJECTIONS.md` - costs and revenue
- `MARKETING_PLAN.md` - traffic and revenue strategy
