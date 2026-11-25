import { test, expect } from "@playwright/test";

import {
    EMPTY_GRN_QUERY,
    accepted,
    canReceiveAgainst,
    checkEditAgainstReceipts,
    goodsReceiptsCsv,
    hasAnyReceipts,
    hasGrnErrors,
    hasPostedReceipts,
    linesFromOrder,
    mergeGoodsReceipts,
    overReceipts,
    planGrnSync,
    priceChanges,
    queryGoodsReceipts,
    receivedByLine,
    receivedByOrder,
    remainingByLine,
    sanitizeGoodsReceipt,
    totalsOf,
    validateGoodsReceipt,
    voidShortages,
    type GoodsReceipt,
    type GrnDraft,
    type GrnLine,
} from "../lib/goodsReceipts";
import { sanitizeProduct, stockLevels, type Product, type StockMovement } from "../lib/products";
import { displayStatus, sanitizePurchaseOrder, summarisePurchaseOrders, type PurchaseOrder } from "../lib/purchaseOrders";

/** Goods receipts: quantities, validation, stock-in and reversal. Pure logic, no browser. */

const product = (id: string, over: Record<string, unknown> = {}): Product =>
    sanitizeProduct({ id, name: id.toUpperCase(), type: "product", trackStock: true, purchasePrice: 50, sellingPrice: 80, ...over })!;

const WIDGET = product("widget");
const GADGET = product("gadget");
const SERVICE = product("consulting", { type: "service" });
const PRODUCTS = [WIDGET, GADGET, SERVICE];

const po = (over: Partial<PurchaseOrder> = {}): PurchaseOrder =>
    sanitizePurchaseOrder({
        id: "po1",
        number: "PO-0001",
        supplierId: "s1",
        supplier: { name: "Acme" },
        date: "2026-03-01",
        expectedDate: "2099-01-01",
        currency: "INR",
        lines: [
            { id: "l1", productId: "widget", name: "Widget", unit: "pcs", quantity: 10, unitPrice: 50, taxRate: 18 },
            { id: "l2", productId: "gadget", name: "Gadget", unit: "pcs", quantity: 4, unitPrice: 90, taxRate: 18 },
        ],
        status: "sent",
        ...over,
    })!;

const line = (id: string, over: Partial<GrnLine> = {}): GrnLine => ({ id, name: "Widget", unit: "pcs", received: 10, rejected: 0, unitPrice: 50, productId: "widget", poLineId: "l1", ...over });

let seq = 0;
const grn = (over: Record<string, unknown> = {}): GoodsReceipt => {
    seq += 1;
    return sanitizeGoodsReceipt({
        id: `g${seq}`,
        number: `GRN-${String(seq).padStart(4, "0")}`,
        supplierId: "s1",
        supplierName: "Acme",
        poId: "po1",
        poNumber: "PO-0001",
        date: "2026-03-05",
        currency: "INR",
        lines: [line("a")],
        status: "posted",
        ...over,
    })!;
};

const ids = () => {
    let n = 0;
    return () => `m${++n}`;
};

/** Applies a plan to a ledger, as the store would, and returns the new ledger. */
const apply = (ledger: StockMovement[], plan: StockMovement[]) => [...ledger, ...plan];
const stock = (ledger: StockMovement[], id: string) => stockLevels(ledger).get(id) ?? 0;
const OPENING: StockMovement[] = [
    { id: "o1", productId: "widget", date: "2026-01-01T00:00:00.000Z", qty: 5, kind: "opening" },
    { id: "o2", productId: "gadget", date: "2026-01-01T00:00:00.000Z", qty: 0.001, kind: "opening" },
];

test.describe("quantities", () => {
    test("accepted is received less rejected, never negative", () => {
        expect(accepted({ received: 10, rejected: 3 })).toBe(7);
        expect(accepted({ received: 10, rejected: 10 })).toBe(0);
        expect(accepted({ received: 0.3, rejected: 0.1 })).toBe(0.2);
    });

    test("sanitising bounds rejected by received and drops what cannot be a receipt", () => {
        const g = grn({ lines: [line("a", { received: 5, rejected: 99 })] });
        expect(g.lines[0].rejected).toBe(5);
        expect(sanitizeGoodsReceipt({ id: "x", number: "G", supplierId: "s", date: "2026-03-05", status: "posted", lines: [] })).toBeNull();
        expect(sanitizeGoodsReceipt({ id: "x", number: "G", supplierId: "s", date: "2026-02-31", status: "posted", lines: [line("a")] })).toBeNull();
        expect(sanitizeGoodsReceipt({ id: "x", number: "G", supplierId: "s", date: "2026-03-05", status: "weird", lines: [line("a")] })).toBeNull();
    });

    test("void details are kept only on a void receipt", () => {
        const v = grn({ status: "void", voidedAt: "2026-03-06T00:00:00.000Z", voidReason: "wrong delivery" });
        expect(v).toMatchObject({ voidedAt: "2026-03-06T00:00:00.000Z", voidReason: "wrong delivery" });
        const p = grn({ status: "posted", voidReason: "ignored" });
        expect(p.voidReason).toBeUndefined();
    });

    test("is idempotent", () => {
        const once = grn();
        expect(sanitizeGoodsReceipt(once)).toEqual(once);
    });
});

