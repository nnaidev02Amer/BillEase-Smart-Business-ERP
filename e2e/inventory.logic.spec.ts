import { test, expect } from "@playwright/test";

import {
    historyOf,
    lowStockProducts,
    planStockSync,
    queryProducts,
    sanitizeMovement,
    sanitizeProduct,
    stockLevels,
    stockOf,
    stockStatus,
    validateProduct,
    EMPTY_PRODUCT_QUERY,
    type Product,
    type StockMovement,
} from "../lib/products";
import { mergeInventory } from "../lib/inventory";
import { invoice as baseInvoice } from "./fixtures";
import type { InvoiceType } from "../types";

/** Stock ledger and invoice → stock rules: pure logic, no browser. */

const product = (over: Partial<Product> & { id: string; name: string }): Product =>
    sanitizeProduct({ type: "product", trackStock: true, sellingPrice: 100, ...over })!;

const WIDGET = product({ id: "p-widget", name: "Widget", sku: "wid-1", minStock: 5 });
const GADGET = product({ id: "p-gadget", name: "Gadget", sku: "GAD-1" });
const CONSULT = product({ id: "p-consult", name: "Consulting", type: "service", unit: "hr" });
const PRODUCTS = [WIDGET, GADGET, CONSULT];

let seq = 0;
const newId = () => `m-${++seq}`;
const at = new Date("2026-06-15T10:00:00Z");

const opening = (productId: string, qty: number): StockMovement => ({
    id: `open-${productId}`,
    productId,
    date: "2026-06-01T00:00:00Z",
    qty,
    kind: "opening",
});

type Line = { productId?: string; qty: number; name?: string };
const inv = (number: string, status: string, lines: Line[]): InvoiceType => {
    const base = baseInvoice(number, "Acme", "a@acme.test", 100, { status, issued: -2, due: 28 });
    return {
        ...base,
        details: {
            ...base.details,
            items: lines.map((l) => ({
                name: l.name ?? "Item",
                quantity: l.qty,
                unitPrice: 10,
                total: l.qty * 10,
                ...(l.productId ? { productId: l.productId } : {}),
            })),
        },
    } as unknown as InvoiceType;
};

/** Plans and applies, as the app does, returning the new ledger. */
const sync = (ledger: StockMovement[], invoices: InvoiceType[], products = PRODUCTS) => {
    const plan = planStockSync(products, ledger, invoices, { now: at, newId });
    return { plan, ledger: [...ledger, ...plan.movements] };
};

test.describe("product records", () => {
    test("sanitising normalises and clamps", () => {
        const p = sanitizeProduct({ id: "x", name: "  Bolt  ", sku: "ab-1", sellingPrice: "12.345", taxRate: 250, hsn: "84a71", minStock: -3, type: "product" })!;
        expect(p.name).toBe("Bolt");
        expect(p.sku).toBe("AB-1");
        expect(p.sellingPrice).toBe(12.35);
        expect(p.taxRate).toBe(100);
        expect(p.hsn).toBe("8471");
        expect(p.minStock).toBe(0);
        expect(p.trackStock).toBe(true);
    });

    test("services never track stock", () => {
        const s = sanitizeProduct({ id: "s", name: "Design", type: "service", trackStock: true })!;
        expect(s.trackStock).toBe(false);
        expect(s.unit).toBe("hr");
    });

    test("records without an id or a name are dropped", () => {
        expect(sanitizeProduct({ name: "No id" })).toBeNull();
        expect(sanitizeProduct({ id: "x", name: "   " })).toBeNull();
        expect(sanitizeProduct("junk")).toBeNull();
    });

    test("movements need a product, a kind and a non-zero quantity", () => {
        expect(sanitizeMovement({ id: "a", productId: "p", qty: 0, kind: "sale" })).toBeNull();
        expect(sanitizeMovement({ id: "a", productId: "p", qty: 3, kind: "bogus" })).toBeNull();
        expect(sanitizeMovement({ id: "a", productId: "p", qty: 3, kind: "purchase" })).not.toBeNull();
    });
});

