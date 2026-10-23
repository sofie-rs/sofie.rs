---
title: Areas, identity and permissions
description: How an area decides who may call an endpoint and on whose records, and how sofie-identity signs people in.
sidebar:
  order: 6
---

An **area** is an audience of the app: the public, customers, staff, an organization's members.
Everything an endpoint needs to know about who may call it, and on whose records, comes from its
area rather than from the endpoint.

## Why access belongs to the area

In most frameworks each endpoint states its own guard, and each query adds its own "where the
owner is the current user". One forgotten line exposes another customer's records, and a
security review has to read every handler to know who can reach what.

sofie moves both decisions to the area:

- **The principal decides the access.** An area's access follows from the type of its principal,
  so the two cannot disagree.
- **The owner filter is not written.** In an owned area, every query is scoped to the principal
  and every commit refuses a record the principal does not own. A handler cannot opt out, because
  the only `Read` it can get is the one its request context scoped.
- **One file per audience.** Everything one audience can reach in a module is in that area's
  folder, which is where a security review starts.

The same action can be published in several areas, and each listing inherits its area's checks.
Actions themselves stay free of HTTP.

## What an area is

An area is a type implementing `Area`, with a name, a URL prefix, a sign-in path and a
principal. The framework ships one, `Web`:

```rust
// sofie-http
pub struct Web;

impl Area for Web {
    const NAME: &'static str = "web";
    const PREFIX: &'static str = "";
    const SIGN_IN: &'static str = "/";
    type Principal = Visitor;
}
```

`Web` is the app's face to the outside world. Every app has it and every module can contribute to
it, whatever its tier. It holds what anyone may reach: public screens, sign-in and sign-up,
webhooks, JSON endpoints an outside client calls without an account. Its principal is a
`Visitor`, which never gains access to records; anything that acts as someone belongs in another
area. The framework's own endpoints (`/live`, `/ready`, metrics, static files) are not part of it
and cannot be shadowed by it.

Every other area is the app's, defined once in an app module's contract. The shop example adds
`Customer`:

```rust
// modules/order/contract/src/area.rs
pub struct Customer;

impl Area for Customer {
    const NAME: &'static str = "customer";
    const PREFIX: &'static str = "/account";
    const SIGN_IN: &'static str = "/sign-in";
    type Principal = Account;
}

impl sofie_identity::SignUp for Customer {
    const PATH: &'static str = "/sign-up";
}
```