test.describe("what has been received against an order", () => {
    const a = grn({ lines: [line("a", { received: 6, rejected: 1 })] }); // accepted 5
    const b = grn({ lines: [line("b", { received: 3 })] }); // accepted 3
    const voided = grn({ status: "void", lines: [line("c", { received: 100 })] });
    const other = grn({ poId: "po2", lines: [line("d", { received: 100 })] });
    const direct = grn({ poId: undefined, poNumber: undefined, lines: [line("e", { poLineId: undefined })] });
    const all = [a, b, voided, other, direct];

    test("sums accepted quantity per order line across posted receipts only", () => {
        expect(receivedByLine(all, "po1").get("l1")).toBe(8);
        expect(receivedByLine(all, "po1").has("l2")).toBe(false);
    });

    test("rejected goods, void receipts, other orders and direct receipts do not count", () => {
        expect(receivedByLine([voided, other, direct], "po1").size).toBe(0);
    });

    test("every order's map at once agrees", () => {
        const m = receivedByOrder(all);
        expect(m.get("po1")?.get("l1")).toBe(8);
        expect(m.get("po2")?.get("l1")).toBe(100);
        expect(m.has("none")).toBe(false);
    });

    test("posted receipts decide whether an order has received goods; any receipt stops its deletion", () => {
        expect(hasPostedReceipts([voided], "po1")).toBe(false);
        expect(hasAnyReceipts([voided], "po1")).toBe(true);
        expect(hasPostedReceipts([a], "po1")).toBe(true);
        expect(hasAnyReceipts([a], "other")).toBe(false);
    });

    test("remaining is what is still to come, never below zero", () => {
        const r = remainingByLine(po(), new Map([["l1", 8], ["l2", 9]]));
        expect(r.get("l1")).toBe(2);
        expect(r.get("l2")).toBe(0);
    });

    test("only a sent order can take goods", () => {
        expect(canReceiveAgainst({ status: "sent" })).toBe(true);
        for (const status of ["draft", "closed", "cancelled"] as const) expect(canReceiveAgainst({ status })).toBe(false);
    });
});

test.describe("validation", () => {
    const suppliers = [{ id: "s1" }];
    const orders = [po()];
    const draft = (over: Partial<GrnDraft> = {}): GrnDraft => ({ number: "", supplierId: "s1", poId: "po1", date: "2026-03-05", reference: "", note: "", currency: "INR", lines: [line("a")], ...over });
    const check = (d: GrnDraft, receipts: GoodsReceipt[] = [], os = orders) => validateGoodsReceipt(d, { suppliers, orders: os, receipts });

    test("a good receipt has no errors", () => expect(hasGrnErrors(check(draft()))).toBe(false));

    test("needs a known supplier and a real date", () => {
        expect(check(draft({ supplierId: "nobody" })).supplier).toBe("supplierRequired");
        expect(check(draft({ date: "2026-13-40" })).date).toBe("dateInvalid");
    });

    test("an order must exist, be open for goods, and be the same supplier's", () => {
        expect(check(draft({ poId: "ghost" })).order).toBe("orderNotFound");
        expect(check(draft(), [], [po({ status: "draft" })]).order).toBe("orderNotOpen");
        expect(check(draft(), [], [po({ status: "closed" })]).order).toBe("orderNotOpen");
        expect(check(draft(), [], [po({ status: "cancelled" })]).order).toBe("orderNotOpen");
        expect(check(draft(), [], [po({ supplierId: "s2" })]).order).toBe("orderSupplierMismatch");
        expect(check(draft({ poId: undefined })).order).toBeUndefined();
    });

    test("something must actually have arrived", () => {
        expect(check(draft({ lines: [] })).lines).toBe("linesRequired");
        expect(check(draft({ lines: [line("a", { received: 0 })] })).lines).toBe("nothingReceived");
    });

    test("rejected cannot exceed received; names and quantities are checked", () => {
        const e = check(draft({ lines: [line("a", { received: 5, rejected: 6 }), line("b", { name: "", received: -1 })] }));
        expect(e.lineErrors.a?.rejected).toBe("rejectedTooMany");
        expect(e.lineErrors.b).toMatchObject({ name: "nameRequired", received: "quantityInvalid" });
    });

    test("a number already used is refused", () => {
        const existing = grn({ number: "GRN-0042" });
        expect(check(draft({ number: "grn-0042" }), [existing]).number).toBe("numberTaken");
    });
});

