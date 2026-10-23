---
title: Search, files and cache
description: Full-text search, file storage and uploads, CSV, retention, image variants and the cache, each an opt-in feature.
sidebar:
  order: 4
---

Most apps need the same few services around their data: finding records by their words, keeping
uploaded files, exporting and importing spreadsheets, deleting old rows, and caching a costly
answer. Each is easy to start and easy to get subtly wrong: a path built from a file name, an
uploaded page served as the app's own, a search index that shows one user another's records, a
cache entry that lives forever.

sofie ships each one as a feature of `sofie`, off by default, so an app compiles only what it
uses. Each is built on the parts the rest of the framework already has: aggregates, the outbox,
`Outgoing` and owned areas. The rules those parts enforce hold here too.

## Full-text search

With the `search` feature, an aggregate that uses the `Searched` behavior keeps a `search_text`
column of its searchable fields, rewritten with every write:

```rust
#[aggregate(behaviors(Searched))]
pub struct Product { /* … */ }

let found = Product::query().where_(Product::matching("blue wool -red")).all(&read).await?;
```

Which fields are searched follows from their type: text, emails, slugs and enums are; amounts,
times and secrets are not. `matching` finds records holding every word, with quoted phrases and
`-word` to exclude.

On Postgres, it runs as `to_tsvector('simple', search_text) @@ websearch_to_tsquery(…)`, served by
a GIN index on that expression. Another database finds the words as one piece of text, ignoring
case.

```sh
sofie new search catalog Product
```

This adds the behavior, the column and an index built concurrently. A record written before the
column existed is found once it is written again.

### Meilisearch

With `search-meilisearch`, the same `matching` call can be answered by Meilisearch instead.
`SOFIE_SEARCH` chooses the engine: `database` (the default) or `meilisearch`, configured by
`SOFIE_SEARCH_MEILISEARCH_URL` and `SOFIE_SEARCH_MEILISEARCH_API_KEY`. Its requests go through an
`Outgoing`, so they are allow-listed, bounded and traced.

- Each searched aggregate is an index `<module>_<aggregate>`. A write that changes a record's text,
  owner or deletion queues an index job with its commit; the worker reads the record as it is then
  and puts or removes it, so a retried or late job never leaves an old state.
- A match asks the engine for at most 1000 ids, best first, within the reader's owner when the
  record holds one. The database then filters by those ids with the rest of the query's conditions,
  the owner's included, and orders and pages there. An owned area never sees another principal's
  records, whatever the engine answers.
- After switching to Meilisearch, or after losing its index, run
  `shop task sofie.search.reindex` once.

A failed Meilisearch task is logged at error level with its code, never with Meilisearch's message,
which may quote a document.

## Files and uploads

### Storage

With the `storage` feature, `Storage` keeps files under keys it generates itself, 128 random bits
as hex. No caller ever names a path, so none can leave the store's directory or bucket. Handlers
take `Storage` as an argument.

`SOFIE_STORAGE` chooses the store:

- `local`, the default: files under `SOFIE_STORAGE_ROOT`, each written beside its name and renamed
  once complete.
- `s3`, with the `storage-s3` feature: `SOFIE_STORAGE_S3_REGION`, `SOFIE_STORAGE_S3_BUCKET`,
  `SOFIE_STORAGE_S3_ACCESS_KEY_ID` and `SOFIE_STORAGE_S3_SECRET_ACCESS_KEY`, plus `_ENDPOINT`,
  `_PATH_STYLE` and `_PRIVATE` for another S3-compatible service.

Files stream both ways: S3 writes in 8 MiB parts, so one part is in memory at a time, and reads in
ranges. The S3 adapter signs requests with AWS Signature Version 4, written in the framework and
tested against AWS's published examples, and sends them through `Outgoing`.

`download_url(key, content_type, valid_for)` is a link that opens a file until it expires. S3
presigns it; `local` signs it with the app's signing keys. Only images and PDF are sent inline as
their type; anything else is an `application/octet-stream` attachment, so an uploaded HTML page
never runs as the app's own.

### Uploads

With the `uploads` feature, a `multipart/form-data` body is read as it arrives: text fields into
the input as a form post's, each file straight into storage. Only a route with `.file_limit(…)`
takes files; elsewhere a file part is answered 415.

```rust
routes
    .post("/products/{product}/photo", attach_photo)
    .body_limit(20 * 1024 * 1024)
    .file_limit(10 * 1024 * 1024);
```

- The body stays within `.body_limit(…)`, each file within `.file_limit(…)`, and text within
  64 KiB whatever the route allows.
- A file whose declared type its first bytes contradict (PNG, JPEG, GIF, WebP, PDF) is refused as a
  field error and deleted.
- A file arrives as an `Upload` field of the input, holding its key, a sanitized file name, its
  type and size. It is sealed with a key of the process, so a JSON body cannot name a stored file.
