# Decision journal

---

## Architectural decisions

### 1. Monolith Architecture instead of microservices:

Chose: one codebase , one docker image and three processes (`api`, `worker`, `migrator`).

Alternatives : 
- Microservice per tenant : heavy ops for 3 this assessment (as there were only 3 tenants)
- Microservices per concern (auth , pii , migration) : more deployable units , independent scaling but will add network hops , distributed tracing and versioning will be tough for >2k seed rows

Why monolith : this assessment cared about isolation , pii tokenisation
and async tenant ctx and not much k8s (as far as i understood). 
For production at scale i will split worker pool first and not pii into its own service unless there is a compliance demand.

The tradeoff becuase of this was that we can't scale API and workers independently without running more containers of the same image anyway (which compose already allows).

### 2. FF3-1 + per-tenant DEK + per-borrower tweak: 

Chose: `ff3` npm for phone/aadhaar/bankAccount. Vault in `_vault`. Tweak per borrower for erasure.

Alternatives:
- Random token lookup table: not format-preserving
- HMAC-truncate for everything: format-preserving-ish for numbers, not for PAN
- Pure FPE without per-borrower tweak: erasure would require rotating whole tenant DEK
- Encrypt-then-store (AES-GCM blobs): reversible but phone doesn't look like a phone anymore

Why tweak per borrower: Compliance wants right to erasure. Destroy one row in `borrower_tweaks` → that borrower's tokens irreversible, everyone else untouched. Consistency holds because all fields for one borrower share the same tweak.

Concern I have for this (vault lookups): 100 borrowers = 100 vault reads? Partially already handled — `TokenService` has in-memory `dekCache` and `tweakCache`. First detokenize per borrower hits `_vault`; repeats in same process don't. 

Still missing: LRU/TTL, cache invalidation after erasure (stale tweak in memory until restart), batch prefetch for `GET /borrowers` list. Not fixing for assessment.

### 3. `AsyncLocalStorage` for tenant context, re-hydrate at every async boundary: 

Chose: ALS in HTTP middleware, workers serialize `tenantId` into `job.data` and `runWithContextAsync` on consume.

Alternatives:
- Pass `tenantId` as argument through every function: easy to forget one call site
- Thread-local style global: same problem as ALS but worse in Node
- BullMQ job inherits ALS automatically: doesn't work.

### 4. Wipe-and-reingest migration (not incremental merge):

Chose: `clearExistingData()` then bulk insert from seed. Re-run = full reset from JSON.

Alternatives:
- Incremental upsert: preserves API-created borrowers but harder to validate exact counts and re-tokenize safely
- Skip migrator if `_system.migration_state` exists: better for prod, didn't implement
- Dual-write during cutover: overkill for static seed dump

Why: Spec wants reversible recovery ("delete a borrower, re-run, it's back"). Simpler to reason about. Documented in README that re-run also wipes live API data that's intentional for recovery, not for prod ops.


## Where I was wrong / stuck / changed direction

### PAN tokenization — format preserving was not trivial

What I did first (wrong): Treated PAN like phone — run FF3 over the whole 10-character string. PAN is `AAAAA9999A` (letters + digits + letter). FF3 needs a fixed radix and length per call. A single radix-10 cipher corrupts letters; radix-36 over 10 chars doesn't guarantee the output still matches `[A-Z]{5}\d{4}[A-Z]`.

How did I solved it (`src/pii/ff3.ts`): Split into three segments:
- First 5 letters → FF3 with radix-26 (map A-Z into a 26-char alphabet)
- Middle 4 digits → affine permutation mod 10000, key-derived
- Last letter → Caesar shift with offset from SHA256(dek+tweak)

Now it is format preserving , reversible , deterministic.
Tests in `pii.test.ts` confirms this.

### ALS does not cross the BullMQ boundary

Problem: While building the compliance report worker, I assumed the tenant context from the HTTP request would automatically be available inside the BullMQ job. It wasn't. As a result, the worker could not determine which tenant's database to use.

Solution: I included tenantId (and requestId) in every job payload. When a worker processes a job, it recreates the tenant context using these values before running the job logic. For scheduled tasks like overdue checks and data erasure, the scheduler creates a separate job for each tenant instead of running a single global job.

### Security incident / breach handling — scope of revoke

Wrong model: Assumed any `X-Tenant-Id` mismatch (including admin with wrong header) would revoke + flag breach. Actually revoke only runs for tenant-bound roles (`debt-counselor`, `client-viewer`) where JWT carries a fixed `tenantId`. Admin/engineer have `tenantScope: '*'` and pick tenant via header legitimately.

Doc vs code gap: Architecture writeup mentioned "enqueue admin notification" on breach. **Not implemented** — no `admin-notification` job, no email/Slack. Only `_system.security_incidents` insert + revoke for header mismatch. Scope violations log incident but don't revoke.

If I revisit: Severity tiers (high = revoke + notify, low = audit only). Header typo for counselor maybe shouldn't kill session on first offense. For assessment left as-is.

## Intentionally NOT built (and why)

1. Microservices: see decision #1. Complexity without benefit at this scale.

2. Runtime tenant provisioning API: three canonical tenants from seed; registry populated at migration. Adding tenant #4 is ops/migration concern, not HTTP endpoint.

3. User/counselor onboarding API: 
Approach: User and counselor accounts are loaded from users.json with passwords hashed using bcrypt (changeme as the initial password).

Alternative: In a production system, user accounts would typically be managed through an identity provider (Auth0, Okta, Keycloak, etc.) or an admin onboarding API.

Reason: Authentication infrastructure was not the focus of this assignment, so a simple file-based setup was sufficient.

4. Admin Notification on Security Incidents: When a security incident is detected, the system records it in the database and marks it with flaggedForReview: true. A production system would also send notifications (email, Slack, etc.) to administrators using a background job queue.For this assessment, storing the incident and flagging it for review was sufficient to demonstrate the security workflow.

5. Blind PII scrub in conversation text: only replace PII known on borrower profile. Regex on "any 10 digits" would eat amounts and payment refs. Chat-only unknown PII can remain plaintext, documented limitation.Detecting arbitrary PII in free-form conversations would require a dedicated PII-detection solution (e.g., NER models, specialized PII classifiers, or a more advanced text-processing pipeline).


## Could still do with more time

- `MIGRATION_FORCE` vs skip-if-complete migrator
- Severity on `security_incidents` + optional notify job
- PAN in `borrowerPlaintextPii()` for conversation scrub on write (gap: PAN in message text might not scrub)