test.describe("over-receipt", () => {
    const order = po();
    test("no warning when receiving exactly what is left", () => {
        expect(overReceipts(order, [line("a", { received: 10 })], new Map())).toEqual([]);
    });

    test("flags the amount over, counting what was already received", () => {
        const over = overReceipts(order, [line("a", { received: 5 })], new Map([["l1", 8]]));
        expect(over).toEqual([{ poLineId: "l1", name: "Widget", ordered: 10, alreadyReceived: 8, nowAccepted: 5, over: 3 }]);
    });

    test("rejected goods do not count toward being over", () => {
        expect(overReceipts(order, [line("a", { received: 12, rejected: 2 })], new Map())).toEqual([]);
    });

    test("lines that are not on the order are never 'over'", () => {
        expect(overReceipts(order, [line("a", { poLineId: undefined, received: 999 })], new Map())).toEqual([]);
    });

    test("two lines for the same order line add up", () => {
        const over = overReceipts(order, [line("a", { received: 6 }), line("b", { received: 6 })], new Map());
        expect(over[0].over).toBe(2);
    });
});

test.describe("receipt lines from an order", () => {
    test("pre-fills what is still to come and leaves out finished lines", () => {
        const lines = linesFromOrder(po(), new Map([["l1", 10], ["l2", 1]]), ids());
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({ poLineId: "l2", productId: "gadget", received: 3, rejected: 0, unitPrice: 90 });
    });
});

test.describe("editing an order that has receipts", () => {
    const got = new Map([["l1", 6]]);
    test("a line cannot be removed or cut below what has arrived", () => {
        expect(checkEditAgainstReceipts([{ id: "l1", quantity: 5 }], got).lineErrors).toEqual({ l1: "belowReceived" });
        expect(checkEditAgainstReceipts([{ id: "l2", quantity: 5 }], got).removed).toEqual(["l1"]);
    });
    test("raising it, or touching other lines, is fine", () => {
        const r = checkEditAgainstReceipts([{ id: "l1", quantity: 6 }, { id: "l2", quantity: 1 }], got);
        expect(r.lineErrors).toEqual({});
        expect(r.removed).toEqual([]);
    });
});

test.describe("stock-in", () => {
    test("posting records one purchase movement per tracked product, for the accepted quantity", () => {
        const g = grn({ lines: [line("a", { received: 10, rejected: 2 }), line("b", { productId: "gadget", poLineId: "l2", received: 4 })] });
        const plan = planGrnSync(PRODUCTS, OPENING, [g], { newId: ids() });
        expect(plan).toHaveLength(2);
        const w = plan.find((m) => m.productId === "widget")!;
        expect(w).toMatchObject({ qty: 8, kind: "purchase", grnId: g.id });
        expect(w.note).toContain(g.number);
        expect(stock(apply(OPENING, plan), "widget")).toBe(13);
        expect(stock(apply(OPENING, plan), "gadget")).toBe(4.001);
    });

    test("is idempotent: running it again records nothing", () => {
        const g = grn();
        const once = apply(OPENING, planGrnSync(PRODUCTS, OPENING, [g]));
        expect(planGrnSync(PRODUCTS, once, [g])).toEqual([]);
        expect(planGrnSync(PRODUCTS, apply(once, planGrnSync(PRODUCTS, once, [g])), [g])).toEqual([]);
    });

    test("a service, an untracked or an unknown product never moves stock", () => {
        const g = grn({ lines: [line("a", { productId: "consulting" }), line("b", { productId: "ghost" }), line("c", { productId: undefined })] });
        expect(planGrnSync(PRODUCTS, OPENING, [g])).toEqual([]);
    });

    test("two lines for the same product in one receipt become one movement", () => {
        const g = grn({ lines: [line("a", { received: 3 }), line("b", { received: 4 })] });
        const plan = planGrnSync(PRODUCTS, OPENING, [g]);
        expect(plan).toHaveLength(1);
        expect(plan[0].qty).toBe(7);
    });

    test("separate receipts each record their own stock-in", () => {
        const a = grn({ lines: [line("a", { received: 4 })] });
        const b = grn({ lines: [line("b", { received: 3 })] });
        const plan = planGrnSync(PRODUCTS, OPENING, [a, b]);
        expect(plan.map((m) => m.qty).sort()).toEqual([3, 4]);
        expect(stock(apply(OPENING, plan), "widget")).toBe(12);
    });

    test("an interrupted stock-in is finished once, not repeated", () => {
        const g = grn({ lines: [line("a", { received: 4 }), line("b", { productId: "gadget", poLineId: "l2", received: 2 })] });
        const full = planGrnSync(PRODUCTS, OPENING, [g]);
        // Only the first movement made it to storage before the browser closed.
        const partial = apply(OPENING, [full[0]]);
        const rest = planGrnSync(PRODUCTS, partial, [g]);
        expect(rest).toHaveLength(1);
        expect(rest[0].productId).toBe(full[1].productId);
        expect(planGrnSync(PRODUCTS, apply(partial, rest), [g])).toEqual([]);
    });

    test("a fully rejected line brings nothing in", () => {
        const g = grn({ lines: [line("a", { received: 5, rejected: 5 })] });
        expect(planGrnSync(PRODUCTS, OPENING, [g])).toEqual([]);
    });
});

