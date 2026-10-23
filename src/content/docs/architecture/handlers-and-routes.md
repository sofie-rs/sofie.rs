---
title: Handlers and routes
description: How actions and queries become endpoints, how their arguments are resolved by type, and what the router derives at boot.
sidebar:
  order: 3
---

In most frameworks a controller knows a lot: the request, the session, the container it pulls
services from, the name of its route, the middleware that guards it. Each of those is a place
for a mistake, and none of it is the business rule the controller exists for.

In sofie a handler is a plain `async fn` that knows no HTTP. Its signature says what it needs,
and the framework provides each argument by type. A route is one line in a module's `routes.rs`
that puts the handler in an **area**; its name, its permission, its record binding and its
owner scope are derived from the area, the schema and the handler. The router is built once at
boot, and a GET handler cannot write, which the compiler checks.

## Actions and queries

There are two kinds of handler.

- An **action** is one state-changing use case, such as `place_order`. It lives under the
  module's `actions`, and what it returns is committed in one short transaction after it returns
  (see [the unit of work](../../architecture/data/#the-unit-of-work)).
- A **query** is one read. It lives under `queries` and gets a read-only connection.

```rust
// modules/order/src/actions.rs
pub async fn place_order(
    customer: Principal<Customer>,
    input: PlaceOrder,
    read: Read,
    clock: Clock,
) -> Result<Order> {
    let account = Account::find(&read, customer.id()).await?;
    factory::place(customer.id(), account.email().clone(), input.total, clock.now())
}

// modules/order/src/queries.rs
pub async fn list_orders(read: Read) -> Result<Vec<OrderRow>> {
    OrderRow::query().latest().limit(50).all(&read).await
}
```

Neither function knows it is an endpoint. Because handlers do not know HTTP, the same action can
be routed, queued as a job, run by a schedule or registered as a listener with no adapter
written for each (see [Events, jobs and gateways](../../architecture/messages/)).

## Dependencies resolved by type

Every argument of an action, query or listener implements one trait, `Resolve`, against a
context: a request, a job or a task. There is no container, no service locator and no
reflection. The framework implements `Call` for functions of up to twelve arguments, the way
`axum` does, and an argument type without `Resolve` is a compile error at the route that
registers the handler.

| Argument | Resolved from |
|---|---|
| An aggregate (`Order`) | The route segment named after it, loaded through the area's scope |
| A read model (`OrderRow`) | The route segment named after its aggregate, read the same way |
| An input or value (`PlaceOrder`, `CancelReason`) | The request body, a job's payload, or a task's `--name value` arguments |
| An event (`OrderPlaced`) | The message being delivered, for a listener |
| `Principal<A>` | The session, in area `A` only |
| `Session` | The session cookie |
| `Read`, `Clock`, `Features`, `Permissions`, the module's config | The app state |
| `Flags`, `Jobs` | The app state |
| `Dep<dyn Trait>` for a contract or gateway trait | The app state, filled by the generated wiring |

A context leaves out what it does not carry, and the argument is refused when it resolves: a
task names no record, and only a listener receives an event.

The handler asks for `Clock` rather than reading the system time, and for its module's config
rather than the environment; `sofie check` holds code to both. That keeps every input of a
handler visible in its signature, which is what makes the same handler testable and reusable as
a job.

## Inputs

A handler argument that is not bound from the route is its input.

- A `#[derive(Input)]` struct reads the body field by field, from a JSON body or a form alike,
  and refuses unknown, missing and invalid fields together as one 422 with each field's
  `validation.*` key.
- A lone value reads the one field named after its type. `cancel_order(order: Order,
  cancel_reason: Option<CancelReason>)` reads `{ "cancel_reason": … }`. The field is named after
  the type, not the argument, because resolution sees only the type.
- The body is read once, so a handler taking several values takes them as one `Input` struct.
- A GET takes no body. It reads its query string as `Query<Q>`, with `Q` a `#[derive(Input)]`
  struct; a refused value is a 422, a key `Q` has no field for is a 400.

Field constraints, inherited constraints and form attributes are described under
[inputs and other DTOs](../../architecture/data/#inputs-and-other-dtos).

## Outcomes

What a handler returns is its **outcome**. For an action the outcome says what to commit; for a
query it is what to reply.

| Returned | Effect |
|---|---|
| `Result<()>` | Nothing is written |
| An aggregate | It is written if it changed, with its child rows and events |
| A tuple, a `Vec` or an `Option` of outcomes | Each is committed, in one transaction |
| `Queued` (from `jobs.queue(…)`) | A job, stored with the handler's commit |
| `Guard<A>` (from `across(…).guard(…)`) | A cross-owner check run again inside the commit |
| A read model, a `Vec` of them, `Paginated<T>` | Replied, never committed |

An error is an `Error` variant, answered the same way by every endpoint: `Invalid` as a 422 with
its field errors, `Rule` as a 422 with its message, `NotFound` as a 404, `Conflict` as a 409,
`BadRequest` as a 400, `TooManyRequests` as a 429 with `Retry-After`, and `Unavailable` as a 503.
`NotFound` is also the answer when the principal may not know that the record exists.

## A GET never writes

A GET handler resolves in a read-only context and must return a read-only outcome. Naming a
write-side argument (an aggregate, an input, `Session`, `Flags`, `Jobs`, `Dep`, an
`IdempotencyKey`) or returning an aggregate or `Queued` fails to compile at the route, with an
error that says a GET never writes. `sofie check` also reports the handler as `writing-get` with
its file and line, and refuses a handler under `get` that does not live in `queries`, or an
action that does (`route-kind`).

Nothing implicit covers "write while reading", such as a last-seen time or a counter. A write
belongs in a POST, or in a job a domain event triggers.

Because no GET writes, every GET may be answered from the rows it read: with the `etag` feature
each one is tagged and revalidated, and a GET does nothing that needs the primary database.

## Routes

Routes are written per area, in the module's `src/areas/<area>/routes.rs`:

```rust
// modules/order/src/areas/customer/routes.rs
pub fn routes(routes: &mut Routes<Customer>) {
    routes.screen("/orders", "orders", queries::list_orders);
    routes
        .post("/orders", actions::place_order)
        .then_screen("orders", "orders");
    routes
        .post("/orders/{order}/cancel", actions::cancel_order)
        .then_screen("orders", "orders");
}
```

`routes.rs` is plain Rust, so the compiler checks every handler against its area:
`Routes<Customer>` accepts only handlers whose principal belongs to that area. The area also
gives the URL prefix (`/account` here), the guard and the access rule, so a route never repeats
them. Areas are described in [Areas](../../architecture/areas/).

### Route kinds

| Call | Serves |
|---|---|
| `routes.get(path, query)` | A query, answered as JSON. Also answers HEAD |
| `routes.screen(path, name, query)` | A screen fed by the query (see [Screens](../../architecture/screens/)) |
| `routes.island(…)` | A screen with a Svelte island, fed by its loader |
| `routes.post`, `put`, `patch`, `delete` | An action |
| `routes.queue(path, job)` | Queues a `#[job]` action with the request's input and path parameters. Refused in an area whose principals own their records |
| `routes.webhook(path, handler).verify(…)` | An incoming webhook, in the public `Web` area only: raw body, signature check, no session, a redelivery gets the first answer |
| `routes.resource::<A>()` | A whole set of screens and actions for an aggregate (see [Resources](#resources)) |
| `routes.group(path, …)` | Routes under a parent record's path |

After an action, `.then_screen(name, fragment)` refreshes a fragment of a screen for htmx, and
`.then_redirect("/orders/{id}")` sends a form posted without JavaScript to a page. JSON callers
get the action's reply either way. Each `{name}` in a redirect is the route's path parameter of
that name, or else the reply's field.

### Record binding

A `{order}` segment binds the handler's `Order` argument (an action's) or a read model of
`Order` (a query's), loaded through the area's scope. Another owner's record, or a child outside
its parent, is a 404, so a handler never checks ownership itself.

### Modifiers

| Modifier | Effect | Feature |
|---|---|---|
| `.throttle(Rate::per_minute(10))` | Counts requests per principal, or per client address without one, and answers 429 past the rate | always |
| `.signed()` | Opens the route only through a link signed with the app's keys; a changed, expired or unsigned link is a 403 | `signed-links` |
| `.idempotent()` | Requires an `Idempotency-Key` header; a retry gets the first answer and the action's effects are written once | `idempotency` |
| `.body_limit(bytes)` | Raises the 64 KiB a body may hold | always |
| `.file_limit(bytes)` | Lets an action take files below the limit | `uploads` |

Security-related modifiers and the shield are covered in [Security](../../features/security/).

## Built at boot, named by the wiring

`routes.rs` runs at boot and builds the router. There is no generated router and nothing to
cache.

Names and permissions need the handler's module path, which Rust does not offer reliably at run
time. `sofie gen` already reads every `routes.rs`, so each module's generated wiring carries a
table from each route's method and full path to its name, `<module>.<area>.<handler>`, such as
`order.customer.cancel_order`. The router looks names up once, at boot. A request's span is named
`<METHOD> <name>`, and each route's permission and feature flag come in tables of the same shape.

`sofie gen` reads `routes.rs` without compiling it, so the body is restricted to route calls with
literal paths. Anything else is a generation error.

Before building the router, boot checks what every registration must keep: no two routes the
router cannot tell apart, one name per route, one name per job, and a schedule between once a
second and once in 1000 years. `sofie check` runs the same check over the source, reporting file
and line, so a duplicate path is found before the app starts rather than at run time.

`sofie routes` prints the route table: area, method, path, name, handler, permission, feature
flag, owner scope and modifiers.

## Typed URL builders

Each contract crate exports a builder for every endpoint of its module, generated by `sofie gen`
into the contract's `src/gen/mod.rs`. Another module links to an order's cancel action without
depending on the order module's implementation:

```rust
let cancel = order_contract::routes::customer::cancel_order(order_id);
// a RoutePath: POST /account/orders/{order}/cancel, filled in
```

A builder returns a `RoutePath`, the method and the filled path. A segment named after one of
the module's aggregates takes that aggregate's `Id`; the contract cannot name the type, so the
builder is generic and fails the build for any other aggregate's id. Any other segment takes
`impl Display`, and `.with_query("near", &value)` adds a query parameter. A renamed path changes
the builder, so every link to it follows.

## Resources

With the `resources` feature, one line gives an aggregate a list, a detail page and forms:

```rust
routes.resource::<OrderLine>();
routes.resource::<Order>().only([Resource::Index, Resource::Show]);
```

A resource is reached under its name in the plural (`OrderLine` → `/order-lines`):

| Part | Routes |
|---|---|
| `Index` | `GET /order-lines` lists |
| `Show` | `GET /order-lines/{order_line}` shows |
| `Create` | `GET` and `POST /order-lines/new` |
| `Edit` | `GET` and `POST /order-lines/{order_line}/edit` |
| `Delete` | `POST /order-lines/{order_line}/delete`, only for an aggregate with `SoftDelete` |

The screens come from the aggregate's field metadata, and writes go through its factory and its
methods, so a resource keeps the aggregate's rules. Each form posts to its own page's path, so a
refused form without JavaScript comes back filled in. A new record's owner is the principal. A
duplicate of a `#[unique]` field is answered as that field's `validation.unique` error.

`routes.group("/orders/{order}", |routes| …)` (the `groups` feature) puts routes under a parent's
path. A record bound below it must hold the parent's id in its field named like the parameter, or
it is not found; a resource's list shows only the parent's records, and its forms take the parent
from the path, never from the post.

## What each method may do

| Method | Handler | May write | Arguments it may take |
|---|---|---|---|
| GET, HEAD | A query, from `queries` | No | Read-side only: `Read`, `Clock`, a bound read model, `Query<Q>`, `Principal`, config |
| POST, PUT, PATCH, DELETE | An action, from `actions` | Yes, through its outcome | Everything, including aggregates, inputs, `Session`, `Jobs`, `Dep` |
| Webhook (POST) | An action, in `Web` | Yes | The verified raw body; no session |

## Trade-offs

- **`routes.rs` is restricted.** Because `sofie gen` reads it without compiling, it holds only
  route calls with literal paths. Routes cannot be built in loops or from configuration.
- **Throttling is per instance.** Counting is in-process: behind a load balancer each instance
  allows the full rate, so the effective limit is the rate times the instance count.
- **No write on read.** Recording that something was seen takes a POST or an event-driven job.
- **Handlers are resolved, not injected freely.** Only types that implement `Resolve` can be
  arguments; anything else reaches a handler through its module's config or a contract.
