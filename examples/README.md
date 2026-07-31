# ravendb-test-driver examples

Three self-contained example projects, one per test runner. Each covers the same
six scenarios with the same test bodies, so the diff between folders is the runner
setup — not the driver usage.

| Runner | Folder | Setup needed | Servers per run | Suite time |
| --- | --- | --- | --- | --- |
| **vitest** | [vitest/](vitest) | `pool: "forks"` + `fileParallelism: false` | 1 | ~43s |
| **mocha** | [mocha/](mocha) | No `--parallel`; one `after` hook calling `stopServer()` | 1 | ~20s |
| **jest** | [jest/](jest) | `--experimental-vm-modules`, `--runInBand`, `stopServer()` **per file** | 1 per file | ~80s |

Start with [vitest/](vitest) if you have no runner preference: it needs the least
setup.

## Run any of them

```bash
cd vitest && npm install && npm test
```

Each folder depends on the driver via `"ravendb-test-driver": "file:../.."`, so
build the package at the repo root first:

```bash
pnpm build
```

The first run downloads the RavenDB server binaries — expect a few minutes. Set
`RAVEN_LICENSE` (inline license JSON) or `RAVEN_LICENSE_PATH` (path to a license
file) to run licensed; with neither set, the server runs unlicensed.

## Scenarios

| # | Shows |
| --- | --- |
| 01 | Minimal setup; store / load / update / delete |
| 02 | A fresh database per store, name prefixes, `await using` |
| 03 | `setupDatabase`, `preInitialize`, `preConfigureDatabase`; subclassing |
| 04 | `waitForIndexing`, `waitForIndexingTimeout`, querying a static index |
| 05 | Seeding from a `.ravendbdump` via file path and stream |
| 06 | `configureServerOnce` vs `configureServer`, lazy start, server reuse |
| 07 | An HTTPS server with certificate authentication (`secured()`) |

Each folder also has a `serverOptions.ts` with the shared `TestServerOptions`
(temp data/logs directories, EULA accepted, license read from the environment),
and a `securedServerOptions.ts` used only by scenario 07.

## The secured example

Scenario 07 runs the embedded server over HTTPS with certificate
authentication. The test bodies are the same as everywhere else — once
`secured()` is configured, the driver builds every store it hands out with the
client certificate, so test code never mentions certificates.

It uses throwaway self-signed certificates committed under [certs/](certs) —
see that folder's README for what they are and why their private key is in the
repository.

Because the driver keeps one embedded server per process and a secured server is
a different server, scenario 07 uses `configureServer` rather than
`configureServerOnce`, and each runner reconciles that differently:

- **vitest** — `fileParallelism: false` already serializes files; the file stops
  the secured server in its own `afterAll`.
- **jest** — nothing special. Each file gets its own module registry and
  therefore its own server, so it cannot collide with the unsecured files.
- **mocha** — all files share one process and one server, so the file stops the
  shared unsecured server in `before` before claiming the slot. It relies on
  sorting last; a file running after it would get the secured server instead.

## The one thing every runner has to get right

The driver keeps its embedded server in a module-level singleton, so there is one
server per *module registry*, started lazily by the first `getDocumentStore()`
call. It deliberately outlives `driver.dispose()` so test files can share it.

Two consequences, and each runner handles them differently:

1. **Sharing one server across files** requires files to share a process *and* a
   module registry. Vitest needs `pool: "forks"` + `fileParallelism: false`; Mocha
   gets it by default (without `--parallel`); Jest cannot — it isolates the
   registry per file, so each file gets its own server even under `--runInBand`.
2. **In-process runners hang after a green run**, because the live Raven.Server
   child-process handle keeps the event loop alive. Both Jest and Mocha need
   `RavenTestDriver.stopServer()`. Mocha needs it once, in a single top-level
   `after`; Jest needs it in *every file's* `afterAll` — a `globalTeardown` runs in
   a different module registry and would stop nothing. Vitest needs neither: the
   fork exits and takes the server with it.

Also worth knowing: `ts-jest` and `ts-node` both cap their TypeScript peer below
7, so the jest and mocha examples pin TypeScript 5.9 while the driver itself
builds on TypeScript 7. Each folder's README says so.

Each folder's README explains its own version of this, plus one Jest-only caveat
(the client's dynamic `import()` versus Jest's VM sandbox).