test.describe("void and reversal", () => {
    test("voiding records the exact reversal and returns stock to where it was", () => {
        const g = grn({ lines: [line("a", { received: 10, rejected: 3 })] });
        const posted = apply(OPENING, planGrnSync(PRODUCTS, OPENING, [g]));
        expect(stock(posted, "widget")).toBe(12);

        const voided = { ...g, status: "void" as const };
        const reversal = planGrnSync(PRODUCTS, posted, [voided]);
        expect(reversal).toHaveLength(1);
        expect(reversal[0]).toMatchObject({ qty: -7, kind: "adjustment", grnId: g.id });
        expect(reversal[0].note).toContain("Reversal");
        const after = apply(posted, reversal);
        expect(stock(after, "widget")).toBe(5);
        // …and doing it again changes nothing.
        expect(planGrnSync(PRODUCTS, after, [voided])).toEqual([]);
    });

    test("voiding a receipt that never reached the ledger records nothing", () => {
        expect(planGrnSync(PRODUCTS, OPENING, [grn({ status: "void" })])).toEqual([]);
    });

    test("an unrelated receipt is untouched by another's void", () => {
        const a = grn({ lines: [line("a", { received: 4 })] });
        const b = grn({ lines: [line("b", { received: 3 })] });
        const ledger = apply(OPENING, planGrnSync(PRODUCTS, OPENING, [a, b]));
        const plan = planGrnSync(PRODUCTS, ledger, [{ ...a, status: "void" }, b]);
        expect(plan.map((m) => [m.grnId, m.qty])).toEqual([[a.id, -4]]);
    });

    test("a receipt that no longer exists is left alone, never read as 'reverse it'", () => {
        const g = grn({ lines: [line("a", { received: 4 })] });
        const ledger = apply(OPENING, planGrnSync(PRODUCTS, OPENING, [g]));
        expect(planGrnSync(PRODUCTS, ledger, [])).toEqual([]);
        expect(stock(ledger, "widget")).toBe(9);
    });

    test("is refused when the goods have since been used", () => {
        const g = grn({ lines: [line("a", { received: 10 })] });
        const posted = apply(OPENING, planGrnSync(PRODUCTS, OPENING, [g]));
        const sold: StockMovement[] = [...posted, { id: "s1", productId: "widget", date: "2026-03-06T00:00:00.000Z", qty: -9, kind: "sale", invoiceNumber: "INV-1" }];
        const short = voidShortages(g, PRODUCTS, stockLevels(sold));
        expect(short).toEqual([{ productId: "widget", name: "WIDGET", available: 6, needed: 10 }]);
        expect(voidShortages(g, PRODUCTS, stockLevels(posted))).toEqual([]);
    });

    test("untracked products never block a void", () => {
        const g = grn({ lines: [line("a", { productId: "consulting", received: 5 })] });
        expect(voidShortages(g, PRODUCTS, new Map())).toEqual([]);
    });
});

