---
title: Architecture overview
description: The layout of a sofie app, the roles of its files, modules and tiers, the app model, what sofie gen writes, and the crates of the framework.
sidebar:
  order: 1
---

Every sofie app has the same shape. That is the point: because the layout is fixed, the
framework can read an app into one model and derive its wiring, documentation and checks from it.
This page walks through that shape from the outside in: the folders, the roles of the files in
them, the modules they form, the model `sofie gen` reads, and the crates that implement it all.

## Layout of an app

An app is a Cargo workspace with one binary crate and one folder per module:

```text
AGENTS.md                 generated: the conventions, for agents and people
app/                      the binary
  build.rs                runs `sofie check` and compiles screens and islands
  src/
    main.rs
    wiring.rs             generated: MODULES, app, worker, route table
modules/
  order/
    contract/             crate order-contract, the only importable part
      src/
        lib.rs            traits other modules call
        events.rs
        area.rs           an area, only in the module that owns its principal
        gen/              generated: exposed DTOs, route builders
    src/                  crate order
      module.rs           manifest: the module declares itself
      wiring.rs           generated: what the manifest spreads
      config.rs           its configuration and environment keys
      order/              one folder per aggregate: mod.rs, factory.rs
      actions/            one file per action
      queries/            one file per query
      areas/customer/     routes.rs, menu.rs, screens/, islands/
      gateways/           gateway traits and one adapter per vendor
      extensions/
      domain/             private code: value objects, calculations
    migrations/           NNNN_name.sql
    lang/                 <language>.toml
```

A module needs only `module.rs` and one aggregate folder to start. Every other folder appears
when its first file does. A small module may also keep its actions in `actions.rs` and its queries
in `queries.rs`, as the example shop does. The [layout reference](../../reference/layout/) lists
the place of every file.

The app crate holds no module code. Its `main.rs` hands the generated wiring to `sofie::run`:

```rust
// examples/shop/app/src/main.rs
fn main() -> sofie::core::Result<()> {
    sofie::run(shop::MODULES, shop::app, shop::worker)
}
```

Its build script runs `sofie check`, so a finding fails `cargo build`:

```rust
// examples/shop/app/build.rs
fn main() -> std::process::ExitCode {
    sofie_cli::check_in_build_script(std::path::Path::new(".."))
}
```

## Roles and what each one buys

A role is a kind of file the framework acts on. Each exists because something is generated or
enforced from it; everything else in a module is plain private Rust.

| Role | Location | The framework generates or enforces |
|---|---|---|
| Manifest | `module.rs` | Module registry, tier and dependency checks, feature and setting catalogs, architecture docs, the boundary a split cuts along |
| Config | `config.rs` | A typed config struct, boot-time validation, the module's `.env.example`, injection into its handlers |
| Aggregate | `<aggregate>/mod.rs` | Columns, field metadata, load and save, validation, input DTOs, permissions, form fields, table columns, fixtures, contract DTOs for exposed fields |
| Read model | beside the queries that use it | One SQL statement with its joins, decoding, screen binding |
| Migration | `migrations/*.sql` | Applied in order, compared with the schema, checked not to lock a table the running version uses or to name another module's schema |
| Factory | `<aggregate>/factory.rs` | The only constructor, enforced by module privacy; derived by default when absent |
| Action | `actions/*.rs` | Arguments resolved by type, the commit of what it returns, span and metrics; by annotation a queued job, a schedule or an event listener |
| Query | `queries/*.rs` | A read-only connection (a type, so writing does not compile), screen data binding |
| Area definition | `contract/src/area.rs` | The audience's principal, prefix, sign-in path and layout |
| Routes | `areas/<area>/routes.rs` | The module's endpoints in that area, with derived route names |
| Menu | `areas/<area>/menu.rs` | The area's navigation, linked by route name |
| Screen | `areas/<area>/screens/*.html` | Rendering, bindings checked against its loader, translation keys |
| Island | `areas/<area>/islands/*.svelte` | Build and hot reload, props typed from its loader, one bundle per area |
| Resource | one line in `routes.rs` | Index, show, create, edit and delete screens and their actions, with no file |
| Contract | `contract/` | In-process wiring today; a remote client and server once the module is split |
| Event | `contract/src/events.rs` | Outbox write, delivery, retries, listener registry |
| Gateway and adapter | `gateways/` | The configured vendor chosen at boot, span and metrics per vendor call, a test fake |
| Extension | `extensions/` | Registration with the extension point |
| Translations | `lang/` | Labels derived from field names, so files hold only what differs; a parity check across languages |