test.describe("validation", () => {
    const draft = { name: "Thing", sku: "", sellingPrice: "10", purchasePrice: "5", taxRate: "18", hsn: "", minStock: "0" };
    test("a valid draft has no errors", () => {
        expect(validateProduct(draft, PRODUCTS)).toEqual({});
    });
    test("SKU must be unique, case-insensitively, except for itself", () => {
        expect(validateProduct({ ...draft, sku: "wid-1" }, PRODUCTS).sku).toBe("skuTaken");
        expect(validateProduct({ ...draft, sku: "wid-1" }, PRODUCTS, "p-widget").sku).toBeUndefined();
    });
    test("rejects negative prices, bad rates, bad HSN and short names", () => {
        const e = validateProduct({ ...draft, name: "x", sellingPrice: "-1", taxRate: "150", hsn: "12ab", openingStock: "-2" }, PRODUCTS);
        expect(Object.keys(e).sort()).toEqual(["hsn", "name", "openingStock", "sellingPrice", "taxRate"]);
    });
});

test.describe("stock is derived from the ledger", () => {
    test("sums movements per product", () => {
        const ledger = [opening("p-widget", 10), { id: "1", productId: "p-widget", date: "2026-06-02T00:00:00Z", qty: -3, kind: "sale" as const }];
        expect(stockOf("p-widget", ledger)).toBe(7);
        expect(stockOf("p-gadget", ledger)).toBe(0);
        expect(stockLevels(ledger).get("p-widget")).toBe(7);
    });
    test("decimal quantities do not accumulate float noise", () => {
        const ledger = [0.1, 0.2, 0.3].map((q, i) => ({ id: String(i), productId: "p", date: "2026-01-01", qty: q, kind: "purchase" as const }));
        expect(stockOf("p", ledger)).toBe(0.6);
    });
    test("status thresholds", () => {
        expect(stockStatus(WIDGET, 0)).toBe("out");
        expect(stockStatus(WIDGET, 5)).toBe("low");
        expect(stockStatus(WIDGET, 6)).toBe("ok");
        expect(stockStatus(CONSULT, 0)).toBe("untracked");
    });
    test("history carries a running balance", () => {
        const ledger: StockMovement[] = [
            { id: "1", productId: "p", date: "2026-01-01", qty: 10, kind: "opening" },
            { id: "2", productId: "p", date: "2026-01-02", qty: -4, kind: "sale" },
            { id: "3", productId: "p", date: "2026-01-03", qty: 6, kind: "purchase" },
        ];
        expect(historyOf("p", ledger).map((r) => r.balance)).toEqual([10, 6, 12]);
    });
});

