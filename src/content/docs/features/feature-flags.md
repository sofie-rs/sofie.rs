---
title: Feature flags
description: Flags declared in a module's manifest, gating routes, jobs, menus and parts of screens, with rules per environment, area, principal and percentage.
sidebar:
  order: 3
---

A feature flag service bolted onto an app knows nothing about the app. It can answer "is this on",
but every place that should obey the answer has to ask, by hand: the route, the menu entry, the
button, the job. One forgotten place shows a half-built feature or runs it in the background.

sofie builds flags in, because everything a flag can gate is already known to the framework. A
flag is a constant in Rust; a route, an action, a listener, a menu entry or part of a screen names
it, and the framework applies it everywhere it is named. Deleting the constant breaks the build at
every place that still uses it.

Flags live in `sofie-flags`, exposed as `sofie::flags` behind the `feature-flags` feature of
`sofie`.

## Declaring a flag

A flag is declared in its module's manifest, `src/module.rs`, and named `<module>.<flag>` by a
literal, once in the app:

```rust
// modules/order/src/module.rs
pub const SPLIT_PAYMENTS: Feature =
    Feature::new("order.split_payments").added("2026-09-01").retire_after_days(30);

pub const CHECKOUT_LAYOUT: Variants<CheckoutLayout> =
    Variants::new("order.checkout_layout").added("2026-10-01");
```

`Feature` is on or off. `Variants<V>` picks one of an enum's variants, such as a layout under test.
`.added(…)` is required: it is the day the flag was added, as a `YYYY-MM-DD` literal. Its use is
covered under [flag age](#flag-age).

`sofie check` (rule `feature-flag`) holds the naming: a flag is named after its module and
declared once.

## What a flag gates

| What | How | When off |
|---|---|---|
| An endpoint | `routes.post(…).feature(SPLIT_PAYMENTS)` | 404, so a hidden feature is not revealed; another method on the same path does not list it in a 405's `Allow` |
| An action, listener or schedule | `#[sofie::feature(SPLIT_PAYMENTS)]` | Not run; the skip is traced |
| A menu entry | `.feature(…)` on the entry | Not shown |
| Part of a screen | `{#if enabled("order.split_payments")}…{/if}` | No gated markup is sent |
| A branch in code | `features.enabled(SPLIT_PAYMENTS)` or `features.variant(CHECKOUT_LAYOUT)` | The code decides |

The attribute is `#[sofie::feature(…)]` with its path, because a bare `feature` is Rust's own crate
attribute.

A handler that branches takes `Features` as an argument, like any other argument it resolves:

```rust
async fn pay(features: Features, input: Payment) -> Result<Receipt> {
    if features.enabled(SPLIT_PAYMENTS) {
        // …
    }
    // …
}
```

### In screens

A condition in a template is evaluated while rendering, for the request's principal, exactly like a
permission check. Nothing hidden reaches the browser: a fragment request cannot reach a hidden part
by its id, and a render made outside a request shows nothing gated.

A JSON caller, or a client area's envelope, gets `null` for each data path bound only inside parts
gated off for the viewer, so the data a hidden part would have shown is not sent either.

## Rules

What a flag answers comes from its `Rule`, stored per flag:

- **Switched on.** A flag nobody stored a rule for is off.
- **Narrowed** to environments and areas. None listed means all.
- **Open** to listed principals, and to a percentage of the others.
- **Split by weight** between variants, for a `Variants` flag.

A percentage is decided by hashing the flag's name with the account id (FNV-1a), so each person
stays in or out as the percentage changes, rather than flipping on every request. A request
without a principal, and a job, are in only at 100%.

The environment is `SOFIE_ENVIRONMENT`, such as `production`. It is required once an app has flags:
a guessed environment could switch on in production a flag meant for staging.

### Changing a rule

Rules are stored in `sofie.flags` with the time each changed, and set with `Flags::set` or on
sofie-identity's flags screen. `Flags::set` validates the rule: names of letters, digits, `_` and
`-`, none listed twice, and a percentage up to 100.

```rust
flags.set("order.split_payments", Rule::everyone()).await?;
```

Each process holds the flags in memory, so a request reads what is held and never waits. A change
commits with a wake-up on the messages channel, and every process reads the table again, a burst
of changes once, after 200 ms. Without a wake-up, it reads again every 30 seconds. A failed read
keeps the last state.

## Wiring

Once a module declares a flag, `sofie gen` changes the generated wiring:

- `app(db, flags: Flags)` gives the flags to routes and handlers through
  `.gates(Gates::default().features(flags).route_features(ROUTE_FEATURES))`.
- `worker(db, flags: &Flags)` wraps each marked listener or schedule in `sofie::flags::gated`.
- The app's `main` calls `sofie::run_with_flags(MODULES, app, worker)` instead of `sofie::run`,
  which starts the flags once per process, for both the web and the worker role.

A worker-only binary calls `sofie::run_worker_with_flags(MODULES, worker)`, and
`sofie build --worker` names whichever one the app needs.

## Tracing and experiments

The flags a request evaluated, with their answers, are the request span's `feature_flags`
attribute (`order.split_payments=on`); a skipped job logs its flag.

A [product event](../../features/observability/#product-events) raised in a request or a gated job
carries the flags evaluated before it, variants included (`order.checkout_layout=COMPACT`). An
experiment's funnels split by variant without the code that raises the event naming it.

With the `etag` feature, a cached page's tag is also keyed by the flags' version, so changing a
rule changes the tag.

## Flag age

A flag is temporary. It declares the day it was added and how long it may live,
`retire_after_days`, 90 by default. Once it is older, `sofie check` reports it with its file and
line (rule `flag-age`).

The check is offline, so it cannot see whether the flag is fully on or off. A flag past its age is
either finished and due for removal, or rolling out longer than declared. The age counts from the
day the flag was added. The check runs in `sofie check` and not in the build script, so a build
never starts failing as days pass.

To see what the database holds, an operator runs the app's binary:

```sh
shop flags settled
```

It prints each settled flag, one either off or on for everyone with a single variant, with its
state and the days since its rule last changed:

```text
order.split_payments on 120
```

A settled flag is ready to be removed from the code.

## Removing a flag

Delete the constant. Every route, attribute, menu entry and code branch that names it stops
compiling, so none is left behind. A template names a flag by string, in `enabled("…")`, so search
the screens for it too; the generated documentation lists everything each flag gates.

## Trade-offs

- Flags are read from the app's own database, not an external service. Targeting is limited to
  what a `Rule` holds: environments, areas, listed principals, a percentage and variant weights.
- A change reaches every process through a database wake-up, else within 30 seconds; there is no
  stronger guarantee of when a running request sees it.
- A flag named in a template is a string, which deleting the constant does not catch.
- Percentages need a principal. Anonymous requests and jobs are either fully in or out.
