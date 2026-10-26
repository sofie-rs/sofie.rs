---
title: Your first page
description: Build a product catalog with a form, a table and a JSON API, and see what sofie derives from a few lines.
sidebar:
  order: 2
---

This tutorial builds a small product catalog: a page with a form that adds a product and a table
that lists them. It takes about ten minutes, and along the way it shows what sofie writes for you
and what it checks.

It assumes you followed [Getting started](../getting-started/): the CLI is installed, `sofie new
app shop` made an app, and `.env` points at a database.

## 1. Run the app

In one terminal, start the development server and leave it running:

```sh
sofie dev
```

It migrates the database, serves the app at `http://127.0.0.1:8080`, and regenerates, rebuilds
and restarts it whenever a file changes. An edited template reloads the open page.

Run the commands below in a second terminal, inside the app's folder.

## 2. Add a module

A module owns a part of the business: its data, its rules and its screens.

```sh
sofie new module catalog
```

This makes `modules/catalog/` with the module crate and its **contract**, the part other modules
may use. The app's wiring is updated for you.

:::caution[sofie-cli 0.1.0]
The 0.1.0 release leaves the framework out of a new contract's dependencies, so the app stops
compiling once the next step adds a record. Add it to `modules/catalog/contract/Cargo.toml`:

```toml
[dependencies]
sofie.workspace = true
```

A CLI installed from the repository's main branch adds it itself.
:::

## 3. Add a record

An **aggregate** is a record saved and loaded as a whole.

```sh
sofie new aggregate catalog Product
```

It writes `modules/catalog/src/product/mod.rs` and a migration creating the table. Give the
product a name and a price, and a constructor that enforces its one rule:

```rust
// modules/catalog/src/product/mod.rs
use sofie::prelude::*;

#[derive(Aggregate)]
pub struct Product {
    meta: Meta,
    name: String,
    price: Money,
}

impl Product {
    pub fn new(name: String, price: Money) -> Result<Self> {
        if !price.is_positive() {
            return Err(Error::invalid("price", "must be positive"));
        }
        Ok(Self { meta: Meta::new()?, name, price })
    }
}
```

`meta` holds the id, version and timestamps. `Money` is an exact amount with its currency; there
are no floats for money in sofie.

Migrations are plain SQL you own. This one has not run yet, so add the columns to it directly:

```sql
-- modules/catalog/migrations/0001_create_product.sql
CREATE TABLE "product" (
    id uuid PRIMARY KEY,
    version bigint NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    name text NOT NULL,
    price bigint NOT NULL,
    price_currency char(3) NOT NULL
);
```

`sofie schema check` compares the migrated database with the struct and names every missing or
mistyped column; the scaffolded tests run the same check in CI. To change a table that already has rows, edit the struct and run
`sofie gen migration catalog <name>`: it writes the `ALTER TABLE` steps, in an order that is safe
while the old version keeps serving.

## 4. Add the routes

Two routes: a page that lists products and a form post that adds one.

```sh
sofie new route catalog web get /products list_products --screen products
sofie new route catalog web post /products add_product
```

`web` is the public **area**, the audience these routes serve. The generators write a stub query,
a stub action, the route lines and an empty screen. Fill them in.

The query returns a **read model**, the columns the page shows:

```rust
// modules/catalog/src/queries.rs
use sofie::prelude::*;

use crate::Product;

#[derive(ReadModel)]
#[read(from = Product)]
pub struct ProductRow {
    name: String,
    price: Money,
}

pub async fn list_products(read: Read) -> Result<Vec<ProductRow>> {
    ProductRow::query().latest().limit(50).all(&read).await
}
```

The action takes an **input** and returns the product to save:

```rust
// modules/catalog/src/actions.rs
use sofie::prelude::*;

use crate::Product;

#[derive(Input)]
pub struct AddProduct {
    name: String,
    price: Money,
}

pub async fn add_product(input: AddProduct) -> Result<Product> {
    Product::new(input.name, input.price)
}
```

