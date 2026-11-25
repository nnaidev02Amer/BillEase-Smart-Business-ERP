import { test, expect } from "@playwright/test";

import { gstOfInvoice, gstinCheckChar } from "../lib/gst";
import { InvoiceSchema } from "../lib/schemas";
import { DEFAULT_SETTINGS, type BusinessProfile } from "../lib/settings";
import { sanitizeSupplier, type Supplier } from "../lib/suppliers";
import {
    EMPTY_PO_QUERY,
    canDelete,
    canEdit,
    canTransition,
    displayStatus,
    hasErrors,
    mergePurchaseOrders,
    poPdfIssues,
    poToDocument,
    poTotals,
    purchaseOrdersCsv,
    queryPurchaseOrders,
    receiptProgress,
    sanitizeLine,
    sanitizePurchaseOrder,
    snapshotOf,
    summarisePurchaseOrders,
    validatePurchaseOrder,
    type PoDraft,
    type PoLine,
    type PurchaseOrder,
} from "../lib/purchaseOrders";

/** Purchase orders: totals, GST, status, validation, merge and the PDF document. No browser. */

const gstin = (state: string, pan: string) => {
    const first14 = `${state}${pan}1Z`;
    return `${first14}${gstinCheckChar(first14)}`;
};
const MH = gstin("27", "AAPFU0939F");
const KA = gstin("29", "BBBPK1234C");

const BUSINESS: BusinessProfile = {
    ...DEFAULT_SETTINGS.business,
    name: "My Shop",
    address: "12 Market Road",
    city: "Mumbai",
    zipCode: "400001",
    country: "India",
    email: "me@shop.test",
    phone: "9999999999",
    gstin: MH,
    state: "27",
};

const sup = (over: Partial<Supplier> = {}): Supplier =>
    sanitizeSupplier({
        id: "s1",
        name: "Acme Traders",
        address: "5 Industrial Area",
        city: "Pune",
        zipCode: "411001",
        country: "India",
        email: "sales@acme.test",
        phone: "8888888888",
        gstin: MH,
        ...over,
    })!;

const line = (over: Partial<PoLine> = {}): PoLine => ({
    id: "l1",
    name: "Widget",
    description: "",
    hsn: "8501",
    unit: "pcs",
    quantity: 10,
    unitPrice: 100,
    taxRate: 18,
    ...over,
});

const po = (over: Partial<PurchaseOrder> = {}): PurchaseOrder =>
    sanitizePurchaseOrder({
        id: "po1",
        number: "PO-0001",
        supplierId: "s1",
        supplier: snapshotOf(sup()),
        date: "2026-03-01",
        expectedDate: "2026-03-15",
        currency: "INR",
        lines: [line()],
        discount: { type: "amount", value: 0 },
        freight: 0,
        gstEnabled: true,
        status: "sent",
        ...over,
    })!;

const draftOf = (p: PurchaseOrder): PoDraft => ({
    number: p.number,
    supplierId: p.supplierId,
    date: p.date,
    expectedDate: p.expectedDate,
    currency: p.currency,
    lines: p.lines,
    discount: p.discount,
    freight: p.freight,
    gstEnabled: p.gstEnabled,
});

test.describe("sanitise", () => {
    test("drops a PO with no valid id, number, supplier, date or status", () => {
        expect(sanitizePurchaseOrder(null)).toBeNull();
        expect(sanitizePurchaseOrder({ id: "a", number: "PO-1", supplierId: "s", date: "2026-02-31", status: "draft" })).toBeNull();
        expect(sanitizePurchaseOrder({ id: "a", number: "PO-1", supplierId: "s", date: "2026-03-01", status: "bogus" })).toBeNull();
    });

    test("drops unusable lines and bounds quantities and rates", () => {
        expect(sanitizeLine({ id: "x" })).toBeNull();
        const l = sanitizeLine({ id: "x", name: "A", quantity: -3, unitPrice: "1,200.456", taxRate: 400, hsn: "85-01" })!;
        expect(l).toMatchObject({ quantity: 0, unitPrice: 1200.46, taxRate: 100, hsn: "8501" });
    });

    test("a percentage discount is capped at 100", () => {
        expect(po({ discount: { type: "percentage", value: 250 } }).discount.value).toBe(100);
    });

    test("is idempotent", () => {
        const once = po();
        expect(sanitizePurchaseOrder(once)).toEqual(once);
    });
});

