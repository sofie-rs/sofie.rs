---
title: Data and aggregates
description: How sofie stores, changes and reads data, from the aggregate's struct to the hand-written migration it is checked against.
sidebar:
  order: 2
---

Most web frameworks let any code load a record, change a field and call `save()`. That is
quick to write and hard to keep correct: a rule such as "a paid order cannot go back to
pending" has to be repeated wherever an order is changed, and nothing tells you when one place
forgets it.

sofie takes the opposite position. A record and its rules live in one folder, only that folder
can change it, and the framework writes what changed after the handler returns. Reading is a
separate side, with its own small types shaped for the screen or the API that needs them.

This page covers both sides and the types that hold the data: aggregates, the unit of work, read
models and queries, values, enums, inputs, behaviors, migrations and the database seam.

## Aggregates

An **aggregate** is a record and its child rows, saved and loaded as one. It is a plain struct
with `#[derive(Aggregate)]` in its own folder of the module:

```rust
// modules/order/src/order/mod.rs
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

impl Order {
    pub fn cancel(&mut self, reason: Option<CancelReason>) -> Result<()> {
        self.status = self.status.to(OrderStatus::Cancelled)?;
        self.meta.raise(OrderCancelled {
            order: self.id().uuid(),
            reason: reason.map(|reason| reason.0),
        })
    }
}
```

### Why the fields are private

Rust makes a struct's private fields visible only to the module that declares it and that
module's children. sofie uses that as the whole enforcement:

```text
src/order/
  mod.rs        the aggregate: fields, behaviour, the schema attributes
  factory.rs    a child module, so it alone may construct an Order
```

Nothing outside `src/order/` can build an `Order` or change one of its fields; the compiler says
so. There is no token type and no runtime check. A rule written in `Order::cancel` therefore
holds for every caller, because there is no other way in.

- `meta: Meta` is the one explicit line every aggregate carries: its id, version, the snapshot it
  was loaded as, and the events it has raised but not yet committed. The derive refuses an
  aggregate without it.
- The derive emits only a description of the type, as data: its table, its fields and their
  columns, constraints, owner and sensitivity, its behaviors, and how to encode and decode a row.
  It also writes one typed column constant per field, such as `Order::STATUS`. Loading, saving,
  querying, checking and rendering are generic code in the framework that reads that
  description.
