import * as os from "node:os";
import { ServerOptions } from "ravendb-embedded";
import type { ServerOptionsInit } from "ravendb-embedded";

export class TestServerOptions extends ServerOptions {
    public constructor(init?: ServerOptionsInit) {
        super(init);
        // C# TestServerOptions ctor sets Licensing.ThrowOnInvalidOrMissingLicense = true;
        // an explicit init value still wins.
        if (init?.licensing?.throwOnInvalidOrMissingLicense === undefined) {
            this.licensing.throwOnInvalidOrMissingLicense = true;
        }
    }

    public static useFiddler(): TestServerOptions {
        const options = new TestServerOptions();
        options.serverUrl = `http://${os.hostname()}:0`;
        options.commandLineArgs.push("--Security.UnsecuredAccessAllowed=PrivateNetwork");
        return options;
    }
}
