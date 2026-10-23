---
title: How sofie works
description: The structure an app follows and what the framework derives from it.
---

An app written in sofie’s structure gets features without writing them. The structure is fixed,
so the framework can read the whole app and derive its wiring, endpoints, screens, permissions,
telemetry, documentation and checks. Every rule exists because something is generated or
enforced from it.

## Principles

- **A role exists only if the framework acts on it.** It wires, generates or checks it.
  Everything else is plain private Rust inside a module.
- **Location before annotation.** A file’s place says what it is. An annotation carries only
  what the place cannot, such as a schedule.
- **Generate data, never behaviour.** Behaviour is library code written once. A derive describes
  one type to it; `sofie gen` writes only what no single type can know, such as the app’s wiring.
- **No hidden runtime machinery.** No container, reflection or service locator: wiring is plain
  construction, generated once per app.
- **The compiler enforces what it can; `sofie check` enforces the rest.**
- **The framework knows no business.** It ships mechanisms, never an audience, a currency or a
  vendor. The app declares those.

## The parts of an app

**App.** The deployable binary: a list of modules and configuration. It holds no business rule.

**Module.** The unit of ownership. It owns its data, its rules and its screens, and is a pair of
crates: the module and its **contract**, the only part other modules may use. A module’s **tier**
is `Experience`, `Core` or `Platform`, and dependencies only flow downward.

**Aggregate.** A record and its child rows, saved and loaded as one. Its fields are private to its
folder, so only its own methods and its factory change it. Its struct is the single source for
columns, validation, permissions, screen fields and search fields; migrations are hand-written
SQL, checked against it.

**Action and query.** An action is one state-changing use case, such as `PlaceOrder`; what it
changed is committed in one short transaction after it returns. A query is one read and gets a
read-only connection. Neither knows HTTP: an **area** exposes them as endpoints.

**Area.** An audience of the app, with its principal, access, URL prefix and layout. The framework
ships `Web`, the public face; the app defines the rest.

**Event.** A fact a module publishes, such as `OrderPlaced`, declared in its contract. It is
written to the outbox in the same transaction as the change that raised it, and a worker delivers
it after the commit. The same table carries jobs and scheduled runs.

**Screen.** A template of catalog components (`Table`, `Form`, `Field`, `Money`, …) that the
engine renders to HTML on the server and updates in the browser. What the catalog cannot express
is an **island**, written in Svelte.

**Gateway.** A trait a module defines for a third-party capability, with one adapter per vendor.
Every request leaving the app goes through one, traced and held to that vendor’s hosts.

## What is generated

`sofie gen` reads the app once into a single model of its modules, routes, areas and screens. It
writes the app’s wiring, what contracts export, `.env.example` and `AGENTS.md`, and checks every
screen binding against its loader’s type. Generated files are committed and never edited;
`sofie check` reports them stale when the code changes.

The full contract is in
[`docs/structure.md`](https://github.com/sofie-rs/sofie/blob/main/docs/structure.md), and how the
framework implements it in
[`docs/core.md`](https://github.com/sofie-rs/sofie/blob/main/docs/core.md).
