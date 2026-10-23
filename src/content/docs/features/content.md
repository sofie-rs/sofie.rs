---
title: Content pages
description: Written pages with slugs that follow their titles, search and link-preview tags, and a sitemap, from the sofie-content package.
sidebar:
  order: 7
---

Most apps carry a few pages that are written rather than computed: an about page, terms, a help
article. They need the same small set of things every time: a readable address, a redirect when
the address changes, the tags search engines and link previews read, a sitemap, and somewhere to
write them. Building that for each app is repetitive, and the details (an old link that 404s, an
empty `og:image`, raw HTML in a Markdown body) are easy to get wrong.

sofie ships this as `sofie-content`, a package an app depends on like sofie-identity. It is a
module like any other: an aggregate, its migrations, a screen and routes. `sofie gen` wires its
migrations, screen, routes and settings, and `sofie routes` lists its routes beside the app's own.

## Pages

A `Page` has:

| Field | Holds |
|---|---|
| `title` | The page's title, from which its slug follows |
| `summary` | The description search engines and link previews show |
| `body` | Markdown |
| `image` | An optional image `Url`, shown in link previews |
| `published_at` | When it was published; none while it is a draft |

Only a published page is served, at `/pages/{slug}`. `publish` sets the publishing time once and
`withdraw` clears it, so a page published again after a withdrawal carries the new time.

## Slugs

The slug comes from the `Slugged` behavior, which any aggregate can use:

```rust
#[derive(Aggregate)]
#[aggregate(behaviors(Slugged(from = title)))]
pub struct Page { /* … */ }
```

The slug is derived when the record is created and whenever the title changes; an unchanged title
keeps its slug. It is lowercase words joined by hyphens, at most 100 bytes, cut between words.

### Transliteration

A small built-in table spells Turkish, German, accented Latin and Cyrillic letters in ASCII:

| Title | Slug |
|---|---|
| `Öğle` | `ogle` |
| `Straße` | `strasse` |
| `Привет` | `privet` |

Any other letter, digit or combining mark stays as it is, so a title in Chinese or Hindi keeps its
script (`关于`, `नमस्ते`). Spaces, punctuation and symbols separate words. A title that gives no
slug at all, such as only an emoji, is refused as a field error.

The slug is unique per table, by an index, so a title that would give another page's slug is
refused under the title field.

### Previous slugs answer 301

A slug a record leaves is kept in `sofie.previous_slug`. A query looks a record up with
`by_slug(&read, slug)`: by its current slug, or, for a previous one, it answers
`Error::Moved { from, to }`, which a `GET` answers with a 301 to its own path, the slug replaced and
the query string kept.

```rust
let page = Published::query()
    .where_(Page::PUBLISHED_AT.is_not_null())
    .by_slug(&read, slug)
    .await?;
```

A link shared before a title change keeps working. A previous slug is dropped when another record
takes it, or when its record is deleted.

## Search and link-preview tags

The page screen is shown through two catalog components:

```html
<Head title={data.page.title} description={data.page.summary} image={data.page.image} url={data.url} type="article" />
<article class="sofie-content">
  <h1>{data.page.title}</h1>
  <Markdown text={data.page.body} />
</article>
```

`<Head>` writes into the page's `<head>`: the title, a `description` meta tag, a canonical link,
Open Graph tags (`og:title`, `og:description`, `og:type`, `og:url`, `og:image`) and a Twitter card,
`summary_large_image` when there is an image and `summary` otherwise. A tag whose value comes out
empty is left out, because link previews read an empty `og:image` as a broken image rather than
none.

`<Markdown>` renders a strict subset. Raw HTML in the body stays text, and a link whose scheme is
not `http`, `https`, `mailto` or `tel` goes nowhere, so a page body cannot inject script or a
`javascript:` link.

### Giving pages the app's look

The screen's key is `sofie_content/web/page`. An app gives it its own look by writing a template of
that key; the package's template is the default.

## Sitemap

`/sitemap.xml` lists every published page with the day it last changed, at most 50 000. It is a
`.document(Media::Xml)` route, limited to 6 requests a minute, since it reads many rows and a
crawler fetches it rarely.

## Where the app is reached

Canonical URLs and the sitemap need the app's public address. It is read at boot from
`SOFIE_CONTENT_BASE_URL`, else `SOFIE_BASE_URL`: an `http` or `https` URL. A release build requires
it; a debug build without it uses `http://127.0.0.1:8080`.

## Writing pages

With the package's `admin` feature, `admin_routes::<A>` gives an area of the app resource screens
to list, write and change pages, and two actions, `/pages/{page}/publish` and
`/pages/{page}/withdraw`. The app mounts them in the area it chooses:

```rust
app.area::<Console>("sofie_content", sofie_content::admin_routes::<Console>)
```

A `Permitted` area suits it best, as each of its routes then needs a permission.

## Limits

- A page is served only once published. There is no draft preview route; a writer sees a draft
  through the admin's resource screens, not at its public address.
- Pages are plain Markdown with a title, summary and image. There are no page trees, categories,
  revisions or localized versions of one page.
- The sitemap stops at 50 000 pages.
