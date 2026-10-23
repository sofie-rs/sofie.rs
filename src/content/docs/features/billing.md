---
title: Billing
description: Plans declared as constants, entitlements checked on routes, menus and screens, and subscriptions kept in step with Stripe or Paddle.
sidebar:
  order: 6
---

Billing code tends to spread. The plan names live in the payment provider's dashboard, the checks
for "may this account export" live in handlers, the menu shows an entry the plan does not allow,
and a quota is counted in a way two concurrent requests can both pass.

sofie treats what a plan allows as data the framework knows, like a flag or a permission. A module
declares its entitlements as constants, one module declares the plans that grant them, and routes,
menus and screens require them the same way they require a flag. The payment provider only bills;
the app's own database decides what an owner may do, and without a provider plans, trials and
quotas still work.

Billing is the `sofie-billing` crate, behind the `billing` feature of `sofie`.

## Entitlements

An entitlement is what a plan grants, named `<module>.<name>`. There are three kinds:

| Kind | Means | Example |
|---|---|---|
| `Entitlement` | A switch: the plan has it or not | Exporting |
| `Limit` | At most N of something the app counts itself | Projects kept |
| `Quota` | At most N uses per period (`Day`, `Week`, `Month`, `Year`) | API calls a month |

```rust
pub const EXPORT: Entitlement = Entitlement::new("project.export");
pub const PROJECTS: Limit = Limit::new("project.projects");
pub const CALLS: Quota = Quota::new("project.api_calls", Period::Month);
```

A quota's period counts from the subscription's start, so a month runs from its billing day; an
owner without one counts calendar periods in UTC.

An entitlement is neither a permission, which a role grants, nor a feature flag, which a rule
switches. The three can gate the same route side by side.

## Plans

One module's `src/plans.rs` declares the plans and lists them in `PLANS`:

```rust
pub const FREE: Plan = Plan::new("free")
    .limits(&[(PROJECTS, 1)])
    .quotas(&[(CALLS, 2)]);

pub const PRO: Plan = Plan::new("pro")
    .grants(&[EXPORT])
    .limits(&[(PROJECTS, UNLIMITED)])
    .quotas(&[(CALLS, 3)])
    .trial_days(14)
    .per_seat();

pub const PLANS: Plans = Plans::new(FREE, &[PRO]).products(&[CREDITS]);
```

- The first plan is the default every owner without a subscription holds.
- A limit the plan leaves out allows none; `UNLIMITED` means no end.
- `PLANS` is checked as the constant is built, so a malformed name or a repeat fails the build.
- `Product`s are one-off purchases, such as credits, listed with `.products(…)`.

`sofie new plan MODULE name` adds a plan to `src/plans.rs` and turns on the `billing` feature.
`sofie gen` then installs it: `sofie::billing::install(&db, &PLANS)` in the app and the worker,
`Gates::entitlements`, its migrations and its webhook.

## Checking entitlements

### On routes, menus and screens

```rust
routes.get("/export", export).entitled(EXPORT);
```

An owner whose plan lacks it gets a 403. A menu entry follows its route, so it is hidden for the
same owners. A screen asks in its template:

```html
{#if entitled("project.export")}<p>Export</p>{:else}<p>Upgrade to export</p>{/if}
```

A limit or quota above zero counts as held. The principal's plan is read once for a request that
needs it.

`sofie check` (rule `entitlement`) reports an `.entitled(…)` or a screen's `entitled("…")` that
names no entitlement, limit or quota a module declares.

### In handlers

A handler takes `Entitlements` as an argument; the owner is the area's principal.

```rust
async fn second_project(entitlements: Entitlements) -> Result<()> {
    entitlements.allow_another(PROJECTS, 1)
}

async fn call(entitlements: Entitlements) -> Result<Consumed> {
    entitlements.consume(CALLS, 1).await
}
```

- `allow_another(limit, count)` takes how many the owner has now, which the app counts, and refuses
  when one more would pass the plan's limit.
