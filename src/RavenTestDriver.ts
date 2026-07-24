import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    CreateDatabaseOperation,
    DeleteDatabasesOperation,
    DocumentStore,
} from "ravendb";
import type { DatabaseRecord, IDocumentStore } from "ravendb";
import { EmbeddedServer, ServerOptions } from "ravendb-embedded";
import { TestServerOptions } from "./TestServerOptions";
import type { GetDocumentStoreOptions } from "./GetDocumentStoreOptions";

// ---- module-level state: the Node analogue of the C# statics ----------------

let globalServer: EmbeddedServer | null = null;
let globalStorePromise: Promise<IDocumentStore> | null = null;
let globalServerOptions: TestServerOptions | null = null;
let databaseIndex = 0;
let emptySettingsFilePath: string | null = null;

function getEmptySettingsFile(): string {
    if (!emptySettingsFilePath) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ravendb-testdriver-"));
        emptySettingsFilePath = path.join(dir, "settings.json");
        fs.writeFileSync(emptySettingsFilePath, "{}");
    }
    return emptySettingsFilePath;
}

async function startServerAndCreateStore(server: EmbeddedServer, options: ServerOptions): Promise<IDocumentStore> {
    // same as C#: force an empty settings file and in-memory storage
    options.commandLineArgs.unshift("-c", getEmptySettingsFile());
    options.commandLineArgs.push("--RunInMemory=true");

    await server.startServer(options);
    const url = await server.getServerUri();

    const store = new DocumentStore(url, "");
    store.conventions.disableTopologyUpdates = true;
    store.initialize();
    return store;
}

function getGlobalStore(): Promise<IDocumentStore> {
    if (!globalStorePromise) {
        globalServer = new EmbeddedServer();
        globalStorePromise = startServerAndCreateStore(globalServer, globalServerOptions ?? new TestServerOptions());
    }
    return globalStorePromise;
}

/**
 * Test-only escape hatch: stops the per-process global server so test runners
 * exit cleanly. Not part of the public API (C# relies on process exit).
 */
export async function _disposeGlobalServer(): Promise<void> {
    if (globalStorePromise) {
        try {
            (await globalStorePromise).dispose();
        } catch {
            // ignore
        }
        globalStorePromise = null;
    }
    if (globalServer) {
        await globalServer.dispose();
        globalServer = null;
    }
    globalServerOptions = null;
}

// ---- driver -----------------------------------------------------------------

export interface RavenTestDriverOptions {
    /** Called before store.initialize() on every store handed out. */
    preInitialize?: (store: IDocumentStore) => void | Promise<void>;
    /** Called on the DatabaseRecord before the database is created. */
    preConfigureDatabase?: (databaseRecord: DatabaseRecord) => void | Promise<void>;
    /** Called after the store is initialized (seed data here). */
    setupDatabase?: (store: IDocumentStore) => void | Promise<void>;
    /** .ravendbdump file imported into every new database. */
    databaseDumpFilePath?: string;
    /** Readable stream with a .ravendbdump — buffered to a temp file on import. */
    databaseDumpFileStream?: NodeJS.ReadableStream;
}

export class RavenTestDriver implements AsyncDisposable {
    private readonly _options: RavenTestDriverOptions;
    private readonly _documentStores = new Set<IDocumentStore>();
    private readonly _pendingDeletes = new Set<Promise<void>>();
    private _disposed = false;

    /** Invoked once, after dispose() finishes. (C# DriverDisposed event.) */
    public onDriverDisposed?: () => void;

    public constructor(options: RavenTestDriverOptions = {}) {
        this._options = options;
    }

    public get isDisposed(): boolean {
        return this._disposed;
    }

    public static configureServer(options: TestServerOptions): void {
        if (globalStorePromise) {
            throw new Error(
                "Cannot configure server after it was started. " +
                "Please call 'configureServer' method before any 'getDocumentStore' is called.");
        }
        globalServerOptions = options;
    }

    public async getDocumentStore(options?: GetDocumentStoreOptions, database = "test"): Promise<IDocumentStore> {
        const name = `${database}_${++databaseIndex}`;
        const parentStore = await getGlobalStore();

        const databaseRecord: DatabaseRecord = { databaseName: name };

        await parentStore.maintenance.server.send(new CreateDatabaseOperation(databaseRecord));

        const store = new DocumentStore(parentStore.urls, name);
        store.conventions.disableTopologyUpdates = true;

        store.initialize();

        store.once("afterDispose", (callback: () => void) => {
            if (!this._documentStores.delete(store)) {
                callback();
                return;
            }
            const deletion = parentStore.maintenance.server
                .send(new DeleteDatabasesOperation({ databaseNames: [name], hardDelete: true }))
                .then(() => undefined)
                .catch((err: Error) => {
                    if (err.name === "DatabaseDoesNotExistException" || err.name === "NoLeaderException") {
                        return;
                    }
                    // eslint-disable-next-line no-console
                    console.error(`Failed to delete database '${name}':`, err);
                });
            this._pendingDeletes.add(deletion);
            void deletion.finally(() => {
                this._pendingDeletes.delete(deletion);
                callback();
            });
        });

        this._documentStores.add(store);

        return store;
    }

    public async dispose(): Promise<void> {
        if (this._disposed) {
            return;
        }

        const errors: unknown[] = [];

        for (const store of [...this._documentStores]) {
            try {
                store.dispose();
            } catch (e) {
                errors.push(e);
            }
        }

        // afterDispose handlers queue database deletions — let them finish
        await Promise.allSettled([...this._pendingDeletes]);

        this._disposed = true;
        this.onDriverDisposed?.();

        if (errors.length > 0) {
            throw new AggregateError(errors, "Failed to dispose test driver");
        }
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        await this.dispose();
    }
}
