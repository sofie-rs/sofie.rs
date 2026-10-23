---
title: Events, jobs and gateways
description: How modules react to each other, how background work runs on the database alone, and how every request leaving the app goes through one way out.
sidebar:
  order: 4
---

An app needs work that does not happen inside one request: an email after an order is placed,
a reminder every hour, a record kept in step with another module's. The usual answer is a broker
or a queue beside the database, and with it a familiar failure: the database commits and the
message is lost, or the message is sent and the transaction rolls back.

sofie keeps all of it in the database. An event is written in the same transaction as the change
that raised it, and one worker delivers events, runs jobs and fires schedules from one table. A
job's effect and the removal of its message commit together, so its effect happens once.

The same page covers the two other ways a module reaches outside itself: **contracts**, the only
way modules call each other synchronously, and **gateways**, the only way a request leaves the
app.

## Events

An **event** is a fact a module publishes, such as `OrderPlaced`. It is declared in the module's
contract crate, in `src/events.rs`, so any module may hear it:

```rust
// modules/order/contract/src/events.rs
#[derive(Event)]
pub struct OrderPlaced {
    pub order: Uuid,
}

#[derive(Event)]
pub struct OrderCancelled {
    pub order: Uuid,
    pub reason: Option<String>,
}
```

An aggregate raises one from its own methods or its factory, with `self.meta.raise(…)`. Raising
does nothing yet: the event waits in the aggregate's `meta` until the action returns it, and the
commit that writes the aggregate stores the event in the same transaction. If the commit fails,
no event exists.

An event is stored under `<module>.<Type>`, such as `order.OrderPlaced`. `sofie check` refuses
an event declared in the module's own crate instead of its contract (`event-in-contract`).

## Listeners

A listener is an `async fn` marked `#[on]`. The type of its first argument is the event it hears,
so the attribute takes no arguments:

```rust
// modules/order/src/listeners.rs
#[on]
pub async fn audit_placement(event: OrderPlaced, clock: Clock) -> Result<AuditEntry> {
    factory::record(Id::from_uuid(event.order), AuditAction::Placed, clock.now())
}
```

