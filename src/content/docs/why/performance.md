---
title: Size and speed
description: How sofie measures app code, build times, binary size and runtime against a Loco twin of the same shop.
sidebar:
  order: 2
---

Size and speed are part of sofie's design goals, so they are measured, not claimed. The framework's
example shop is compared with a twin of the same app built with [Loco](https://loco.rs).

This page explains what is measured and how, shows the latest full run, and states the caveats
of the comparison.

## Why compare against a twin

An absolute number such as "24 000 requests per second" says little on its own: it depends on the
machine, the database and what each request does. Building the same app twice, with the same
features, and measuring both on the same machine back to back makes the numbers comparable. The
twin is Loco because it is a full-stack Rust framework with the same scope: server-rendered pages,
accounts, a database-backed job queue, migrations and a scheduler.

## The two apps

Both apps implement the same shop:

- Sign up, sign in and sign out, with a session cookie.
- Orders owned by the signed-in user: an email, a status with fixed transitions (`PENDING` to
  `PAID`, `CANCELLED` or `EXPIRED`; `PAID` to `SHIPPED` or `REFUNDED`), a total in minor units
  with a three-letter currency, and the time it was placed.
- Placing an order (validated email, an exact amount parsed from text such as `149.90`), listing
  one's own newest 50, and cancelling one's own. Another user's order is a 404.
- A server-rendered HTML page with the list, a place-order form and a cancel button per row, and
  the same data as JSON.
- An audit row written by a background job for each placement and cancellation, and an hourly job
  that expires orders still pending after 24 hours.

The sofie side is [`examples/shop`](https://github.com/sofie-rs/sofie/tree/main/examples/shop).
The Loco side is [`bench/loco-shop`](https://github.com/sofie-rs/sofie/tree/main/bench/loco-shop),
made with `loco new` (the SaaS starter with server-side views, a Postgres-backed queue and JWT
auth) and Loco's generators, then filled in the way Loco's documentation intends.

## What is measured

`bench/run.sh` measures both apps and writes
[`bench/results.md`](https://github.com/sofie-rs/sofie/blob/main/bench/results.md).

```sh
bench/run.sh          # quick run, both apps, release binaries reused
bench/run.sh --full   # clean builds, timed, and longer load runs
```

### App code

Non-blank, non-comment lines in every file the developer writes and keeps, by kind: Rust,
templates, migrations and configuration. Tests are reported separately and not counted in the
total. A file a generator wrote once and the developer then owns counts as written code; this
includes Loco's starter files. Files a tool regenerates and nobody edits are left out on both
sides: sofie's `app/src/wiring.rs` and contract `gen/` output, and Loco's
`src/models/_entities/`.

sofie ships accounts as the `sofie-identity` crate, while Loco's starter generates the account
system into the app. Loco's account files therefore count as app code, and the report also shows
"of which accounts" so the shop's own code can be compared without them.

### Framework and dependencies

- Rust lines of the framework's own crates, and of those compiled into the app (counting only
  files reached under the features the app enables).
- The app's dependency tree from `cargo tree`, deduplicated by name and version, with the Rust
  lines of each crate counted from its source.

### Build

Measured only with `--full`: a clean release build into an empty target directory, a rebuild after
touching one handler file, and the release binary's size. Both apps use the same release profile
(Cargo's defaults: opt-level 3, no LTO, 16 codegen units, no debug info), set through Cargo's
environment variables so neither manifest's own profile applies. The shop is built without its
default `tls` feature, as the twin serves plain HTTP too.

### Runtime

Both apps are seeded with the same data (two users who signed up through the app, and a fixed
number of orders each), then loaded with `oha` at 64 connections for three scenarios: the JSON
order list, the HTML order page, and placing an order through the form post. The run records
requests per second (only answers with the expected status), p50 and p99 latency, errors, bytes
per answer, the pace of the audit job under load, resident memory after the runs, and the time
from process start to the first successful request.

Each app runs in production mode with its defaults. sofie's binary runs with `DATABASE_URL` and a
fresh `SOFIE_SIGNING_KEYS`; Loco runs with `start --all`, so server, queue workers and scheduler
share one process as sofie's do.

## The latest full run

Apple M3 Pro (11 cores), 18 GB memory, Postgres 18 on the same machine, `oha` with 4 threads.
Each app was seeded with 1 000 orders per user and loaded for 30 seconds per scenario after a
5-second warm-up.

### Code and dependencies

| Measure | sofie | Loco |
|---|---:|---:|
| App code, total lines | 365 | 1 834 |
| of which accounts | 0 | 889 |
| Crates in the app's dependency tree | 121 | 444 |
| Rust lines in those crates | 754 311 | 2 204 449 |
| Framework Rust lines compiled into the app | 27 521 | 18 313 |

sofie compiles more framework code into the app than Loco does, since the framework does more.
The dependency tree is a third of Loco's in crates and lines.

### Build and binary

| Measure | sofie | Loco |
|---|---:|---:|
| Clean release build (s) | 20.4 | 80.8 |
| Rebuild after touching one handler (s) | 3.1 | 13.6 |
| Release binary (MB) | 9.4 | 32.6 |

### Runtime

| Scenario | sofie | Loco |
|---|---:|---:|
| JSON order list: requests/s | 24 313 | 5 894 |
| JSON order list: p99 (ms) | 5.10 | 15.11 |
| HTML order page: requests/s | 23 804 | 5 632 |
| HTML order page: p99 (ms) | 5.18 | 15.69 |
| Place order (form post): requests/s | 9 994 | 4 173 |
| Place order (form post): p99 (ms) | 10.36 | 22.71 |
| Audit rows written, from the order run's start to 10 s after it | 2 152 | 868 |
| Resident memory after the runs (MB) | 19 | 34 |
| Start to first successful request (ms) | 49 | 92 |

No scenario returned errors on either side.

## Why it is small and fast

Design choices that bear on these numbers:

- **A short dependency list.** The core needs `tokio`, `hyper`, `matchit` for routing,
  `tokio-postgres` with `deadpool-postgres`, `serde`, `jiff` for time, `tracing`, and `ring` for
  signing and sealing. The OpenTelemetry exporter is sofie's own, encoding protobuf by hand and
  sending with `hyper`. The list is kept in
  [`docs/core.md`](https://github.com/sofie-rs/sofie/blob/main/docs/core.md#dependencies) so the
  size of the core stays visible.
- **Features off by default.** What not every app needs — idempotency, webhooks, signed links,
  CORS, TLS, feature flags, permissions, cache, storage, uploads, search, mail and more — is a
  feature of its crate, forwarded by `sofie` and off by default, so an app compiles only what it
  uses.
- **No infrastructure beyond the database.** No broker or cache server is in the core; jobs,
  events and schedules share one table and one worker loop.
- **Templates compiled at build time.** The app's build script compiles each screen into a program
  of ops that the binary embeds and loads at boot without a parser.
- **One query where a session is enough.** The sealed session cookie carries the account id, so
  the order list needs one query.

## Where the comparison is uneven

Some differences favour one side or change numbers for reasons other than the framework:

- **Database pool.** Both apps get sofie's default pool size (logical CPUs × 2). Loco's job queue
  keeps its own pool of 20; sofie's worker is given one of 20 too
  (`SOFIE_WORKER_POOL_SIZE=20`), so jobs compare on equal resources.
- **Request logging.** sofie writes a JSON line per request; Loco in production writes none. This
  costs sofie time.
- **Queries per request.** Loco's idiomatic `auth::JWTWithUser` loads the user on every request,
  two queries for the order list; sofie's session cookie carries the account id, one query.
- **Durability of the audit job.** sofie writes the event to its outbox in the same transaction as
  the order; Loco enqueues the job after the order is committed, from a separate pool, so a crash
  in between loses the audit row. Cancelling in Loco is a read then an update without a version
  check; sofie checks the row's version.
- **Security work per request.** sofie refuses cross-site POSTs and sends a Content-Security-Policy
  with a per-response nonce; the Loco app has no CSRF protection for its cookie-authenticated
  forms. This costs sofie time.
- **Response bodies differ** in size and content. sofie's HTML page is larger; its JSON is
  smaller.
- **Loco's defaults.** Loco's starter compiles SQLite support (with bundled C SQLite) and its
  generator code into the binary, which is also the app's CLI. This is how Loco ships, so it is
  kept, and it shows in build time and binary size.
- **Postgres over TLS.** The shop is built without sofie's default `postgres-tls`, which leaves
  about 1.6 MB of TLS code out of its binary; Loco's twin compiles rustls into sea-orm. Both reach
  the bench's Postgres in plain text.
- **Generated entities.** Loco's `src/models/_entities/` were written by hand in the format its
  code generator writes, because that generator was not installed. They are not counted.

## Caveats

- **One shared machine.** The load generator, the app and Postgres run on one machine, and
  Postgres also serves whatever else runs there. The report records the load average when each
  app's runs begin. Results vary between runs: compare runs made back to back, and read the
  numbers as relative, not absolute.
- **One app.** The shop is small. The numbers describe that shop, not every app built with
  either framework.
- **Quick mode reuses binaries.** `bench/run.sh` without `--full` reuses whatever binary is in
  `bench/target/`, so after a change a full run is needed before its numbers can be trusted.
- **The audit job falls behind under load.** In both apps the background job writes far fewer audit
  rows per second than orders are placed: when the order run ended, most orders in both apps were
  still waiting for their audit row. The jobs are queued and the rows are only late, but the
  worker's pace under sustained load is an open issue.

## Measuring your own app

`sofie bench` load-tests an app built with sofie, not against Loco but against its own previous
runs. It generates a k6 scenario per GET route (a route with a screen is loaded as HTML and as
JSON) and for POST routes that create a record from an input, signs in to each area through
`sofie-identity`, and keeps p95 latency and error rate per route in `bench/baseline.json`. A
regression beyond the allowed margin (p95 20% above, error rate one point above) fails the run; an
improvement lowers the baseline. It refuses any environment other than local, testing or staging.
k6 is an external tool the CLI runs, not a dependency of the app. See
[Testing](../../features/testing/) for more.