test.describe("invoices → stock", () => {
    const start = [opening("p-widget", 10), opening("p-gadget", 4)];

    test("a draft invoice does not touch stock", () => {
        const { plan } = sync(start, [inv("A", "draft", [{ productId: "p-widget", qty: 3 }])]);
        expect(plan.movements).toEqual([]);
    });

    test("issuing an invoice records exactly one sale", () => {
        const { plan, ledger } = sync(start, [inv("A", "sent", [{ productId: "p-widget", qty: 3 }])]);
        expect(plan.movements).toHaveLength(1);
        expect(plan.movements[0]).toMatchObject({ productId: "p-widget", qty: -3, kind: "sale", invoiceNumber: "A" });
        expect(stockOf("p-widget", ledger)).toBe(7);
    });

    test("syncing again, or many times, never deducts twice", () => {
        const invoices = [inv("A", "sent", [{ productId: "p-widget", qty: 3 }])];
        let { ledger } = sync(start, invoices);
        for (let i = 0; i < 5; i++) {
            const next = sync(ledger, invoices);
            expect(next.plan.movements).toEqual([]);
            ledger = next.ledger;
        }
        expect(stockOf("p-widget", ledger)).toBe(7);
    });

    test("editing the quantity of an issued invoice records only the difference", () => {
        let { ledger } = sync(start, [inv("A", "sent", [{ productId: "p-widget", qty: 3 }])]);
        const up = sync(ledger, [inv("A", "sent", [{ productId: "p-widget", qty: 5 }])]);
        expect(up.plan.movements).toHaveLength(1);
        expect(up.plan.movements[0]).toMatchObject({ qty: -2, kind: "sale" });
        expect(stockOf("p-widget", up.ledger)).toBe(5);

        const down = sync(up.ledger, [inv("A", "sent", [{ productId: "p-widget", qty: 1 }])]);
        expect(down.plan.movements[0]).toMatchObject({ qty: 4, kind: "return" });
        expect(stockOf("p-widget", down.ledger)).toBe(9);
    });

    test("cancelling or reopening an invoice returns the stock", () => {
        const { ledger } = sync(start, [inv("A", "sent", [{ productId: "p-widget", qty: 3 }])]);
        const cancelled = sync(ledger, [inv("A", "cancelled", [{ productId: "p-widget", qty: 3 }])]);
        expect(cancelled.plan.movements[0]).toMatchObject({ qty: 3, kind: "return" });
        expect(stockOf("p-widget", cancelled.ledger)).toBe(10);

        const backToDraft = sync(ledger, [inv("A", "draft", [{ productId: "p-widget", qty: 3 }])]);
        expect(stockOf("p-widget", backToDraft.ledger)).toBe(10);
    });

    test("deleting an issued invoice returns the stock", () => {
        const { ledger } = sync(start, [inv("A", "sent", [{ productId: "p-widget", qty: 3 }])]);
        const gone = sync(ledger, []);
        expect(gone.plan.movements[0]).toMatchObject({ qty: 3, kind: "return", invoiceNumber: "A" });
        expect(stockOf("p-widget", gone.ledger)).toBe(10);
    });

    test("re-issuing after cancelling deducts once more, not twice", () => {
        let { ledger } = sync(start, [inv("A", "sent", [{ productId: "p-widget", qty: 3 }])]);
        ledger = sync(ledger, [inv("A", "cancelled", [{ productId: "p-widget", qty: 3 }])]).ledger;
        ledger = sync(ledger, [inv("A", "sent", [{ productId: "p-widget", qty: 3 }])]).ledger;
        expect(stockOf("p-widget", ledger)).toBe(7);
    });

    test("services, free-text lines and untracked products never affect stock", () => {
        const { plan } = sync(start, [
            inv("A", "sent", [
                { productId: "p-consult", qty: 8, name: "Consulting" },
                { qty: 5, name: "Free text line" },
                { productId: "unknown-id", qty: 2 },
            ]),
        ]);
        expect(plan.movements).toEqual([]);
        expect(plan.shortages).toEqual([]);
    });

    test("the same product on several lines is combined", () => {
        const { plan, ledger } = sync(start, [inv("A", "sent", [{ productId: "p-widget", qty: 2 }, { productId: "p-widget", qty: 3 }])]);
        expect(plan.movements).toHaveLength(1);
        expect(stockOf("p-widget", ledger)).toBe(5);
    });

    test("several invoices each deduct their own quantity", () => {
        const { ledger } = sync(start, [
            inv("A", "sent", [{ productId: "p-widget", qty: 3 }]),
            inv("B", "sent", [{ productId: "p-widget", qty: 2 }, { productId: "p-gadget", qty: 1 }]),
        ]);
        expect(stockOf("p-widget", ledger)).toBe(5);
        expect(stockOf("p-gadget", ledger)).toBe(3);
    });

    test("invalid quantities are ignored", () => {
        const { plan } = sync(start, [inv("A", "sent", [{ productId: "p-widget", qty: 0 }, { productId: "p-widget", qty: -4 }])]);
        expect(plan.movements).toEqual([]);
    });
});

