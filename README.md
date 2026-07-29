# ravendb-test-driver

RavenDB test driver for Node.js — the port of [Raven.TestDriver](https://ravendb.net/docs/article-page/latest/csharp/start/test-driver) (C#).
Starts one embedded RavenDB server per test process and hands out an isolated, auto-deleted database per `getDocumentStore()` call.

Built on `ravendb-embedded`. Neither package is published to npm yet — both are consumed from a local git checkout (packed into a tarball) until they're released to the registry.

## Install

Neither `ravendb-test-driver` nor its `ravendb-embedded` dependency is on the npm registry yet. Until then, build each from a checkout and pack it into a tarball:

```bash
# from a checkout of ravendb-nodejs-embedded
cd ravendb-nodejs-embedded && pnpm build && pnpm pack
# from a checkout of ravendb-nodejs-testdriver (this repo)
cd ravendb-nodejs-testdriver && pnpm build && pnpm pack
```

Then install both tarballs into your test project:

```bash
pnpm add -D /path/to/ravendb-embedded-<version>.tgz /path/to/ravendb-test-driver-<version>.tgz
```

`ravendb` (the RavenDB client) is a peer dependency — install it alongside if it isn't already in the project. Registry installs (`pnpm add -D ravendb-test-driver`) will work once both packages are released to npm.

## Usage (vitest)

```ts
import { afterAll, describe, expect, it } from "vitest";
import { RavenTestDriver, TestServerOptions } from "ravendb-test-driver";

// Safe to call from every test file: first registration wins, later calls
// are no-ops, and the factory runs once when the server actually starts.
RavenTestDriver.configureServerOnce(() => new TestServerOptions({
    licensing: {
        eulaAccepted: true,
        license: process.env.RAVEN_LICENSE,
    },
}));

const driver = new RavenTestDriver({
    setupDatabase: async (store) => {
        const session = store.openSession();
        await session.store({ name: "Grisha" }, "people/1");
        await session.saveChanges();
    },
});

afterAll(async () => {
    await driver.dispose();
});

describe("people", () => {
    it("loads seeded data", async () => {
        const store = await driver.getDocumentStore();
        const session = store.openSession();
        const person = await session.load("people/1");
        expect(person?.name).toBe("Grisha");
    });
});
```

Subclassing works too (the C# pattern): override `preInitialize`, `preConfigureDatabase`, `setupDatabase`, or the `databaseDumpFilePath` / `databaseDumpFileStream` getters.

## One server per test run

The driver keeps one embedded RavenDB server per Node process (a module-level singleton, analogous to the C# driver's static server). Every `getDocumentStore()` call creates a fresh, isolated database against that same server and deletes it when the returned store is disposed.

Because the server lives at module scope, test runners that spawn one worker process per file (vitest's and jest's default) end up starting one server per file instead of one per run. This repo's own `vitest.config.ts` avoids that by forcing a single worker process:

```ts
// vitest.config.ts
export default defineConfig({
    test: {
        pool: "forks",
        fileParallelism: false,
        // ...
    },
});
```

(`poolOptions.forks.singleFork` doesn't apply here — Vitest 4 removed it. `pool: "forks"` combined with `fileParallelism: false` is the equivalent: a single fork runs every test file sequentially, so the module-level server survives across files.)

If you need multiple concurrent servers instead (e.g. to parallelize across workers), see the "Internal/advanced" note below.

### Jest

With Jest, the single-worker equivalent is `--runInBand`, and two more caveats apply (a working setup is the [nestjs-ravendb-example](https://github.com/ravendb/nestjs-ravendb-example) repo):

- **`--experimental-vm-modules` is required.** The `ravendb` client loads `undici` through a dynamic `await import()`, which Jest's VM sandbox only supports behind that Node flag. Without it every request fails with a 503-wrapped dispatcher assertion. Run Jest as:

  ```json
  {
    "scripts": {
      "test": "node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand"
    }
  }
  ```

- **Stop the server explicitly or Jest hangs after a green run.** The embedded server deliberately survives `driver.dispose()` so it can be reused across test files, and is normally cleaned up at process exit. Jest runs tests in-process, so the Raven.Server child-process handle keeps the event loop alive and Jest never exits. Call `RavenTestDriver.stopServer()` once after the whole suite — in the last `afterAll` or a Jest `globalTeardown`:

  ```ts
  afterAll(async () => {
      await driver.dispose();
      await RavenTestDriver.stopServer();
  });
  ```

Vitest with `pool: "forks"` needs neither: the fork loads `undici` natively and exits cleanly, which is why the vitest example above stops at `driver.dispose()`.

## License / EULA

`TestServerOptions` matches the C# driver's defaults: `licensing.throwOnInvalidOrMissingLicense` is `true` unless you explicitly set it in the constructor init.

- `licensing.eulaAccepted = true` is required for the embedded server to auto-download the RavenDB server binaries.
- Provide a license via `licensing.license` (inline string) or `licensing.licensePath` (path to a license file).
- This repo's own integration tests read the license from the `RAVEN_LICENSE` / `RAVEN_LICENSE_PATH` environment variables (see `test/testOptions.ts`); when neither is set, they fall back to `throwOnInvalidOrMissingLicense = false` so the suite can still run unlicensed locally.

## API

- `RavenTestDriver.configureServer(options)` — configures the shared per-process server. Must run before the first `getDocumentStore()`; throws if called afterward.
- `RavenTestDriver.configureServerOnce(factory)` — idempotent variant for setup code that runs once per test file: the first registered factory wins and every later call (even after the server started) is a no-op, so callers don't need their own "already configured" guard. The factory runs lazily, at most once, when the server actually starts — side effects like `mkdtempSync` or reading a license file don't repeat per file. An explicit `configureServer` call before start overrides a pending factory.
- `RavenTestDriver.stopServer()` — stops the shared per-process server (no-op if none was started) and resets its configuration so `configureServer` can be called again. Usually unnecessary — the server is reclaimed at process exit — but required with in-process runners like Jest (see the "Jest" section above).
- `driver.getDocumentStore(options?, database = "test")` — creates a new isolated database and returns a store for it; the database is deleted when the store is disposed. `options.waitForIndexingTimeout` waits for indexing to settle before returning.
- `driver.waitForIndexing(store, database?, timeoutMs?)` — waits until all indexes are non-stale, throwing (with index error details) on timeout.
- `driver.waitForUserToContinueTheTest(store)` — opens RavenDB Studio for the store's database and resumes once you create a `Debug/Done` document from Studio.
  **Warning:** this blocks forever until that document appears — it never resumes on its own (unlike the C# version, it cannot detect an attached debugger). Treat it as an interactive/debug-only helper and never leave a call to it in committed test code, or CI will hang indefinitely.
- `driver.dispose()` — disposes all stores handed out by this driver (and any scoped server). Also available via `await using driver = new RavenTestDriver()` (TypeScript 5.2+ / `ESNext.Disposable` lib, since `RavenTestDriver` implements `AsyncDisposable`).

### Internal/advanced

`driver.configureScopedServer(options)` exists to give an individual `RavenTestDriver` instance its own embedded server instead of sharing the process-wide one (e.g. to run multiple concurrent servers). It is marked `@internal` and used for RavenDB-internal testing — it is not part of the supported public API and may change without notice.

## Testing this package

```bash
pnpm build
pnpm test
```

`pnpm test:unit` and `pnpm test:integration` run the two suites separately. Integration tests spin up a real embedded server, so they need a RavenDB license (or `RAVEN_LICENSE`/`RAVEN_LICENSE_PATH` unset, which runs unlicensed).