`NAME` is the folder under a module's `src/areas/`, so `areas/customer/` holds what each module
publishes for customers. A `PREFIX` is `""` or starts with `/` and does not end with one
(`sofie check`'s `area-prefix`). Two definitions of one name are a generation error, and a module
contributes only to areas whose contract it may import, so the tier rules apply unchanged.

A public site or a public API is just `Web`. Another app may add several areas, or none.

### What each area derives

From each area, sofie derives:

- **The route group:** prefix, guard, session and CSRF settings, and rate limits. An app adds an
  area-wide limit with `app.throttle::<A>(Rate::per_minute(n))` and its own pipeline steps with
  `app.step::<A>(step)`.
- **The principal as a typed handler argument.** An action routed to one area cannot ask for
  another area's principal; the compiler refuses it.
- **Cross-origin calls and content security**, per area: `app.cors::<A>(…)` with the `cors`
  feature, and the extra hosts a page may reach through `content_security::<A>(…)`.
- **Island bundles:** an area never ships another area's islands.
- **Layout and menu**, from the menu entries of every module's area folder. Each whole page of
  the area starts with its menu, and an entry whose route needs a permission the viewer lacks, or
  whose flag is off, is left out.
- **`area` as a dimension** on every span, metric and audit entry, and as an OpenAPI tag.

A menu entry is one statement per page:

```rust
pub fn menu(menu: &mut Menu<Console>) {
    menu.entry("Orders", routes::console::list_orders());
}
```

## Access

An area's access is one of three, fixed by its principal:

| Principal | Access | Who passes | On which records |
|---|---|---|---|
| `Visitor` | `Public` | Anyone; the endpoint states its own limits | Any |
| sofie-identity's `Permitted` | `Permitted` | A signed-in principal holding the endpoint's permission; otherwise 403 | Any |
| An aggregate, such as `Account` | `Owned` | The signed-in principal | Only its own records, and records without an owner |

### Owned areas

In an `Owned` area, the principal is an aggregate, and records carry an `#[owner]` field naming
it:

```rust
#[derive(Aggregate)]
pub struct Order {
    meta: Meta,
    #[owner]
    account: AccountId,
    email: Email,
    status: OrderStatus,
    total: Money,
    placed_at: Instant,
}
```

A handler in the area then gets a `Read` that adds the owner filter to every query, and a commit
that refuses any record the principal does not own. A record of another principal reads as not
found (404), and a write to one is refused at commit. The loader for the customer's orders is
therefore just a query, with no owner condition:

```rust
pub async fn list_orders(read: Read) -> Result<Vec<OrderRow>> {
    OrderRow::query().latest().limit(50).all(&read).await
}
```

A handler gets a `Read` only from its request context, which scopes it; there is no other to ask
for. That is why a handler cannot reach another principal's records, even by mistake.

A handler that needs the principal asks for it by type:

```rust
pub async fn place_order(
    customer: Principal<Customer>,
    input: PlaceOrder,
    read: Read,
    clock: Clock,
) -> Result<Order> {
    let account = Account::find(&read, customer.id()).await?;
    factory::place(customer.id(), account.email().clone(), input.total, clock.now())
}
```

Without a principal, a browser is sent to `SIGN_IN` (with `next` for a page asked for with
`GET`), htmx is told to go there and an API client gets 401. After signing in, the browser returns
to `next` only when it is a page of this app the new session opens; anything else sends it to the
area's home.

## Permissions

A `Permitted` area is for audiences that reach every record but each only with a permission, such
as staff. Its principal is `sofie_identity::Permitted`, behind the `permissions` feature of `sofie`
and sofie-identity:

```rust
impl Area for Console {
    const NAME: &'static str = "console";
    const PREFIX: &'static str = "/console";
    const SIGN_IN: &'static str = "/console/sign-in";
    type Principal = sofie_identity::Permitted;
}
```

### Named, never written

Permissions are named `module.model.field.action` and derived from the code, never written by
hand:

- Each aggregate grants its record's `read`, `create`, `update` and `delete` (field `*`), and each
  field's `read` and `update`.
- A route needs `read` for a page. Otherwise it needs its handler's first word, on the module's
  aggregate its name mentions: `cancel_order` needs `order.order.*.cancel`.
- A write never needs `read`, so a handler named `read_…` that marks something needs `update`.

`sofie gen` writes each module's permissions as constants in its contract, such as
`order_contract::permissions::ORDER_CANCEL`, and the table of each route's permission. A route of
a `Permitted` area without a permission stops the app at boot, as does a route given one in an
area that does not admit by permission, which would check no grant.

### Roles and grants

A grant may put `*` on any axis, such as `order.*.*.read`. A needed `*` (the whole record) is
covered only by a `*`.

sofie-identity stores roles and their grants, and a membership of a `Permitted` area names its
member's role. The grants are read for each request, so a revoked grant stops the next request. A
handler reads them as `Permissions` and asks `can(PERMISSION)`; a screen asks
`{#if can("order.order.total.read")}`.

The functions `create_role`, `grant`, `grant_as`, `revoke` and `assign_role` return what to
commit. `grant_as` refuses a permission the granter's own permissions do not cover.

Staff are added with `add_member(read, clock, email, area)`, optionally `.with_role(…)`, or by a
task the app registers:

```rust
Tasks::new().task("sofie_identity.add_member", sofie_identity::add_member_task)
```

```sh
shop task sofie_identity.add_member --email ops@example.com --area console --role support
```

An address without an account gets one with no password, which signs in once its owner sets one
through a reset or sign-in link, or connects a provider.

Signing up is closed in every member area unless it sets a sign-up path. A `Permitted` area that
opens it lets anyone sign up, and each new account gets 403 everywhere there until it is given a
role.

With the `permitted-screens` feature, `sofie_identity::permitted_routes::<A>` adds screens for
roles (`/roles`) and each role's grants, where a grant the poster's own grants do not cover is
refused. `permitted-flags` adds screens for feature flags and runtime settings, and
`permitted-shield` one for the shield's blocks.

## Identity: sofie-identity

`sofie-identity` is an opt-in module that owns accounts, password hashes, area memberships, and
the sign-up, sign-in and sign-out actions and screens, with its migrations. `sofie gen` wires it
into an app that depends on it. An app's own areas take `sofie_identity::Account` (or
`Permitted`) as their principal.

