---
title: Coding agents and MCP
description: How one queryable app model, a generated AGENTS.md and the sofie mcp server let coding agents work on an app.
sidebar:
  order: 9
---

A coding agent working on an unfamiliar codebase spends most of its effort finding things: where
a route is declared, what input it takes, which file a new handler belongs in, whether the change
it made broke a rule nobody wrote down. In a free-form codebase every answer is a search, and
every guess is a chance to put code in the wrong place.

A sofie app has a fixed structure, and `sofie gen` reads the whole app into one model of its
modules, routes, areas and screens. That model is what makes an app legible to an agent:

- **It is told where each kind of code goes.** The structure is the same in every app, and
  `AGENTS.md` says it.
- **It can ask instead of search.** `sofie explain` answers what the model knows about any named
  thing.
- **Its mistakes are caught.** `sofie check` reports code in the wrong place like a compiler
  error, with the fix.
- **It can act through tools.** `sofie mcp` serves the model, the generators, the build and the
  running app over the Model Context Protocol.

People and agents read the same model through the same commands; nothing here is a separate
system for agents.

## AGENTS.md

`sofie gen` writes `AGENTS.md` at the app root from the structure’s rules and the app’s own
modules and areas. It holds:

- the app’s modules, each with its tier, areas, aggregates, events, tasks and contract;
- its areas and their URL prefixes;
- every command, including each `sofie new` generator with its arguments;
- how to run the app through `sofie mcp`;
- where each kind of code goes, the rules, recipes for common changes, and how data is handled.

It starts with a marker saying it is generated, and `sofie check` reports it stale when the code
changes, like the wiring. An `AGENTS.md` written by hand, without that marker, is left alone.

A new app gets one from its first `sofie gen`, before it has a module.

## `sofie explain`

`sofie explain NAME` answers everything the model knows about one thing, so an agent learns about
it before changing it. It takes a route (by name, such as `order.customer.cancel_order`, or by
handler path), an area, a module, an event, a job, a task, a read model, an aggregate, a screen
(by key, such as `order/customer/orders`), a screen component or a flag.

For a route it names its files, permission, flag, owner scope, what it answers, the screens that
show it, and the input it takes: each field of its `Input` type, required or optional, with its
JSON shape where the Rust type does not say it, such as `Money` as
`{"minor":14990,"currency":"EUR"}`, and a body it accepts. For a screen it names the route each
`<Form>` and `<Action>` posts and that route’s input fields. For an aggregate it lists the
columns its behaviors add. For a flag it lists the routes it hides and the jobs it skips.

```sh
sofie explain order.customer.cancel_order
sofie explain order/customer/orders
```

## `sofie mcp`

`sofie mcp [ROOT]` serves the app model to coding agents over the Model Context Protocol on
stdio: JSON-RPC 2.0, with the `initialize`, `ping`, `tools/list` and `tools/call` subset. It is
in the CLI’s default features (`mcp`).

Each tool is built on the same function its CLI command uses and reads the app afresh on every
call, so an answer is never stale.

### Connecting a client

Register the server under the name `sofie` in the client’s MCP configuration. The shop example
keeps it in `.mcp.json` at the app root:

```json
{
  "mcpServers": {
    "sofie": {
      "command": "sofie",
      "args": ["mcp"]
    }
  }
}
```

The name matters: clients prefix each tool with it (`mcp__sofie__explain`), and the server’s
instructions use those names.

### Steps

The `initialize` answer’s instructions map each step of a change to its tools, and every tool’s
description starts with its step and when to use it. Under each step the instructions list its
tools by client name (`select:mcp__sofie__…`), so a client that defers tools loads a whole step
in one search.

| Step | Tools |
|---|---|
| Read | `modules`, `explain`, `routes`, `schema`, `screens`, `components`, `tasks`, `flows`, `docs_page` |
| Change | `new_route`, `edit_screen`, `new_aggregate`, `new_migration`, `new_event`, `new_listener`, `new_task`, `new_menu_entry`, `scaffold_screen`, `feature`, `gen` |
| Change, less often | `new_module`, `new_area`, `new_search`, `new_plan`, `new_mail`, `new_account_screen`, `new_impersonation`, `new_tenancy` |
| Run | `request`, `dev`, `logs`, `traces`, `task`, `db_status` |
| Test | `tests`, `scaffold_tests`, `test` |
| Finish | `check`, `fix`, `lint`, `changes`, `build` |
| Rarely | `split`, `fuzz`, `seed` |

### Read tools

