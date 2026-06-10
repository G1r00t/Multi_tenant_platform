# Riverline Platform

Secure multi-tenant debt-collection data platform — per-tenant MongoDB databases, format-preserving PII tokenization, RBAC, audit trail, and async workers.

> See [DISCLAIMER.md](DISCLAIMER.md) — synthetic assessment data only.

## Quick start

```bash
docker compose up --build
```

No manual steps. The migrator runs automatically before the API and worker start. All environment variables are set in `docker-compose.yml`.

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

See [ARCHITECTURE.docx](Architecture.docx) (submission document)

## Migration tooling

The migrator ingests `seed-data/` into the multi-tenant architecture: normalizes malformed `clientId` values, partitions records into per-tenant databases, tokenizes PII, scrubs conversation text, fixes cross-tenant counselor assignments, and validates counts.

### Docker (automatic)

On `docker compose up`, the `migrator` service runs once and exits before `api` / `worker` start:

```bash
docker compose up --build
docker compose logs migrator   # {"event":"migration_complete", ...}
```

**What migrator does:**


| Phase     | Action                                                                        |
| --------- | ----------------------------------------------------------------------------- |
| Bootstrap | Creates `_system`, `_vault`, and `tenant_{slug}__v1` databases with indexes   |
| Normalize | Maps alias `clientId` values → canonical tenants; unknown/null → quarantine   |
| Partition | Routes borrowers, conversations, payments by resolved tenant                  |
| Tokenize  | FF3-1 PII tokens + per-borrower tweaks; scrubs known PII in message text      |
| Fix       | Reassigns cross-tenant `assignedTo` counselors; logs fixes to `migration_log` |
| Validate  | Asserts expected record counts and zero plaintext PII in tenant DBs           |


Re-running is **idempotent** — it wipes platform databases and re-ingests from seed (safe recovery if seed data is corrupted).

> **Warning:** A re-run deletes **all** live API data too — borrowers, conversations, payments, and audit logs created after the first migration that are not in `seed-data/` and will be lost. Only re-run for disaster recovery or a dev reset, not during normal operation.

**Expected counts:** 704 sunrise + 803 metro + 501 digital borrowers, 5 quarantined, 3305 conversations, 1593 payments, 18 users. Completes in under 60 seconds.

## Test suite

Requires **Node.js 20+**, **MongoDB**, and **Redis** (e.g. after `docker compose up -d mongo redis` once migration has run).

```bash
nvm use    # optional
npm test
```

Tests run **sequentially** (`fileParallelism: false`) because migration tests mutate shared MongoDB state.

### Adversarial coverage (spec §5)


| Requirement                                | Test file(s)                                                     | What is proven                                                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Tenant isolation under concurrent load** | `isolation.test.ts`                                              | 3 tenants × 5 parallel `GET /borrowers`; zero borrower ID overlap                                                   |
| **Scope enforcement**                      | `borrowers.test.ts`, `compliance-rules.test.ts`, `audit.test.ts` | Counselor cannot read another counselor's borrower (403 + `security_incidents`); list filtered to `assignedTo`      |
| **PII tokenization correctness**           | `pii.test.ts`                                                    | FF3 round-trip, format preservation, determinism, tenant DEK isolation                                              |
| **PII consistency across collections**     | `tokenization-consistency.test.ts`, `live-writes.test.ts`        | Borrower `phoneToken` matches token embedded in conversation text; live message POST scrubs plaintext at write time |
| **Role-based masking**                     | `shape.test.ts`, `borrowers.test.ts`, `compliance-rules.test.ts` | Admin detokenizes; counselor partial; engineer masked; client-viewer aggregates only                                |
| **Resilience**                             | `resilience.test.ts`                                             | Injected tenant fault → 503 for that tenant only; others return 200                                                 |


### Additional coverage


| Area                    | Test file(s)                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Full migration pipeline | `migration.test.ts` — timing, counts, idempotent re-run, API reachable during migration                               |
| RBAC policy matrix      | `policy.test.ts`                                                                                                      |
| Live API write paths    | `live-writes.test.ts` — `POST /borrowers`, `PUT /borrowers/:id`, `POST /conversations/.../messages`, `POST /payments` |
| Async jobs & webhooks   | `async-processing.test.ts`, `day3.test.ts`                                                                            |
| Compliance rules        | `compliance-rules.test.ts` — quiet hours, erasure, breach detection, data minimization                                |
| Domain glossary         | `domain-glossary.test.ts`                                                                                             |


## Local development (without Docker)

Requires **Node.js 20+**. If you use nvm, run `nvm use` (see `.nvmrc`).

```bash
npm install
npm run build
# Start mongo + redis locally, then migrate (see Migration tooling above)
MONGO_MAX_POOL_SIZE=6 SERVICE_NAME=api node dist/index-api.js
# In another terminal:
MONGO_MAX_POOL_SIZE=4 SERVICE_NAME=worker node dist/index-worker.js
```

