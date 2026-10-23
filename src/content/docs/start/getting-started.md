---
title: Getting started
description: Install the sofie CLI, create an app and run it.
---

## Requirements

- Rust 1.99 or later.
- A Postgres database you can reach from this machine. SQLite works too, with sofie’s `sqlite`
  feature.
- Node, only if the app will have Svelte islands or client areas.

## Install the CLI

Until the crates are published, the CLI installs from the repository:

```sh
cargo install --git https://github.com/sofie-rs/sofie sofie-cli
```

## Create an app

```sh
sofie new app shop
cd shop
```

The new app depends on the framework at the commit the CLI was built from, so the two always
match. It holds no module yet:

```text
shop/
├── Cargo.toml        the workspace, with sofie and sofie-cli
├── AGENTS.md         what goes where and every command, kept current by sofie gen
├── .env.example      every setting the app reads, kept current by sofie gen
├── app/              the binary: wiring only, no module code
└── modules/          one folder per module
```

## Configure it

```sh
cp .env.example .env
```

In `.env`, set two values:

- `DATABASE_URL`, such as `postgres://sofie:sofie@127.0.0.1:25432/sofie`.
- `SOFIE_SIGNING_KEYS`, the output of `openssl rand -base64 32`. It seals sessions and signs
  links.

The [environment reference](../../reference/environment/) lists every other setting.

## Run it

```sh
sofie dev
```

`sofie dev` migrates the database, runs the app at `http://127.0.0.1:8080` and rebuilds and
reloads it when the code changes. A new app routes no page yet, so `/` answers “Not found.”

A binary started outside `sofie dev` migrates only with `SOFIE_MIGRATE=on`, so a deployment
decides which process migrates and when. On a database with none of the framework’s tables it
refuses to start and says so.

## Add to it

```sh
sofie new module catalog
```

A module starts in the `Core` tier; `modules/catalog/src/module.rs` changes it. Add to it with
the generators:

- `sofie new aggregate catalog Product`: a record and the migration creating its table.
- `sofie new route catalog web get /products list_products --screen products`: a query, the
  endpoint serving it and its screen.
- `sofie new event` and `sofie new listener`: a fact one module publishes and another reacts to.

After changing routes, modules, aggregates or screens, run `sofie gen`. A finding of
`sofie check` fails `cargo build`, so the app cannot drift from its structure. The
[command reference](../../reference/commands/) lists every command.
