---
title: Developer experience
description: sofie dev, the development toolbar, the movable clock, compiler-style diagnostics, generators, sofie fix and upgrades.
sidebar:
  order: 10
---

A fixed structure pays off while you work, not only in production. Because sofie knows where
every kind of code lives, it can rebuild only what changed, show what a request did without
extra instrumentation, write new code into the right place, explain a broken rule with its fix,
and rewrite an app when the framework’s API changes.

## `sofie dev`

```sh
sofie dev [--at INSTANT] [--remote-database] [ROOT]
```

`sofie dev` runs `sofie gen`, builds the app with `sofie/development`, and runs it with
`SOFIE_MIGRATE=on` and the keys of the app’s `.env` that the environment does not already set.
A `DATABASE_URL` on another host is refused unless `--remote-database` is passed, so a
development run cannot migrate a shared database by accident.

It polls the modules, the app crate and `web/` for changes (no file watcher dependency), and
reacts by the kind of file:

| Changed | What happens |
|---|---|
| A screen template | Open pages reload; a debug build reads templates from disk, so nothing is rebuilt. |
| A mail template (`src/mails/*.html`) | The next send rereads it; no rebuild. |
| A Svelte island | It is rebuilt into the development directory and swapped in place; its islands remount with their props. |
| Anything else, or a file added or removed | The app is regenerated, rebuilt and restarted. If the build fails, the running app keeps running. |

Pages learn of a change through a small development client (sofie-http’s `development` feature,
debug builds only). It holds a request to `/_sofie/dev/reload` and reloads when the generation
`sofie dev` writes moves or the server’s boot id changes.

On Ctrl-C, SIGTERM or the SIGHUP of a closed terminal, `sofie dev` stops and reaps every
long-running child it started (the app, cargo builds, Node for island builds), then exits with
130, 143 or 129. `sofie mcp`, `sofie fuzz` and `sofie seed` do the same. A SIGHUP that was ignored
when sofie started, as under `nohup sofie dev &`, stays ignored.

## The development toolbar

Development builds show a toolbar under each page. It shows the request’s span tree so far: the
handler, the screen, every statement with its SQL, the flags evaluated, the route’s permission
check, every permission check a handler or screen made (granted or refused) and the area. The
span tree is the telemetry the app already records, so the toolbar adds no instrumentation of
its own.

The toolbar can also change how this browser’s requests run:

- **Act as a principal** of any signed-in area, given its id. The session then carries that
  principal, so guards, `Principal`, grants and flag rules see it. “Stop acting” returns to the
  signed-in one.
- **Override a flag** to `on`, `off` or a variant’s name, over its stored rule. The stored flag is
  untouched.
- **Move the clock** to an instant, or shift it by hours. The request’s `Db` carries the app’s
  clock shifted by that much, so handlers, loaders and commits run at that moment while time keeps
  running.

Its summary line names every override the browser holds, so one is not forgotten while the
toolbar is closed. The overrides live in a `__Host-<app>-toolbar` cookie of this browser alone,
sealed with a key of the process: no client can write one itself, and a restart forgets them. Its
forms post to `/_sofie/toolbar`, same-origin and from this machine only.

The toolbar is the `toolbar` feature, compiled only with `debug_assertions`. A release build does
not contain it: it answers `/_sofie/toolbar` as not found and ignores the cookie, which a test run
with `--release` holds.

## The clock in development

Every handler that needs the time asks for `Clock`; nothing reads the system time directly. So the
whole app, schedules included, can run at another moment:

```sh
sofie dev --at 2027-01-01T09:00
```

This passes `serve --at` to the binary (feature `development`), which gives the app’s and the
worker’s database a clock that starts at that instant and runs on. An instant without an offset is
read in the display zone, `SOFIE_TIME_ZONE`, as the toolbar’s clock is.

