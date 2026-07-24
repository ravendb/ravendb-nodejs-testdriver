import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { pipeline } from "node:stream/promises";
import {
    CreateDatabaseOperation,
    DatabaseSmugglerImportOptions,
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
    /**
     * Readable stream with a .ravendbdump — buffered to a temp file on import.
     * The stream is consumed by the first getDocumentStore() call; reusing the driver
     * for more stores with a stream dump silently imports an empty dump — use
     * databaseDumpFilePath for multi-store drivers.
     */
    databaseDumpFileStream?: NodeJS.ReadableStream;
}

export class RavenTestDriver implements AsyncDisposable {
    private readonly _options: RavenTestDriverOptions;
    private readonly _documentStores = new Set<IDocumentStore>();
    private readonly _storeDisposals = new Map<IDocumentStore, Promise<void>>();
    private _disposed = false;
    private _disposePromise: Promise<void> | null = null;
    private _scopedServer: EmbeddedServer | null = null;
    private _scopedServerOptions: TestServerOptions | null = null;
    private _scopedStorePromise: Promise<IDocumentStore> | null = null;

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

    /** Path to a .ravendbdump imported into every new database. Override or set via constructor options. */
    protected get databaseDumpFilePath(): string | null {
        return this._options.databaseDumpFilePath ?? null;
    }

    /**
     * Stream with a .ravendbdump imported into every new database (buffered to a temp file).
     * The stream is consumed by the first getDocumentStore() call; reusing the driver
     * for more stores with a stream dump silently imports an empty dump — use
     * databaseDumpFilePath for multi-store drivers.
     */
    protected get databaseDumpFileStream(): NodeJS.ReadableStream | null {
        return this._options.databaseDumpFileStream ?? null;
    }

    public static configureServer(options: TestServerOptions): void {
        if (globalStorePromise) {
            throw new Error(
                "Cannot configure server after it was started. " +
                "Please call 'configureServer' method before any 'getDocumentStore' is called.");
        }
        globalServerOptions = options;
    }

    /**
     * @internal Runs this driver against its own embedded server instead of the
     * per-process global one. Returns a disposer that stops that server.
     */
    public configureScopedServer(options: TestServerOptions, server?: EmbeddedServer): () => Promise<void> {
        if (this._scopedServer) {
            throw new Error("Local embedded server is already set.");
        }
        if (this._scopedStorePromise) {
            throw new Error("Cannot set embedded server after document store has been initialized.");
        }

        this._scopedServer = server ?? new EmbeddedServer();
        this._scopedServerOptions = options;

        return async () => {
            try {
                await this._scopedServer?.dispose();
            } catch {
                // swallow exceptions, same as C#
            } finally {
                this._scopedServer = null;
                this._scopedServerOptions = null;
                this._scopedStorePromise = null;
            }
        };
    }

    private _getScopedStore(): Promise<IDocumentStore> {
        if (!this._scopedStorePromise) {
            const options = this._scopedServerOptions ?? globalServerOptions ?? new TestServerOptions();
            this._scopedStorePromise = startServerAndCreateStore(this._scopedServer!, options);
        }
        return this._scopedStorePromise;
    }

    public async getDocumentStore(options?: GetDocumentStoreOptions, database = "test"): Promise<IDocumentStore> {
        if (this._disposed) {
            throw new Error("The test driver has already been disposed.");
        }

        const name = `${database}_${++databaseIndex}`;
        const parentStore = this._scopedServer ? await this._getScopedStore() : await getGlobalStore();

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

            await this._importDatabase(store, name);

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

    private async _importDatabase(store: IDocumentStore, database: string): Promise<void> {
        const dumpPath = this.databaseDumpFilePath;
        const dumpStream = this.databaseDumpFileStream;
        if (!dumpPath && !dumpStream) {
            return;
        }

        // node smuggler import() only accepts a file path — buffer streams to a temp file
        let filePath = dumpPath;
        let tempDir: string | null = null;
        if (!filePath && dumpStream) {
            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravendb-testdriver-dump-"));
            filePath = path.join(tempDir, "dump.ravendbdump");
        }

        try {
            if (tempDir && dumpStream) {
                await pipeline(dumpStream, fs.createWriteStream(filePath!));
            }

            const operation = await store.smuggler.forDatabase(database)
                .import(new DatabaseSmugglerImportOptions(), filePath!);
            await operation.waitForCompletion();
        } finally {
            if (tempDir) {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
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

    /**
     * Opens RavenDB Studio for the store's database and blocks until a document
     * with id "Debug/Done" is created (create it from Studio to resume the test).
     * Unlike C#, this cannot detect an attached debugger — it always waits.
     */
    public async waitForUserToContinueTheTest(store: IDocumentStore): Promise<void> {
        const databaseNameEncoded = encodeURIComponent(store.database);
        const documentsPage = store.urls[0]
            + "/studio/index.html#databases/documents?&database=" + databaseNameEncoded + "&withStop=true";

        this.openBrowser(documentsPage);

        // eslint-disable-next-line no-constant-condition
        while (true) {
            await delay(500);

            const session = store.openSession();
            if (await session.advanced.exists("Debug/Done")) {
                await session.delete("Debug/Done");
                await session.saveChanges();
                break;
            }
        }
    }

    protected openBrowser(url: string): void {
        // eslint-disable-next-line no-console
        console.log(url);

        if (process.platform === "win32") {
            spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
        } else if (process.platform === "darwin") {
            spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
        } else {
            spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
        }
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

        if (this._scopedServer && this._scopedStorePromise) {
            try {
                (await this._scopedStorePromise).dispose();
            } catch (e) {
                errors.push(e);
            }
        }

        if (this._scopedServer) {
            try {
                await this._scopedServer.dispose();
            } catch (e) {
                errors.push(e);
            }
        }

        this._scopedServer = null;
        this._scopedServerOptions = null;
        this._scopedStorePromise = null;

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
