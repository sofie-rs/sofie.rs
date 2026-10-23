---
title: Security
description: What sofie protects by default, how each protection works and what it leaves to you.
sidebar:
  order: 1
---

A web app is usually made safe by remembering things: a CSRF token in every form, a header in a
middleware, a check in each handler that the record belongs to the caller. Each one forgotten is a
hole. sofie moves these into the framework, so an app gets them without writing them, and an app
loosens a default only explicitly, per area.

Nothing on this page needs configuring unless it says so. Some protections sit behind cargo
features of `sofie`, so an app that does not need them does not compile them.

## The server

The binary is the server. It runs on `hyper` 1.x directly, chosen for its strict parsing, which
refuses ambiguous requests, and an HTTP/2 stack hardened against attacks such as Rapid Reset. The
framework owns the whole request path on top of it: a `matchit` router built once at boot and a
fixed pipeline of steps (limits, request id, trace, area guard, CSRF, flags, handler, negotiation,
compression), composed statically.

Every framework crate carries `#![forbid(unsafe_code)]`.

### Limits

| Concern | Default |
|---|---|
| Slow clients | Header read timeout of 10 s, request timeout of 30 s; a connection that sends nothing for 10 s after connecting, or moves no byte for 60 s later, is closed |
| Connections | At most 4096 at once (`Serving::max_connections`) and 64 per client address (IPv6 by /64); past that a 503 with `Connection: close` |
| Headers | Within 32 KiB, else 431, plus a count limit |
| Bodies | 64 KiB per route unless the route raises it with `.body_limit(…)`; past it a 413 |
| HTTP/2 | 32 concurrent streams; a connection is closed after 20 pending client resets or 256 resets for protocol errors |
| Smuggling | Ambiguous `Content-Length` and `Transfer-Encoding` refused by `hyper`; paths normalized once, before routing |
| Errors | No internals in any response; details go to telemetry only |

A route that takes files stops its request timeout while the file parts stream in, and restarts
it once the body is read, which may take at most 10 minutes.

### Response headers

Every HTML page gets a `Content-Security-Policy` with a nonce per response, so htmx and islands
load without `unsafe-inline` or `unsafe-eval`. Every other answer but a 304 (JSON, errors,
health) gets `default-src 'none'; frame-ancestors 'none'`. Answers also carry
`Strict-Transport-Security: max-age=63072000; includeSubDomains`, `X-Content-Type-Options`,
`Referrer-Policy`, and a `Permissions-Policy` refusing camera, microphone, geolocation, sensors,
USB, MIDI, screen capture and topics. There is no server banner.

A page that must load a provider's script or frames widens its area's policy by naming HTTPS hosts:

```rust
app.serving(|serving| {
    serving.content_security::<Customer>(
        ContentSecurity::new()
            .script("https://js.provider.example")
            .frame("https://js.provider.example"),
    )
})
```

An app's own pipeline steps (`PipelineStep`) may set headers on an answer, but not `Set-Cookie`,
a security header or a CORS header, and the security headers are set after them regardless.

### TLS

HTTP/1.1 and HTTP/2 come from `hyper`. With the `tls` feature, sofie serves HTTPS through
`rustls`, a memory-safe implementation, from `SOFIE_TLS_CERTIFICATE` (the PEM chain, leaf first)
and `SOFIE_TLS_KEY`; with neither set, it serves plain HTTP. Terminating TLS at a load balancer
or proxy instead remains a configuration choice.

### Client address and proxies

The client address is the connection's peer. With the `trusted-proxies` feature, on by default,
it is taken from `X-Forwarded-For` only when the request came from a proxy listed in
`SOFIE_TRUSTED_PROXIES` (addresses and CIDR ranges), read from the right. The server's own
request id stays the request id; a trusted proxy's id is recorded beside it as
`edge_request_id`, so no caller chooses it.

## Sessions and signing keys

Session cookies are sealed: encrypted and authenticated with AES-256-GCM under keys from
`SOFIE_SIGNING_KEYS`, a comma-separated list of base64 keys of 32 bytes. The app refuses to start
without it.

```sh
openssl rand -base64 32
```

The first key seals and signs; every key opens. To rotate, put the new key first and keep the old
one after it until the sessions it sealed have expired. A session lasts at most 30 days, however
often it is refreshed, and ends after 12 hours idle.

Cookies are `__Host-` prefixed, `Secure`, `HttpOnly` and `SameSite=Lax`. They are named after the
app's package (`__Host-<app>-session`), because cookies do not separate by port: two apps on one
host keep their own sessions.

The same keys, each under its own purpose, sign links (`.signed()` routes and `SignedUrls`, an
HMAC-SHA256 `signature` with `expires`; a changed, expired or unsigned link is a 403), seal live
screen streams, and sign the principal token one app of a split sends another.

## CSRF without tokens