- `modules`: the app with the sofie features it enables, then each module’s tier, areas, events,
  aggregates, read models, jobs and route count. The place to start.
- `explain`: as [`sofie explain`](#sofie-explain), plus a screen’s markup.
- `routes`: the route table with method, full path, name, handler, permission and modifiers.
- `schema`: each module’s aggregates with fields and columns, its read models and migrations.
- `screens`: each screen template by key, with the routes that show it.
- `components`: every catalog component a template may use, with its props and children, the
  template syntax, and which features this app has on.
- `tasks`: each `#[task]` with the arguments it reads.
- `flows`: every request flow, from endpoint to action, event, listener and job.
- `docs_page`: a page `sofie docs` writes, such as `architecture` or `modules/<module>`.

### Change tools

Every generator has a tool: `new_module` and the `new_*` tools of the `sofie new` commands,
`scaffold_screen`, `scaffold_tests`, `gen`, `fix` and `feature`. `edit_screen` replaces one exact
occurrence of `find` in a screen template with `replace`, and refuses when the text is missing or
occurs more than once.

Each change tool runs `sofie gen` (and `sofie docs` for an app keeping docs) and `sofie check`
after it, so the agent sees at once whether the change holds. Each takes `dry_run`: it runs the
generator on a scratch copy of the app’s workspace and reports the files it would create, change
or remove, by comparing the copy before and after. A change made to the real app meanwhile, such
as `sofie dev` regenerating it, cannot hide one. The instructions tell agents to call each
generator with `dry_run` first, then without.

### Build, test and lint

- `build` and `test` run `cargo --offline --message-format short` over the app’s packages and
  answer only diagnostics, failures and result lines, cut at 16 KiB.
- `test` answers the passed, failed and ignored counts first, then every failure in full, then
  passed and ignored tests by file: every name in files git sees changed, counts elsewhere. With
  `filter` it lists every name it ran, and it fails when the filter matched no test.
- `tests` lists each test file with its test functions; with `name` it answers one test’s file,
  lines and source, so an agent follows the existing style.
- `lint` runs `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` on the app’s own
  packages; with `write` it formats them.
- `check` runs `sofie check`, which must answer `ok`.
- `changes` lists the files added, modified, renamed or deleted under the app root since git’s
  last commit; with `path` it answers that file’s diff, or a new file’s text. It is read-only and
  refuses outside a repository.

### Running the app

The run tools run the app as `sofie dev` does, on a free local port, and refuse a `DATABASE_URL`
not on this machine. Its stdout and stderr are kept in a buffer of the last 2,000 numbered lines.

- `request` sends one request to the running app. It starts the app first, or rebuilds it when
  code changed and sends a reload signal when only templates did. It sets an `Origin` so the CSRF
  check passes, and asks for a `page`, `json` or `fragment` answer (`target` names the fragment).
  `session` names a cookie jar: sign in through the app’s own routes with one, then act as that
  principal by naming it again; cookie values are never shown. The answer carries the status,
  `location`, `content-type`, `x-request-id`, the names of cookies set, the request’s span tree
  and the body cut at 16 KiB. A 400 or 422 answer points to `explain` for the input the route
  takes.
- `traces` lists recent span trees with their trace ids, or with `trace` every tree of one trace:
  the request’s, then the jobs and listeners that joined it.
- `logs` answers the app’s lines after a cursor, optionally filtered, and the next cursor.
- `dev` starts, stops or reports the app (pid, address, last exit), or with `run` queues a
  schedule’s job now, which the running worker takes next whatever its interval.
- `task` builds the development binary and runs one `#[task]` with `arguments` (a JSON object
  passed as `--name value` process arguments, never through a shell).
- `db_status` answers `<app> db status`: per module, each migration applied, pending, edited or
  missing. It fails when one is edited or missing.

A failed build answers the compiler’s errors, cut at 16 KiB.

### A typical loop

An agent adding a page to an area would call `modules` and `explain` on the area, `new_route`
with `dry_run` and then without, `edit_screen` to fill in the template, `request` to load the
page with a signed-in session, `scaffold_tests` and `test`, and finally `check`, `lint` and
`changes` to review what it did.

## Limits

- The server implements a subset of MCP: `initialize`, `ping`, `tools/list` and `tools/call`, over
  stdio only.
- Comparing a table with its aggregate needs the compiled type, so no read tool answers it; the
  scaffolded `schema` test does, run through `test`.
- The run tools, `fuzz`, `seed`, `task` and `db_status` work only against a database on this
  machine.
- Output is cut at 16 KiB, so a very long failure or body is truncated.