- The files of a request answered with an error are deleted.

A form whose input has an `Upload` field is rendered with `enctype="multipart/form-data"` and a
file control. CSRF protection and the session apply as to any form post.

### Image variants

With `image-variants`, `Storage::make_variants` reads an uploaded JPEG, PNG, WebP or GIF of at most
32 MiB and keeps resized copies under keys derived from the original's, so they are found again
without being stored anywhere:

```rust
const THUMB: Variant = Variant::new("thumb", 320);

storage.make_variants(&key, &[THUMB], &RESIZER).await?;
let thumb = key.variant(&THUMB);
```

The resizer is the app's own `Resizer`, run on the blocking pool. The framework decodes no images,
so no image library is in its dependency tree; the app's resizer brings one. A variant kept
already is not made again, so a retried job finishes the rest.

## CSV

With the `csv` feature, a `GET` route answers its list of records as RFC 4180 CSV:

```rust
routes.get("/orders.csv", orders).document(Media::Csv);
```

It is headed by the first record's fields. A text cell a spreadsheet would run as a formula
(starting with `=`, `+`, `-`, `@` or a tab) gets a leading `'`; a number does not.

An action taking `CsvRows<I>` reads the body's CSV, each row as `I` reads a form post. One refused
row refuses the import, its errors named `<row>.<field>`, so an import commits all rows or none.
The body is held to the route's `.body_limit(…)`.

## Retention

With the `retention` feature, a scheduled job takes `Prune` and deletes records older than a
cutoff on any ordered column:

```rust
prune.before(Visit::CREATED_AT, cutoff).await?;
```

Rows are deleted 1000 at a time, so no statement holds many rows' locks and a retried job
resumes. A nullable column keeps its null rows. An aggregate with children is refused: delete
those with their children in a job of the module's own.

The app's listeners hear `<Aggregate>Pruned` with the id and version, queued in the prune's
commit. Mirrors of the record in other modules drop it too, and remember it, so an older change
arriving late does not bring it back.

With `product-reports`, the worker also prunes stored product events hourly, keeping
`SOFIE_PRODUCT_EVENTS_KEEP_DAYS` (400 when unset).

## Cache

With the `cache` feature, handlers take `Cache` as an argument:

```rust
const TOTALS: Key<Totals> = sofie::cache::key!("totals");

async fn totals(cache: Cache, read: Read) -> Result<Totals> {
    cache.entry(&TOTALS).part(customer)
        .expires_in(Duration::from_secs(300))
        .depends_on::<Order>()
        .get_or_compute(|| compute(&read))
        .await
}
```

### Expiry is required

There is no entry without an expiry, and none longer than 7 days. A cache that never expires is a
bug waiting for a missed invalidation; the type makes the choice explicit.

### Keys

Keys are typed and namespaced by the crate that declares them. Parts are escaped, so they cannot
forge a separator. Values are JSON; a value an earlier build wrote in another shape reads as a
miss.

### Invalidation by aggregate change

An entry names what it depends on: an aggregate (`.depends_on::<Order>()`) or one record
(`.depends_on_record(id)`). Every commit hands its written records to the cache, which drops this
instance's memory entries depending on them before the commit returns, and drops the shared
store's and tells other instances in the background, so a commit does not wait for it.

A value computed while one of its dependencies was dropped is answered but not stored. Entries can
also be dropped by key with `delete()`, and `set` drops other instances' copies.

One computation per key runs at a time in a process; the other callers wait for its value.

### Stores

`SOFIE_CACHE_STORE` chooses the shared store:

| Store | Feature | What it is |
|---|---|---|
| `memory` | `cache` | The default. At most 10 000 entries and 64 MiB, evicted by clock |
| `database` | `cache-database` | An unlogged table `sofie.cache`, pruned each minute |
| `redis` | `cache-redis` | Redis at `SOFIE_REDIS_URL`, with `AUTH`, `SELECT` and TLS for `rediss://` |

Memory always sits in front of a shared store. Instances drop each other's memory copies through
`pg_notify` or Redis pub/sub. The Redis store speaks the Redis protocol (RESP2 and RESP3) itself.

Store calls are `cache` spans and the `sofie.cache.duration` metric; lookups are counted in
`sofie.cache.lookups` by tier.

### Failure

A store that fails during `get_or_compute` is a miss with a warning, so a cache outage slows the
app instead of breaking it. `get`, `set` and `delete` fail with the error.

## Limits

- Search on a database other than Postgres finds the words as one piece of text, ignoring case,
  without Postgres's phrase and `-word` syntax.
- With Meilisearch, a record owned through its parent carries no owner in its index, so in an
  owned area it is found among the best 1000 matches of every owner, then filtered to the
  principal's own.
- A drop another instance made in the shared cache is known here only once its message arrives, so
  a value computed meanwhile can outlive it until it expires.
- The framework does not resize images itself; an app supplies a `Resizer`.