test.describe("totals and GST", () => {
    test("an intra-state purchase splits tax into CGST and SGST", () => {
        const t = poTotals(po(), "27");
        expect(t).toMatchObject({ supply: "intra", supplyKnown: true, taxableValue: 1000, cgst: 90, sgst: 90, igst: 0, totalTax: 180, total: 1180 });
    });

    test("an inter-state purchase uses IGST", () => {
        const p = po({ supplier: snapshotOf(sup({ gstin: KA })) });
        expect(poTotals(p, "27")).toMatchObject({ supply: "inter", cgst: 0, sgst: 0, igst: 180, total: 1180 });
    });

    test("an unknown state is flagged, not silently guessed", () => {
        const p = po({ supplier: { ...snapshotOf(sup()), gstin: "", state: "" } });
        expect(poTotals(p, "27").supplyKnown).toBe(false);
        expect(poTotals(po(), "").supplyKnown).toBe(false);
    });

    test("discount reduces the taxable value; freight is added after tax and is not taxed", () => {
        const p = po({ discount: { type: "percentage", value: 10 }, freight: 50 });
        expect(poTotals(p, "27")).toMatchObject({ discountAmount: 100, taxableValue: 900, totalTax: 162, shippingAmount: 50, total: 1112 });
    });

    test("with GST off there is no tax at all", () => {
        expect(poTotals(po({ gstEnabled: false }), "27")).toMatchObject({ totalTax: 0, total: 1000 });
    });

    test("different rates on different lines are taxed separately", () => {
        const p = po({ lines: [line({ id: "a", unitPrice: 100, quantity: 1, taxRate: 5 }), line({ id: "b", unitPrice: 200, quantity: 1, taxRate: 18 })] });
        expect(poTotals(p, "27").totalTax).toBe(41);
    });
});

test.describe("validation", () => {
    const suppliers = [{ id: "s1" }];

    test("a good draft has no errors", () => {
        expect(hasErrors(validatePurchaseOrder(draftOf(po()), suppliers, []))).toBe(false);
    });

    test("needs a known supplier, a real date and at least one line", () => {
        const e = validatePurchaseOrder({ ...draftOf(po()), supplierId: "gone", date: "2026-13-01", lines: [] }, suppliers, []);
        expect(e).toMatchObject({ supplier: "supplierRequired", date: "dateInvalid", lines: "linesRequired" });
    });

    test("the expected date cannot be before the order date", () => {
        expect(validatePurchaseOrder({ ...draftOf(po()), expectedDate: "2026-02-01" }, suppliers, []).expectedDate).toBe("expectedBeforeDate");
        expect(validatePurchaseOrder({ ...draftOf(po()), expectedDate: "" }, suppliers, []).expectedDate).toBeUndefined();
    });

    test("each line needs a name, a positive quantity and price, a sane rate and a valid HSN", () => {
        const bad = line({ id: "bad", name: "", quantity: 0, unitPrice: 0, taxRate: 120, hsn: "123" + "9" });
        const e = validatePurchaseOrder({ ...draftOf(po()), lines: [bad, line({ id: "ok" })], }, suppliers, []);
        expect(Object.keys(e.lineErrors)).toEqual(["bad"]);
        expect(e.lineErrors.bad).toMatchObject({ name: "nameRequired", quantity: "quantityInvalid", unitPrice: "priceInvalid", taxRate: "rateInvalid" });
        expect(validatePurchaseOrder({ ...draftOf(po()), lines: [line({ hsn: "99" })] }, suppliers, []).lineErrors.l1?.hsn).toBe("hsnInvalid");
    });

    test("a number already used by another PO is refused, but its own is fine", () => {
        const other = po({ id: "po2", number: "PO-0009" });
        expect(validatePurchaseOrder({ ...draftOf(po()), number: "po-0009" }, suppliers, [other]).number).toBe("numberTaken");
        expect(validatePurchaseOrder({ ...draftOf(other) }, suppliers, [other], "po2").number).toBeUndefined();
    });

    test("discount and freight must be sensible", () => {
        const e = validatePurchaseOrder({ ...draftOf(po()), discount: { type: "percentage", value: 120 }, freight: -1 }, suppliers, []);
        expect(e).toMatchObject({ discount: "discountInvalid", freight: "freightInvalid" });
    });
});

