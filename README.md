# sofie.rs

The documentation site of [sofie](https://github.com/sofie-rs/sofie), built with
[Astro Starlight](https://starlight.astro.build) and published to GitHub Pages on every push to
`main` and daily.

The pages under `src/content/docs/reference/` are not kept here: `scripts/reference.mjs` writes
them from the files `sofie gen` writes into sofie's example app, so they follow the framework.

```sh
git clone https://github.com/sofie-rs/sofie
npm ci
npm run dev
```

`npm run dev` and `npm run build` read sofie from `./sofie`, or from `SOFIE_REPO`.

Licensed under either of [Apache License, Version 2.0](LICENSE-APACHE) or [MIT license](LICENSE-MIT)
at your option.
