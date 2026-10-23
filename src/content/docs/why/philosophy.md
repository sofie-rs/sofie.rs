---
title: Why Sofie
description: The problem sofie addresses, the principles it follows and the trade-offs a team accepts by using it.
sidebar:
  order: 1
---

sofie is a Rust web framework built on one idea: if every app follows the same fixed structure,
the framework can read the whole app and derive most of what is usually written by hand. This
page explains the problem that idea answers, the principles that follow from it, and what a team
gives up in return.

sofie is a proof of concept, partly built. Nothing on this page is a promise of stability.

## The problem

A typical web app carries a large amount of code that is not its business:

- **Wiring.** Registering routes, listeners, jobs and schedules; constructing services and handing
  them to handlers; loading configuration and passing it down.
- **Boilerplate.** Input types that repeat the fields of a record, form fields that repeat the
  input, table columns that repeat the record again, permission names typed by hand.
- **Drift.** The architecture diagram, the API description, the list of environment keys and the
  security review are written beside the code and fall behind it. Checks such as "this module may
  not reach that one" live in a wiki or in a reviewer's memory.

Each of these is a second copy of something the code already says. A second copy can disagree
with the first, and someone has to keep the two in step.

## The promise

An app written in sofie's structure gets features without writing them. The structure is fixed,
so the framework can read the whole app and derive wiring, endpoints, screens, permissions,
telemetry, documentation and checks from it.

The structure is the price of that promise, and it is kept small on purpose: every rule in it
exists because something is generated or enforced from it. A rule that feeds nothing does not
belong in the structure.

## The eight principles

### 1. A role exists only if the framework acts on it

A role is a kind of file the framework knows: a manifest, an aggregate, an action, a query, a
screen, a gateway. Each role is there because the framework wires, generates or checks something
from it. Everything else is plain private Rust inside a module, with no framework vocabulary.

**Buys:** a short list of things to learn, each with a visible payoff. **Costs:** code that does
not fit a role gets no help from the framework; it is ordinary Rust in the module's `domain/`
folder.

### 2. Location before annotation

A file's place says what it is. A function in `actions/` is an action; a template in
`areas/customer/screens/` is a screen of the `customer` area. An annotation carries only what the
place cannot, such as a schedule (`#[every("15m", …)]`) or an event to react to (`#[on]`).

**Buys:** a reader finds code by its kind without searching, and the framework finds it the same
way. **Costs:** the folder layout is not yours to choose.

### 3. Generate data, never behaviour

Behaviour — loading, saving, querying, routing, rendering, tracing — is generic library code,
written and tested once and shared by every app. A derive such as `#[derive(Aggregate)]` only
describes one type to that library: its table, its columns, its fields. `sofie gen` writes only
what no single type can know: the app's wiring across crates, what each contract exports, and
output that is not Rust, such as `.env.example`. Where a type or module privacy can enforce a
rule, nothing is generated for it.

**Buys:** generated code stays small and boring, compiler errors point at the developer's own
lines, and a fix to the library reaches every app at once. **Costs:** behaviour that the library
does not offer is written by hand, not generated per app.

### 4. No hidden runtime machinery

There is no dependency-injection container, no reflection and no service locator. Wiring is plain
construction, generated once per app into `app/src/wiring.rs` and committed. A handler receives
what its signature asks for, resolved by type in that generated code; an argument of a type
nothing can provide is an error when the wiring is generated, not at runtime.

**Buys:** what runs is code a developer can open and read, and a missing dependency is found
before the app starts. **Costs:** the wiring must be regenerated when the app changes; `sofie
check` reports it stale until it is.

### 5. The compiler enforces what it can; `sofie check` enforces the rest

