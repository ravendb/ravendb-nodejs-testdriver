export interface GetDocumentStoreOptions {
    /**
     * Milliseconds. When set, getDocumentStore waits for indexing to settle
     * before returning the store. (C# WaitForIndexingTimeout, TimeSpan.)
     */
    waitForIndexingTimeout?: number;
}
