---
title: Building and deploying
description: sofie build and its container image, process roles, migrations at start, configuration checks, health endpoints and splitting a module out.
sidebar:
  order: 12
---

A sofie app deploys as one binary. Screens, island bundles, migrations and translations are
compiled into it, configuration is read once at boot, and the same binary runs as a web process,
a worker or both. What the binary will not do on its own, such as migrating a production
database, is left to the deployment to switch on.

## `sofie build`

```sh
sofie build [--image | --worker] [--pgo] [ROOT]
```

`sofie build` refuses a stale `sofie gen` and any `sofie check` finding, then runs
`cargo build --profile dist` for the app and prints the binary’s path and size.

The binary carries everything it serves:

- the screens’ compiled programs, written by `app/build.rs` into `OUT_DIR`;
- island bundles, also built by `app/build.rs`;
- migrations and translations, through the wiring `sofie gen` writes.

Only a `development` build reads templates or island bundles from disk.

### The `dist` profile

`sofie new app` writes a `dist` profile into the workspace:

```toml
[profile.dist]
inherits = "release"
lto = "fat"
codegen-units = 1
strip = "symbols"
```

Fat LTO, one codegen unit and stripped symbols take the shop’s binary from 6.6 MB to 3.4 MB and
lower its CPU per request by 7–14%. `release` keeps Cargo’s defaults, so building while you work
skips the single-threaded fat-LTO link, about half of the shop’s clean build. For an older app,
`sofie build` names the lines to add.

`panic = "abort"` would save another 0.6 MB, but it would turn a panicking handler, which today
ends only its own connection, into the end of the process. It stays off.

### A container image

`sofie build --image` builds nothing on the host. It writes `Dockerfile` and
`Dockerfile.dockerignore` beside the app once, never rewrites them, and runs `docker build` from
the workspace root when docker is installed.

- **Builder:** `rust:1-bookworm`. An app with islands also gets Node for the island toolchain.
- **Runtime:** `gcr.io/distroless/cc-debian12:nonroot`: glibc and libgcc (the binary links glibc
  dynamically), CA certificates and tzdata. No shell, no package manager, user `nonroot`, and
  `SOFIE_ADDRESS=0.0.0.0:8080`.
- **Pinned images.** Both images are written with a `<digest>` placeholder, and
  `sofie build --image` refuses until each is replaced with a real digest, so every rebuild uses
  the same toolchain and runtime.
- **No secrets in the context.** The ignore file keeps `.git`, `target`, `node_modules` and every
  `.env*` but `.env.example` out of the build context, so an environment’s secrets never reach the
  builder’s cache.
- **Read-only.** The binary writes nothing to disk, so it runs with a read-only root filesystem.
- **No `HEALTHCHECK`.** Nothing in the image could run one; the orchestrator probes `/live` and
  `/ready`.

The image reaches the framework and the modules by path, so `--image` refuses first when a path
dependency lies outside the workspace root, since docker could not copy it in.

### A worker binary

`sofie build --worker` builds `<app>-worker`, a binary that only runs jobs. `src/bin/worker.rs`
calls `sofie::run_worker(MODULES, worker)`, or `sofie::run_worker_with_flags(MODULES, worker)` for
an app with feature flags; `sofie build --worker` names whichever the app needs. The app declares
it behind a `worker-binary` feature so other builds skip it. It answers `serve` and
`schema check`, and never builds the app, so the HTTP server and screens are left out of it.

### Profile-guided builds

`sofie build --pgo` builds the binary instrumented, runs it under `sofie bench`’s load (endpoints
and journeys) on a database on this machine, stops it with SIGTERM so the profile is written,
merges the profile with `llvm-profdata` and rebuilds with it. It needs k6, a local database and
`rustup component add llvm-tools`, and it does not combine with `--image`.

Both builds pass `--target <host>`, so the profile reaches the app’s code but not build scripts or
macros, and lands in `target/<host>/dist` without invalidating the ordinary `dist` build. The
profile flags join any rustflags cargo would already read rather than replacing them.

## Roles

The binary’s `main` is one call:

```rust
fn main() -> sofie::core::Result<()> {
    sofie::run(shop::MODULES, shop::app, shop::worker)
}
```

An app with feature flags calls `sofie::run_with_flags` instead. Its arguments choose what a
process runs:

```sh
shop serve --role web     # HTTP only
shop serve --role worker  # jobs, events and schedules only
shop serve --role all     # both; also what `serve` or no arguments mean
```

Every role builds the app, so a worker fails at boot on the same mistake a web process would.

The binary also answers `schema check`, which compares the tables of every aggregate with the
database `DATABASE_URL` names and exits non-zero on any mismatch, and `jobs dead` and
`jobs replay` for the outbox.

## Migrations at start

The binary migrates on start only when told to, with `SOFIE_MIGRATE=on`. Unset, it does not. Which
process migrates, and when, is the deployment’s choice: a release step, one instance, or a job
before the rollout.

A binary started without `SOFIE_MIGRATE=on` on a database that has none of the framework’s tables
refuses to start, naming the setting, instead of failing on every query.

