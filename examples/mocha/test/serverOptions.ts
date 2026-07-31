import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TestServerOptions } from "ravendb-testdriver";

/**
 * Server options shared by every example file.
 *
 * Each file calls `RavenTestDriver.configureServerOnce(createServerOptions)`.
 * That call is safe to repeat: the first registration wins, later calls are
 * no-ops (even after the server started), and the factory itself runs at most
 * once — when the server actually starts. So the temp directory below is
 * created once per test run, not once per file.
 */
export function createServerOptions(): TestServerOptions {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravendb-example-"));

    const options = new TestServerOptions();
    options.dataDirectory = path.join(tempDir, "data");
    options.logsPath = path.join(tempDir, "logs");

    // Required for the embedded server to auto-download the RavenDB binaries.
    options.licensing.eulaAccepted = true;

    const license = process.env["RAVEN_LICENSE"];
    const licensePath = process.env["RAVEN_LICENSE_PATH"];
    if (license?.trim()) {
        options.licensing.license = license;
    } else if (licensePath?.trim()) {
        options.licensing.licensePath = licensePath;
    } else {
        // TestServerOptions defaults throwOnInvalidOrMissingLicense to true.
        // With no license around, run unlicensed instead of failing at startup.
        options.licensing.throwOnInvalidOrMissingLicense = false;
    }

    return options;
}