It never touches the database: whatever an action returns is committed in one transaction after
it succeeds. A query gets a read-only connection.

After a post, show the products screen again:

```rust
// modules/catalog/src/areas/web/routes.rs
use crate::{actions, queries};
use sofie::prelude::*;

pub fn routes(routes: &mut Routes<Web>) {
    routes.screen("/products", "products", queries::list_products);
    routes
        .post("/products", actions::add_product)
        .then_screen("products", "products");
}
```

## 5. Write the screen

Screens are templates of catalog components that the engine renders on the server:

```html
<!-- modules/catalog/src/areas/web/screens/products.html -->
<Section title="Products">
  <Form id="add-product" post="/products" target="products">
    <Submit label="Add product" />
  </Form>
  <Table id="products" of={data} columns="name price" />
</Section>
```

The form lists no fields. `sofie gen` finds the action that `/products` posts to and builds the
form from `AddProduct`: a text field for the name and an amount-and-currency input for the price,
each with its label. `target="products"` replaces only the table after a post, without a full
page load.

## 6. Try it

Open `http://127.0.0.1:8080/products` and add a product. Then try a price of `0`: the form answers
with “must be positive” under the price field.

The same URL is also an API. Ask for JSON and the query's rows come back, with no second handler:

```sh
curl -H 'Accept: application/json' http://127.0.0.1:8080/products
```

```json
[{"name":"Coffee beans","price":{"minor":1250,"currency":"EUR"}}]
```

A post with invalid data gets `422` and the error for each field. A post from another site gets
`403`, because every unsafe request is checked against cross-site request forgery.

## 7. Make a mistake on purpose

Show each product's stock under the table, a field the read model does not have:

```html
  {#each data as product}<p>{product.stock}</p>{/each}
```

`sofie dev` refuses to build it, and `sofie check` says why:

```text
error[screen-binding]: `data[…].stock` at column 29 cannot be filled from the data of loader
`queries::list_products`: read model `ProductRow` has no field `stock`; its fields are name,
price, so it would render empty
  --> modules/catalog/src/areas/web/screens/products.html:6
   = help: bind a field the read model declares, or add the field to it
```

The same check runs inside `cargo build`, so a template cannot drift from its query in CI either.
Remove the line before going on.

## 8. Ask the app about itself

sofie reads the whole app into one model, and you can query it:

```sh
sofie routes
```

```text
AREA  METHOD  PATH       NAME                       HANDLER                          ...
web   GET     /products  catalog.web.list_products  catalog::queries::list_products  ...
web   POST    /products  catalog.web.add_product    catalog::actions::add_product    ...
```

```sh
sofie explain catalog.web.add_product
```

`explain` shows where the route is declared, its input with an example body, what the handler
calls and the screen it renders. Coding agents get the same model through `sofie mcp`, and
`AGENTS.md` in the app root is kept current by `sofie gen`.

## What you did not write

For about forty lines of Rust and five of template, you got:

- the route registration, the wiring and the database connection handed to the query;
- request parsing and validation, with messages placed under their fields;
- a form built from the input, and a table that updates in place;
- a JSON API at the same URL;
- CSRF protection, security headers and a trace for every request;
- checks that the template binds only what the query returns, which fail `cargo build` when they
  drift apart, and a schema check that holds the table to the struct.

## Next steps

- React to a change in another module with an event and a listener:
  `sofie new event` and `sofie new listener`. See [Messages](../../architecture/messages/).
- Let people sign up and own their records with `sofie-identity`. See
  [Areas](../../architecture/areas/).
- Test the catalog with the harness, which gives each test its own database and a clock it can
  move. See [Testing](../../features/testing/).
- Read [`examples/shop`](https://github.com/sofie-rs/sofie/tree/main/examples/shop) for accounts,
  owned orders, status transitions, an audit listener and an hourly job.
