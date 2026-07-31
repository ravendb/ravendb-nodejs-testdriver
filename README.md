# ravendb-testdriver

RavenDB test driver for Node.js.
Starts one embedded RavenDB server per test process and hands out an isolated, auto-deleted database per `getDocumentStore()` call.

## Install

```bash
npm install --save-dev ravendb-testdriver
```

or with pnpm / yarn:

```bash
pnpm add -D ravendb-testdriver
```

```bash
yarn add -D ravendb-testdriver
```

Requires Node.js >= 22.

## Usage (vitest)

```ts
import { afterAll, describe, expect, it } from "vitest";
import { RavenTestDriver, TestServerOptions } from "ravendb-testdriver";

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

Subclassing works too: override `preInitialize`, `preConfigureDatabase`, `setupDatabase`, or the `databaseDumpFilePath` / `databaseDumpFileStream` getters.

## Examples

[`examples/`](examples) holds three standalone, runnable projects, one per test runner. Each covers the same seven scenarios with the same test bodies, so the difference between folders is the runner setup, not the driver usage.

| Runner | Folder | Setup needed | Servers per run |
| --- | --- | --- | --- |
| **vitest** | [examples/vitest](examples/vitest) | `pool: "forks"` + `fileParallelism: false`; raised `testTimeout` / `hookTimeout` | 1 |
| **mocha** | [examples/mocha](examples/mocha) | No `--parallel`; raised `timeout`; one `after` hook calling `stopServer()` | 1 |
| **jest** | [examples/jest](examples/jest) | `--experimental-vm-modules`, `--runInBand`, raised `testTimeout`, `stopServer()` **per file** | 1 per file |

The scenarios: basic CRUD; a fresh database per store (and `await using`); the `setupDatabase` / `preInitialize` / `preConfigureDatabase` hooks plus subclassing; `waitForIndexing` and querying a static index; seeding from a `.ravendbdump` by path and by stream; the server lifecycle (`configureServerOnce` vs `configureServer`, lazy start, server reuse); and an HTTPS server with certificate authentication via `ServerOptions.secured()`.

Build the package first, since each example depends on it via `file:../..`:

```bash
pnpm build
```

Then run any folder:

```bash
cd examples/vitest && npm install && npm test
```

Start with the vitest example if you have no runner preference, since it needs the least setup. See [examples/README.md](examples/README.md) for the runner comparison, and each folder's README for its own caveats.

Two notes that apply to every folder:

- **Raise the runner's timeout.** The first `getDocumentStore()` call starts the embedded server, and on the very first run downloads the RavenDB binaries, which takes far longer than any runner's default (vitest and jest: 5s, mocha: 2s). Each example sets 300s: `testTimeout` + `hookTimeout` for vitest, `testTimeout` for jest, `timeout` for mocha.
- **The jest and mocha examples pin TypeScript `~5.9`.** `ts-jest` and `ts-node` both cap their TypeScript peer below 7, so TypeScript 7 fails their install with an `ERESOLVE` peer conflict. The driver itself builds on TypeScript 7; the pin is a constraint of those two loaders, not of the driver.

## One server per test run

The driver keeps one embedded RavenDB server per Node process (a module-level singleton). Every `getDocumentStore()` call creates a fresh, isolated database against that same server and deletes it when the returned store is disposed.

More precisely, there is one server per *module registry*. Test runners that spawn one worker process per file (vitest's and jest's default) therefore start one server per file instead of one per run. This repo's own `vitest.config.ts` avoids that by forcing a single worker process:

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

(`poolOptions.forks.singleFork` doesn't apply here: Vitest 4 removed it. `pool: "forks"` combined with `fileParallelism: false` is the equivalent: a single fork runs every test file sequentially, so the module-level server survives across files.)

Mocha gets the same result by default, as long as you don't enable `--parallel`. Jest is the exception: it isolates the module registry per test file, so each file starts its own server no matter the configuration, `--runInBand` included. See the "Jest" section below.

If you need multiple concurrent servers instead (e.g. to parallelize across workers), see the "Internal/advanced" note below.

### Jest

With Jest, the single-worker equivalent is `--runInBand`, and two more caveats apply (a working setup is [examples/jest](examples/jest)):

- **Work around the client's dynamic `import()` calls.** The `ravendb` client loads some of its dependencies through dynamic `await import()` (e.g. `undici` for its HTTP agent), which Jest's VM sandbox rejects, so every request then fails with a 503-wrapped dispatcher assertion. Two ways around it, pick one:

  **Option 1 (recommended): run Jest with `--experimental-vm-modules`.** Enables dynamic `import()` inside Jest's sandbox, so *all* client features work, with no other changes needed:

  ```json
  {
    "scripts": {
      "test": "node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand"
    }
  }
  ```

  (Or add the flag to `NODE_OPTIONS`, which is also the fix for IDE test runners that bypass the npm script.)

  **Option 2: a `setupFiles` script that swaps the client's agent factory for a `require`-based one.** No Node flag needed, but note that no example implements this path, so unlike Option 1 it is not covered by a runnable project here. Add `undici` as a devDependency (package managers with strict `node_modules` layouts, like pnpm, won't resolve transitive packages):

  ```ts
  // test/jest.setup.ts
  import { Agent } from "undici";
  import { RequestExecutor } from "ravendb";

  (RequestExecutor as any).createAgent = async (options: Agent.Options) => new Agent(options);
  ```

  ```js
  // jest.config.js
  module.exports = {
      // ...
      setupFiles: ["<rootDir>/test/jest.setup.ts"],
  };
  ```

  This covers the plain CRUD/query/indexing path, but *not* features that hide other dynamic imports (bulk insert via `node:zlib`, the Changes API via `ws`, smuggler import/export via `node:fs`), which is why Option 1 is the recommendation.

  A future `ravendb` client release is expected to drop the dynamic imports on the CommonJS path, making both workarounds unnecessary.

- **Stop the server in every test file, or Jest hangs after a green run.** The embedded server deliberately survives `driver.dispose()` so it can be reused, and is normally cleaned up at process exit. Jest runs tests in-process, so the Raven.Server child-process handle keeps the event loop alive and Jest reports `Jest did not exit one second after the test run has completed.` and then hangs (in CI, until the job times out). Call `RavenTestDriver.stopServer()` in each file's `afterAll`:

  ```ts
  afterAll(async () => {
      await driver.dispose();
      await RavenTestDriver.stopServer();
  });
  ```

  Per file, and *not* in a `globalTeardown`: Jest gives each test file its own module registry, so the driver's module-level server singleton is per-file too. A `globalTeardown` runs in yet another registry, where it sees no server and stops nothing: the run still hangs and each file's server leaks until the process is killed. Only the registry that started a server can stop it.

  The same isolation means each Jest test file starts its own embedded server, even under `--runInBand`. That is inherent to Jest; for a single server per run, use vitest (`pool: "forks"` + `fileParallelism: false`) or Mocha without `--parallel`.

Vitest with `pool: "forks"` needs neither: the fork loads `undici` natively and exits cleanly, which is why the vitest example above stops at `driver.dispose()`.

### Mocha

Mocha runs every test file in one process by default, so the shared server already behaves as one-per-run, so just don't enable `--parallel`. A working setup is [examples/mocha](examples/mocha). Two caveats:

- **Raise the timeout.** The first `getDocumentStore()` call starts (and on first ever run, downloads) the embedded server, which blows past Mocha's default 2s timeout:

  ```json
  // .mocharc.json
  {
    "require": "ts-node/register",
    "spec": "test/**/*.test.ts",
    "timeout": 300000
  }
  ```

- **Stop the server explicitly or Mocha hangs after a green run.** Same in-process issue as Jest: the Raven.Server child-process handle keeps the event loop alive. Call `RavenTestDriver.stopServer()` in a root-level `after` hook:

  ```ts
  import * as assert from "node:assert/strict";
  import { RavenTestDriver, TestServerOptions } from "ravendb-testdriver";

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

  after(async () => {
      await driver.dispose();
      await RavenTestDriver.stopServer();
  });

  describe("people", () => {
      it("loads seeded data", async () => {
          const store = await driver.getDocumentStore();
          const session = store.openSession();
          const person = await session.load<{ name: string }>("people/1");
          assert.equal(person?.name, "Grisha");
      });
  });
  ```

Unlike Jest, Mocha has no VM sandbox: tests run on plain Node, so the `ravendb` client's dynamic `import("undici")` works out of the box, with no setup-file workaround or `--experimental-vm-modules` flag (see the Jest section above).

## License / EULA

`licensing.throwOnInvalidOrMissingLicense` defaults to `true` unless you explicitly set it in the constructor init.

- `licensing.eulaAccepted = true` is required for the embedded server to auto-download the RavenDB server binaries.
- Provide a license via `licensing.license` (inline string) or `licensing.licensePath` (path to a license file).
- This repo's own integration tests read the license from the `RAVEN_LICENSE` / `RAVEN_LICENSE_PATH` environment variables (see `test/testOptions.ts`); when neither is set, they fall back to `throwOnInvalidOrMissingLicense = false` so the suite can still run unlicensed locally.

## API

- `RavenTestDriver.configureServer(options)`: configures the shared per-process server. Must run before the first `getDocumentStore()`; throws if called afterward.
- `RavenTestDriver.configureServerOnce(factory)`: idempotent variant for setup code that runs once per test file: the first registered factory wins and every later call (even after the server started) is a no-op, so callers don't need their own "already configured" guard. The factory runs lazily, at most once, when the server actually starts, so side effects like `mkdtempSync` or reading a license file don't repeat per file. An explicit `configureServer` call before start overrides a pending factory.
- `RavenTestDriver.stopServer()`: stops the shared per-process server (no-op if none was started) and resets its configuration so `configureServer` can be called again. Unnecessary under vitest with `pool: "forks"` (the fork exits and takes the server with it), but required with in-process runners: once in a root-level `after` for Mocha, and in *every* test file's `afterAll` for Jest (see the "Jest" and "Mocha" sections above).
- `driver.getDocumentStore(options?, database = "test")`: creates a new isolated database and returns a store for it; the database is deleted when the store is disposed. `options.waitForIndexingTimeout` waits for indexing to settle before returning.
- `driver.waitForIndexing(store, database?, timeout?)`: waits until all indexes are non-stale (default timeout 60s), throwing (with index error details) on timeout.
- `driver.waitForUserToContinueTheTest(store)`: opens RavenDB Studio for the store's database and resumes once you create a `Debug/Done` document from Studio.
  **Warning:** this blocks forever until that document appears; it never resumes on its own. Treat it as an interactive/debug-only helper and never leave a call to it in committed test code, or CI will hang indefinitely.
- `driver.dispose()`: disposes all stores handed out by this driver (and any scoped server). Also available via `await using driver = new RavenTestDriver()` (TypeScript 5.2+ / `ESNext.Disposable` lib, since `RavenTestDriver` implements `AsyncDisposable`). Disposal failures are collected and thrown together as an `AggregateError`.
- `driver.isDisposed`: whether `dispose()` has finished. `getDocumentStore()` throws once the driver is disposed.
- `driver.onDriverDisposed`: optional callback invoked once, after `dispose()` completes (the C# `DriverDisposed` event).
- `TestServerOptions.useFiddler()`: static factory returning options bound to `http://<hostname>:0` with `Security.UnsecuredAccessAllowed=PrivateNetwork`, so the traffic is visible to a proxy such as Fiddler.

For a server secured with `ServerOptions.secured()` / `securedWithExec()`, the driver passes the client certificate to every store it hands out, so test code itself never mentions certificates. See scenario 07 in the [examples](examples).

## Testing this package

```bash
pnpm build
pnpm test
```

`pnpm test:unit` and `pnpm test:integration` run the two suites separately. Integration tests spin up a real embedded server, so they need a RavenDB license (or `RAVEN_LICENSE`/`RAVEN_LICENSE_PATH` unset, which runs unlicensed).

The [examples](examples) are separate projects that consume the built package via `file:../..`, so they are not covered by `pnpm test`. Run `pnpm build` first, then `npm install && npm test` inside the folder you want to check.