The two differ in reach: `--at` moves the whole process, the worker included, while the toolbar
moves one browser’s requests and leaves the worker and other browsers on the app’s clock. Tests
move time with `app.advance`, described in [Testing](../../features/testing/#the-clock-you-can-move).

## Diagnostics

`sofie gen` and `sofie check` report like the Rust compiler: the rule, what is wrong, the file and
line, and the fix.

```text
error[<rule>]: <what is wrong>
  --> modules/order/src/areas/web/routes.rs:5
   = help: <the fix>

1 problem
```

A clean app answers `ok`. `app/build.rs` runs `sofie check`, so a finding also fails
`cargo build`. The rules are listed in the [rules reference](../../reference/rules/).

### `sofie fix`

`sofie fix` applies the fixes that have exactly one form, then reports what `sofie check` still
finds:

- a missing `mod` line for a module’s manifest, config, routes or menu;
- the app’s missing dependency on a module, or on the contract defining an area it routes in;
- a contract’s missing `mod r#gen;` and `pub use r#gen::…;`, and a `main` not handing tasks to
  the runner (both of which `sofie gen` also writes);
- a stale generated file or documentation page.

Nothing that needs a decision is changed.

## New apps, modules and code

`sofie new app <name>` creates the app’s workspace (with the release profile `sofie build` uses),
its `app/` crate and an empty `modules/`. `sofie new module <name>`, run in an app, adds a module
with its manifest, contract crate, config, a `web` area with an empty `routes.rs` and a `screens/`
folder, and folders for migrations and translations, then makes the app depend on it. Both end by
running `sofie gen`, so the result passes `sofie check` and compiles.

Inside a module, `sofie new` writes stubs that compile and are wired, then runs `sofie gen` and
`sofie check`. It refuses to overwrite, and validates names: snake case for modules, functions and
screens, Pascal case for types.

| Command | Writes |
|---|---|
| `sofie new migration MODULE NAME` | An empty `migrations/NNNN_<name>.sql`, numbered after the last. |
| `sofie gen migration MODULE NAME` | The next migrations, from the difference between the module’s aggregates and what its migrations create. |
| `sofie new aggregate MODULE Name` | `src/<name>/mod.rs` with `#[derive(Aggregate)]`, its `mod` line and re-export, and a migration creating its table. |
| `sofie new event MODULE Name` | A `#[derive(Event)]` struct in the contract’s `events.rs`. |
| `sofie new listener MODULE Event handler` | An `#[on]` function in `src/listeners.rs`. |
| `sofie new task MODULE name` | A `#[task]` function in `src/tasks.rs`, and the `tasks` feature. |
| `sofie new route MODULE AREA METHOD PATH handler` | A handler stub in `actions.rs` or `queries.rs`, joined to the area’s `routes.rs`; with `--screen`, a screen and a loader. |
| `sofie new menu MODULE AREA handler LABEL` | A menu entry for a parameterless `get` page. |
| `sofie new area MODULE NAME ACCESS` | An area in the contract, `public`, `owned` or `permitted`; a member area gets its sign-in and first page. |

`sofie new search`, `plan`, `mail`, `account-screen`, `impersonation` and `tenancy` follow the same
pattern; `AGENTS.md` lists every generator with its arguments, and the
[commands reference](../../reference/commands/) has the full list.

`sofie gen migration` writes migrations that are safe to deploy without downtime: new columns
nullable or with a default where a behavior fills old rows, CHECKs on existing tables `NOT VALID`
with `VALIDATE` in a following file, each index on an existing table `CONCURRENTLY` in a file of
its own, and a dropped column only as a commented `DROP COLUMN`. What it cannot read it writes as
a comment or a note.

`sofie new route` with `--screen` on a `get` whose path names an aggregate (`/orders/{order}`)
writes a loader and a read model of the aggregate’s stored fields. It leaves out the owner field,
references to other records and anything marked sensitive, and names each field it leaves out. The
screen starts with a link back to the area’s list page, and the output says which link it chose.

`sofie scaffold screen <module>/<area>/<screen>` writes a resource’s built-in screen into the
module’s area, which then overrides it.

## Upgrades

The structure is fixed, so a framework upgrade can rewrite apps. Each release that changes an API
ships codemods, and upgrading is running a command and reviewing a diff:

```sh
sofie upgrade          # show each change
sofie upgrade --write  # write them, run sofie gen, report what sofie check finds
```

`sofie upgrade` runs every codemod over the Rust files of the app and its modules and prints each
change as the line before and after, naming the codemod and the breaking change it carries. A
codemod that brings in another crate’s path adds that crate to the rewritten crate, the app and the
workspace’s dependencies in the same write.

A codemod rewrites only the old form of an API, by `syn` spans, so the rest of a file keeps its
formatting. Running it on upgraded code changes nothing, so an app keeps no record of which
codemods ran. Manifest codemods run first, over every `Cargo.toml` under the root, since
`cargo metadata` refuses the app until they are written. While a manifest codemod has changes to
show, a run without `--write` shows only those.

## Limits

- `sofie fix` does not yet draft a missing translation key in every language.
- A `use` naming a moved item inside a group of other items is left for the compiler to point at;
  `sofie upgrade` does not rewrite it.
- No catalog component has changed yet, so no template codemod exists; templates are not yet
  rewritten by `sofie upgrade`.
- `sofie gen migration` reads migration files, not a database. Types it cannot read, bound CHECKs
  and changed enum CHECKs are written as comments, and a changed column type or nullability as a
  note, for you to finish.
