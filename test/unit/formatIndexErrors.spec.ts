import { describe, it, expect } from "vitest";
import { formatIndexErrors } from "../../src/RavenTestDriver";
import type { IndexErrors } from "ravendb";

describe("formatIndexErrors", () => {
    it("returns empty string for no errors", () => {
        expect(formatIndexErrors([])).toBe("");
        expect(formatIndexErrors(undefined as unknown as IndexErrors[])).toBe("");
    });

    it("formats one error block per index", () => {
        const errors = [
            {
                name: "People/ByName",
                errors: [
                    { error: "boom", timestamp: new Date(), document: "people/1", action: "Map" }
                ]
            }
        ] as IndexErrors[];
        const text = formatIndexErrors(errors);
        expect(text).toContain("Indexing errors:");
        expect(text).toContain("Index 'People/ByName' (1 errors):");
        expect(text).toContain("boom");
    });

    it("joins multiple index blocks with a newline and renders an empty errors array with no lines", () => {
        const errors = [
            {
                name: "People/ByName",
                errors: [
                    { error: "boom", timestamp: new Date(), document: "people/1", action: "Map" }
                ]
            },
            {
                name: "Orders/ByCompany",
                errors: []
            }
        ] as IndexErrors[];
        const text = formatIndexErrors(errors);
        expect(text).toBe(
            "Indexing errors:\n" +
            "Index 'People/ByName' (1 errors):\n" +
            "- boom\n" +
            "Index 'Orders/ByCompany' (0 errors):\n"
        );
    });
});