An account signs in to an area only as its member, and signing up at the area's sign-up path
makes it one. For each member area, sofie-identity mounts sign-in at `SIGN_IN`, sign-up at the
sign-up path and sign-out at `<PREFIX>/sign-out`, all in `Web`. `sofie gen` writes the area's
`MemberArea` when the contract leaves it out: its `HOME` is the area's first screen without
parameters.

```rust
// modules/order/contract/src/gen/mod.rs, written by sofie gen
impl sofie_identity::MemberArea for crate::area::Customer {
    const HOME: &'static str = "/account/orders";
    const SIGN_UP: Option<&'static str> =
        Some(<crate::area::Customer as sofie_identity::SignUp>::PATH);
}
```

An app replaces a built-in screen with `src/areas/web/screens/sofie_identity/<name>.html` in one
of its modules.

### Signing up tells nothing

Signing up signs nobody in and answers alike, after hashing the password either way, whether or
not the address has an account: a new address gets its account, a taken one changes nothing. So
the sign-up form cannot be used to find out who has an account. Only a sign-up racing another for
the same address to the unique index is answered "is already registered".

### Ways to sign in

Every way of signing in ends in one place, which checks membership.

- **Passwords.** Hashed with Argon2id (19 MiB, two passes, one lane) in the PHC string format, at
  most one hash per core at a time. A PBKDF2 hash stored before still verifies, and a sign-in that
  proves it stores an Argon2id one in the same commit. Sign-in is limited to 10 a minute.
- **Mailed links** (`sign-in-links`): a link valid for fifteen minutes, used once, confirming the
  address.
- **Passkeys** (`passkeys`): WebAuthn with ES256, EdDSA and RS256. Challenges are sealed, so
  nothing is stored between the page and the answer. A credential refuses a challenge older than
  its last and a counter that goes back. A user-verifying passkey signs in without the second
  factor.
- **OAuth and OpenID Connect** (`oauth`): Google, Microsoft, GitHub or any OIDC provider by its
  endpoints, configured with `SOFIE_OAUTH_PROVIDERS` and installed at boot with
  `sofie_identity::oauth::install`. The flow uses PKCE, a sealed state and a ten-minute flow
  cookie, so a callback begun in another browser signs nobody in. ID tokens are verified against
  the provider's keys (RS256, RS384, RS512 and ES256; `none` and HMAC are refused), with `iss`,
  `aud`, `exp`, `iat` and `nonce` checked. An address an account here already holds is refused
  until that account connects the provider itself.
- **Two-factor** (`totp`): after a first step that is not a second factor itself, an account with
  a confirmed second factor is asked for a code from an authenticator app (RFC 6238) or a recovery
  code. Five wrong codes in fifteen minutes stop codes for the account.

Adding a passkey, a provider or a second factor needs a session signed in within the last ten
minutes. With `password-reset` and `email-verification`, members can ask for mailed links; these
routes always answer the same, so they tell nobody which addresses have accounts. An area with
`MemberArea::VERIFIED_EMAIL = true` signs in only confirmed accounts.

### Sessions

A session lives in a sealed cookie carrying an id chosen at sign-in, sealed with
`SOFIE_SIGNING_KEYS`. It ends after 12 hours without a request and 30 days after sign-in,
whichever comes first.

With sofie-identity's `sessions` feature, on by default, each sign-in is also a recorded session
with its device, checked on every request. Signing out, "sign out everywhere else", a password
reset, closing the account, ending an impersonation and removing a membership then end the
session for every copy of its cookie, each in the commit of its change. The check is served from
a per-instance cache that each change to sessions invalidates, here at once and on other
instances through Postgres notifications.

An app can turn `sessions` off for stateless, API-only use. Sessions then live only in their
cookies, which brings back four gaps: a copied cookie outlives signing out; "sign out everywhere
else" and a password reset end nothing open elsewhere; removing a membership ends nothing; and a
request sent before signing out and answered after it signs the browser back in.

### Bearer tokens

An area opts in to bearer tokens with `const TOKENS: bool = true;` (the `tokens` feature). A
token is 256 random bits, shown once and stored only as its SHA-256 digest, with its account,
area, scopes and expiry. The account must be the area's member on every request, so a removed
member's token is refused at once. In a `Permitted` area, a route needs both the account's grant
and a covering scope.