Migrations written by `sofie gen migration` are shaped to deploy without downtime: new columns
nullable or with a default, CHECKs added `NOT VALID` then validated, indexes on existing tables
built `CONCURRENTLY`. See [Developer experience](../../features/developer-experience/#new-apps-modules-and-code).

## Configuration

The process’s own settings (`DATABASE_URL`, `SOFIE_ADDRESS`, `SOFIE_MIGRATE`, `SOFIE_SIGNING_KEYS`,
`SOFIE_TIME_ZONE` and the tuning keys) are read by `sofie::run`. A module’s config is a struct
deriving `sofie::Config`, read and parsed from the module’s prefixed environment keys once, when
the wiring builds the app, and handed to handlers and jobs as `Config<OrderConfig>`. A changed key takes
effect at the next start.

`sofie gen` reads the same structs to write `.env.example`. Before a deploy, check an environment’s
file against them:

```sh
sofie config check --env production
```

This reads `.env.production` and names each missing or malformed key, including each module’s
gateway keys. Values are never printed, since they may be secrets. The
[environment reference](../../reference/environment/) lists every framework key.

### Tuning

| Key | Default |
|---|---|
| `SOFIE_RUNTIME_THREADS` | One per logical CPU. |
| `SOFIE_DB_POOL_SIZE` | Twice the runtime threads. |
| `SOFIE_DB_POOL_WAIT_MS` | 5000; past it a request is answered 503 with `Retry-After`, never left waiting. |
| `SOFIE_WORKER_BATCH` | 2. |
| `SOFIE_WORKER_POOL_SIZE` | The app’s pool when unset; set it to give the worker its own. |

### TLS

With sofie’s `tls` feature, the binary serves HTTPS on its own address from
`SOFIE_TLS_CERTIFICATE` (the chain, leaf first) and `SOFIE_TLS_KEY`, both PEM files read at start;
one without the other refuses to start. It uses rustls with TLS 1.2 and 1.3 and HTTP/2 by ALPN. A
renewed certificate is picked up without a restart: at most once a minute a handshake checks the
files’ modification times and reloads them. Behind a proxy that ends TLS, leave the feature off.

Postgres is reached over TLS as the URL’s `sslmode` asks, with the `postgres-tls` feature on by
default.

## Health and shutdown

The binary serves two endpoints for the orchestrator:

- `/live` answers once the process serves.
- `/ready` names a dependency that is down, never why; a telemetry outage answers 200, degraded.

On shutdown it stops accepting, drains requests and jobs, then exits.

## Splitting a module into its own deployment

A module is a unit of ownership, and its contract is the only part other modules use. That makes
moving one module into an app of its own a mechanical change:

```sh
sofie split catalog           # print the plan, change nothing
sofie split catalog --write   # carry it out
```

The plan names what moves, what is then served over HTTP, the contract methods that cannot cross
apps (not `async`, generic, taking `&mut` or a borrowed type, or answering other than a `Result` of
an owned type), the reverse-proxy prefixes and the keys each app needs. It lists the app’s test
files that name the module, which stop compiling, but does not move them. A failure part-way undoes
every move and edit.

- **Where it goes.** The module folder moves to `split/<module>/modules/`, beside a new app crate
  `split/<module>/app` named `<module>-app`. Both apps stay in one Cargo workspace, so the contract
  crate is shared by path.
- **Data, not code.** Each app’s `[package.metadata.sofie]` says what it `serves` and which modules
  are `remote`; `sofie gen` reads it. The app left keeps the contract, turns on sofie’s
  `remote-contracts` and lists the module as `remote`.
- **Wiring.** For a remote module the wiring calls `sofie::remote::connect("<module>")?`, with keys
  `<MODULE>_REMOTE_*` such as `BASE_URL`, and provides a `Remote<dyn Trait>` for each contract trait
  that crosses apps. The served side registers the contract, its lookups and its events. Events
  flow between the apps as feeds the workers pull.
- **Sign-in.** It stays where sofie-identity is. Both apps read the session cookie and share
  `SOFIE_SIGNING_KEYS`.
- **Routing.** `proxy.toml` beside the app left maps each path prefix of the module’s routes to the
  new app, with `default` naming the app left. The plan warns when a prefix also starts a route the
  app keeps. `/_sofie/` is never routed from outside the network.

In tests, an app sofie-testing starts connects nowhere; a test provides the contract’s fake.

## Trade-offs and limits

- `panic = "abort"` is off by design, at the cost of 0.6 MB, so one panicking handler does not end
  the process.
- The image needs both digests pinned by hand before its first build.
- `--pgo` needs k6 and a local database, and cannot build inside the image.
- Three performance features of `sofie` are off by default: `mimalloc`, `compression` and `etag`.
  On the shop, `mimalloc` serves pages 16% faster and `compression` makes them nine times smaller,
  but each raises memory use, and `compression` also lowers throughput. See
  [Performance](../../why/performance/).
- Contract methods that are not `async`, are generic, or take borrowed arguments cannot cross apps
  after a split; their callers stop compiling and must change first.
