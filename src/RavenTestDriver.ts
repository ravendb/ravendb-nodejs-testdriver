import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
    CreateDatabaseOperation,
    DeleteDatabasesOperation,
    DocumentStore,
    GetIndexErrorsOperation,
    GetStatisticsOperation,
} from "ravendb";
import type { DatabaseRecord, IDocumentStore, IndexErrors } from "ravendb";
import { EmbeddedServer, ServerOptions } from "ravendb-embedded";
import { TestServerOptions } from "./TestServerOptions";
import type { GetDocumentStoreOptions } from "./GetDocumentStoreOptions";

const SIDE_BY_SIDE_INDEX_NAME_PREFIX = "ReplacementOf/";

/** Builds the C#-style index error report appended to the waitForIndexing timeout message. */
export function formatIndexErrors(errors: IndexErrors[]): string {
    if (!errors || errors.length === 0) {
        return "";
    }
    const blocks = errors.map(indexErrors => {
        const errorsListText = indexErrors.errors.map(x => `- ${x.error}`).join("\n");
        return `Index '${indexErrors.name}' (${indexErrors.errors.length} errors):\n${errorsListText}`;
    });
    return `Indexing errors:\n${blocks.join("\n")}`;
}

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

    // The node client requires a database argument; this store is used only for
    // server-wide maintenance operations (create/delete database), so it is left empty.
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
 * Best-effort database deletion, shared by the normal afterDispose path and the
 * getDocumentStore failure-cleanup path. Swallows "already gone"/"no leader"
 * errors the same way both callers previously did inline.
 */
async function deleteDatabase(parentStore: IDocumentStore, name: string): Promise<void> {
    try {
        await parentStore.maintenance.server.send(new DeleteDatabasesOperation({ databaseNames: [name], hardDelete: true }));
    } catch (err) {
        const error = err as Error;
        if (error.name === "DatabaseDoesNotExistException" || error.name === "NoLeaderException") {
            return;
        }
        // eslint-disable-next-line no-console
        console.error(`Failed to delete database '${name}':`, err);
    }
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
    private readonly _storeDisposals = new Map<IDocumentStore, Promise<void>>();
    private _disposed = false;
    private _disposePromise: Promise<void> | null = null;

    /** Invoked once, after dispose() finishes. (C# DriverDisposed event.) */
    public onDriverDisposed?: () => void;

    public constructor(options: RavenTestDriverOptions = {}) {
        this._options = options;
    }

    public get isDisposed(): boolean {
        return this._disposed;
    }

    /** Called before store.initialize(). Override in a subclass or pass via constructor options. */
    protected async preInitialize(store: IDocumentStore): Promise<void> {
        await this._options.preInitialize?.(store);
    }

    /** Called on the DatabaseRecord before CreateDatabaseOperation. */
    protected async preConfigureDatabase(databaseRecord: DatabaseRecord): Promise<void> {
        await this._options.preConfigureDatabase?.(databaseRecord);
    }

    /** Called after the store is initialized — seed data here. */
    protected async setupDatabase(store: IDocumentStore): Promise<void> {
        await this._options.setupDatabase?.(store);
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

        await this.preConfigureDatabase(databaseRecord);

        await parentStore.maintenance.server.send(new CreateDatabaseOperation(databaseRecord));

        let store: IDocumentStore | undefined;
        try {
            store = new DocumentStore(parentStore.urls, name);
            store.conventions.disableTopologyUpdates = true;

            await this.preInitialize(store);

            store.initialize();

            // Created up front (at registration time) so dispose() can await it —
            // DocumentStore.dispose() is fire-and-forget and "afterDispose" fires
            // at least a couple of microtask hops later, so a promise populated only
            // inside the event handler would still be unset by the time dispose()
            // reaches its await, letting the deletion race server teardown.
            const currentStore = store;
            const disposalDone = new Promise<void>((resolve) => {
                currentStore.once("afterDispose", (callback: () => void) => {
                    const finish = () => {
                        this._storeDisposals.delete(currentStore);
                        resolve();
                        callback();
                    };
                    if (!this._documentStores.delete(currentStore)) {
                        finish();
                        return;
                    }
                    deleteDatabase(parentStore, name).finally(finish);
                });
            });
            this._storeDisposals.set(store, disposalDone);

            await this.setupDatabase(store);

            if (options?.waitForIndexingTimeout !== undefined) {
                await this.waitForIndexing(store, name, options.waitForIndexingTimeout);
            }

            this._documentStores.add(store);

            return store;
        } catch (error) {
            // A hook (preInitialize/setupDatabase) threw after the database was
            // already created server-side. Since the store was never added to
            // _documentStores/returned, nobody can dispose it and the afterDispose
            // deletion never fires — clean up here so the database isn't orphaned.
            if (store) {
                this._documentStores.delete(store);
                this._storeDisposals.delete(store);
                try {
                    store.dispose();
                } catch {
                    // store may not have been initialized yet — ignore
                }
            }
            await deleteDatabase(parentStore, name);
            throw error;
        }
    }

    public async waitForIndexing(store: IDocumentStore, database?: string, timeout = 60_000): Promise<void> {
        const admin = database ? store.maintenance.forDatabase(database) : store.maintenance;

        const start = Date.now();
        while (Date.now() - start < timeout) {
            const stats = await admin.send(new GetStatisticsOperation());
            const indexes = stats.indexes.filter(x => x.state !== "Disabled");

            if (indexes.every(x => !x.isStale && !x.name.startsWith(SIDE_BY_SIDE_INDEX_NAME_PREFIX))) {
                return;
            }

            if (stats.indexes.some(x => x.state === "Error")) {
                break;
            }

            await delay(100);
        }

        let errors: IndexErrors[] = [];
        try {
            errors = await admin.send(new GetIndexErrorsOperation());
        } catch {
            // the timeout error below is more useful than a failing error-fetch
        }
        const allIndexErrorsText = formatIndexErrors(errors);
        throw new Error(`The indexes stayed stale for more than ${timeout} ms. ${allIndexErrorsText}`);
    }

    public async dispose(): Promise<void> {
        if (this._disposePromise) {
            return this._disposePromise;
        }
        this._disposePromise = this._doDispose();
        return this._disposePromise;
    }

    private async _doDispose(): Promise<void> {
        const errors: unknown[] = [];
        const disposals: Promise<void>[] = [];

        for (const store of [...this._documentStores]) {
            const disposalDone = this._storeDisposals.get(store);
            if (disposalDone) {
                disposals.push(disposalDone);
            }
            try {
                store.dispose();
            } catch (e) {
                errors.push(e);
            }
        }

        // afterDispose handlers queue database deletions — genuinely wait for them,
        // since these promises were created at registration time (not inside the
        // event handler), they are already populated here.
        await Promise.allSettled(disposals);

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