A rule that can be a type or a crate boundary is one. A query receives a read-only connection, so
writing from a query does not compile. An aggregate's fields are private to its folder, so only
its own methods and its factory can change it. A module may import only another module's contract
crate. What the type system cannot express — tier order, no SQL joins across modules, environment
variables read only through config — is a `sofie check` rule. The app's build script runs `sofie
check`, so a finding fails `cargo build`.

**Buys:** architecture rules hold on every build, not only in review. **Costs:** the checks are
strict, and a justified exception needs an explicit allow entry with its reason.

### 6. Every piece of knowledge lives in one place

The aggregate's struct is the schema: the single source for columns, validation, input types,
permissions, form fields, table columns and search fields. The manifest (`module.rs`) is the
module's identity. The area folder is what an audience may reach. Migrations are hand-written SQL,
and they are checked against the schema rather than generated from it.

**Buys:** a change is made once, and everything derived from it follows. **Costs:** a field that
should look different on one screen than the schema says needs an explicit override.

### 7. The framework knows no business

sofie ships mechanisms — areas, values, behaviors, flags, gateways, the engine — and never an
audience, a currency, a vendor, a language or a domain concept. The only area it ships is `Web`,
the app's public face; every other audience, such as a customer area or a console, is declared by
the app. Examples use a small shop only because it is widely understood; nothing in them is part
of the framework.

**Buys:** the framework fits any domain without fighting assumptions built into it. **Costs:** the
app declares its own areas, plans, topics and vendors, even common ones.

### 8. One app model

`sofie gen` reads the app once into a single model of its modules, schemas, routes, areas,
screens, flows and rules. Every generator, every check, the generated documentation, `sofie
explain` and the MCP server read that same model, so they cannot disagree with one another.

**Buys:** the documentation, the API description and the checks describe the same app the wiring
was built from. **Costs:** the model is read from source without compiling, so it understands what
the structure declares and does not guess at the rest. Where it cannot resolve something, such as
a call whose type only inference knows, it says so rather than inventing an answer.

## What Sofie deliberately does not do

**No runtime magic.** Nothing is discovered by scanning at startup, and nothing is registered by
side effect. The binary is the server, built on `hyper` directly, with no separate process in front
of the app's code.

**No business.** sofie has no idea what a customer, an order or a price list is. It ships values
such as `Money` and `Email`, behaviors such as `SoftDelete`, and opt-in packages such as accounts
(`sofie-identity`), but the meaning of each audience and record belongs to the app.

**No infrastructure beyond the database.** Data, events, jobs, schedules, sessions, flags and
settings all live in the database. There is no Redis, broker or search engine in the core; each can
be added behind a gateway or an opt-in feature. See
[Data and persistence](../../architecture/data/).

**No per-type generated behaviour.** `sofie gen` writes no Rust per type. A derive emits trait
implementations, never logic.

**No frontend framework in the critical path.** Screens are templates of catalog components that
the engine renders to HTML on the server and updates in the browser with htmx. What the catalog
cannot express is an island, written in Svelte. An app without islands needs no Node toolchain.

## The structure under strain

The structure is meant to hold for real features, not only for a CRUD resource. A few cases where
it is pressed, and the design each produced:

- **A process across modules.** Checking out a cart touches catalog, order and payment. There is
  no process object. The synchronous part is one action in an Experience module calling contracts,
  each contract write committing its own unit of work. The asynchronous part is events. An order
  left `Pending` after a failed payment is expired by a scheduled action, so the aggregate's status
  is the state.
- **A vendor call inside a write.** A payment must return the vendor's redirect to the member. This
  is safe because no transaction is open while a handler body runs: the unit of work commits in
  one short transaction after the body returns, and methods with side effects at a vendor take an
  `IdempotencyKey`, a type only the framework constructs.
- **Filtering by another module's field.** Joins across modules are forbidden, so a console that
  filters orders by the member's city keeps a mirror: a local, read-only copy of the fields the
  member module exposes, kept current from its change events. It costs one declaration and keeps
  working after the module is split out.
- **A low-tier module reacting to a high-tier one.** A Platform module may not import a Core
  module's contract, so it cannot listen to its events. The Core module listens to its own event
  and calls the Platform module's contract instead.
- **A plain record with no rules.** Construction always goes through a factory, but a record with
  nothing to hold gets a default factory and a default update derived from its schema. Writing
  either replaces the default.

## Trade-offs a team accepts

**A fixed structure.** The layout of an app, the roles of its files and the direction of its
dependencies are set by the framework. A team that wants to arrange code its own way will find
sofie in the way. In return, any sofie app reads like any other, and an upgrade can rewrite apps
with codemods (`sofie upgrade`) because it knows where everything is.

**Generated wiring, committed.** `app/src/wiring.rs`, each module's `src/wiring.rs`, each
contract's `src/gen/`, `.env.example` and `AGENTS.md` are written by `sofie gen`, committed and
never edited. They show up in diffs, and `sofie check` fails the build when they are stale. This
is more files under version control, but each one is a reviewable record of what the app is.

**Split-readiness costs something now.** Modules do not share transactions or join each other's
tables even while they run in one binary, so that `sofie split` can later move a module out
without changing its queries. That means mirrors and batch lookups where a monolith would use a
join.

**A proof of concept.** sofie is partly built. Some mechanisms described in its design documents
are not implemented yet, APIs still change (a release that changes one ships a codemod for `sofie
upgrade`), and the crates are published as 0.1.0. Postgres is the main database, and SQLite is
available for an app running as one instance. A team adopting sofie today is adopting a design under construction.

## Further reading

- [How Sofie works](../../start/how-it-works/): the parts of an app in one page.
- [Architecture overview](../../architecture/overview/): layout, roles, modules and crates.
- [Size and speed](../performance/): how sofie measures itself.
- [`docs/structure.md`](https://github.com/sofie-rs/sofie/blob/main/docs/structure.md): the full
  contract every app is built against.
