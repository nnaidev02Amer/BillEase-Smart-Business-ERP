import { test, expect } from "@playwright/test";

import { formatDay } from "../lib/dates";
import { sanitizePurchaseBill } from "../lib/purchaseBills";

/**
 * Fix 2: dates a person reads are localised, dates the app stores and sorts are
 * not. Pure logic: no browser, no server.
 */

const SNAP = { name: "Acme Traders", gstin: "", state: "27", address: "", city: "", zipCode: "", country: "", email: "", phone: "" };
const rawBill = (over: Record<string, unknown> = {}) => ({
    id: "b1",
    number: "PB-0001",
    supplierBillNo: "INV/1",
    supplierId: "s1",
    supplier: SNAP,
    billDate: "2026-01-10",
    dueDate: "2026-02-09",
    currency: "INR",
    lines: [{ id: "l1", name: "Widget", description: "", hsn: "8471", unit: "pcs", quantity: 10, unitPrice: 100, taxRate: 18 }],
    discount: { type: "amount", value: 0 },
    freight: 0,
    gstEnabled: true,
    itcEligible: true,
    status: "posted",
    ...over,
});

test.describe("formatDay (display)", () => {
    test("English reads as a short month name, not as the stored yyyy-mm-dd", () => {
        expect(formatDay("2026-01-10", "en")).toBe("Jan 10, 2026");
        expect(formatDay("2026-12-31", "en-US")).toBe("Dec 31, 2026");
    });

    test("other locales get their own order and month words", () => {
        expect(formatDay("2026-01-10", "de")).toMatch(/^10\.\s?Jan\.?\s2026$/);
        expect(formatDay("2026-01-10", "fr")).toMatch(/^10\sjanv\.?\s2026$/);
        // the same day reads differently per locale: it is localised, not hard-wired
        expect(new Set(["en", "de", "fr", "ja"].map((l) => formatDay("2026-01-10", l))).size).toBe(4);
    });

    test("the stored text is never shown to the reader", () => {
        for (const locale of ["en", "de", "fr", "es", "ja", "ar"]) {
            expect(formatDay("2026-01-10", locale)).not.toContain("2026-01-10");
        }
    });

    test("is a calendar day, so it cannot slip a day with the time zone", () => {
        // 1 January and 31 December are where a UTC round-trip would show 31 Dec / 1 Jan
        expect(formatDay("2026-01-01", "en")).toBe("Jan 1, 2026");
        expect(formatDay("2026-12-31", "en")).toBe("Dec 31, 2026");
        expect(formatDay("2028-02-29", "en")).toBe("Feb 29, 2028");
    });

    test("a time on the end of the day is ignored", () => {
        expect(formatDay("2026-01-10T23:59:59.000Z", "en")).toBe("Jan 10, 2026");
    });

    test("text that is not a day is handed back untouched, never 'Invalid Date'", () => {
        expect(formatDay("", "en")).toBe("");
        expect(formatDay("soon", "en")).toBe("soon");
        expect(formatDay("10/01/2026", "en")).toBe("10/01/2026");
        expect(formatDay("2026-1-10", "en")).toBe("2026-1-10");
    });

    test("an unknown locale does not throw", () => {
        expect(() => formatDay("2026-01-10", "xx-NOPE")).not.toThrow();
    });
});

test.describe("ISO storage and sorting are untouched by display", () => {
    test("a bill keeps its dates as yyyy-mm-dd through sanitising, and again when sanitised twice", () => {
        const once = sanitizePurchaseBill(rawBill())!;
        expect(once.billDate).toBe("2026-01-10");
        expect(once.dueDate).toBe("2026-02-09");
        const twice = sanitizePurchaseBill(once)!;
        expect(twice.billDate).toBe("2026-01-10");
        expect(twice.dueDate).toBe("2026-02-09");
    });

    test("formatting a stored day does not change the stored value", () => {
        const bill = sanitizePurchaseBill(rawBill())!;
        const shown = formatDay(bill.billDate, "de");
        expect(shown).not.toBe(bill.billDate);
        expect(bill.billDate).toBe("2026-01-10");
    });

    test("stored days sort by plain string comparison, whatever the display locale", () => {
        const stored = ["2026-03-02", "2025-12-31", "2026-01-10", "2026-01-09"];
        const sorted = [...stored].sort();
        expect(sorted).toEqual(["2025-12-31", "2026-01-09", "2026-01-10", "2026-03-02"]);
        // displayed text does not sort chronologically, which is exactly why it is never what is stored
        const displayed = [...stored].map((d) => formatDay(d, "en")).sort();
        expect(displayed).not.toEqual(sorted.map((d) => formatDay(d, "en")));
    });

    test("an impossible calendar day is refused at the door, not displayed", () => {
        expect(sanitizePurchaseBill(rawBill({ billDate: "2026-02-31" }))).toBeNull();
    });
});
