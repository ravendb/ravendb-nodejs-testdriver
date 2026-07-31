# ravendb-testdriver with vitest

Runnable examples. Vitest needs the least setup of the three runners: no VM-sandbox
workaround, no explicit server teardown.

## Run

```bash
npm install
npm test
```

The first run downloads the RavenDB server binaries, so it takes a while — hence
the 300s timeouts in [vitest.config.ts](vitest.config.ts).

Optionally set `RAVEN_LICENSE` (inline license JSON) or `RAVEN_LICENSE_PATH`
(path to a license file). With neither set, the server runs unlicensed
(see [test/serverOptions.ts](test/serverOptions.ts)).

## Required config

Two settings in [vitest.config.ts](vitest.config.ts) matter:

```ts
export default defineConfig({
    test: {
        testTimeout: 300_000,
        hookTimeout: 300_000,

        // One server per process, reused across files.
        pool: "forks",
        fileParallelism: false
    }
});
```

The driver keeps its embedded server at module scope, so one server exists per
Node process. Vitest's default is a worker process per file, which would start a
server per file. `pool: "forks"` with `fileParallelism: false` runs every file
sequentially in a single fork, so the one server is shared.

(`poolOptions.forks.singleFork` does not apply — Vitest 4 removed it.)

## Files

| File | Shows |
| --- | --- |
| [test/serverOptions.ts](test/serverOptions.ts) | Shared `TestServerOptions`: temp dirs, EULA, license from env |
| [test/01-basic-crud.spec.ts](test/01-basic-crud.spec.ts) | Minimal setup; store / load / update / delete |
| [test/02-isolated-databases.spec.ts](test/02-isolated-databases.spec.ts) | A database per store, name prefixes, `await using` |
| [test/03-seeding-with-hooks.spec.ts](test/03-seeding-with-hooks.spec.ts) | `setupDatabase`, `preInitialize`, `preConfigureDatabase`; subclassing |
| [test/04-indexing-and-queries.spec.ts](test/04-indexing-and-queries.spec.ts) | `waitForIndexing`, `waitForIndexingTimeout`, querying a static index |
| [test/05-database-dump.spec.ts](test/05-database-dump.spec.ts) | Seeding from a `.ravendbdump` via file path and stream |
| [test/06-server-lifecycle.spec.ts](test/06-server-lifecycle.spec.ts) | `configureServerOnce` vs `configureServer`, lazy start, server reuse |
| [test/07-secured-server.spec.ts](test/07-secured-server.spec.ts) | An HTTPS server with certificate authentication (`secured()`) |

## Cleanup rules

- `driver.dispose()` in `afterAll` — disposes every store the driver handed out,
  which hard-deletes each store's database.
- `RavenTestDriver.stopServer()` is **not** needed here: the fork exits at the end
  of the run and takes the server with it. Jest and Mocha do need it — see those
  examples.

## Same examples for other runners

- [../jest](../jest)
- [../mocha](../mocha)
