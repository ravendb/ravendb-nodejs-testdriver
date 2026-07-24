import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TestServerOptions } from "../src/TestServerOptions";

/** Server options for integration tests: temp dirs, EULA accepted, license from env when present. */
export function createTestServerOptions(): TestServerOptions {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravendb-testdriver-it-"));
    const options = new TestServerOptions();
    options.dataDirectory = path.join(tempDir, "data");
    options.logsPath = path.join(tempDir, "logs");
    options.licensing.eulaAccepted = true;

    const license = process.env["RAVEN_LICENSE"];
    const licensePath = process.env["RAVEN_LICENSE_PATH"];
    if (license?.trim()) {
        options.licensing.license = license;
    } else if (licensePath?.trim()) {
        options.licensing.licensePath = licensePath;
    } else {
        options.licensing.throwOnInvalidOrMissingLicense = false;
    }
    return options;
}