Every unsafe method must come from the app's own pages: the request carries
`Sec-Fetch-Site: same-origin`, or, from a browser too old to send it, an `Origin` naming the host.
A request carrying the session cookie with neither is refused.

There is no form token. The browser's fetch metadata already proves the request is same-origin,
which a token only approximates; Go's `CrossOriginProtection` reasons the same way. It also means
no secret sits in a response body, which matters for compression below.

The check is skipped only where no session cookie can ride along: webhook routes
(`routes.webhook(…).verify(…)`, in `Web` only, which verify a signature instead and take no
session) and requests with a bearer token. With the `cors` feature, a write from an origin the
area's CORS policy lists also passes, carrying the session cookie only when that policy allows
credentials.

## Compression and BREACH

Compression is off by default (the `compression` feature). Measured on the example shop, it makes
pages 9 times smaller but lowers throughput and raises memory use.

When on, it uses Brotli or gzip by `Accept-Encoding` for text answers of 1 KiB or more and sends
`Vary: Accept-Encoding, Sec-Fetch-Site`. Against BREACH, an answer to a request another site
started (`Sec-Fetch-Site` neither `same-origin` nor `none`) is never compressed. Together with
CSRF protection that reads headers, no attacker-triggered compressed answer holds a token.

## API tokens and rate limits

With the `tokens` feature, an area that sets `const TOKENS: bool = true` accepts
`Authorization: Bearer`. A token is 256 random bits, shown once and stored as a SHA-256 digest;
it expires, can be revoked, is narrowed by permission scopes, and is never a cookie or a session.
An unknown, expired or revoked token is a 401, one used outside its scopes a 403, and 10 failures
a minute from one address a 429.

Rate limits are per area (`app.throttle::<A>(Rate::per_minute(n))`) and per route
(`.throttle(…)`), counted per principal or per client address and answered with 429 and
`Retry-After`. None apply unless asked for, except sofie-identity's sign-in at 10 a minute.

## The shield

With the `shield` feature, sofie watches behaviour, never payloads. The pipeline sends small
signals into a bounded channel that never blocks, and a `sofie-shield` thread counts them per
caller (the principal when signed in, else the address) in sliding windows:

| Rule | Counts | Default threshold |
|---|---|---|
| `scan` | 404s on paths no route serves, and 405s | 30 a minute |
| `probe` | 404s on matched routes, as guessing other owners' ids is | 20 a minute |
| `refused` | 403s: cross-site, unsigned or unpermitted requests | 10 a minute |
| `malformed` | 400s and 413s | 20 a minute |
| `throttled` | 429s | 30 a minute |
| `protocol` | Connections failed on protocol errors | 5 a minute |
| `sign_in` | Failed sign-ins from one caller | 20 in 10 minutes |
| `account` | Failed sign-ins to one account from one caller | 10 in 15 minutes |
| `account_total` | Failed sign-ins to one account from every caller | 100 in 15 minutes |
| `sign_up` | Sign-ups from one caller | 10 an hour |

The sign-in rules need sofie-identity's `shield` feature. Paths that browsers and crawlers ask for
on their own, such as `/favicon.ico` and `/robots.txt`, do not count as scans.

Each rule is graded against its threshold: half of it is reported, the threshold slows the caller
to one request a second, and twice it blocks the caller with 429 and `Retry-After` for 15 minutes.
At the `account` threshold, signing in to that account is locked for that caller only, so an
attacker elsewhere cannot lock the owner out; at `account_total`, for everyone. Either lock tells
the account's owner through the `sofie_identity.SignInLocked` event.

Every block expires. A trusted proxy, a loopback or an unspecified address is never blocked. A
request pays one atomic load while nothing is blocked.

```sh
SOFIE_SHIELD=on                          # on, dry-run or off
SOFIE_SHIELD_THRESHOLDS=scan=60,member.probe=40
SOFIE_SHIELD_SHARED=on
```

- `SOFIE_SHIELD=dry-run` reports decisions without acting on them; it is the default of a debug
  build. `off` is for tests, `sofie bench` and `sofie fuzz`.
- `SOFIE_SHIELD_THRESHOLDS` takes `rule=count` or `area.rule=count`; an area's own count wins.
- `SOFIE_SHIELD_SHARED=on` writes blocks to `sofie.shield`, and every instance follows the table
  on `NOTIFY sofie_shield`, or every 10 s.

Each decision is one warning with its rule, grade, reason and caller (an address only as its /24
or /48). `ShieldBlocks` lists and lifts blocks in an action, and `ActiveBlocks` lists them on a
screen.

## Outgoing requests

Every request that leaves the app goes through `Outgoing`, the framework's client, behind the
`client` feature. App code cannot make one: it has no public constructor, and the wiring gives
one only to a gateway's adapter or a remote contract. `sofie check` refuses HTTP client and TLS
crates, `sofie-client` itself and raw sockets in modules, so the one way out cannot be bypassed by
adding a dependency.