A listener is a handler like any other. Its other arguments are resolved by type (see
[Handlers and routes](../../architecture/handlers-and-routes/#dependencies-resolved-by-type)),
and what it returns is committed by the unit of work. `sofie check` refuses a listener whose
event type does not derive `Event` (`listener-event`).

A listener runs as the principal whose commit raised the event, so its writes, history and the
messages it queues name that principal. One without a principal, such as a schedule's, runs with
full reach.

A Platform module never listens to events of the modules above it (`platform-listener`): it
reacts to them only by being called through its contract or through an extension point it
declares.

## The message table

One table, `sofie.messages`, carries events, jobs and scheduled runs.

- **Written in the commit.** Once a worker is running, a commit writes, in one statement, one job
  per listener of each event it raises, and nothing for an event no listener hears. Before then,
  the commit queues the event itself and the first worker to claim it fans it out.
- **Claimed without a broker.** A worker claims messages with `FOR UPDATE SKIP LOCKED` under a
  five-minute lease, renewed while the job runs. A job runs at most four minutes. A worker that
  dies loses its lease, and the message is claimed again.
- **Woken, not only polled.** On Postgres the worker is woken by `LISTEN/NOTIFY`, with a poll
  fallback whenever listening fails. On SQLite it polls.
- **A fixed number in flight.** `SOFIE_WORKER_BATCH` (default 2) messages run at once; another is
  claimed as soon as one finishes.

One worker loop serves all three kinds of message, so there is one thing to run, watch and scale.

### Exactly-once effects

A job's outcome and the deletion of its message commit in one transaction. If the job fails, its
writes roll back with it and the message stays; if it succeeds, the message is gone. Its effect
inside the database therefore happens once, however often it is claimed.

An effect outside the database, such as a charge at a payment provider, cannot join that
transaction. For those, a job asks for an `IdempotencyKey` (with the `idempotency` feature),
which is the message's id and the same on every retry. A gateway sends it to the vendor, so a
retried call is recognised. Only the framework constructs an `IdempotencyKey`.

### Retries and dead messages

A failure is either one that may pass on retry, or one that cannot:

| Error | Treatment |
|---|---|
| `Internal`, `Conflict`, `Unavailable`, `TooManyRequests` | Retried with backoff: 1 s, doubling each attempt, capped at an hour |
| `NotFound`, `Moved`, `BadRequest`, `Invalid`, `Rule` | Dead at once |

A message that runs out of attempts (ten by default) stays in the table, dead and out of
claiming, for inspection. A panicking job fails like any other.

```sh
<app> jobs dead          # the 100 most recently dead messages: id, time, name, attempts, error
<app> jobs replay ID     # makes one claimable at once, with its attempts reset
```

`jobs replay` refuses a message that is not dead, and logs the replay at info with its id, name
and previous attempts as its audit.

## Jobs

With the `jobs` feature, an action marked `#[job]` runs in the worker once a handler queues it:

```rust
pub async fn place_order(jobs: Jobs, /* … */) -> Result<(Order, Queued)> {
    let order = factory::place(/* … */)?;
    let receipt = jobs.queue(actions::send_receipt, &json!({ "order": order.id() }))?;
    Ok((order, receipt))
}
```

`jobs.queue` returns a `Queued` outcome, stored with the handler's commit, so a job is queued
only if the change that asked for it commits. `jobs.queue_at(…, at)` runs it no sooner than a
given instant. The payload binds the job's arguments as a request body would: a field named
after an aggregate loads that record.

A route can queue a job itself with `routes.queue("/path", actions::send_receipt)`, with the
request's input and path parameters as the payload. Such a job runs as the requester but reaches
every record, so an area whose principals own their records cannot queue one (`queued-route`).

## Schedules

A schedule is an attribute on an action:

```rust
// modules/order/src/jobs.rs
#[every("1h", each = unpaid_orders)]
pub async fn expire_unpaid(mut order: Order) -> Result<Order> {
    order.expire()?;
    Ok(order)
}
```

- **`#[every("1h")]`** runs the action every interval: `30s`, `15m`, `1h`, `1d`.
- **`each = query`** runs the query (any function of the module returning `Result<Vec<Order>>`)
  and queues the action once per record, each in its own job, unit of work and retries. A record
  whose job still waits gets no second one. This is how sofie changes many records: one action
  per record, never a bulk `UPDATE`.
- **`#[every(daily_at = "03:00", zone = "Europe/Istanbul")]`**, optionally with
  `weekly_on = "monday"`, runs the action when the zone's clocks show that time. It needs sofie's
  `local-time` feature, and cannot be combined with `each`.

A wall-clock schedule follows the zone's rules: a time a clock change skips runs where the change
ends, and a repeated one runs once, at its first occurrence. A missed run fires once, late. The
time and day are checked as the app compiles, and the zone by `sofie check` (`schedule-zone`) and
again when the worker starts. `sofie check` also refuses an `each` naming no function of the
module (`schedule-each`).

**One instance fires each schedule.** Firing a due schedule and queueing its job is one atomic
statement on `sofie.schedules`, so with several workers only one runs it, and no lock is held.

A future run at a time a user chose, such as a daily digest at 09:00 in their zone, is set at run
time with `LocalJobs::set(key, job, payload, local_date_time, Repeat::Daily)`. It keeps the local
time and zone and places each run by the zone's rules when it is due, so the run stays at 09:00
across a clock change.

## Tasks

With the `tasks` feature, an `async fn` marked `#[task]` in the module's `src/tasks.rs` runs once
by hand, in release builds too, for operational work such as a data backfill:

```sh
<app> task <module>.<function> [--name value]...
```

It takes what a job takes, and for arguments one `#[derive(Input)]` struct read from the
`--name value` pairs and validated before it runs. `sofie tasks` lists every task with its
arguments.

## Contracts between modules

A module reaches another synchronously only through its **contract**: a separate crate holding
the module's events, the DTOs it exposes, its typed route builders and, with the `contracts`
feature, its traits.

```rust
// in the contract crate
#[sofie::contract]
pub trait Directory: Send + Sync {
    async fn city_of(&self, name: &str) -> Result<String>;
}
```

The module implements its own contract's traits in `src/contract.rs`, on a type built from the
database (`impl From<Db>`, or a unit struct). A handler in any other module asks for it by type:
`directory: Dep<dyn member_contract::Directory>`. `sofie gen` provides each implementation to
the app and the worker.

### Why `dyn` at the boundary

A contract or gateway is a trait object chosen at boot: the module's implementation in the
monolith, a generated HTTP client after the module is split into its own app, the configured
vendor for a gateway, a fake in tests. Dynamic dispatch costs nanoseconds beside the database or
network call behind it, and it keeps generic parameters out of every handler and registry.
`#[sofie::contract]` rewrites the trait's `async fn`s so they can be called through `dyn`.

A module's handler that takes `Dep<dyn Trait>` of its own contract would read past its area's
owner filter, so `sofie check` reports it (`own-contract`) and points to `across` and `guard`
(see [Checking across owners](../../architecture/data/#checking-across-owners)).

### What a contract gives without code

- **Exposed DTOs.** Fields marked `#[expose]` on an aggregate become a DTO in the contract crate,
  written by `sofie gen`.
- **Batch lookups.** Every aggregate with exposed fields is reachable as
  `Dep<dyn Lookup<order_contract::Order>>`; `get_many(&ids)` reads many records' exposed fields
  in one query, so a page of records referring to another module resolves in one call.
- **Change events.** Each committed change of such an aggregate raises a generated
  `<Type>Changed` event with its id, version and exposed fields.
- **Mirrors.** `#[mirror(customer_contract::Customer)]` on an aggregate keeps a local, read-only
  copy of some of `Customer`'s exposed fields from its change events, never overwriting a newer
  version with an older one. Reads then filter, sort and join by them without crossing modules.
  `sofie check` refuses a mirrored field the source does not expose (`mirror-field`).
- **Extension points.** A contract trait that other modules implement under their
  `src/extensions/`; the declaring module asks for `Extensions<dyn Trait>` and gets every
  implementation in the wiring's order.

With `remote-contracts` (off by default), the same traits can be served and called across apps
over HTTP, with each call carrying a short-lived signed token for the principal it acts for, and
events crossing apps as a pull feed.

## Gateways and adapters

A **gateway** is a trait a module defines for a third-party capability, with one **adapter** per
vendor. Both live in the module's `src/gateways/`:

```rust
// modules/payment/src/gateways.rs
#[sofie::gateway]
pub trait Payments: Send + Sync {
    async fn charge(&self, charge: &ChargeRequest, key: &IdempotencyKey) -> Result<ChargeResponse>;
}

// modules/payment/src/gateways/stripe.rs
impl Adapter for Stripe {
    const VENDOR: &'static str = "stripe";
    type Settings = StripeSettings;

    fn new(http: Outgoing, settings: StripeSettings) -> Self {
        Self { http, settings }
    }
}

#[sofie::gateway]
impl Payments for Stripe {
    async fn charge(&self, charge: &ChargeRequest, key: &IdempotencyKey) -> Result<ChargeResponse> {
        let request = self.http.post("/v1/charges").bearer(self.settings.api_key.expose());
        request.json(charge).idempotency(key).send().await?.json()
    }
}
```

Handlers take `Dep<dyn Payments>` and never name the vendor. The generated wiring builds the
adapter that `PAYMENT_PAYMENTS` names (`<MODULE>_<GATEWAY>`, unset when there is only one), from
that vendor's keys, `PAYMENT_STRIPE_*`. Gateways need the `client` feature.

In tests no adapter is built, so no real call is made. `#[sofie::gateway]` gives each gateway a
fake recording its calls, which a test provides with `sofie_testing::fake::<dyn Payments>(…)`; a
gateway left unprovided fails the call.

## Outgoing: one way out

Every request leaving the app goes through `Outgoing`, which only adapters receive: it has no
public constructor and cannot be asked for as a handler argument. That single path is where every
outgoing request is traced, bounded and held to where it may go.

- **Allowlisted hosts.** An `Outgoing` reaches its base URL's host and the hosts listed in
  `<MODULE>_<VENDOR>_HOSTS`, over HTTPS. Anything else is refused before a connection opens.
- **Private addresses refused.** The host is resolved, every address checked, and the connection
  opened to a checked address. Private, loopback and shared addresses are refused unless the
  vendor sets `PRIVATE=true`; link-local, cloud metadata, multicast and reserved addresses always
  are. Redirects are followed only for GET, each hop held to the same rules.
- **URLs from users.** A target a user supplies, such as a webhook URL, goes through
  `Outgoing::untrusted`: any public host over HTTPS, no redirect, no credentials in the URL. A
  refused host gets one message whatever it resolved to, so a user cannot map the internal
  network.
- **Bounded.** Connect (5 s) and total (30 s) timeouts, a 4 MiB response cap, and a circuit
  breaker per host. Retries (two, with backoff) happen only on a failed connection or a 502, 503
  or 504, and only when the method is idempotent or the request carries an `IdempotencyKey`.
- **Traced.** Each adapter call is a `gateway` span named `<vendor>.<method>` (`stripe.charge`),
  each request under it an `http.client` span carrying `traceparent`. Headers, bodies and secrets
  are never recorded.
- **Other protocols.** A gateway that speaks SMTP or an object store's protocol wraps its client
  in `Outgoing::operation`, which gives it the same span, metrics, timeout and breaker.

The way out cannot be bypassed by adding a dependency. `sofie check` refuses, in any module, HTTP
client and TLS crates (`reqwest`, `hyper`, `rustls`, `openssl` and the like), raw sockets, and an
`Outgoing` named outside `src/gateways/`.

## Limits

- **Every committing process must know the listeners.** A commit writes one job per listener its
  process knows. A process that commits must run with the app's full listener set, or its commits
  queue no job for the listeners it lacks. During a rolling deploy, a listener's job waits for a
  worker that knows it.
- **Unhandled messages wait an hour.** A message no running worker handles waits an hour; then an
  event is dropped with a warning naming it, and a job is buried.
- **Jobs are short.** A job runs at most four minutes. Longer work is split into jobs, for example
  with `each`.
- **No saga or process manager.** Synchronous steps across modules are an action calling
  contracts, each contract write committing on its own. Asynchronous steps are events.
  Compensation is an aggregate's state plus a scheduled action.
- **Effects outside the database are at least once.** The database side of a job happens once; a
  vendor call is retried, and relies on the vendor honouring the `IdempotencyKey`.
- **SQLite polls.** Without change notifications the worker polls instead of being woken.
