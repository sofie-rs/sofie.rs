---
title: Observability
description: Traces, logs, metrics, product events and health checks that sofie records without being asked.
sidebar:
  order: 2
---

Telemetry is usually added by hand: a span here, a log line there, a request id threaded through
by convention. What is forgotten is invisible exactly when it is needed, and what is added by hand
tends to leak personal data or explode a metric's labels.

In sofie, every entry point already passes through the framework: the handler adapter, the screen
renderer, the store, the message worker, and the gateway and contract wrappers. Those open the
spans, record the metrics and carry the context, so there is almost nothing to annotate. Every
request, job, event delivery and contract call can be followed from its first span to its last,
across processes and across a split.

## One trace per piece of work

- **Incoming.** A request from a trusted proxy (`SOFIE_TRUSTED_PROXIES`) continues its W3C
  `traceparent`; any other request starts a trace, so a client cannot choose trace ids or
  sampling. The request id is always the server's own; a trusted proxy's id is recorded beside it
  as `edge_request_id`. The response carries the server's id and the `traceparent`.
- **Across async work.** The outbox row and the queued job store the `traceparent` of the work
  that created them, so a listener's span joins the trace of the request that raised the event,
  minutes later and in another process.
- **Across modules.** A contract call is a child span in a single app and a propagated HTTP call
  after a split, so `sofie split` changes the shape of a trace, not its continuity. Each split app
  reports under its own service name.
- **Outgoing.** Gateway calls inject `traceparent` into the vendor's request.
- **Browser.** The engine's client propagates `traceparent` on every call it makes. Behind a
  trusted proxy, a click, the request it caused and the queries under it are one trace.

## Spans

| Boundary | Span name | Attributes |
|---|---|---|
| Request | `GET order.customer.my_orders` (the route name, not the path) | area, module, route, status, flags evaluated, permission granted or refused |
| Action, query, loader | `order::actions::cancel_order` (the handler's path) | module |
| Render | `order/customer/invoice` (the screen key) | screen |
| A marked step | `order::actions::reserve_stock` | module |
| Database | The statement without bindings | rows, duration; slow ones logged as warnings |
| Commit | `commit` | aggregates written, events queued |
| Outbox and jobs | `deliver order.OrderPlaced`, `job order.expire_pending` | attempt, lifecycle |
| Contract call | `Customers::get_many` | the implementing module; a remote call names the app it calls |
| Gateway | `stripe.charge`, then `POST` | vendor, operation, outcome; peer host and port, status, retries |

The one span written by hand is a step inside a handler that deserves its own. Mark the function
with `#[span]` (feature `spans`); its body runs in a `step` span named after its path, and its
arguments are never recorded.

## Logs

Logs are structured: fields are values, not text. The logging macros take values and write each
through its `LogFields`, named by the last part of its path:

```rust
sofie::telemetry::info!(order.id, order.total, "order placed");
```

`Money` writes `total.minor=14990 total.currency=EUR`. The message is a literal, so nothing is
formatted into it, and a sensitive value cannot be interpolated unmasked. `warn!`, `error!` and
`debug!` work the same way (feature `log-fields`).

Every record carries `trace_id`, `span_id`, `request_id`, module and area without being asked.

### Masking

A value's type decides how it is logged. `Email` prints `j***@example.com`; `PersonName`,
`PhoneNumber` and any value marked `#[sensitive]` print their mask; `Secret<T>` has a masked
`Debug` and no `Display`. An aggregate field marked `#[sensitive]` shows as `***` in the
aggregate's `Debug` and in a log line naming it.

What has no type to mask by is still scrubbed, on the writer's thread, before a line is written or
exported:

- A field whose name ends in a key such as `password`, `secret`, `token`, `authorization`,
  `cookie`, `api_key`, `signature`, `session` or `card_number` logs `***`.
- In every text value, such a key's value in `key=value`, `key: value` and JSON form, a URL's
  password and query values, `Bearer` and `Basic` credentials, and Postgres's `Key (…)=(…)` and
  `Failing row contains (…)` details are masked.
- Email addresses, in any script, and IPv4 and IPv6 addresses become `***`. Loopback and
  unspecified addresses stay visible, as they are not personal data.

Times, versions like 1.2.3, durations, UUIDs, hex ids and ports are left alone. A four-part version
like 1.2.3.4 reads as an IPv4 address and is masked. The same scrubber runs over exported spans and
over the development span tree.

### Off the request path

A request only records an event's fields and queues them. A thread of its own formats each line and
writes it to stdout through a buffer, so no request waits on stdout. The queue never blocks: past
its capacity, info lines are dropped and counted, while warnings and errors have a bound four times
larger; anything dropped is counted and reported in a line of its own level.

### Sampling

`SOFIE_LOG` chooses which events are logged, such as `info,sofie_http=debug`. `SOFIE_LOG_SAMPLE`
(0 to 1, all when unset) keeps the info lines of that share of traces, and `SOFIE_TRACE_SAMPLE`
does the same for exported spans. Both are decided from the trace id, so lower rates are subsets
of higher ones and a kept trace keeps all its logs. Warnings and above are always kept.

## Metrics

Behind the `metrics` feature. The framework records:

| Metric | Labels |
|---|---|
| `http.server.request.duration` | route name, method, status, area |
| `sofie.handler.duration` | handler, module |
| `db.client.operation.duration` | operation |
| `db.client.connection.count` | busy connections |
| `messaging.process.lag`, `messaging.process.outcomes` | work, registered name; completed, retried, dead |
| `messaging.outbox.depth` | messages not yet handled, counted every 15 s |
| `sofie.gateway.duration`, `sofie.outgoing.duration` | vendor, operation, outcome |
| `sofie.shield.decisions` | rule, grade |
| `product.events`, `sofie.browser.events` | |

**Labels are bounded by type.** A label is a `Label`: a `&'static str`, such as a route name, an
enum variant's name or a module name, or a status code. An id or a text made while serving is not
`'static`, so it does not compile as a label, and a metric cannot explode in cardinality.

**Kept in the process.** A request only sends a measurement into a channel; a `sofie-metrics`
thread drains it every 50 ms and adds it up. No external store is needed. Prometheus scrapes
`/metrics` with `Authorization: Bearer` and `SOFIE_METRICS_TOKEN` (at least 32 characters); without
the token the endpoint does not exist.

## Product events

A product event records a business moment, counted in full and never sampled, on its own signal,
so funnels and conversion are read without mixing analytics into technical logs (feature
`product-events`):

```rust
sofie::telemetry::product_event!(order.placed, order.total);
```

It is written to the target `product`, which neither `SOFIE_LOG` nor `SOFIE_LOG_SAMPLE` drops, with
`product.event="order.placed"` and its values as fields. An event raised in a flow that evaluated
feature flags carries them as `feature_flags` (`order.checkout_layout=COMPACT`), so an experiment's
funnels split by variant without the caller naming it.

With sofie's `product-reports` feature, product events are also kept in `sofie.product_events`
with their time and principal, written in batches off the raising thread. The app's binary reads
them back as a retention table:

```sh
shop report retention --start signed_up --returning ordered --period week
```

It groups principals by the period of their first `start` event and shows how many of each cohort
raised the `returning` event in each period after. An event a job raises has no principal and
joins no cohort.

## Health and readiness

- `/live` answers as soon as the process serves.
- `/ready` checks what requests need: the database, the message table and each dependency the app
  declares with `app.serving(|serving| serving.dependency(name, check))`. It answers 503
  `unavailable` when one is down, naming which and why only in the log, as anyone may ask. Its
  answer is kept for a second, so a flood of probes costs one round of checks a second.
- A telemetry outage, such as a failing export, is answered 200 `degraded` and never takes an
  instance out of rotation.

Health probes open no request span and log no line; metrics still count them.

## Browser telemetry

With the `browser-telemetry` feature, the engine's client records Web Vitals (LCP, CLS, INP, FCP,
TTFB), errors, navigations and long tasks. It sends them through the app's own endpoint,
`/_sofie/telemetry`, so the collector is never exposed publicly. The endpoint takes 60 posts a
minute from one address. `SOFIE_BROWSER_SAMPLE` sets the share of pages that report.

