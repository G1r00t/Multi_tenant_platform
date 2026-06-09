# Riverline Platform — Day 1

Secure multi-tenant debt-collection platform (Day 1: isolation + auth skeleton).

> See [DISCLAIMER.md](DISCLAIMER.md) — synthetic assessment data only.

## Quick start

```bash
docker compose up --build
```

No manual steps. All environment variables are set in `docker-compose.yml` with local dev defaults.

Default login password for all seed users: `**changeme**`

## Verify the system

### Health

```bash
curl -s http://localhost:3000/health | jq
```

### Login (Sunrise counselor)

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"ajay.menon@hotmail.com","password":"changeme"}' | jq -r .token)

curl -s http://localhost:3000/borrowers \
  -H "Authorization: Bearer $TOKEN" | jq
# Expect: tenantId client_sunrise_001, count ~704
```

### Login (Metro counselor — different tenant count)

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"pankaj_thakur1993@hotmail.com","password":"changeme"}' | jq -r .token)

curl -s http://localhost:3000/borrowers \
  -H "Authorization: Bearer $TOKEN" | jq
# Expect: tenantId client_metro_002, count ~803
```

### Engineer fan-out (all tenants)

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"rohitsingh@rediffmail.com","password":"changeme"}' | jq -r .token)

curl -s http://localhost:3000/borrowers \
  -H "Authorization: Bearer $TOKEN" | jq
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design.

## Local development (without Docker)

Requires **Node.js 20+** (Fastify 5 needs `diagnostics.tracingChannel`). If you use nvm, run `nvm use` in the repo root (see `.nvmrc`).

```bash
npm install
npm run build
# Start mongo + redis locally, then:
MONGO_URI=mongodb://localhost:27017 REDIS_URL=redis://localhost:6379 \
JWT_SECRET=local-dev-jwt-secret-min-16-chars MASTER_KEY=0123456789abcdef0123456789abcdef \
SEED_DATA_PATH=./seed-data DEFAULT_PASSWORD=changeme MONGO_MAX_POOL_SIZE=8 \
node dist/index-migrate.js

MONGO_MAX_POOL_SIZE=6 SERVICE_NAME=api node dist/index-api.js
```

## Tests

Requires **Node.js 20+** for local test runs (`npm test`). Docker-based setup already uses Node 20.

```bash
nvm use    # optional, if you use nvm
npm test
```