test.describe("preventing invalid deductions", () => {
    const start = [opening("p-widget", 4)];

    test("issuing more than is in stock is reported as a shortage", () => {
        const { plan } = sync(start, [inv("A", "sent", [{ productId: "p-widget", qty: 5 }])]);
        expect(plan.shortages).toEqual([{ productId: "p-widget", name: "Widget", available: 4, needed: 5 }]);
    });

    test("exactly the stock on hand is allowed", () => {
        expect(sync(start, [inv("A", "sent", [{ productId: "p-widget", qty: 4 }])]).plan.shortages).toEqual([]);
    });

    test("an invoice's own earlier deduction does not count against it", () => {
        // 10 on hand, A already took 8. Editing A from 8 to 9 needs only 1 more.
        let { ledger } = sync([opening("p-widget", 10)], [inv("A", "sent", [{ productId: "p-widget", qty: 8 }])]);
        expect(sync(ledger, [inv("A", "sent", [{ productId: "p-widget", qty: 9 }])]).plan.shortages).toEqual([]);
        expect(sync(ledger, [inv("A", "sent", [{ productId: "p-widget", qty: 11 }])]).plan.shortages).toHaveLength(1);
    });

    test("two invoices competing for the last units are caught together", () => {
        const { plan } = sync(start, [inv("A", "sent", [{ productId: "p-widget", qty: 3 }]), inv("B", "sent", [{ productId: "p-widget", qty: 3 }])]);
        expect(plan.shortages).toHaveLength(1);
        expect(plan.shortages[0].needed).toBe(6);
    });

    test("releasing stock is never a shortage, even when the balance is negative", () => {
        const negative = [opening("p-widget", 2), { id: "x", productId: "p-widget", date: "2026-06-02", qty: -5, kind: "sale" as const, invoiceNumber: "A" }];
        const { plan } = sync(negative, [inv("A", "cancelled", [{ productId: "p-widget", qty: 5 }])]);
        expect(plan.shortages).toEqual([]);
        expect(plan.movements[0]).toMatchObject({ kind: "return", qty: 5 });
    });
});

test.describe("alerts and search", () => {
    const ledger = [opening("p-widget", 5), opening("p-gadget", 20)];
    test("low-stock lists only tracked, active products at or below their minimum", () => {
        const low = lowStockProducts(PRODUCTS, ledger);
        expect(low.map((l) => l.product.id)).toEqual(["p-widget"]);
        expect(lowStockProducts([{ ...WIDGET, archived: true }], ledger)).toEqual([]);
    });
    test("search matches name, SKU and category; filters combine", () => {
        const all = [product({ id: "a", name: "Red Bolt", sku: "BLT-R", category: "Hardware" }), product({ id: "b", name: "Blue Nut", sku: "NUT-B", category: "Hardware" }), product({ id: "c", name: "Manual", category: "Books" })];
        const q = (o: Partial<typeof EMPTY_PRODUCT_QUERY>) => queryProducts(all, [], { ...EMPTY_PRODUCT_QUERY, ...o }).map((r) => r.product.id);
        expect(q({ search: "blt" })).toEqual(["a"]);
        expect(q({ category: "Hardware" })).toEqual(["b", "a"]); // sorted by name
        expect(q({ category: "Hardware", search: "nut" })).toEqual(["b"]);
        expect(q({ stock: "out" })).toEqual(["b", "c", "a"]);
    });
    test("archived products are hidden unless asked for", () => {
        const list = [{ ...WIDGET, archived: true }, GADGET];
        expect(queryProducts(list, [], EMPTY_PRODUCT_QUERY)).toHaveLength(1);
        expect(queryProducts(list, [], { ...EMPTY_PRODUCT_QUERY, showArchived: true })).toHaveLength(2);
    });
});

test.describe("backup merge", () => {
    test("importing the same file twice adds nothing the second time", () => {
        const incomingMoves = [opening("p-widget", 10)];
        const first = mergeInventory([], [], [WIDGET], incomingMoves);
        expect(first.addedProducts).toBe(1);
        expect(first.addedMovements).toBe(1);
        const second = mergeInventory(first.products, first.movements, [WIDGET], incomingMoves);
        expect(second.addedProducts).toBe(0);
        expect(second.addedMovements).toBe(0);
        expect(stockOf("p-widget", second.movements)).toBe(10);
    });
    test("a product matched by SKU does not import its history again", () => {
        const local = [WIDGET];
        const localMoves = [opening("p-widget", 10)];
        const theirs = { ...WIDGET, id: "other-id" };
        const r = mergeInventory(local, localMoves, [theirs], [opening("other-id", 99)]);
        expect(r.products).toHaveLength(1);
        expect(r.addedMovements).toBe(0);
        expect(stockOf("p-widget", r.movements)).toBe(10);
    });
    test("movements for products that are not in the file are not guessed at", () => {
        const r = mergeInventory([], [], [], [opening("ghost", 5)]);
        expect(r.movements).toEqual([]);
    });
});
