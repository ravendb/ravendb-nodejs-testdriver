import { RavenTestDriver } from "ravendb-test-driver";

/**
 * Required for Mocha. The embedded server deliberately outlives
 * `driver.dispose()` so test files can share one server, and it is normally
 * reclaimed when the process exits. Mocha runs tests in-process, so the live
 * Raven.Server child-process handle keeps the event loop alive and Mocha hangs
 * after an otherwise green run.
 *
 * This file is picked up as an ordinary spec (note the `00-` prefix: Mocha loads
 * spec files in sorted order, and top-level `after` hooks run last regardless).
 * Because all files share one process, this single hook covers the whole run —
 * unlike Jest, which needs the call in every file.
 *
 * Registering it here rather than through `.mocharc.json`'s `require` avoids a
 * resolution trap: a relative path in `require` is resolved against Mocha's own
 * internals, not the project root, so `./test/rootHooks.ts` fails with
 * ERR_MODULE_NOT_FOUND.
 */
after(async () => {
    await RavenTestDriver.stopServer();
});
