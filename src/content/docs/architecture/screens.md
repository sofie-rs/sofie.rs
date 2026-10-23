---
title: Screens and server-driven UI
description: How sofie renders every screen from one template format on the server, and where Svelte takes over.
sidebar:
  order: 5
---

A sofie app has no separate frontend. Every screen is a template of catalog components that one
engine, owned by the framework, renders to HTML on the server. The browser receives HTML and swaps
in fragments of it as the viewer sorts, filters, pages and posts. What the catalog cannot express
is an **island**, a Svelte component with typed props.

## Why one template format

Most web stacks split the UI in two: server views for simple pages and a JavaScript framework for
the rest, with an API between them. Each half has its own release cycle, its own build and its
own copy of the rules about who may see what.

sofie keeps one format for every screen. A record table and a marketing page are the same kind of
file, rendered by the same engine:

- **No frontend framework's release can break an app.** The engine belongs to the framework, so a
  screen changes only when the app changes it. A Svelte major release touches only the islands.
- **Every screen is checked.** Because a screen is a template the framework can read, `sofie gen`
  checks each binding against the type its loader returns, so a wrong field is an error, not an
  empty spot.
- **Every screen is also an API.** The same route answers a browser with HTML and a JSON caller
  with data, with no second handler.
- **Permissions apply while rendering.** A part of the template the viewer may not see is never
  sent, as HTML or as data.

The cost is that a screen can only do what the catalog and plain HTML can do. Anything richer is
an island, written in Svelte and built with Node.

## A screen

A screen lives in its module's area folder, under `screens/`. This one, from the shop example,
lists a customer's orders with a form to place one and a button to cancel each:

```html
<!-- modules/order/src/areas/customer/screens/orders.html -->
<Section title="Your orders">
  <Form id="place-order" post="/account/orders" target="orders">
    <Submit label="Place order" />
  </Form>
  <Table id="orders" of={data} columns="id status total" as="order">
    <Action post="/account/orders/{order.id}/cancel" label="Cancel" target="orders" when={order.status_to.CANCELLED} />
  </Table>
</Section>
```

The route binds the screen to a loader, a query that returns a read model:

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

`when={order.status_to.CANCELLED}` shows the button only for an order whose status may move to
`Cancelled`: a field's `<field>_to` states are part of the read model.

### What a template may hold

**Logic stays in Rust.** Expressions are field access and formatting only; anything computed is
computed in the loader. A template has `{…}` values, `{#if}` and `{#each}` blocks, and calls such
as `t("key")`, `number(…)`, `money(…)` and `date(…)` where text is written.

**Authored markup stays as written.** Literal text and quoted attribute values are the author's
HTML; only `{…}` values are escaped. A template cannot carry `<script>`, `<style>`, `<meta>`,
`<base>`, `<link>`, `<iframe>`, `<object>`, `<embed>`, the SVG elements `<animate>`, `<set>` and
`<animateMotion>`, or `style` and `on…` attributes. The page's head, scripts and styles come from
the engine, under its strict content security policy. A top-level `<title>` names the page.

**Components exist only for what HTML cannot do alone:** binding data, posting with htmx,
formatting money. Plain HTML and layout components cover the rest, so a marketing page is a
screen too:

```html
<Section title={t("home.title")}>
  {#each products as product}
    <Card href={product.link}>
      <p>{product.name}</p>
      <Money value={product.price} />
    </Card>
  {/each}
</Section>
```

## The component catalog

Each component is declared once in the engine, with its props, their kinds, which are required,
what children it takes and the feature that brings it. `sofie components` lists them,
`sofie explain <Component>` describes one, and the MCP `components` tool answers from the same
description.

| Component | What it does | Feature |
|---|---|---|
| `Section` | A titled part of a page holding any markup and components | |
| `Table` | Rows of a list, one column per field; its content is rendered in a last cell of every row | |
| `Money` | An amount, `{minor, currency}`, formatted in the viewer's language | |
| `Action` | A button posting to an action route, such as cancelling the row it sits in | |
| `Form` | A form posting to an action route; its fields come from the route's input type | |
| `Field` | One field of a `Form`, its control chosen from the input type's field | |
| `Submit` | The button sending a `Form` | |
| `Badge` | An enum value shown as its translated variant with the variant's tone | `i18n` |
| `Grid` | Lays its children out in responsive columns | `layout` |
| `Card` | A boxed group of content, a link as a whole when it has `href` | `layout` |
| `Image` | An image, loaded lazily | `layout` |
| `Island` | A Svelte component mounted as a custom element with typed props | `islands` |
| `Markdown` | Markdown rendered without raw HTML | `content` |
| `Head` | The page's title, description, canonical URL and link-preview tags | `content` |