test.describe("purchase price option", () => {
    test("proposes only prices that really differ", () => {
        const changes = priceChanges(PRODUCTS, [line("a", { unitPrice: 55 }), line("b", { productId: "gadget", poLineId: "l2", unitPrice: 50 })]);
        expect(changes).toEqual([{ productId: "widget", name: "WIDGET", from: 50, to: 55 }]);
    });

    test("ignores unpriced, fully rejected, service and unknown lines", () => {
        const none = priceChanges(PRODUCTS, [line("a", { unitPrice: 0 }), line("b", { received: 3, rejected: 3, unitPrice: 99 }), line("c", { productId: "ghost", unitPrice: 99 }), line("d", { productId: undefined, unitPrice: 99 })]);
        expect(none).toEqual([]);
    });

    test("when a product is on two lines the last price wins, once", () => {
        const changes = priceChanges(PRODUCTS, [line("a", { unitPrice: 55 }), line("b", { unitPrice: 60 })]);
        expect(changes).toEqual([{ productId: "widget", name: "WIDGET", from: 50, to: 60 }]);
    });
});

test.describe("order progress, driven by real receipts", () => {
    const order = po();
    const at = new Date(2026, 5, 1);

    test("a partial then a complete delivery moves the order through its derived states", () => {
        const partial = grn({ lines: [line("a", { received: 4 }), line("x", { productId: "gadget", poLineId: "l2", received: 4 })] });
        expect(displayStatus(order, receivedByLine([partial], "po1"), at)).toBe("partiallyReceived");
        const rest = grn({ lines: [line("b", { received: 6 })] });
        expect(displayStatus(order, receivedByLine([partial, rest], "po1"), at)).toBe("received");
    });

    test("voiding a receipt takes the order back", () => {
        const full = grn({ lines: [line("a", { received: 10 }), line("x", { productId: "gadget", poLineId: "l2", received: 4 })] });
        expect(displayStatus(order, receivedByLine([full], "po1"), at)).toBe("received");
        expect(displayStatus(order, receivedByLine([{ ...full, status: "void" }], "po1"), at)).toBe("sent");
    });

    test("a fully received order is no longer open", () => {
        const full = grn({ lines: [line("a", { received: 10 }), line("x", { productId: "gadget", poLineId: "l2", received: 4 })] });
        expect(summarisePurchaseOrders([order], "27", receivedByLine([full], "po1")).open).toBe(0);
        expect(summarisePurchaseOrders([order], "27", new Map()).open).toBe(1);
    });
});

test.describe("listing, merge and export", () => {
    const a = grn({ number: "GRN-0001", date: "2026-03-01", supplierName: "Acme" });
    const b = grn({ number: "GRN-0002", date: "2026-03-09", supplierName: "Bolts Co", status: "void", reference: "DC-77" });

    test("filters by status, order and text; newest first", () => {
        expect(queryGoodsReceipts([a, b], EMPTY_GRN_QUERY).map((g) => g.number)).toEqual(["GRN-0002", "GRN-0001"]);
        expect(queryGoodsReceipts([a, b], { ...EMPTY_GRN_QUERY, status: "void" }).map((g) => g.number)).toEqual(["GRN-0002"]);
        expect(queryGoodsReceipts([a, b], { ...EMPTY_GRN_QUERY, q: "dc-77" })).toHaveLength(1);
        expect(queryGoodsReceipts([a, b], { ...EMPTY_GRN_QUERY, poId: "nope" })).toHaveLength(0);
    });

    test("totals add up received, rejected and accepted", () => {
        expect(totalsOf(grn({ lines: [line("a", { received: 10, rejected: 2 }), line("b", { received: 5 })] }))).toEqual({ received: 15, rejected: 2, accepted: 13 });
    });

    test("merge keeps held ids, maps a supplier, and renumbers a clashing number", () => {
        const held = grn({ id: "keep", number: "GRN-0001" });
        const r = mergeGoodsReceipts(
            [held],
            [grn({ id: "keep" }), grn({ id: "new1", number: "GRN-0001", supplierId: "old" }), grn({ id: "new2", number: "GRN-0005" })],
            new Map([["old", "s9"]]),
            (taken) => `GRN-${String(taken.length + 100).padStart(4, "0")}`
        );
        expect(r).toMatchObject({ added: 2, skipped: 1, renumbered: 1 });
        expect(r.list.find((g) => g.id === "new1")).toMatchObject({ supplierId: "s9", number: "GRN-0101" });
        expect(new Set(r.list.map((g) => g.number)).size).toBe(r.list.length);
    });

    test("CSV has one row per line", () => {
        const rows = goodsReceiptsCsv([grn({ lines: [line("a"), line("b", { name: "Bolt" })] })]).split("\r\n");
        expect(rows).toHaveLength(3);
        expect(rows[2]).toContain("Bolt");
    });
});