The pages on [data](../data/), [handlers and routes](../handlers-and-routes/),
[messages](../messages/), [screens](../screens/) and [areas](../areas/) cover each role in
depth.

## Modules, tiers, contexts and contracts

### Modules

A **module** is the unit of ownership. It owns its data, its rules and its screens, and it is a
pair of crates: the module itself and its contract. Each module's tables live in its own database
schema, named after the module.

### Contracts

The **contract** is a module's public surface: the traits other modules call, the data they
receive and the events it publishes. It is the only thing another module may import; `sofie
check` refuses a module that depends on another module's implementation crate, and a contract
that depends on any module. No foreign key or join crosses modules either. When one module needs
to filter by another's fields it keeps a mirror, a local read-only copy kept current from change
events.

A contract also exports generated code in `contract/src/gen/`: DTOs of the fields an aggregate
exposes, their change events, and typed route builders, so modules link to each other's endpoints
without depending on implementations.

### Tiers

A module's **tier** is `Experience`, `Core` or `Platform`, and dependencies only flow downward:

- **Experience** modules compose others for an audience, such as a checkout that calls the
  catalog, order and payment contracts in one action.
- **Core** modules hold the business: catalog, order, payment.
- **Platform** modules serve every other module: files, communication. A Platform module reacts to
  Core only by being called; its listeners hear Platform events only.

`sofie check` enforces the order, reading Cargo metadata and each manifest's tier. Cargo itself
refuses cycles.

### Contexts

A **context** is a named group of Core modules that belong to one part of the business, such as
`commerce`. It is metadata for the documentation and for splitting several modules together, and
it grants no extra access.

## Module declaration and configuration

A module declares itself in one file and carries its configuration with it, so that splitting it
out moves files rather than untangling them.

```rust
// examples/shop/modules/order/src/module.rs
use sofie::{Module, Tier};

pub const MODULE: Module = Module {
    name: "order",
    tier: Tier::Core,
    context: Some("commerce"),
    settings: &[],
    ..crate::wiring::GENERATED
};
```

The manifest states the module's name, tier, context and runtime settings, and spreads what
`sofie gen` wrote into `src/wiring.rs`: migrations, area routes and menus, route names,
listeners, schedules and jobs. `name` must be the crate name, because it is also the module's
database schema and its configuration prefix; `sofie check` reports a mismatch.

Configuration is a struct deriving `sofie::Config`:

```rust
// modules/order/src/config.rs
#[derive(sofie::Config)]
pub struct OrderConfig {
    /// Printed before every invoice number.
    invoice_prefix: String,
    /// Hours a placed order may stay unpaid; 24 when unset.
    payment_window_hours: Option<u64>,
    payment_api_key: Secret<String>,
    database: Database,
    queue: Queue,
}

// a handler or job asks for it by type
pub async fn expire_unpaid(read: Read, config: Config<OrderConfig>) -> Result<Vec<Order>>
```

- **Keys are prefixed by the module.** `OrderConfig` reads `ORDER_INVOICE_PREFIX`,
  `ORDER_PAYMENT_API_KEY` and so on, and only `ORDER_*` keys. Two modules cannot collide.
