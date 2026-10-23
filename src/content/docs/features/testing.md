---
title: Testing
description: The test harness, scaffolded tests, fixtures, fuzzing, load tests and seed data, all read from the app model.
sidebar:
  order: 8
---

Tests in most web apps repeat what the code already declares: that a field has a maximum length,
that a route refuses a stranger, that a status can only move along its transitions. Writing
those by hand is slow, and they drift from the code they check.

sofie reads the same app model that drives the wiring, so it knows every aggregate, constraint,
route, area and screen. From that it builds a test harness that speaks the app’s own types,
scaffolds tests for what the app declares, and generates requests for fuzzing and load tests.
What you write by hand is what only you know: the behaviour of a use case.

## The test harness

A test is an async function that takes a running app:

```rust
#[test_app]
async fn customer_cancels_own_order(app: TestApp) {
    let customer = TestPrincipal::<Customer>::member(&app).await;
    let order = app
        .as_(&customer)
        .request(&order_contract::routes::customer::place_order())
        .json(&fixture_input::<PlaceOrder>(&app))
        .await
        .record_id();

    app.as_(&customer)
        .request(&order_contract::routes::customer::cancel_order(Id::<Order>::from_uuid(order)))
        .accept_json()
        .await
        .assert_ok();

    assert_raised::<OrderCancelled>(&app);
}
```

`#[test_app]` starts the app of the crate under test as its generated wiring builds it (its
modules, its app and its worker; with flags when the wiring takes them), on a runtime of its
own. `sofie_testing::start` and `start_with_flags` build one by hand. A wiring with flags gives
the app and its worker one `Flags`, which `app.flags()` switches.

The style is fixed: each test is `#[test_app] async fn name(app: TestApp)`. Use `#[tokio::test]`
only where `#[test_app]` cannot run the test (a multi-thread runtime, or no app at all), with a
line saying why. A check that needs no app, such as the transitions of an enum, is a plain
`#[test]`.

### The real database

Every test runs on the real database, each on its own. The database is dropped on a thread of
its own so the drop never blocks the test’s runtime, and one left behind by a killed test
process is dropped by the next run. There is no in-memory stand-in to drift from Postgres.

### Requests

Requests are built with the generated route builders and typed inputs, so a renamed route or a
changed input breaks the test at compile time rather than at run time. `app.get(path)` and
`app.post(path)` exist for raw paths. A request can carry a JSON body (`.json`), a form
(`.form`), a session (`.session`), ask for JSON (`.accept_json`) or for an htmx fragment
(`.htmx(target)`). The response offers `status`, `json()`, `assert_ok()`,
`assert_status(code)`, `record_id()` and the session it set.

### Signing in as a principal

- `app.as_(&principal)` calls as a principal with a session sealed by the app’s keys at the
  clock’s current moment, without going through sign-in. It keeps working across
  `app.advance`.
- `TestPrincipal::fresh(&app)` is a principal with a new id.
- `TestPrincipal::<A>::member(&app)` signs an account up to a sofie-identity area and then in.
  It needs sofie-identity’s `testing` feature and `sofie_identity::testing::TestMember` in scope.
  `sofie_identity::testing::signed_up` does the same for an address you choose.
- `sofie_identity::testing::granted::<A>(&app, &["shop.order.*.cancel"])` (with `permissions`)
  is a new member of the `Permitted` area `A` whose role holds exactly those grants, added
  without a sign-up.
- `app.principal_of::<A>(&session)` says whom a session the app issued signs in to area `A`.

A session the app itself issued (a `TestSession` from signing in) ends after 12 idle hours of
test time like any other. A test that advances past that signs in again, or calls through
`app.as_`.

### Events and jobs

The worker does not run in the background during a test. `app.drain()` delivers what is in the
outbox, so a whole flow (action, event, listener, job) runs inside one test, and returns how
many messages it handled:

```rust
#[test_app]
async fn a_cancellation_is_audited_once_the_worker_drains(app: TestApp) {
    let customer = signed_in_customer(&app).await;
    let order = place_order(&app, &customer).await;
    cancel_order(&app, &customer, &order).await;

    assert_eq!(audit(&app, &order).await, Vec::<String>::new());

    assert_eq!(app.drain().await, 4);
    assert_eq!(audit(&app, &order).await, ["CANCELLED", "PLACED"]);
}
```