test.describe("status flow", () => {
    test("allowed moves", () => {
        expect(canTransition("draft", "sent")).toBe(true);
        expect(canTransition("sent", "closed")).toBe(true);
        expect(canTransition("closed", "sent")).toBe(true);
        expect(canTransition("cancelled", "draft")).toBe(true);
    });

    test("disallowed moves", () => {
        expect(canTransition("draft", "closed")).toBe(false);
        expect(canTransition("cancelled", "sent")).toBe(false);
        expect(canTransition("sent", "sent")).toBe(false);
    });

    test("once goods were received the PO cannot go back to draft or be cancelled", () => {
        expect(canTransition("sent", "draft", { hasReceipts: true })).toBe(false);
        expect(canTransition("sent", "cancelled", { hasReceipts: true })).toBe(false);
        expect(canTransition("sent", "closed", { hasReceipts: true })).toBe(true);
    });

    test("only drafts and sent orders are editable; only unreferenced drafts and cancelled orders can be deleted", () => {
        expect(canEdit({ status: "draft" })).toBe(true);
        expect(canEdit({ status: "sent" })).toBe(true);
        expect(canEdit({ status: "closed" })).toBe(false);
        expect(canDelete({ status: "draft" })).toBe(true);
        expect(canDelete({ status: "sent" })).toBe(false);
        expect(canDelete({ status: "cancelled" }, { hasReceipts: true })).toBe(false);
    });
});

test.describe("derived display status", () => {
    const NOW = new Date(2026, 2, 10);
    const sent = po();

    test("stored statuses other than sent are shown as they are", () => {
        expect(displayStatus(po({ status: "draft" }), new Map(), NOW)).toBe("draft");
        expect(displayStatus(po({ status: "closed" }), new Map(), NOW)).toBe("closed");
    });

    test("sent shows partial and complete receipt progress", () => {
        expect(displayStatus(sent, new Map(), NOW)).toBe("sent");
        expect(displayStatus(sent, new Map([["l1", 4]]), NOW)).toBe("partiallyReceived");
        expect(displayStatus(sent, new Map([["l1", 10]]), NOW)).toBe("received");
        expect(displayStatus(sent, new Map([["l1", 99]]), NOW)).toBe("received");
    });

    test("overdue only while goods are still outstanding", () => {
        const late = new Date(2026, 2, 16);
        expect(displayStatus(sent, new Map(), late)).toBe("overdue");
        expect(displayStatus(sent, new Map([["l1", 10]]), late)).toBe("received");
        expect(displayStatus(po({ expectedDate: "" }), new Map(), late)).toBe("sent");
        expect(displayStatus(sent, new Map(), new Date(2026, 2, 15))).toBe("sent");
    });

    test("progress never counts more than was ordered", () => {
        expect(receiptProgress(sent, new Map([["l1", 25]]))).toEqual({ ordered: 10, received: 10, fraction: 1 });
    });
});

test.describe("summary, query and CSV", () => {
    const orders = [
        po({ id: "a", number: "PO-0001", status: "sent" }),
        po({ id: "b", number: "PO-0002", status: "sent", currency: "USD" }),
        po({ id: "c", number: "PO-0003", status: "draft" }),
        po({ id: "d", number: "PO-0004", status: "cancelled" }),
        po({ id: "e", number: "PO-0005", status: "sent", date: "2026-03-05" }),
    ];

    test("open value is per currency and counts only sent, unreceived orders", () => {
        const s = summarisePurchaseOrders(orders, "27", new Map([["l1", 10]]), new Date(2026, 2, 10));
        // every sent PO shares line id "l1", so all are fully received here
        expect(s.open).toBe(0);
        const open = summarisePurchaseOrders(orders, "27", new Map(), new Date(2026, 2, 10));
        expect(open).toMatchObject({ open: 3, draft: 1, overdue: 0 });
        expect(open.openValue).toEqual({ INR: 2360, USD: 1180 });
    });

    test("filters by status and supplier text, newest first", () => {
        expect(queryPurchaseOrders(orders, { ...EMPTY_PO_QUERY, status: "draft" }).map((p) => p.id)).toEqual(["c"]);
        expect(queryPurchaseOrders(orders, EMPTY_PO_QUERY).map((p) => p.id)).toEqual(["e", "d", "c", "b", "a"]);
        expect(queryPurchaseOrders(orders, { ...EMPTY_PO_QUERY, q: "widget" })).toHaveLength(5);
        expect(queryPurchaseOrders(orders, { ...EMPTY_PO_QUERY, q: "nothing-like-this" })).toHaveLength(0);
    });

    test("CSV has one row per PO with the tax-inclusive total", () => {
        const rows = purchaseOrdersCsv([orders[0]], "27").split("\r\n");
        expect(rows).toHaveLength(2);
        expect(rows[1]).toContain("PO-0001");
        expect(rows[1].endsWith(',"1180"')).toBe(true);
    });
});