The catalog refuses combinations that would break the page, when the template is built:

- A `Card` with `href` is a link, so a link, button, form, `Action`, `Table`, `Island` or
  `Markdown` inside it is refused.
- A `Form` is refused inside `{#each}` or a `Table` row, as its id would repeat. Picking one of N
  items is an `Action` posting fixed fields from its row:
  `<Action post="/slots/book" label="Book" with={{slot: slot.id}} />`. It renders a form whose
  hidden inputs post each field, so it works without JavaScript too. `sofie check`
  (`action-input`) finds a `with` key the posted route's input has no field for, and a required
  field it does not post.

### Forms come from the input type

A form's fields come from the input its route reads. `sofie gen` finds the route each
`<Form post="…">` posts to and the `Input` its action takes. The form then shows every field of
the input, in order, with its label and the control its type presents. A `Field` the template
writes keeps its own props (`label`, `value`, `options`, `currency`), so a template lists only
what it changes:

```html
<Form id="write-note" post="/desk/notes" target="notes">
  <Field name="body" label="What it says" />
  <Submit label="Write" />
</Form>
```

A validation error re-renders the form with each message under its field and answers 422.
Success redirects to the resource's show screen, follows `.then(redirect(…))`, or returns the
updated fragment to htmx (`.then_screen(…)`).

### Lists that page, sort and filter

A loader taking `Listing<T>` (the `listing` feature) reads the query's `page`, `size`, `sort`
(`sort=-total`) and filters (`status=PAID`, `total.gt=100`), each checked against the fields the
read model `T` selects, never a `#[sensitive]` one. It answers `Listed<T>`. A `Table` over it with
`sort="…"` and `filter="…"` links each column, shows a filter form and the neighbouring pages,
and every link fetches the table's own fragment. A refused filter value is listed under `errors`
beside its filter, in the viewer's language; an unknown field or operator is a 400.

### Resources need no file

`routes.resource::<Order>()` (the `resources` feature) renders an aggregate's index, show, create
and edit screens from its description: the fields of its create input, their controls and
constraints, its sortable and filterable columns. A module overrides one screen with its own
file, and `sofie scaffold screen order/console/order_index` writes the source out to start from.

## Checked before running

`sofie gen` reads the app without compiling it and checks every binding in every screen against
its loader's return type. Loaders answer with read models (`#[derive(ReadModel)]`, or a `Vec`,
`Option`, `Paginated` or `Listed` of one). A field holding a read model is checked through.

Data of any other type is a finding asking for a read model, because `sofie gen` reads types
without compiling them. `sofie check` reports a screen whose loader answers no read model, even
when its template binds nothing yet.

When the template depends on the outcome, a handler may pick it:
`Screen::render("empty_orders", data)`, typed `Result<Screen<T>>`. The name is a screen of the
handler's own module and area, and `sofie gen` checks that it exists and its bindings against
`T`. Binding through the route stays the default, because it keeps queries pure and reusable as
JSON.

## Rendered at runtime

The app's build script compiles each template to a program of ops: data, not code. The binary
embeds the programs and loads them at boot without a parser, and the engine renders a screen by
walking its program. There is no generated rendering code and no interpreter beside it, so there
is nothing to keep in agreement.

The engine reads bound data in place. `#[derive(ReadModel)]` describes each read model's fields
as a static table, so rendering a screen of read models builds no JSON tree and copies no text.
Data that is only `Serialize` is read from its JSON instead, with the same output.

In development, a changed template is reloaded from disk without compiling Rust.

## One endpoint, three answers

A screen is served the way a server-rendered framework serves a view with its data, not as a
frontend calling an API. The query returns data; the route names the template that shows it.

| The request | The answer |
|---|---|
| A browser navigation | The whole page as HTML |
| An htmx request from a catalog component (sort, filter, page) | Only that component's fragment: the engine renders the subtree of the template it belongs to |
| `Accept: application/json` | The loader's data as JSON |

So every screen is also an API. An island receives its first data as props in the page and calls
the same endpoints as JSON for more, and external clients reach the same queries through an area
that accepts bearer tokens.

## HTML over the wire

Sorting, filtering, paging, forms and actions send a request and get back the HTML fragment to
swap in, through htmx inside the catalog components. Nothing is hydrated, and screens need no
JavaScript of their own.