A job that fails or panics fails the drain. `sofie_testing::drain_failing(&app)` returns the
failures instead, for a test that expects them. `assert_raised::<E>(&app)` finds every `E`
committed, delivered or not; a rolled-back commit records none. `sofie_testing::raised::<E>(&app)`
returns them without asserting. `app.query(sql, params)` reads the database directly when a test
needs to look at rows.

### Fakes for contracts

`#[contract]` generates a fake beside each contract trait (`FakeOrders` for `Orders`, with the
`fixtures` feature). Each call is recorded in `calls` and answered with a fixture, or fails once
`calls.fail("method")` says so. A test of one module therefore does not need the module it calls.

## The clock you can move

Every handler that needs the time asks for `Clock`; nothing reads the system time directly. That
makes time something a test controls:

```rust
app.advance(Duration::from_hours(25)).await;
```

The clock does not jump straight to the end. It stops at each moment a schedule, a retry or a
delayed job comes due in that window, in order, and the worker drains there. A test of “an
unpaid order expires after a day” is one call. `app.clock()` gives the underlying `TestClock`
for a test that wants to move it without draining.

The same clock moves the app in development: see
[the clock in development](../../features/developer-experience/#the-clock-in-development).

## Fixtures through factories

Fixtures are deterministic from a seed; `SOFIE_TEST_SEED` picks another. Each value of
sofie-values has a realistic `Fixture` and a set of `Samples` (feature `fixtures`).
`#[derive(Input)]` and the default factory’s input make theirs field by field, held to the
fields’ constraints, and an enum’s fixture is its first state.

- `fixture_input::<PlaceOrder>(&app)` is a valid JSON body for an input.
- `fixture_value::<T>(&app)` is one value.
- `app.fixture::<Product>().owned_by(id).with("name", "Mug").await` makes a record through the
  default factory, so it passes the same validation as a record the app makes.

Because a fixture goes through the factory, a test never builds a record the app could not have
built.

## Scaffolded tests

`sofie scaffold tests` writes tests for what the app declares today. Each run writes one new file
named by the moment, `app/tests/scaffolded/<module>_<YYYYMMDDHHMMSS>.rs`, and adds its `mod` line
to the crate’s `main.rs`, leaving the rest of that file as it is. A run that fails part-way
undoes what it wrote.

Each test is a call of one of sofie-testing’s checks with the fact as declared, so the checks
are the behaviour and the test is data:

```rust
#[test_app]
async fn list_orders_refuses_a_caller_without_a_principal(app: TestApp) {
    app.request(&order_contract::routes::customer::list_orders())
        .accept_json()
        .await
        .assert_status(401);
}
```

| From | Test |
|---|---|
| Schema and factory | A fixture made by the default factory is a valid record (through the creating route when the aggregate has a hand-written factory). |
| Constraints | `assert_boundary`: the value at the bound passes, the first past it is refused with the constraint’s key; `assert_unique` for unique fields. |
| Values | `assert_value`: samples parse as they say, fixtures round-trip through JSON and the database (sofie’s own values only). |
| Status enums | `assert_moves`: the declared moves are exactly the enum’s, each succeeds, every other pair is refused. |
| Schema | `assert_schema`: the migrated table has every column the aggregate reads and writes, with the right type and nullability. |
| Store | `assert_store`: a saved record loads one version on, and a save from a stale version is a `Conflict`. |
| Routes and areas | No principal is 401; another owner’s record is 404; a `Permitted` principal without the permission is 403 and with it succeeds; a valid call succeeds; a route behind a flag set off is 404. |
| Screens | The page renders as HTML and shows each plain text field of its read model, escaped; a list screen’s rows link to each record’s page. |
| Contracts | `assert_lookup`: the batch lookup answers exactly the exposed fields. |

What no test can be scaffolded for is printed with the reason, such as an aggregate with a
hand-written factory that no route creates.

### Why they are never regenerated

A scaffolded file is written once and belongs to the module afterwards. It is never regenerated
or overwritten, so a test written for last month’s schema still runs today. Extend a scaffolded
test in its file; hand-written tests go in `app/tests/<topic>.rs`.

Each file lists the facts it covers at its top:

```rust
//! fact `constraint Product.name max 120`: `product_name_keeps_max_120`
```

The next run compares the facts in the app with every file’s list and writes a new file only for
what is new or changed. When a fact changes, the old test asserting it starts failing. That is
the point: the behaviour changed, and the pull request shows a developer updating or removing
that test on purpose. The generator lists superseded tests and never deletes them.

## Fuzzing

`sofie fuzz [--seed N] [--requests N]` sends generated requests to every route and reports each
500, each dropped answer (a panicking handler), each crash of the app, and each success answering
one member’s request for another member’s record. No test has to be written.

It runs the development app on a free local port with `SOFIE_SHIELD=off`, and refuses a
`DATABASE_URL` that is not on this machine.

- **Who asks.** Two members per sofie-identity area are signed up and in; the second gets three
  records from each creating route first. One request in eight to a member route goes signed out.
- **Inputs**, from the handler’s `Input` type, field by field: valid values, boundary values,
  malformed ones (refused samples, control characters, markup, SQL), oversized ones, a wrong
  JSON type, a missing field, an unknown field, and broken bodies (empty, truncated, not JSON,
  nested 10,000 deep, the wrong content type). A GET gets a query instead.
- **Path parameters:** the member’s own id, the other member’s id, a random uuid or a malformed id.
- **Answers:** each request asks for a page, JSON or an htmx fragment.
- **Reproducible.** Every choice is drawn from `--seed` (a new one each run, named in the
  report), so a seed sends the same requests again. `--requests` is 300 by default.

Each finding names the route, method and path, signed in or out, the kind of input and its body,
the status, the request’s span tree and the app’s log lines while it ran. One finding stands for
a route, outcome and kind of input; repeats are counted. A finding exits with status 1.

## Seed data

`sofie seed [--volume N]` fills the local database the way the app does: it posts to every POST
route without a path parameter that takes an input, so each record goes through the route’s
action and factory. It posts as the member `sofie bench` signs in with, so a later load test reads
those records.

It posts each module’s `seeds/<area>.<handler>.json` first, a JSON array of inputs for fixed
records to test by hand:

```json
[
  { "total": { "minor": 1250, "currency": "EUR" } },
  { "total": { "amount": "99.90", "currency": "USD" } }
]
```

Then it posts N inputs per route made from fixtures. It reports per route the records made and
refused, with the first refusal. A seed file naming no such route is an error.

## Benchmarks of an app

`sofie bench [--target URL] [--environment NAME]` generates k6 load tests from what the app
declares and runs them. k6 is an external tool the CLI runs, not a dependency of the app.

- **Endpoints.** One scenario per GET route and answer (a route with a screen is loaded as HTML
  and as JSON), run one after another. Areas sign in once in k6’s `setup()`. A POST route that
  creates a record from an input is loaded with 32 bodies made from fixtures.
- **Journeys.** A module’s `bench/*.ts` files are journeys a person takes, written by hand
  against a generated, typed client in `bench/gen/client.ts`:

  ```ts
  export default function placeAndCancel(sessions: Sessions): void {
    const placed = order_customer_place_order(sessions.customer, {
      total: { amount: '12.50', currency: 'EUR' },
    });
    order_customer_list_orders(sessions.customer);
    order_customer_cancel_order(sessions.customer, { order: placed.id });
  }
  ```

  A renamed or removed route drops its function from the client, so a journey calling it fails
  as k6 loads it.
- **Baselines.** p95 latency and error rate per route and journey are kept in
  `bench/baseline.json`. A regression past the margin (p95 20% above, error rate one point
  above) fails and leaves the file alone; an improvement lowers the baseline.
- **Linked to traces.** Every k6 request carries a `traceparent`, and a request over one second
  is printed with its trace id.

Without `--target`, it builds the app, starts it locally with `SOFIE_MIGRATE=on` and
`SOFIE_SHIELD=off`, and stops it afterwards. The environment must be `local`, `testing` or
`staging`; anything else, production included, is refused. A target on another host is never
signed up on: each member area needs an existing account in `SOFIE_BENCH_<AREA>_EMAIL` and
`SOFIE_BENCH_<AREA>_PASSWORD`.

## Limits

- `assert_value` covers sofie’s own values only; an app’s own values have no samples yet.
- Scaffolded screen tests check plain text fields; formatted fields such as money and dates are
  not checked.
- `sofie bench` does not load a `Permitted` area, an area outside sofie-identity or a `.signed()`
  route, and `sofie fuzz` fuzzes those signed out only. Both reports say so.
- Seeding makes one request per record, which is slower than a bulk insert, and an aggregate no
  route creates is not seeded.
- `sofie-identity-unverified` is a test-only crate for sofie-identity without
  `email-verification`. Run it with `cargo test -p sofie-identity-unverified`, since a workspace
  run unifies features.
