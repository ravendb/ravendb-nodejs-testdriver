# ravendb-testdriver with mocha

Runnable examples — the same six scenarios as the [vitest](../vitest) and
[jest](../jest) folders, so you can diff the setup rather than the test logic.

Assertions use `node:assert/strict`, so there is no assertion-library dependency.

## Run

```bash
npm install
npm test
```

The first run downloads the RavenDB server binaries, so it takes a while — hence
the 300s `timeout` in [.mocharc.json](.mocharc.json).

Optionally set `RAVEN_LICENSE` (inline license JSON) or `RAVEN_LICENSE_PATH`
(path to a license file). With neither set, the server runs unlicensed
(see [test/serverOptions.ts](test/serverOptions.ts)).

## Required config

```json
{
  "require": ["ts-node/register"],
  "spec": "test/**/*.test.ts",
  "timeout": 300000
}
```

- **Raise the timeout.** The first `getDocumentStore()` starts (and on the very
  first run, downloads) the embedded server, far past Mocha's 2s default.
- **Leave `--parallel` off.** Mocha then runs every file in one process, so the
  driver's module-level server is genuinely shared across files — which is what
  you want, and is why this suite is the fastest of the three (~20s).

## Caveat: stop the server, or Mocha hangs

The embedded server deliberately outlives `driver.dispose()`, and is normally
reclaimed at process exit. Mocha runs tests in-process, so the live Raven.Server
child-process handle keeps the event loop alive and Mocha hangs after an
otherwise green run.

[test/00-root-hooks.test.ts](test/00-root-hooks.test.ts) fixes that with a single
top-level `after` hook, in an ordinary spec file:

```ts
after(async () => {
    await RavenTestDriver.stopServer();
});
```

Because all files share one process (and one module registry), this single hook
covers the whole run — unlike Jest, which needs the call in every file.

Two traps worth knowing if you try to move this into `.mocharc.json`'s `require`
instead:

- A relative path there is resolved against **Mocha's own internals**, not the
  project root, so `./test/rootHooks.ts` fails with `ERR_MODULE_NOT_FOUND`
  pointing at `node_modules/mocha/lib/nodejs/test/rootHooks.ts`.
- A bare top-level `after(...)` in a `require`d file also fails with
  `ReferenceError: after is not defined` — those files load before Mocha installs
  its globals, so they need the `mochaHooks` root-hook-plugin export instead.

Keeping the hook in a plain spec file (the `00-` prefix just sorts it first)
avoids both.

## Unlike Jest, no sandbox workaround

Mocha has no VM sandbox — tests run on plain Node, so the `ravendb` client's
dynamic `import("undici")` works out of the box. No `--experimental-vm-modules`
flag and no setup-file agent patch (see the [jest example](../jest) for what that
involves).

## TypeScript version

This example pins TypeScript 5.9 while the driver itself builds on TypeScript 7:
`ts-node` 10.x crashes against TypeScript 7 with
`TypeError: Cannot read properties of undefined (reading 'fileExists')`. If you are
on TypeScript 7, use a loader without that coupling (e.g. `tsx` via
`node --import tsx`) and drop `ts-node/register` from `.mocharc.json`.

## Files

| File | Shows |
| --- | --- |
| [test/serverOptions.ts](test/serverOptions.ts) | Shared `TestServerOptions`: temp dirs, EULA, license from env |
| [test/00-root-hooks.test.ts](test/00-root-hooks.test.ts) | The single `after` hook that stops the server after the run |
| [test/01-basic-crud.test.ts](test/01-basic-crud.test.ts) | Minimal setup; store / load / update / delete |
| [test/02-isolated-databases.test.ts](test/02-isolated-databases.test.ts) | A database per store, name prefixes, `await using` |
| [test/03-seeding-with-hooks.test.ts](test/03-seeding-with-hooks.test.ts) | `setupDatabase`, `preInitialize`, `preConfigureDatabase`; subclassing |
| [test/04-indexing-and-queries.test.ts](test/04-indexing-and-queries.test.ts) | `waitForIndexing`, `waitForIndexingTimeout`, querying a static index |
| [test/05-database-dump.test.ts](test/05-database-dump.test.ts) | Seeding from a `.ravendbdump` via file path and stream |
| [test/06-server-lifecycle.test.ts](test/06-server-lifecycle.test.ts) | `configureServerOnce` vs `configureServer`, lazy start, server reuse |
| [test/07-secured-server.test.ts](test/07-secured-server.test.ts) | An HTTPS server with certificate authentication; stops the shared unsecured server first, and must sort last |

## Same examples for other runners

- [../vitest](../vitest)
- [../jest](../jest)