- **Allowlist.** An `Outgoing` reaches its base URL's host and the hosts its vendor's `HOSTS`
  setting lists, over HTTPS; anything else is refused before a connection opens.
- **Private addresses.** The host is resolved, every address checked, and the connection opened
  to a checked address. Private, loopback and shared addresses are refused unless the vendor sets
  `PRIVATE=true`; link-local, cloud metadata, multicast and reserved addresses always are,
  IPv4-mapped and NAT64 forms included.
- **Redirects** are followed only for `GET`, each hop held to the same rules, never from HTTPS to
  plain HTTP, and without the caller's headers when the host changes.
- **URLs users supply**, such as webhook targets, go through `Outgoing::untrusted`: any public host
  over HTTPS, no redirect, no credentials in the URL. A host with no public address is refused
  with one message whatever it resolved to, so a user cannot map the internal network.
- **Bounded.** Connect (5 s) and total (30 s) timeouts, a 4 MiB response cap and a circuit
  breaker per host.

The settings come from `<MODULE>_<VENDOR>_*` keys, such as `PAYMENT_STRIPE_BASE_URL` and
`PAYMENT_STRIPE_HOSTS`. Headers, bodies and secrets are never recorded in traces.

## Personal data and secrets in telemetry

Logs take values, not strings, so a sensitive value cannot be formatted into a message unmasked.
A value's type decides how it is logged: `Email` prints `j***@example.com`, a value marked
`#[sensitive]` prints its mask, and `Secret<T>` has a masked `Debug`, no `Display` and cannot be
serialized. An aggregate field marked `#[sensitive]` shows as `***` and is never filtered, sorted,
listed, searched or written in the record's JSON.

What has no type to mask by is still scrubbed before a line is written or exported: fields named
like `password`, `token`, `authorization` or `cookie`, credentials in URLs and `Bearer` headers,
Postgres's row details, email addresses and IP addresses. The
[observability page](../../features/observability/) covers the scrubber in full.

## Owned areas

An area's principal fixes its access. When the principal is an aggregate, such as an account, the
area is owned: each record marked with an `#[owner]` field is visible only to its owner.

```rust
pub struct Customer;

impl Area for Customer {
    const NAME: &'static str = "customer";
    const PREFIX: &'static str = "/account";
    const SIGN_IN: &'static str = "/sign-in";
    type Principal = Account;
}
```

In an owned area, a handler's `Read` is made only by the request context, scoped to the principal,
with no way to widen it. Another owner's record is not found, and a commit refuses a write to it.
`Routes<A>` accepts only handlers for `A`'s principal, so an endpoint never receives another
area's principal. A rule over every owner's records, such as "no two bookings overlap", uses the
aggregate's crate-private `across(&read)`, which answers only `exists()` or `count()`, so no row
of another owner leaves it.

## Raw SQL

`read.sql::<Row>("…").bind(&value).all()` is the one place an app writes SQL. Its text is
`&'static str`, so input arrives only as bound parameters; it runs in a read-only transaction, and
`sofie check` keeps it out of actions. An owned area cannot use it, since nothing would keep it to
the principal's records. Everywhere else, values bind as parameters and no string is concatenated
into SQL.

## A database role per module

`sofie gen` writes each module's first migration, `0000_module_role.sql`, which creates a role
named after the module's schema that owns the schema and its tables. The framework writes SQL only
for an aggregate's own table, so its builder, unit of work and worker cannot cross a module.

With the `module-roles` feature, the database enforces it too: a commit enters
`SET LOCAL ROLE <module>` before an aggregate's writes, and `read.sql(…)` runs as the role of its
read model's module, so a module's own SQL cannot name another module's table. A split module logs
in as its role. Roles are global to a Postgres server, so apps sharing one need distinct module
names.

## Seeing it

An app loosens a default only explicitly, and `sofie explain` shows it for a route or an area.
`sofie docs` writes a `security.md` into `docs/gen/` (see
[generated documentation](../../features/generated-docs/)) that lists who reaches each area, a row per route with its access, permission, owner scope, rate limit and checks
(CSRF, webhook signature, signed link, body limit, upload, flag), each vendor's allowed hosts, the
secret configuration keys, and what the model cannot check.

## Limits

- The shield does no payload inspection and no volumetric defence; those belong at the edge.
- Rate limits are counted in-process, so behind a load balancer each instance allows the full
  rate.
- The framework's CI runs formatting, clippy, tests and `sofie check`, but no `cargo audit` or
  `cargo deny` yet.
- Automatic certificates (ACME) and HTTP/3 are not supported.
- The generated `security.md` lists raw SQL, webhook verifiers, gateways without `Adapter`,
  area-wide limits and CORS as what the model cannot check; review those by hand.