- The struct is the single source for columns, validation, permissions, screen fields and
  search fields. Migrations are written by hand and checked against it (see
  [Migrations](#migrations)).
- A reference to another aggregate is its typed id (`Id<Order>`, or `AccountId` above). An
  `OrderId` is not a `CustomerId`, so the two cannot be swapped.

### The factory

An aggregate is born in its factory, `factory.rs`, which is a child module and so may set the
private fields. The factory is where a rule of creation lives:

```rust
// modules/order/src/order/factory.rs
pub fn place(account: AccountId, email: Email, total: Money, placed_at: Instant) -> Result<Order> {
    if !total.is_positive() {
        return Err(Error::invalid("total", "must be positive"));
    }
    let mut order = Order {
        meta: Meta::new()?,
        account,
        email,
        status: OrderStatus::Pending,
        total,
        placed_at,
    };
    order.meta.raise(OrderPlaced { order: order.id().uuid() })?;
    Ok(order)
}
```

A module that has no rule of creation can skip the file. With the `sofie` feature `factories`,
an aggregate without `factory.rs` derives `CreateProduct` (every stored field but the
`#[owner]`, which the area gives), `UpdateProduct`, and the `Create` and `Update` traits that
apply them. Writing `factory.rs` replaces both, so a module with a rule of creation writes its
own changes too.

### Child rows

A child row is a `#[derive(Child)]` struct with an `id: Id<Self>` field, held in a `Children<T>`
field of the aggregate (behind the `children` feature). Its table is in the aggregate's module,
named after the child, with a column named after the aggregate holding the parent's id. A load
reads each kind of child as one JSON column of the same statement, so loading an aggregate with
its children stays one round trip.

## The unit of work

An action returns the aggregates it changed. There is no hidden change tracking and no
`save()`:

```rust
// modules/order/src/actions.rs
pub async fn cancel_order(mut order: Order, cancel_reason: Option<CancelReason>) -> Result<Order> {
    order.cancel(cancel_reason)?;
    Ok(order)
}
```

After the handler returns, the framework opens one short transaction. It compares each returned
aggregate with the snapshot in its `meta`, writes a changed one whole with one fixed `UPDATE` per
type and a version check, writes its child rows by id, and writes its pending events to the
message table in the same transaction (see [Events, jobs and gateways](../../architecture/messages/)).

- **No transaction is open while the handler runs.** Loads read without locks, and a vendor or
  contract call in the body never holds a database transaction open.
- **A stale write is a conflict, never an overwrite.** If another commit changed the record since
  it was loaded, the version check fails and the action fails as `Conflict`.
- **What is returned decides what is written.** `Result<()>` writes nothing; an aggregate writes
  one; a tuple or a `Vec` writes several. A loaded aggregate that only raised events still takes
  the next version, so two copies cannot both commit the same event.
- **Nothing is written for an aggregate that did not change**, and nothing is stamped.
- **The commit is pipelined.** A commit of inserts is one round trip; one with a version check is
  two, since `COMMIT` waits for the count.

Comparing snapshots costs one encode per aggregate at commit and removes every line of per-field
change tracking.

There is no bulk `UPDATE … WHERE`, because it would bypass the aggregate's rules and its events.
A change to many aggregates is an action run once per record, usually from a schedule with
`each` (see [Schedules](../../architecture/messages/#schedules)).

## Two sides: aggregates and read models

The ORM splits along the line domain-driven design already draws: **aggregates for writing,
read models for reading**. Each side stays small because it does one job.

### Writing: aggregates load whole

```rust
let order = Order::find(&read, id).await?; // child rows included
```

An aggregate always loads with its child rows. There is no relation to load later, so lazy
loading and N+1 queries cannot happen on this side. Loading another aggregate is another `find`,
written explicitly.

### Reading: read models are any shape

Screens, APIs and reports read through **read models**: plain structs that state the shape they
need.

```rust
// modules/order/src/queries.rs
#[derive(ReadModel)]
#[read(from = Order)]
pub struct OrderRow {
    id: Id<Order>,
    status: OrderStatus,
    total: Money,
}

pub async fn list_orders(read: Read) -> Result<Vec<OrderRow>> {
    OrderRow::query().latest().limit(50).all(&read).await
}
```

- The derive lists the columns, and the builder writes one SQL statement. A read model selects
  only its own columns, so a screen never loads what it does not show.
- **Joins are stated up front.** A field marked `#[read(via = Order::ACCOUNT, field = …)]` reads
  a column of the record its `via` column points to, as a subquery in the select list. It is an
  `Option`, since the join can always read null (no record, or in an owned area another
  principal's). There is no eager-loading API and nothing to forget.
- **Joins stay inside the module.** Another module's data is joined through a **mirror**, a
  local, read-only table kept from the source's change events (see
  [Contracts between modules](../../architecture/messages/#contracts-between-modules)).
- **Sensitive data stays marked.** A field reading a sensitive one fails to compile unless the
  read model marks it `#[sensitive]` too, since what it selects reaches JSON and tables.
- **Computed read models.** A read model without `from` has no `query()`; its loader fills the
  fields from what it read, for counts, sums and groupings a screen shows.

A read model is also the output DTO of the queries that select it, so the shape a screen binds
to is checked against it by `sofie gen`.

## Queries and scopes

One generic `Query<T>` serves both sides. Columns are typed constants, so a wrong column or a
value of the wrong type does not compile.

| | |
|---|---|
| Conditions | `where_` with `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `between`, `in_`, `is_null`, `is_not_null`, and `like` on text columns only; `Condition::or` to combine |
| Order and limits | `order_by`, `latest` (ids are UUIDv7, so they sort by creation), `limit` |
| Results | `first`, `all`, `count`, `exists`, `paginate(&read, page)` for screens, `stream(&read)` for large sets |
| Scopes | Plain functions applied with `.scope(…)` |
| Implicit filters | Soft delete, lifted by `with_trashed()`; the owner filter of an owned area. Nothing else |

A scope is a plain function from a query to a query:

```rust
fn pending(query: Query<OrderRow>) -> Query<OrderRow> {
    query.where_(Order::STATUS.eq(OrderStatus::Pending))
}

pub async fn pending_orders(read: Read) -> Result<Vec<OrderRow>> {
    OrderRow::query().scope(pending).latest().all(&read).await
}
```

- `paginate` reads one record past the page to tell whether another follows, so no count runs. A
  page holds 1 to 100 records and starts within the first 10 000.
- `stream` reads by id in batches of 500, one short query each, and refuses a query that orders,
  limits or skips.
- Values always bind as parameters; no string is ever concatenated into SQL.

### Raw SQL

`read.sql::<OrderRow>("…").bind(&minimum).all()` decodes rows with the same read model. The text
is `&'static str`, so input arrives only as bound parameters. It runs in a read-only
transaction, only in queries (`sofie check` keeps it out of actions), and never in an owned area,
since nothing would keep it to the principal's records.

### Checking across owners

An owned area's `Read` sees only the principal's records, so a rule over every owner's records,
such as "no two live bookings overlap", needs its own way in. Each aggregate gets a crate-private
`across(&read)`, callable only from its own module. It takes conditions and answers only
`exists()` or `count()`: no row, field or id of another owner leaves it.

A check before the commit still races a concurrent one, so `.guard(refusal)` turns the same
conditions into a `Guard` outcome that the commit checks again inside its transaction. On
Postgres it takes a transaction-scoped advisory lock first; a row found rolls the commit back
as a 422.

## Value objects

A **value object** is a type that cannot hold an invalid value. It is parsed once at the boundary
and trusted everywhere after. `#[derive(Value)]` describes it to the framework:

```rust
// modules/order/src/order/mod.rs
#[derive(Value)]
pub struct CancelReason(String);

impl CancelReason {
    fn try_new(text: String) -> Result<Self, &'static str> {
        let fits = text.chars().count() <= 200;
        fits.then_some(Self(text)).ok_or("over 200 characters")
    }
}
```

- Construction goes through `try_new`, and deserializing a request or a row calls it too, so an
  invalid value never enters the app.
- Equality, hashing and cloning are derived; values are immutable.
- A value marked `#[sensitive]` is masked in `Debug`, and so in logs and traces. A field holding
  it is never filtered, sorted, listed, searched or written in the record's JSON.
- The type alone decides how a field is stored, validated, shown in a form and a table, filtered,
  logged and described in TypeScript and OpenAPI. Adding a value means adding one file.

The framework ships the values most apps need. `Money`, `Currency`, `Email`, `Secret` and
`Instant` are always compiled. The others are `sofie` features, off by default: `time` (`Date`,
`LocalDateTime`, `TimeZone`, `TimeOfDay`, `Weekday`), `phone` (`PhoneNumber`), `person`
(`PersonName`), `geo` (`Coordinate`), `measure` (`Measurement` and its instances such as
`Weight`), `percentage` (`Percentage`) and `web` (`Slug`, `Url`, `Locale`).

- `Money` holds minor units as `i64` and an ISO 4217 currency. There is no default currency and
  no float anywhere; arithmetic across currencies is an error.
- `Instant` is a point in time in UTC, for anything that happened.
- `LocalDateTime` with a `TimeZone` is for anything scheduled in the future, so it survives time
  zone rule changes.

## Casts

The type of a field is its cast; there is no separate cast declaration. A cast says which columns
a type spans, so the schema check can compare them with the migration. `total: Money` spans
`total` and `total_currency`; `phone: PhoneNumber` spans `phone_code` and `phone_number`.

Values are written as the framework's neutral `SqlValue` and read through a `ColumnReader` the
driver implements, never through a driver's types. A module writes its own cast only for a
value spanning several columns that the framework does not ship.

## Enums and transitions

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, Enum)]
pub enum OrderStatus {
    #[to(Paid, Cancelled, Expired)]
    Pending,
    #[to(Shipped, Refunded)]
    Paid,
    Shipped,
    Cancelled,
    Refunded,
    Expired,
}
```

`#[derive(Enum)]` gives the database mapping, `SCREAMING_SNAKE` serialization, translation keys
for labels, form options, and badge tones with `#[tone(…)]`.

An enum with `#[to]` is a state machine. `status.to(OrderStatus::Cancelled)` refuses an edge the
enum does not list, and the unit of work refuses a save whose field moved along an unlisted edge
between the loaded and the saved state, whichever code made the change. The failure is a field
error with the key `validation.move`. Moves made through `to()` are recorded for the action, so
two moves in one action pass as the chain of edges they took; a direct assignment needs a direct
edge.

## Inputs and other DTOs

Most DTOs are never written by hand.

- **Inputs.** A handler argument that is not bound from the route is its input. A
  `#[derive(Input)]` struct reads the body field by field, from JSON or a form alike:

  ```rust
  #[derive(Input)]
  pub struct PlaceOrder {
      total: Money,
  }
  ```

  A lone value reads the one field named after its type: `cancel_order(order, cancel_reason:
  Option<CancelReason>)` reads `{ "cancel_reason": … }`. Absent is `validation.required` (an
  `Option` reads it or nothing), unparsable is `validation.invalid`, any other field is
  `validation.unknown`, all answered as one 422.
- **Query strings.** A GET takes no body; it reads its query string as `Query<Q>`, with `Q` a
  `#[derive(Input)]` struct.
- **Outputs.** A read model is the output DTO of the queries that select it.
- **Contract DTOs.** Fields marked `#[expose]` become the DTO other modules receive, written by
  `sofie gen` into the contract crate.

A hand-written DTO is a plain `#[derive(Input)]` struct, used where data crosses a boundary in a
shape no schema describes, such as a vendor's payload inside a gateway adapter.

### Field constraints

A field of an aggregate or an input declares its limits once: `#[min(n)]`, `#[max(n)]`,
`#[length(min = …, max = …)]` for text, `#[range(min = …, max = …)]` for numbers, `#[required]`
and `#[unique]`. They become:

- **Validation**, as `FieldError`s keyed for translation (`validation.max_length` with
  `max = 120`). An input declared with `#[input(from = Product)]` inherits the constraints of the
  aggregate's fields of the same name and type; `#[unconstrained]` drops them, and
  `#[input(validate)]` runs a `Validate` implementation for cross-field rules.
- **Form attributes** such as `required`, `minlength` and `max`.
- **Database rules** that `sofie check` holds the migrations to: a CHECK per constraint, a unique
  index for `#[unique]`, and a CHECK listing every variant of an enum column.

## Behaviors

A **behavior** gives an aggregate columns, rules, scopes and methods by being named on its
declaration, so nothing is attached from a distance:

```rust
#[derive(Aggregate)]
#[aggregate(behaviors(SoftDelete, Active, Slugged(from = name), Audited))]
pub struct Product {
    meta: Meta,
    #[max(120)]
    name: String,
    price: Money,
    status: ProductStatus,
}
```

| Behavior | Adds | Feature |
|---|---|---|
| `Versioned` | The optimistic lock column. Always on | always |
| `Timestamps` | `created_at`, `updated_at`, stamped by the commit. Always on, never named | always |
| `SoftDelete` | `deleted_at`, a default scope hiding deleted rows, `with_trashed()`, `delete()`, `restore()` | `soft-delete` |
| `Active` | `is_active`, the `active` scope, `activate()`, `deactivate()` | `flags` |
| `Default` | `is_default`; `make_default()` clears it on the owner's other records in the same commit | `flags` |
| `Slugged(from = field)` | `slug`, derived from a text field, unique, with previous slugs answered as a redirect | `codes` |
| `UniqueCode` | `code`, ten Crockford base-32 characters from the record's id | `codes` |
| `Audited` | `created_by`, `updated_by`: the principal that wrote | `history` |
| `RecordsChanges` | A history row per create, update, delete and restore, in the same commit | `history` |
| `PublishLock` | `published_at`; once published, a change to the fields fails as a rule | `publishing` |
| `Broadcasts` | A `<Type>Changed` event per committed change | `publishing` |

A behavior can only derive values before a save, refuse a save, or signal after the commit. It
cannot call a service or a gateway, so it never hides I/O. A module defines its own behavior the
same way the framework does, by implementing the `Behavior` trait.

## Migrations

Migrations are hand-written SQL files, one folder per module. sofie does not generate the schema
from the struct at run time, and it does not check queries against a live database at build time.
Instead the struct and the SQL are both checked against each other.

```sql
-- modules/order/migrations/0001_create_order.sql
CREATE TABLE "order" (
    id uuid PRIMARY KEY,
    version bigint NOT NULL,
    email text NOT NULL,
    status text NOT NULL,
    total bigint NOT NULL,
    total_currency char(3) NOT NULL
);
```

- **Append-only.** Files are applied in the order of the number their names start with, and
  recorded with a checksum, so an applied file edited later is refused. `<app> db status`
  reports each migration as applied, pending, edited or missing.
- **Safe while the previous version serves.** `sofie check` refuses a statement that would lock
  a table the running version still uses (`migration-lock`): a NOT NULL column without a
  default, a type change, `SET NOT NULL`, an index built without `CONCURRENTLY` on an existing
  table, a rename, a drop of what the schema still reads. Each finding explains the expand and
  contract steps instead. A justified exception says why in a
  `-- sofie:allow migration-lock: <reason>` comment above the statement.
- **Inside the module.** `sofie check` refuses a migration naming another module's schema
  (`cross-module-sql`). Each module gets a database role that owns its schema, and with the
  `module-roles` feature the database itself holds a commit to the module whose records it
  writes.
- **Generated when it can be.** `sofie gen migration MODULE NAME` writes one that follows these
  rules. `sofie db fresh` rebuilds a local database from its migrations; it is built only with
  the `development` feature, so a production binary cannot drop its tables.

### The schema check

The schema check reads the database's catalog and compares it with each aggregate's fields and
behaviors' columns, and each child table: every column present, of the type its cast decodes, as
nullable as the field, and no column the app never writes that refuses null without a default.
Each mismatch names its `module.table`.

It runs in two places:

- in the scaffolded tests, so CI holds every aggregate's table on the migrated test database;
- as `<app> schema check` (or `sofie schema check`) against the database the app's settings name,
  so a deploy can check the database before the new version serves. It exits non-zero with a
  line per mismatch.

This gives the guarantee compile-time SQL checking gives, without a database at build time.

## The database seam

Everything that differs between databases sits behind three traits in `sofie-db`. Everything
above them (aggregates, the unit of work, read models, the query builder, values) is written
once.

| Trait | Covers | Postgres |
|---|---|---|
| `Driver` | Connections, pool, prepared statements, pipelined transactions, rows as they arrive | `tokio-postgres` with `deadpool-postgres` |
| `Dialect` | Placeholders, quoting, `RETURNING`, locking clauses, upsert, type names, the message table's SQL | `$1`, `"name"`, `FOR UPDATE SKIP LOCKED`, `ON CONFLICT DO NOTHING` |
| `Catalog` | Reading a table's columns, types, nullability and defaults for the schema check | `pg_catalog` |

Postgres is the default (`postgres`). SQLite is the second implementation, behind sofie's
`sqlite` feature, with `DATABASE_URL=sqlite://app.db`: `?1` placeholders, a module's tables named
after it, `pragma_table_info` as the catalog, and a module's `migrations/sqlite/` files where its
SQL differs. SQLite has no change notifications, so the worker polls.

- **Capabilities, not pretence.** A dialect declares what it supports. Where a database lacks
  something, the seam falls back explicitly, such as polling instead of `NOTIFY`, or the app
  fails at boot naming the missing capability.
- **Rows are read where they arrive.** The driver checks the statement's column types against the
  target once, before any row is read, then decodes rows as they stream in.
- **A bounded wait for a connection.** `SOFIE_DB_POOL_SIZE` and `SOFIE_DB_POOL_WAIT_MS` size the
  pool; a caller still waiting when the wait ends fails as `Unavailable`, which HTTP answers 503
  with `Retry-After` and the worker retries.
- **Per module.** The dialect follows each module's connection, so a split module can move to
  another database by changing only its migrations.

## Why not an existing ORM

The driver and pool are dependencies; the ORM layer is sofie's own. SeaORM and Diesel each bring
their own description of tables, which would be a second source beside the aggregate's struct,
and neither offers what this layer exists for: aggregates loaded whole, a unit of work that diffs
snapshots and writes events in the same transaction, owner scoping from the area, read models
joined through mirrors, and field metadata for screens and the schema check. Only `sofie-db`
touches the driver, so replacing it stays local.

## Trade-offs

- **No `save()`, no mass update, no observers.** Every change goes through an aggregate's methods
  and is committed from what the action returns; a change others react to is an event. Code that
  would be one `UPDATE` elsewhere is a per-record action here.
- **No lazy loading.** Aggregates load whole, so a very large aggregate is loaded in full each
  time. Keep aggregates small and read through read models.
- **No compile-time SQL checking against a database.** The schema check covers the same ground,
  but only when it runs: in CI and before a deploy.
- **Raw SQL is dialect-specific.** `read.sql(…)` is the one place where a database switch means
  editing queries.
- **The seam is kept to what is used.** The traits cover what Postgres and SQLite need; another
  database would widen them.
- **Not yet.** There is no per-viewer time zone (people see instants in the app's display zone),
  and `RecordsChanges` has no history tab on screens yet.
