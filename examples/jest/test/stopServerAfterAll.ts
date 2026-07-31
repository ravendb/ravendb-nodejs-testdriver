import { afterAll } from "@jest/globals";
import { RavenTestDriver } from "ravendb-testdriver";

/**
 * Required for Jest, and it must be called from every test file.
 *
 * The embedded server deliberately outlives `driver.dispose()` so it can be
 * reused, and it is normally reclaimed when the process exits. Jest runs tests
 * in-process, so the live Raven.Server child-process handle keeps the event loop
 * alive and Jest reports:
 *
 *     Jest did not exit one second after the test run has completed.
 *
 * ...after an otherwise green run, then hangs (in CI, until the job times out).
 *
 * Why per-file, and not `globalTeardown`: Jest gives each test file its own
 * module registry, so the driver's module-level server singleton is per-file
 * too — and `globalTeardown` runs in yet another registry, where it would see no
 * server at all and stop nothing. The registry that started a server is the only
 * one that can stop it, so the call belongs in that file's own `afterAll`.
 *
 * The same isolation means each Jest test file starts its own embedded server
 * (roughly a few seconds each), even under `--runInBand`. That is inherent to
 * Jest, not something the driver can work around. If you want a single server for
 * the whole run, use vitest with `pool: "forks"` and `fileParallelism: false`,
 * or Mocha without `--parallel` — see ../../vitest and ../../mocha.
 */
export function stopServerAfterAll(): void {
    afterAll(async () => {
        await RavenTestDriver.stopServer();
    });
}