- **Infrastructure inherits by default.** `Database` reads `ORDER_DATABASE_URL` and falls back to
  `DATABASE_URL`; `Queue` reads `ORDER_QUEUE_URL` and falls back to `DATABASE_URL` too. Before a
  split, an own value that differs from `DATABASE_URL` stops the start with an error.
- **Declared once.** The struct is the only list of keys. `sofie gen` reads it to write the
  module's `.env.example`, with each field's doc comment, and the app's.
- **Fail at boot.** The wiring loads every module's config before the app is built; a missing or
  malformed key stops the app, naming the module and the key. A `Secret` is never printed,
  logged or serialized.
- **A module reads only its own config.** No code outside the framework's loader reads environment
  variables; `sofie check` refuses `env::var` and `env!` in modules.

**Settings**, unlike config, change at runtime. They are declared in the manifest with a default,
stored in the database behind the `feature-flags` feature, and read by a handler through
`sofie::RuntimeSettings`.

## The app model

`sofie gen` reads the app once, from source and without compiling, into a single model of its
modules, schemas, routes, areas, screens, flows and rules. The model lives in the `sofie-model`
crate, which also holds the naming rules, so a name such as a route name
(`module.area.handler`) is derived by one function wherever it is needed.

Every generator, every `sofie check` rule, the generated documentation, `sofie explain` and the MCP
server read that same model. They cannot disagree about what the app contains.

## What `sofie gen` writes

`sofie gen` writes Rust in two places only, the app's wiring and what each contract exports, and
no Rust per type. Everything else it writes is not Rust.

| Output | Contents |
|---|---|
| `modules/<module>/src/wiring.rs` | `GENERATED`, the `Module` the manifest spreads: migrations, area routes and menus, route names, listeners, schedules, `#[job]` actions and mirrors' listeners, named from inside the crate so none of them needs to be `pub` |
| `app/src/wiring.rs` | `MODULES`, the screens the build script compiled and their forms, and `app` and `worker` built from them: config loading, contract implementations, extensions, route flag and permission tables, `#[task]` functions |
| `contract/src/gen/` | DTOs of exposed fields and their change events, route builders and, with `Permitted` areas, permission constants |
| `.env.example` | One per module and one for the app |
| Template binding checks | Errors only, no files |
| `AGENTS.md` | The app's modules and areas, the commands, where each kind of code goes, and the rules it is held to; one written by hand is left alone |
| `docs/gen/` | Rewritten with the wiring once an app keeps it; see [Generated documentation](../../features/generated-docs/) |

Generated files are committed and never edited. `sofie gen --check` verifies them, and `sofie
check` reports stale wiring as a finding, which fails the build.

A `Module` is data, not behaviour. At runtime `sofie::run` migrates the modules' migrations, the
wiring's `app` loads the screens and mounts the areas, and its `worker` starts the message worker
from the same list. The same app can build a web binary and a worker binary from one codebase.

## The crates of the framework

The framework is split by what a binary must pull in, not by how many concepts there are. A crate
exists when some app or some binary can do without it.

