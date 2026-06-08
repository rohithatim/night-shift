# Shortline URL Shortener

A resume-ready full-stack URL shortener built with React, Vite, and a Node/Express API. It supports generated Base62 codes, optional custom aliases, link expiration, redirects, click analytics, URL validation, and API rate limiting.

## Implementation Plan

1. Build the core data model: one durable URL mapping per short code, plus bounded recent click metadata for analytics.
2. Implement URL creation: validate `http`/`https` URLs, block local/private-network destinations, enforce custom alias uniqueness, generate compact Base62 aliases, and persist before returning.
3. Implement redirect reads: resolve `/:code` from the hot in-memory map, reject missing or expired links, record click metadata, and redirect with low latency.
4. Add analytics APIs: expose total clicks, link status, expiration, and recent click events without putting that work on the critical redirect response.
5. Add abuse controls: creation rate limit by client IP, custom alias validation, reserved path protection, request body limits, and optional production URL reputation checks.
6. Build the UI: Vercel-inspired product surface with a shortener form, result copy/open actions, link table, metrics, and recent click inspection.
7. Prepare production architecture: replace local JSON persistence with a replicated database, add Redis/edge caching for redirects, and stream click events to an analytics pipeline.

## Features

- Shorten any valid public `http` or `https` URL.
- Generate unique Base62 short codes.
- Reserve custom aliases with uniqueness checks.
- Set optional expiry windows.
- Redirect short links to their original destinations.
- Track total clicks plus timestamp, IP, user agent, and referrer for recent events.
- Rate limit URL creation to reduce abuse.
- Persist mappings and analytics in `server/data/store.json` for local durability.

## Local Development

Install dependencies:

```bash
npm install
```

Start the API:

```bash
npm run dev:api
```

Start the Vite web app in another terminal:

```bash
npm run dev
```

Open `http://localhost:5173`.

## API

`POST /api/links`

```json
{
  "longUrl": "https://example.com/products/category/electronics/item/12345",
  "customAlias": "launch",
  "expiresAt": "2026-06-09T00:00:00.000Z"
}
```

`GET /api/links`

Returns all links with click counts, status, and recent click events.

`GET /api/links/:code`

Returns analytics for one short code.

`DELETE /api/links/:code`

Deletes a short URL.

`GET /:code`

Redirects to the original long URL or returns `404`/`410`.

## Production System Design

For millions of new URLs per day and billions of redirects per month:

- API layer: stateless app instances behind a load balancer across multiple availability zones.
- ID generation: Snowflake-style or database sequence blocks encoded with Base62. Custom aliases use a unique index on `code`.
- Storage: DynamoDB/Cassandra for globally distributed key-value access, or PostgreSQL with partitioning for a strong-consistency version.
- Cache: Redis or edge KV keyed by short code with TTL matching link expiration. Redirect path checks cache first, then durable store.
- Analytics: publish click events to Kafka/Kinesis/Pub/Sub and process asynchronously into OLAP storage such as ClickHouse, BigQuery, or Druid.
- Hot URLs: cache at CDN/edge, use request coalescing, and keep analytics writes off the redirect path.
- Multi-region: active-active reads with regional caches, globally coordinated ID ranges, and conflict-free custom alias reservation.
- Durability: replicated database, point-in-time backups, write-ahead logging, and disaster recovery runbooks.
- Security: rate limits, URL reputation scanning, private IP blocking, abuse reporting, admin takedowns, bot detection, and audit logs.

## Verification

```bash
npm run build
npm run lint
```