test.describe("merge for backup restore", () => {
    test("keeps existing, remaps a skipped supplier, and renumbers a clashing number", () => {
        const have = [po({ id: "a", number: "PO-0001" })];
        const incoming = [
            po({ id: "a", number: "PO-0001" }),
            po({ id: "b", number: "PO-0001", supplierId: "old" }),
            po({ id: "c", number: "PO-0002" }),
        ];
        const r = mergePurchaseOrders(have, incoming, new Map([["old", "s1"]]), (taken) => `PO-${String(taken.length + 100).padStart(4, "0")}`);
        expect(r).toMatchObject({ added: 2, skipped: 1, renumbered: 1 });
        const b = r.list.find((p) => p.id === "b")!;
        expect(b.supplierId).toBe("s1");
        expect(b.number).toBe("PO-0101");
        expect(new Set(r.list.map((p) => p.number)).size).toBe(r.list.length);
    });
});

test.describe("PDF document", () => {
    test("a complete PO becomes a valid invoice-shaped document", () => {
        expect(poPdfIssues(po(), BUSINESS)).toEqual([]);
        expect(InvoiceSchema.safeParse(poToDocument(po(), BUSINESS)).success).toBe(true);
    });

    test("the sender is the business and the receiver is the supplier", () => {
        const d = poToDocument(po(), BUSINESS);
        expect(d.sender.name).toBe("My Shop");
        expect(d.receiver.name).toBe("Acme Traders");
        expect(d.details.invoiceNumber).toBe("PO-0001");
        expect(d.details.dueDate).toBe("2026-03-15");
    });

    test("its GST, recomputed by the invoice engine, matches the PO's own totals (intra-state)", () => {
        const p = po({ discount: { type: "percentage", value: 10 }, freight: 50 });
        const g = gstOfInvoice(poToDocument(p, BUSINESS))!;
        const t = poTotals(p, "27");
        expect(g.supply).toBe("intra");
        expect(g).toMatchObject({ cgst: t.cgst, sgst: t.sgst, igst: t.igst, totalTax: t.totalTax, total: t.total });
    });

    test("and the same for an inter-state purchase", () => {
        const p = po({ supplier: snapshotOf(sup({ gstin: KA })) });
        const g = gstOfInvoice(poToDocument(p, BUSINESS))!;
        expect(g.supply).toBe("inter");
        expect(g).toMatchObject({ igst: 180, cgst: 0, sgst: 0, total: 1180 });
    });

    test("reports which party is incomplete, by field", () => {
        const issues = poPdfIssues(po(), { ...BUSINESS, address: "", email: "" });
        expect(issues).toEqual(expect.arrayContaining(["sender.address", "sender.email"]));
        const noSupplier = po({ supplier: { ...snapshotOf(sup()), phone: "", city: "" } });
        expect(poPdfIssues(noSupplier, BUSINESS)).toEqual(expect.arrayContaining(["receiver.phone", "receiver.city"]));
    });

    test("GST needs the business GSTIN and a known supplier state", () => {
        expect(poPdfIssues(po(), { ...BUSINESS, gstin: "" })).toContain("sender.gstin");
        expect(poPdfIssues(po({ supplier: { ...snapshotOf(sup()), gstin: "", state: "" } }), BUSINESS)).toContain("gst");
    });

    test("with GST off neither is required", () => {
        const p = po({ gstEnabled: false, supplier: { ...snapshotOf(sup()), gstin: "", state: "" } });
        expect(poPdfIssues(p, { ...BUSINESS, gstin: "", state: "" })).toEqual([]);
    });
});