| Crate | Holds |
|---|---|
| `sofie` | The facade: re-exports everything an app uses; features choose the crates |
| `sofie-model` | The app model and naming rules, parsed with `syn`; nothing of it is in the binary |
| `sofie-macros` | The derives (`Aggregate`, `Value`, `Enum`, `ReadModel`, `Input`, `Config`) and inert attributes |
| `sofie-core` | The value model, `Error`, ids, the clock, encodings and the registration rules boot and `sofie check` share |
| `sofie-values` | Shipped values: `Money`, `Email`, `Instant`, `Date`, `Slug`, `Url`, `Secret` and more, most behind features |
| `sofie-auth` | Signing and sealing: session cookies, signed links, token digests |
| `sofie-telemetry` | Tracing setup, log masking, metrics; OTLP export behind a feature |
| `sofie-engine` | The template renderer, the component catalog, embedded htmx, island mounting |
| `sofie-db` | The handler model, store, unit of work, query builder, read models, migrations, the message table and its worker, the database seam's traits |
| `sofie-postgres` | The database seam for Postgres |
| `sofie-sqlite` | The database seam for SQLite in one file, for an app running as one instance |
| `sofie-client` | Outgoing HTTP for gateways and remote contracts, traced and held to allowed hosts |
| `sofie-http` | The server on `hyper`, the router, areas, guards, sessions, security headers, `Module` |
| `sofie-flags` | Feature flags and runtime settings |
| `sofie-cache` | Opt-in cache in memory, in the database or in Redis |
| `sofie-storage` | Opt-in files, in a local directory or an S3-compatible bucket |
| `sofie-mail` | Opt-in mail rendered from templates and sent by a job |
| `sofie-billing` | Opt-in plans, entitlements, quotas and subscriptions |
| `sofie-notify` | Opt-in inbox, mail and web push per principal's choices |
| `sofie-content` | Opt-in Markdown pages with publishing and a sitemap |
| `sofie-identity` | Opt-in module: accounts, memberships, passwords, sign-up, sign-in and sign-out |
| `sofie-tenancy` | Opt-in module: organizations owning records, members, roles, invitations |
| `sofie-testing` | The test harness |
| `sofie-check` | The rules `sofie check` and an app's build script run |
| `sofie-cli` | The `sofie` command: `new`, `gen`, `check`, `fix`, `docs`, `openapi`, `typescript`, `explain`, `split` and more |

An app depends on `sofie` alone and turns features on or off rather than wiring crates by hand.
What not every app needs is a feature, off by default, so the framework compiled into an app stays
small.

## Splitting a module out

Because a module owns its data, imports only contracts and reads only its own config, it can be
moved into an app of its own. `sofie split <module>` prints a plan and changes nothing; `sofie
split <module> --write` carries it out, and a failure part-way undoes every move and edit.

```sh
sofie split payment          # the plan
sofie split payment --write  # carry it out
```

The plan names what moves, what is served over HTTP, the keys each app needs, and the contract
methods that cannot cross apps: ones that are not `async`, are generic, take `&mut` or a borrowed
type, or answer other than a `Result` of an owned type. Their callers stop compiling. It also
lists the app's test files naming the module, which it does not move.

- **Where it goes.** The module folder moves to `split/<module>/modules/`, beside a new app crate
  `split/<module>/app`. Both apps stay members of one Cargo workspace, so the contract crate is
  shared by path. Then `sofie gen` runs in both apps.
- **Data, not code.** Each app's `[package.metadata.sofie]` says which modules it `serves` and
  which are `remote`. The app left behind drops the module's crate, keeps its contract and turns on
  sofie's `remote-contracts` feature.
- **Wiring.** For a remote module the wiring calls `sofie::remote::connect("<module>")?`, reading
  `<MODULE>_REMOTE_BASE_URL` and the other `<MODULE>_REMOTE_*` keys. Events cross apps as a feed
  each app publishes and others pull with a cursor, so no broker is needed.
- **Sign-in.** Sign-in stays with `sofie-identity`; both apps read the session cookie and share
  `SOFIE_SIGNING_KEYS`.
- **Reverse proxy.** `proxy.toml` beside the app left maps each path prefix of the module's routes
  to the new app. `/_sofie/` is never routed from outside the network.
- **Database.** Setting `<MODULE>_DATABASE_URL` points the moved module at its own database with
  no code change.

## Trade-offs

- **A fixed layout.** Folders and file roles are set by the framework. Code that fits no role is
  private Rust in `domain/` and gets no framework support.
- **Split-readiness has a price.** Modules never share a transaction or a join, even inside one
  binary. Cross-module reads use contracts, batch lookups or mirrors.
- **Generated files in version control.** Wiring, contract exports and `.env.example` are committed
  and must be regenerated when the app changes; the build fails until they are.
- **The model reads source, not types.** `sofie gen` does not compile the app, so data bound by a
  screen must be a read model it can read, and some edges it cannot resolve are reported rather
  than guessed.
