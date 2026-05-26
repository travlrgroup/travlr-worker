# TRAVLR Widget API — Cloudflare Worker

Version: **4.2.0**

Cloudflare Worker that powers the [TRAVLR Price Comparison Widget](https://widget.travlr.com). Returns live hotel prices from multiple OTAs for a given property, check-in/out dates, and currency.

## Live endpoint

```
https://travlr-widget-api-production.travlr-widget-api.workers.dev/rates
```

## Query parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `hotelName` | Yes | Hotel name (used for fuzzy matching) |
| `lat` | Yes | Hotel latitude |
| `lng` | Yes | Hotel longitude |
| `checkIn` | Yes | Check-in date (YYYY-MM-DD) |
| `checkOut` | Yes | Check-out date (YYYY-MM-DD) |
| `currency` | No | Currency code (default: AUD) |
| `adults` | No | Number of adults (default: 2) |
| `travlrPrice` | No | TRAVLR total price for savings calculation |

## OTA sources

- **Agoda** — Affiliate Lite API v2 (direct, CID 1807881)
- **Booking.com** — booking-com15.p.rapidapi.com (RapidAPI)
- **Expedia** — Expedia Rapid API v3 (direct, CID 506148)

## CI/CD

Push to `main` → GitHub Actions auto-deploys to Cloudflare production within ~30 seconds.

## Secrets (set once via Wrangler CLI)

```bash
npx wrangler secret put AGODA_API_KEY --env production
npx wrangler secret put RAPIDAPI_KEY --env production
npx wrangler secret put EXPEDIA_API_KEY --env production
npx wrangler secret put EXPEDIA_API_SECRET --env production
npx wrangler secret put EXPEDIA_CID --env production
```

## GitHub Actions secrets (set in repo Settings → Secrets and variables → Actions)

| Secret | Value |
|--------|-------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Worker deploy permissions |
| `CLOUDFLARE_ACCOUNT_ID` | `5b146cfa96d1bd9243a743aa66e31014` |
