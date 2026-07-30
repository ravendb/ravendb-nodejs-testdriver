/** @type {import("jest").Config} */
module.exports = {
    preset: "ts-jest",
    testEnvironment: "node",
    testMatch: ["<rootDir>/test/**/*.test.ts"],

    // Starting the embedded server — and on the very first run, downloading the
    // RavenDB binaries — takes far longer than Jest's 5s default.
    testTimeout: 300_000,

    // `--runInBand` (see the npm test script) keeps every test file in one
    // process. Note that Jest still gives each file its own module registry, so
    // each file starts its own embedded server regardless — and each file must
    // stop it in its own afterAll. See test/stopServerAfterAll.ts.
    //
    // A `globalTeardown` cannot do that job: it runs in a separate module
    // registry, where it would see no server and stop nothing.
};