- `consume(quota, amount)` returns an outcome that counts the use with the handler's commit, so a
  refused action uses nothing. It is written as an upsert that refuses to pass the allowance, so
  racing requests cannot overspend.
- `used(quota)` reads the use in the current period; `plan()`, `seats()` and `standing()` read the
  owner's plan, seats and subscription.

## Trials

```rust
async fn start_trial(me: Principal<Members>, billing: Billing) -> Result<TrialStarted> {
    billing.start_trial(me.id().into(), PRO).await
}
```

A trial needs no card and is given once per owner. Its length is the plan's `trial_days`. It
starts when the handler returns the `TrialStarted` outcome.

## Paying: `Checkout`

`Checkout` sends a subscriber to the provider's pages. Each method takes an explicit `Subscriber`,
so it works from any context, and returns a `Link`, which a route with `.then_follow()` sends the
browser to:

```rust
async fn upgrade(me: Principal<Members>, checkout: Checkout) -> Result<Link> {
    checkout.subscribe(me.id().into(), PRO, 2, "/members/plan").await
}

async fn manage(me: Principal<Members>, checkout: Checkout) -> Result<Link> {
    checkout.portal(me.id().into(), "/members/plan").await
}

routes.post("/upgrade", upgrade).then_follow();
routes.post("/portal", manage).then_follow();
```

| Method | Does |
|---|---|
| `subscribe(subscriber, plan, seats, return_path)` | Pays for a plan; refused while a plan already renews at the provider |
| `buy(subscriber, product, quantity, return_path)` | Pays once for a product |
| `portal(subscriber, return_path)` | Opens the provider's page to manage what the subscriber pays for |

## Providers

`SOFIE_BILLING_PROVIDER` chooses `stripe` or `paddle`:

| Setting | Holds |
|---|---|
| `SOFIE_BILLING_API_KEY` | The provider's API key |
| `SOFIE_BILLING_WEBHOOK_SECRET` | The secret its notifications are signed with |
| `SOFIE_BILLING_PRICES` | Each plan's or product's price, such as `pro=price_…` |
| `SOFIE_BILLING_BASE_URL` | Where the provider returns the browser, else `SOFIE_BASE_URL` |
| `SOFIE_BILLING_API_URL` | The provider's API, for a test server |

Calls to the provider go through `Outgoing`, so they are allow-listed, bounded and traced.

### Webhooks

The provider's notifications arrive at `/webhooks/billing`. Each is verified by the provider's HMAC
within five minutes and handled once per delivery id.

A subscription follows the states `trialing`, `active`, `past_due` and `canceled` as the provider
reports them, unless the move is one the states do not allow. A change older than the one held is
dropped, so notifications arriving out of order do no harm. The plan is kept while the provider
retries a failed payment.

`SubscriptionChanged` and `PurchaseCompleted` are raised for the app's listeners. A price that
`SOFIE_BILLING_PRICES` does not name is logged as an error with its id and acknowledged: the
subscription keeps its plan, and a new subscription or purchase grants nothing.

## Seats

A plan's seats are unlimited by default, fixed with `.seats(n)`, or bought with `.per_seat()`, as
many as the subscription's quantity. What counts as a seat is the app's.

`Billing::seats(subscriber)` and `Entitlements::seats()` return `Seats::Unlimited` or
`Seats::AtMost(n)`, and `seats.allows(filled)` tells whether one more fits. sofie-tenancy uses this
to limit an organization's members.

`Billing::change_seats` changes the provider's subscription quantity. It is sent by a job after
the commit and prorated, safe to retry: to Stripe with the job's idempotency key, to Paddle as a
count that changes nothing when sent twice. The seats held follow the provider's notification, not
the request.

`Billing::cancel_at_provider` cancels at once, for an owner that is gone.

## Trade-offs

- An owner holds one subscription. `Entitlements` takes the area's principal as the owner;
  `Checkout` and `Billing` take an explicit `Subscriber`, which is how sofie-tenancy bills an
  organization.
- Stripe and Paddle are the only providers.
- No billing screens ship with the framework; the app writes its plan and upgrade pages.