### A member's own screens

`sofie new account-screen AREA SCREEN` mounts a member's own screens in a member area:
`sessions::routes`, `two_factor::routes`, `passkeys::routes`, `oauth::routes` (connected
providers) and `account_data::routes`.

## Impersonation

Support staff sometimes need to see what a member sees. With the `impersonation` feature, a
principal of a `Permitted` area holding `sofie_identity.impersonation.*.create` signs in as a
member of a member area, giving a reason. `sofie new impersonation PERMITTED MEMBER` mounts the
routes.

- Every use is recorded in a row the member owns, raising `ImpersonationStarted` and
  `ImpersonationEnded`, and the session is listed to the member as impersonated.
- It ends by itself after thirty minutes; `/impersonation/stop` signs the impersonator back in.
- Every request made in such a session is logged with the account and the impersonator, by
  account id only.
- The impersonated session adds or removes no passkey, OAuth connection or second factor, ends no
  session, exports nothing and closes no account, so nothing it does outlasts it.

**The subset rule.** A member of the impersonating area is never impersonated, nor a member whose
role's grants are not all covered by the impersonator's own permissions: the same rule granting
follows. Impersonating can never reach more than the impersonator could grant. The member's
permissions at the start are kept; once the member holds one more, the impersonation ends when its
session record is next read, at most a minute later.

## Organizations and tenancy

`sofie-tenancy` is an opt-in module for apps whose records belong to organizations rather than to
people. An organization area's principal is the organization itself:

```rust
impl Area for Team {
    const NAME: &'static str = "team";
    const PREFIX: &'static str = "/team";
    const SIGN_IN: &'static str = "/sign-in";
    type Principal = sofie_tenancy::Organization;
}

impl sofie_tenancy::OrganizationArea for Team {
    const HOME: &'static str = "/team/members";
}
```

Records with `#[owner] organization: OrganizationId` then belong to the organization and every
member reaches them, through the same owner filter as any owned area. The account acting is read
from the session record (`Acting`), never from the cookie alone.

- A member area lists, founds and enters organizations and accepts invitations
  (`member_routes`); the organization area manages members (`organization_routes`).
  `sofie new tenancy ORGANIZATION MEMBER` mounts both.
- Members have an owner, admin or member role. Invitations are mailed as signed links; accepting
  one needs the link and an account of the invited address.
- Role changes, removals, invitations and acceptances lock the organization's row and check again
  in their commit that an owner remains and, with `billing`, that the plan's seats hold.
- An owner can hand the organization over, rename it and delete it. Deleting is soft: every member
  leaves, their sessions acting for it end, open invitations are withdrawn and
  `OrganizationDeleted` is raised. Records it owns in other modules stay until those modules
  erase them on that event.

## Closing accounts and forgetting a principal

With the `account-data` feature, `account_data::routes` lets a member export their data and close
their account.

- **Export** covers the identity's records, tokens and second factor without their secrets,
  impersonations, and every module's records registered as a `PersonalData`.
- **Closing** anonymizes the account rather than deleting it, so other modules' records stay
  whole, all in one commit raising `AccountClosed`. Its sessions end.
- **Forgetting.** Closing records the account as forgotten for good
  (`sofie::db::forget_principal`). `unless_forgotten` refuses a commit planned for a principal
  forgotten since it was read, so a job queued before the close writes nothing for it. With
  `notify`, the account's notifications are erased and its digest stopped.
- With tenancy, an app registering `OrganizationMemberships` exports an account's memberships and
  ends them as it closes. The sole owner of organizations cannot close its account, and the
  refusal names them.

## Limits

- Bearer tokens have no screen for issuing one yet; `sofie_identity::tokens::issue` is called
  from code.
- Assigning a role to a member has no screen yet; `assign_role` and the `add_member` task cover it.
- Sign-in pages are in `Web`, an HTML area, even for a client area.
- Rate limits are counted in-process, so per instance.
- Without `sessions`, the four gaps above apply.
- The dev toolbar's "act as" is a debug-build tool, not impersonation.
- sofie-identity and sofie-tenancy are opt-in modules. An app with its own identity leaves them
  out and answers membership and grants itself, through sofie-http's `AreaMembers`.

The full contract is in
[`docs/structure.md`](https://github.com/sofie-rs/sofie/blob/main/docs/structure.md#areas).
