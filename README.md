# Orders & Settlements

A small backend-first app for tracking customer orders and the payments settled against them.
Prioritizes correctness under concurrency and a defensible data model over feature breadth.

## Deployed URL

**App:** https://orders-and-settlements-rosy.vercel.app
**API:** https://orders-and-settlements-o1kh.onrender.com

**Demo login:**
```
email:    demo@ordersandsettlements.com
password: DemoPass123!
```
Pre-seeded with five orders covering every status (pending, overdue, partially paid, paid,
paid-late), each carrying its own history — a due-date extension, a line item added, a refused
over-payment, a settlement in two instalments — so the dashboard, filters, export, and
[order timeline](#the-order-timeline) all have something real to show.

---

## Prerequisites and setup

**Prerequisites:**
- Node.js 20+ (developed against 24.x — nothing here needs a version that new, but nothing pins
  an older floor either)
- npm
- A MongoDB Atlas cluster (or any MongoDB 6+ replica set — a single-node replica set works; a
  standalone `mongod` does not, since the payment guard's atomic pipeline update requires one)

**One repository, two independently deployable apps:**
```
api/   Express 5 + TypeScript + MongoDB (Mongoose)   → deployed to Render
web/   Next.js App Router                            → deployed to Vercel
```

### 1. Clone and install

```bash
git clone https://github.com/DJ48/orders-and-settlements.git
cd orders-and-settlements
```

### 2. API (`api/`)

```bash
cd api
npm install
cp .env.example .env.local
```

Fill in `.env.local`:
```bash
MONGODB_URI="mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/orders_and_settlements?retryWrites=true&w=majority"
WEB_ORIGIN="http://localhost:3000"
```

```bash
npm run bootstrap   # creates indexes + the collection validator — one-time, per database
npm run seed        # optional — two demo accounts, five orders each, for something to look at
npm run dev         # http://localhost:4000
```

> If `npm run bootstrap` fails with `querySrv ECONNREFUSED`, your local DNS resolver doesn't
> answer SRV queries. Use the standard (non-SRV) connection string from Atlas instead — it lists
> the shard hosts explicitly and skips the SRV lookup.

`npm run seed` creates **two** independent accounts with the same shape of data under different
customer names — one is the demo login above, the other exists so a walkthrough recording and
someone clicking around can't collide. Recording a payment permanently changes that order's state,
and doing that to an account another person is reading would rewrite it underneath them.

It's safe to re-run: an account whose user already exists is skipped rather than duplicated. To
rebuild, delete the users first — deliberately a manual step, since a flag that erases accounts
isn't something a seed script should carry.

Each seeded order carries a different history — a due-date extension, a line item added, a refused
over-payment, a settlement in two instalments — so the [timeline](#the-order-timeline) on the
detail page has something real to show.

Run the tests: `npm test` (199 tests, real `mongodb-memory-server` replica sets — no mocked DB).

### 3. Web (`web/`), in a second terminal

```bash
cd web
npm install
npm run dev   # http://localhost:3000
```

By default it proxies `/api/*` to `http://localhost:4000` (see `next.config.ts`). To point at a
different API, set `API_URL` (server-side only, not `NEXT_PUBLIC_`) before starting.

Open `http://localhost:3000`, sign up, and start creating orders.

---

## API overview

Base path: `/api/v1`. Every `/orders*` route requires a session (opaque cookie, see
[the session controller](#a-hand-rolled-session-controller-not-jwts) below).

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/signup` | `{ email, password, name? }` |
| POST | `/auth/login` | Rate-limited: 5 attempts per email+IP per 15 min |
| POST | `/auth/logout` | Deletes the session row — instant revocation |
| GET | `/auth/me` | Current user, for the frontend to bootstrap on load |
| GET | `/orders` | `?status=&from=&to=&page=&pageSize=` — see [Filtering & pagination](#filtering--pagination) |
| POST | `/orders` | Totals computed server-side from `lineItems`, never trusted from the client |
| GET | `/orders/:id` | 404 for another user's order — never a distinguishable 403 |
| PATCH | `/orders/:id` | `{ customer?, dueDate?, lineItems? }` — see [Edit locking](#edit-locking) |
| GET | `/orders/:id/audit` | that order's recorded history — see [The order timeline](#the-order-timeline) |
| DELETE | `/orders/:id` | Soft delete; blocked once any payment exists |
| POST | `/orders/:id/payments` | `{ amountCents, paidOn, note?, idempotencyKey }` — the atomic guard, see [The payment guard](#the-payment-guard) |
| GET | `/orders/export` | `?status=&from=&to=` — CSV, same filter semantics as the list endpoint |
| GET | `/health` | Liveness only — does not touch the DB |
| GET | `/ready` | Readiness — does a real DB round trip (`admin().ping()`); `503` if it fails |

**Error envelope**, identical for every failure:
```json
{
  "error": {
    "code": "OVERPAYMENT",
    "message": "Payment of $1.00 exceeds the $0.00 still due on this order.",
    "field": "amountCents",
    "requestId": "b8a1...",
    "details": { "attemptedCents": 100, "maxAllowedCents": 0 }
  }
}
```
Codes: `VALIDATION_ERROR`, `OVERPAYMENT`, `ORDER_LOCKED`, `NOT_FOUND`, `UNAUTHENTICATED`,
`RATE_LIMITED`, `CONFLICT`.

**Logging:** every request is logged as one structured JSON line (`pino`/`pino-http`), tagged
with the same `requestId` returned in the `X-Request-Id` header and, on failure, in the error
envelope above — so a single id ties together the response the client saw, the log line, and (for
payment/order writes) the matching audit-log entry. `/health` and `/ready` are excluded from
request logging so an uptime pinger doesn't drown out everything else.

### Filtering & pagination

`GET /orders` is offset-paginated (`page`/`pageSize`, default 20, capped at 100) and returns:
```json
{ "orders": [...], "page": 1, "pageSize": 20, "total": 47, "totalPages": 3,
  "summary": { "totalValueCents": 940000, "outstandingCents": 210000, "overdueCount": 3 } }
```
`summary` is aggregated server-side over **every** order matching the filter, not just the
current page — otherwise the dashboard's stat cards would silently understate totals past page 1.

`from`/`to` filter on `dueDate` (inclusive) and are either both present or both absent — a lone
bound is rejected as ambiguous. Combined with `status`, the two are *intersected*, not one
overriding the other: `status=pending` already implies `dueDate >= today`; a caller-supplied
range narrows further rather than replacing that bound. `GET /orders/export` accepts the exact
same params, built from the same filter code as the list endpoint, so a status + date-range
combination shown on the dashboard always exports that same set.

---

## Status derivation rules and edge-case decisions

Status is **derived on every read, never stored**. A stored value that depends on today's date
(`overdue`) could go stale with no write to the document, needing a nightly sweep to correct it.
Instead, a storage-only `settlementState` (`unpaid` / `partial` / `settled`) encodes just the
money axis — which can't go stale — and the time axis (`dueDate` vs. today) is applied at
response time.

**Precedence, highest first:** `paid` > `overdue` > `partially_paid` > `pending`.

| `settlementState` | vs. `dueDate` | API `status` |
|---|---|---|
| `unpaid` | future / past | `pending` / `overdue` |
| `partial` | future / past | `partially_paid` / **`overdue`** |
| `settled` | either | `paid` |

**Edge case — an order that *was* overdue and is now fully paid resolves to `paid`.** Status is
a pure function of *current* state, so nothing lingers once `amountPaidCents >= totalCents` — a
settled order needs no attention, and permanently pinning it to `overdue` would leave a paid
invoice sitting forever in a "needs collecting" view. The historical fact that it settled late
isn't lost, though — it's a separate field:

**`paidLate`** — true only when the order is fully paid *and* the last payment landed after the
due date. This is the deliberate exception to "status never lingers": `status` answers "what
needs attention right now" (nothing, once paid); `paidLate` answers "did this ever slip" (a fact
that stays true forever once it's happened). One field can't answer both questions without either
lying about current state or losing the history.

### The order timeline

`GET /orders/:id/audit` returns one order's recorded history — created, edited, paid, refused —
from a separate `auditlogs` collection, newest first, served by a `{ orderId, at: -1 }` index.

Ownership is enforced by **resolving the order first**, not by filtering the audit query on
`userId`: filtering would return an *empty* timeline for someone else's order, which reads as
"nothing happened" rather than "not yours" and turns the endpoint into an existence oracle for
order ids. `actor.ip` is recorded but never returned — the timeline is a product surface, not a
forensics console. Status is derived per entry as of that entry's own timestamp, so the frontend
renders transitions without ever deciding what "overdue" means.

**"Became overdue" is not an event.** An order goes overdue because a date passed, not because
anyone did anything, so there's no write to record — the direct consequence of deriving status
rather than storing it. The trail shows status at each recorded event; synthesising a row for the
gap would mean inventing history.

---

## The payment guard

This is the invariant the brief is graded on: `Σpayments ≤ total`, enforced correctly under
concurrent requests against the same order. The guard is **one atomic conditional update** — not
a read, an application-code check, then a write:

```ts
Order.findOneAndUpdate(
  {
    _id: orderId, userId, deletedAt: null,
    'payments.idempotencyKey': { $ne: idempotencyKey },
    $expr: { $lte: [{ $add: ['$amountPaidCents', amountCents] }, '$totalCents'] },
  },
  [ /* pipeline: recompute amountPaidCents, append the payment, recompute settlementState */ ],
  { returnDocument: 'after', updatePipeline: true },
)
```

The over-payment check lives **inside the query predicate**, via `$expr`. MongoDB's
single-document atomicity is the lock — not a mutex, not a transaction, not application-level
locking. Two concurrent requests against the same order physically cannot both match the
predicate if together they'd exceed the total; the database resolves the race, not the Node
process. A pipeline update (not `$inc`/`$push`) is required, not incidental — it lets
`settlementState` be recomputed from the **new**, post-write balance inside the same atomic
operation, so the stored settlement state and the balance can never disagree.

On failure `findOneAndUpdate` returns `null` without saying why, so one follow-up read classifies
it: a 404 for missing-or-not-yours (see [Ownership](#ownership--tenant-isolation)), a replayed
`idempotencyKey` returns current state rather than an error, and only a genuine over-limit raises
`OverpaymentError` with `maxAllowedCents`. A MongoDB collection validator enforces the same
invariant at the storage layer as **defense in depth**, and
`api/test/services/payments.service.test.ts` verifies the guard under `Promise.allSettled` over 2,
then 20, simultaneous payments against one order.

---

## Assumptions and tradeoffs

### Line items and payments are embedded, not referenced

Embedding is for **correctness**: `Σpayments ≤ total` spans a payment and the running balance, so
one document makes the guard a single atomic write. Referencing would force a multi-document
transaction per payment, or open a read-modify-write race. Line items are composition — no
independent lifecycle, immutable once a payment lands. This breaks down past ~1,000-entry arrays,
or if one payment ever settles multiple orders; because the invariant lives in the scalar
`amountPaidCents`, history could move to its own collection without touching that logic.

Indexes follow ESR: `{ userId, deletedAt, settlementState, dueDate }` for the dashboard and
filters, `{ userId, deletedAt, createdAt: -1 }` for the default view. The idempotency index
(`{ userId, 'payments.idempotencyKey' }`, unique and partial) is a per-tenant backstop only —
MongoDB permits duplicates *within* one document's array, so the real guard is the `$ne` clause
above.

### `customer` is a plain string, not a reference

An order is a point-in-time financial document. If a customer renames, historical orders must keep
the name they were issued under — a join would silently rewrite financial history. Denormalizing
is the more correct choice here, not a shortcut.

### Money is integer cents, never a float

BSON's `Double` is IEEE-754: `$352.23 + $1492.14` lands on `1844.3700000000001`. Since "fully
paid" is an *equality* test, that drift would strand a two-installment order at `partially_paid`
forever **and** reject its own final payment as an overpayment. Decimals exist only at the API
boundary.

### Edit locking

Line items lock (`409 ORDER_LOCKED`) the instant **any** payment exists — changing the total would
invalidate the overpayment guard's basis for comparison. `customer` and `dueDate` lock
**narrower**: only once fully paid, or overdue with money on it — the two states where an edit
could rewrite something already true (a settled order's `paidLate` flag, or the fact that an order
was ever overdue). A partially-paid order on track stays editable, as does an overdue one with
zero payments. Both ship as `canEditLineItems` / `canEditMetadata`, so the frontend never
re-derives either rule.

### A hand-rolled session controller, not JWTs

Chosen for **revocation**, which a stateless JWT can't give you without a denylist that makes it
stateful anyway. Login mints 32 CSPRNG bytes and stores only their SHA-256 hash as the session
`_id`, so a database leak hands over no live session. A 30-minute idle window slides on use under
a **24-hour absolute ceiling** — the only bound on a continuously-replayed *stolen* token. Login
failure is constant-time and rate-limited to 5 per email+IP per 15 min, checked before bcrypt runs
so a flood can't burn CPU on hashing.

**A deliberate trade-off:** bcrypt's cost factor is **7**, not 12. On Render's throttled free tier
cost 12 measured past 3 seconds per login (`bcryptjs` is pure-JS, no native binding). Cost 7
trades brute-force margin for latency to fit this host; bcrypt encodes its cost in the hash, so
raising it later needs no migration.

### Ownership & tenant isolation

`userId` comes from the authenticated session only, never from a request body or query param.
Ownership is enforced **in the query predicate** (`findOne({ _id, userId, deletedAt: null })`),
never checked after the fact. A miss is always a 404, never a distinguishable 403, so the API
can't be used to enumerate which order IDs exist on someone else's account.

---

## What I would improve before production

Roughly in priority order:

1. **CI running the suite on every PR** — the tests exist and pass, but nothing enforces them; the
   only workflow in the repo is an uptime pinger. The cheapest possible guard on the payment
   invariant, and the most glaring omission on this list.
2. **Refresh-token rotation** — a short-lived access token would cut the window on a stolen session
   below the current 24-hour ceiling, and a replayed refresh token is a detectable theft signal.
3. **Rate limiting beyond login** — only `POST /auth/login` is throttled today. Every other
   authenticated route is unbounded, which is fine for a demo and not for a public deployment.
4. **Payment corrections via a refund entity**, not by editing or deleting a `payments` entry —
   payments are deliberately append-only, so reversing one today takes a DB intervention.
5. **Streaming CSV export** — `/orders/export` is capped at 5,000 rows and truncates silently past
   that, so a large filter yields a file that won't reconcile with the dashboard's own totals.
   Streaming from a cursor removes the need for the cap; short of that, say the export was cut.
6. **Logs shipped off-box, with alerting** — output is already structured and request-correlated
   (pino), but it lives and dies in the Render dashboard; nothing pages on a 5xx spike.
7. **bcrypt cost back to 12** — a one-line change with no migration, once off a CPU-throttled host.

---

## Tests

`api/test/` — 199 tests, real `mongodb-memory-server` replica sets, no mocked DB:

- **Pure logic:** `parseCents`/`formatCents` including the float-precision failure cases,
  `computeTotals`, `deriveStatus` across all four statuses and the overdue/paid-late precedence.
- **Integration:** the brief's own scenario end-to-end ($1,000 → $400 partial → $600 settles →
  $1 rejected with `maxAllowedCents: 0`), two- and twenty-way concurrent payment races,
  idempotency replay, cross-user 404s, the status+date-range filter intersection, pagination and
  its cross-page summary aggregation, CSV export matching the same filter as the list endpoint,
  `/health` and `/ready` (including that neither requires a session), and the seed script (logs
  in with the credentials it creates, produces one order per status for each account, keeps the
  two accounts separate, and is safe to re-run).
- **Audit trail:** that another user's order 404s rather than returning an empty timeline, that no
  entry leaks an actor's IP or user agent, that an edit records what a field changed *from*, that a
  rename or a quantity/price swap holding the same total is still detected, and that each entry
  reports the status as it stood then rather than as it stands today.

```bash
cd api && npm test
```