Small local state is a few lines in the engine's client: a control with `aria-controls` and
`aria-expanded` shows and hides the element it names, and Escape closes every open one. The
client also turns a request with no answer, or a 5xx page the server did not make (a proxy's),
into a notice instead of a broken swap. Anything more is an island.

## Live screens

With the `live` feature, a screen route keeps a fragment current as the data under it changes:

```rust
routes.screen("/notes", "notes", list).live("notes");
```

The loader runs while sofie records every aggregate table its reads touch. The page names a
signed stream for those tables; the engine's client opens an `EventSource` on it and, on an
event, refetches each fragment through its own route. Every guard, permission and owner filter
applies again on the refetch, and nothing rendered travels down the stream.

- Changes come from the unit of work: every committed aggregate write is announced after the
  commit, to this process at once and to other instances through Postgres notifications.
- A stream hears a change only when its principal may read the record: a write to an owned
  aggregate is heard by its owner and by unrestricted areas.
- The stream's link is sealed, so a caller listens only to the tables a page it was shown reads,
  and a signed-in principal's stream is bound to that principal.
- A burst of changes within 50 ms is one event. A lost stream reconnects with backoff from 1 s to
  60 s and refetches once open.
- At most 8 streams per principal and 10 000 per process; past that, `429` with `Retry-After`.

Measured on a release build with 2 000 streams, an open stream costs about 41 KB of memory, of
which about 35 KB is what any kept-alive HTTP/1.1 connection costs.

## Islands

Anything richer than the catalog, such as a rich editor, a chart or a map, is a Svelte island,
mounted by the engine with props from its loader. Islands are custom elements, so swapped
fragments mount and unmount them without help.

An island is either a whole page or a part of one. From `examples/islands`:

```rust
pub fn routes(routes: &mut Routes<Web>) {
    routes.island("/", "note-editor", queries::latest_note);
    routes.screen("/summary", "summary", queries::summary);
    routes.post("/notes", actions::write_note);
}
```

```html
<!-- screens/summary.html -->
<Section title="Latest note">
  <p>{data.title}</p>
  <Island name="word-count" props={data} />
</Section>
```

`routes.island(path, name, loader)` (the `islands` feature) answers a page that is the island
`islands/<name>.svelte`, or the loader's JSON when asked.

**Typed props.** For an app with islands, `sofie gen` writes `web/gen/types.ts`. An island page's
component declares its props with its loader's read model, and `sofie check` (`island-props`)
finds another type or a field the read model lacks:

```svelte
<script lang="ts">
  import type { NoteDraft } from "../../../../../../web/gen/types";

  let { title, body }: NoteDraft = $props();
</script>
```

**Props as data.** The island's element carries its props as escaped JSON in a
`<script type="application/json">` child, which the browser never runs, so it needs no nonce.
The framework's custom element reads it and mounts the component, so props never pass through
attributes.

**One bundle per area.** Every module's islands for an area compile into one `<area>.js` and
`<area>.css`; component styles go into the stylesheet, never inline, so the strict CSP holds. The
app's build script builds them with Node and the framework's pinned toolchain in `tools/web`, and
an area never ships another area's islands. `sofie dev` hot-reloads them. The toolchain is
installed once with `npm ci` in `tools/web`.

An app without islands needs no Node toolchain at all.

## Client areas: screens compiled to Svelte

An area is served as HTML over the wire unless it names a client. The same templates then become
Svelte components when the app is built; nothing about a screen, a route or a loader changes.
`examples/clients` publishes one screen in two areas side by side:

```rust
impl Area for Board {
    const NAME: &'static str = "board";
    const PREFIX: &'static str = "/board";
    const SIGN_IN: &'static str = "/";
    const CLIENT: Client = Client::Svelte;
    type Principal = Visitor;
}
```

The `Desk` area is the same without `CLIENT`, so it is served as HTML.

- **Compiled beside the HTML program.** For a client area, the build script parses each screen
  into the same ops the server renders and writes a `.svelte` component from them. Expressions
  keep their meaning: a missing path is empty, truthiness is the engine's, text is escaped and a
  URL attribute is checked for its scheme. esbuild bundles the screens and runtime into
  `<area>.client.js` and `.css`, embedded in the binary.
- **One runtime, one stylesheet.** The client runtime builds each catalog component as the
  engine writes its HTML, so one stylesheet serves both kinds of area. Links and the back button
  load screens without a page load, forms and actions post with an `Idempotency-Key` until
  answered, and a refused form keeps what was typed and shows its field errors.
- **The screen envelope.** The first page carries the screen's data as inert JSON. Later loads
  send `Accept: application/vnd.sofie.screen+json` and get an envelope: the screen, its title,
  language, data, the area's menu as the viewer may follow it, and a view describing gates,
  messages, formats, forms and enums for this viewer. The JSON API is unchanged.
- **Framework screens join the bundle.** Screens sofie-identity ships, such as sessions,
  passkeys and two-step sign-in, are compiled into the area's bundle when mounted there; one a
  client cannot render stays an HTML page.
- **Held to the server.** A test renders screens covering every component and field control
  with Svelte on the server and compares the HTML with the engine's for the same template and
  data.

Client areas need the `clients` feature of `sofie`; `sofie check` (`client-feature`) names an app
that uses one without it. `sofie dev` rebuilds a client bundle when a template changes.

## Permissions and flags in screens

A column needing a permission, a button needing another or a section behind a feature flag is a
condition in the template, evaluated while rendering for the request's principal:

```html
{#if can("order.order.total.read")}<Money value={order.total} />{/if}
{#if enabled("order.split_payments")}…{/if}
```

`can`, `enabled` and `entitled` take a quoted permission, flag or entitlement name; an `Action`
has `when`. Nothing hidden is sent to the browser:

- A fragment request cannot reach a hidden part by its id, and a render for no request shows
  nothing gated.
- A hidden part sends no data either. When a template is built, the engine records every data
  path it binds and the gates around it. For a screen's JSON callers and a client area's
  envelope, sofie rewrites the data for the viewer, failing closed: fields read only in hidden
  parts are `null`, a list keeps its length only where a shown loop counts it, and a path the
  viewer's parts only test is sent as `true` or `false`.
- A template whose gates all hold costs nothing.

A resource's screens in a `Permitted` area show their New, Edit and Delete links only to who may
follow them. See [Areas, identity and permissions](../../architecture/areas/) for how permissions
are named and granted.

## The supported path and the open boundary

The framework owns one way of doing each common thing and supports it fully. Anything else
crosses a web standard and is the app's own.

| | Owned by the framework | Open to the app |
|---|---|---|
| Interactions | htmx, pinned and embedded, configured strictly: no `eval`, same-origin requests only, a strict CSP. Its attributes appear only inside catalog components, never in an app's templates | None |
| Rich components | Svelte islands: compiled by the build script, hot-reloaded by `sofie dev`, mounted as the framework's custom elements, props typed from the loader, one bundle per area | Any other custom element (React, Vue, plain JavaScript), mounted by the engine with no typed props, build or reload support |

## Mobile

Mobile is planned, not built. The plan is an opt-in `sofie-mobile` crate in which Tauri wraps an
area in a native app, Tauri being a dependency of the mobile shell only, never of the server:

1. **Remote shell.** The app loads an area from the server in a webview, signing in through a
   token the area accepts beside its session. Native capabilities (push registration,
   biometrics, camera, share) become catalog components with a browser fallback, and UI changes
   ship without a store release.
2. **Embedded rendering.** The engine is a Rust library, so it can also compile for the device
   and render screens locally from data fetched through the API, starting faster and caching for
   offline use.

App stores reject apps that only wrap a website, so the first stage must lean on native
capabilities. Updating templates after release without a store release still needs checking
against store rules on dynamic code.

## Limits

- A screen can do only what the catalog and plain HTML can. Expressions are field access and
  formatting; computation belongs in the loader.
- `sofie gen` checks bindings only against read models. A loader returning another type is a
  finding, because types are read without compiling.
- `Markdown` and `Head` render only in HTML areas; a client area's template using them fails the
  build.
- `Client::React` compiles in the engine but the build refuses it: the web toolchain carries no
  React adapter. Svelte is the only client.
- Sign-in pages are in `Web`, an HTML area, even when the member area is a client area.
- A custom element other than a Svelte island gets no typed props, build or reload support.
- Live screens over raw SQL name no table, so such a screen hears every change. Notifications
  sent while an instance was not listening are lost; those screens catch up on their next change
  or reconnect.
- Mobile is not built yet.

The full contract is in
[`docs/structure.md`](https://github.com/sofie-rs/sofie/blob/main/docs/structure.md#screens-and-the-engine),
and how the engine implements it in
[`docs/core.md`](https://github.com/sofie-rs/sofie/blob/main/docs/core.md).