Only a kind, a name from a fixed list and a number are accepted, so nothing personal is recorded.
Session replay and visitor attribution are not part of the framework.

## Export over OTLP

With the `otlp` feature, `sofie-telemetry` exports traces, logs and metrics itself over
OTLP/HTTP with protobuf bodies, configured by the standard variables:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
OTEL_SERVICE_NAME=shop
```

It also reads `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_TIMEOUT` (milliseconds, 10 s by
default) and `OTEL_RESOURCE_ATTRIBUTES`. Each signal has a bounded queue that drops its oldest item
when full and counts the drop; batches of up to 512 are sent, retried on 429, 502, 503, 504 or no
answer, and the queues are emptied at shutdown. Log records carry the trace and span id of the
innermost span around them, so a collector links logs to traces. Metrics are sent as a cumulative
snapshot every 60 seconds.

Spans and records are masked like log lines before they are encoded.

## In development and tests

`sofie dev` prints each request's span tree with its log lines in the terminal, so no collector is
needed locally (feature `development`).

Tests assert on recorded spans, logs and product events through an in-memory capture
(`Capture::spans`, `Capture::events`, `Capture::product_events`), so telemetry is tested as
behaviour. See [testing](../../features/testing/).

`sofie docs` writes a `telemetry.md` for the app: how its spans nest, each span name it produces,
each metric with the bounded label values it takes, its product events, and which fields are
logged only as their mask.

## Trade-offs

- The collector is meant to run beside the app, on its host or network, so a plain `http://`
  endpoint is the expected setup. An `https://` endpoint is sent over `rustls`.
- Under heavy load, info lines, spans and records are dropped rather than slowing requests. Drops
  are always counted and reported.
- Metrics are kept per process; aggregating across instances is the collector's or Prometheus's
  job.
