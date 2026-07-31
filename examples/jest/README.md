# ravendb-testdriver with jest

Runnable examples — the same six scenarios as the [vitest](../vitest) and
[mocha](../mocha) folders, so you can diff the setup rather than the test logic.

Jest needs the most care of the three runners. Both caveats below are required,
not optional.

## Run

```bash
npm install
npm test
```

The first run downloads the RavenDB server binaries, so it takes a while — hence
the 300s `testTimeout` in [jest.config.js](jest.config.js).

Optionally set `RAVEN_LICENSE` (inline license JSON) or `RAVEN_LICENSE_PATH`
(path to a license file). With neither set, the server runs unlicensed
(see [test/serverOptions.ts](test/serverOptions.ts)).

## Caveat 1: the client's dynamic `import()` and Jest's VM sandbox

The `ravendb` client loads some dependencies through dynamic `await import()`
(e.g. `undici` for its HTTP agent), which Jest's VM sandbox rejects — every
request then fails with a 503-wrapped dispatcher assertion. Pick one fix:

**Option 1 (recommended, used here): run Jest with `--experimental-vm-modules`.**
Enables dynamic `import()` inside the sandbox, so *all* client features work with
no other changes:

```json
{
  "scripts": {
    "test": "node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand"
  }
}
```

(Or put the flag in `NODE_OPTIONS`, which is also the fix for IDE test runners
that bypass the npm script.)

**Option 2: a `setupFiles` script that swaps the agent factory for a
`require`-based one.** No Node flag needed. Add `undici` as a devDependency —
package managers with strict `node_modules` layouts, like pnpm, will not resolve
transitive packages:

```ts
// test/jest.setup.ts
import { Agent } from "undici";
import { RequestExecutor } from "ravendb";

(RequestExecutor as any).createAgent = async (options: Agent.Options) => new Agent(options);
```

```js
// jest.config.js
module.exports = {
    setupFiles: ["<rootDir>/test/jest.setup.ts"],
};
```

This covers the plain CRUD/query/indexing path but **not** features with other
dynamic imports — bulk insert (`node:zlib`), the Changes API (`ws`), or smuggler
import/export (`node:fs`), which
[test/05-database-dump.test.ts](test/05-database-dump.test.ts) uses. That is why
Option 1 is the recommendation.

A future `ravendb` release is expected to drop the dynamic imports on the
CommonJS path, making both workarounds unnecessary.

## Caveat 2: stop the server per test file, or Jest hangs

The embedded server deliberately outlives `driver.dispose()`, and is normally
reclaimed at process exit. Jest runs tests in-process, so the live Raven.Server
child-process handle keeps the event loop alive and you get:

```
Jest did not exit one second after the test run has completed.
```

...after a green run — which in CI means hanging until the job times out.

So every test file calls a small shared helper
([test/stopServerAfterAll.ts](test/stopServerAfterAll.ts)):

```ts
RavenTestDriver.configureServerOnce(createServerOptions);

// Required for Jest: stops this file's embedded server so the run can exit.
stopServerAfterAll();
```

**Why per-file, and not `globalTeardown`:** Jest gives each test file its own
module registry, so the driver's module-level server singleton is per-file too.
`globalTeardown` runs in yet another registry, where it sees no server and stops
nothing — the run still hangs, and each file's server leaks until the process is
killed. Only the registry that started a server can stop it.

## One server per file

The same module-registry isolation means each Jest test file starts its own
embedded server, even under `--runInBand`. That is inherent to Jest, not
something the driver can work around; it is why this suite takes ~80s where the
[mocha](../mocha) one takes ~16s.

For a single server across the whole run, use vitest with `pool: "forks"` +
`fileParallelism: false`, or Mocha without `--parallel`.

## TypeScript version

`ts-jest` currently declares `typescript@>=4.3 <7`, so this example pins
TypeScript 5.9 while the driver itself builds on TypeScript 7. Installing with
TypeScript 7 here fails `npm install` with an `ERESOLVE` peer conflict.

## Files

| File | Shows |
| --- | --- |
| [test/serverOptions.ts](test/serverOptions.ts) | Shared `TestServerOptions`: temp dirs, EULA, license from env |
| [test/stopServerAfterAll.ts](test/stopServerAfterAll.ts) | The required per-file server teardown, and why |
| [test/01-basic-crud.test.ts](test/01-basic-crud.test.ts) | Minimal setup; store / load / update / delete |
| [test/02-isolated-databases.test.ts](test/02-isolated-databases.test.ts) | A database per store, name prefixes, `await using` |
| [test/03-seeding-with-hooks.test.ts](test/03-seeding-with-hooks.test.ts) | `setupDatabase`, `preInitialize`, `preConfigureDatabase`; subclassing |
| [test/04-indexing-and-queries.test.ts](test/04-indexing-and-queries.test.ts) | `waitForIndexing`, `waitForIndexingTimeout`, querying a static index |
| [test/05-database-dump.test.ts](test/05-database-dump.test.ts) | Seeding from a `.ravendbdump` via file path and stream |
| [test/06-server-lifecycle.test.ts](test/06-server-lifecycle.test.ts) | `configureServerOnce` vs `configureServer`, lazy start, server reuse |
| [test/07-secured-server.test.ts](test/07-secured-server.test.ts) | An HTTPS server with certificate authentication; own module registry, so no collision with the unsecured files |

## Same examples for other runners

- [../vitest](../vitest)
- [../mocha](../mocha)
