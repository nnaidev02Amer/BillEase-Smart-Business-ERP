import { test, expect } from "@playwright/test";

import { gstOfInvoice, gstinCheckChar } from "../lib/gst";
import { duplicateOf } from "../lib/invoiceRecords";
import {
    canConvert,
    canDelete,
    canEdit,
    canTransition,
    conversionsOf,
    displayStatus,
    expiryInfo,
    isNumberTaken,
    quotationStats,
    quotationToInvoice,
    quotationsToCsv,
    queryQuotations,
    sanitizeQuotation,
    suggestQuotationNumber,
    withStatus,
    EMPTY_QUOTATION_QUERY,
    type Quotation,
    type StoredQuotationStatus,
} from "../lib/quotations";
import { incrementInvoiceNumber } from "../lib/invoiceNumber";
import { InvoiceSchema } from "../lib/schemas";
import { invoice as base, party } from "./fixtures";
import type { InvoiceType } from "../types";

const NOW = new Date(2026, 5, 15, 12, 0, 0); // 15 June 2026, noon
const day = (offset: number) => new Date(2026, 5, 15 + offset).toISOString();

const gstin = (state: string) => {
    const first14 = `${state}AAPFU0939F1Z`;
    return first14 + gstinCheckChar(first14);
};

let seq = 0;
const quote = (
    number: string,
    status: StoredQuotationStatus,
    o: { validIn?: number; issued?: number; total?: number; currency?: string; customer?: string; email?: string; gst?: boolean; items?: Record<string, unknown>[] } = {}
): Quotation => {
    const total = o.total ?? 1180;
    const inv = base(number, o.customer ?? "Acme Corp", o.email ?? "buyer@acme.test", total, { issued: 0, due: 0, currency: o.currency });
    const doc = {
        ...inv,
        sender: { ...party("Sender Co", "s@example.com"), gstin: gstin("27") },
        details: {
            ...inv.details,
            invoiceDate: day(o.issued ?? 0),
            dueDate: day(o.validIn ?? 30),
            items: o.items ?? [{ name: "Laptop", quantity: 1, unitPrice: 1000, total: 1000, hsn: "8471", gstRate: 18, productId: "p-1", unit: "pcs" }],
            subTotal: 1000,
            totalAmount: total,
            gst: o.gst === false ? undefined : { enabled: true, pricing: "exclusive", placeOfSupply: "27", taxableValue: 1000, cgst: 90, sgst: 90, igst: 0, totalTax: 180 },
        },
    } as unknown as InvoiceType;
    return { id: `id-${++seq}`, status, doc, createdAt: day(-5), updatedAt: day(-5), events: [{ at: day(-5), kind: "created" }] };
};

test.describe("status", () => {
    test("expired is derived: only a sent quotation past its valid-until day", () => {
        expect(displayStatus(quote("A", "sent", { validIn: -1 }), NOW)).toBe("expired");
        expect(displayStatus(quote("B", "sent", { validIn: 0 }), NOW)).toBe("sent"); // valid through the whole last day
        expect(displayStatus(quote("C", "draft", { validIn: -10 }), NOW)).toBe("draft");
        expect(displayStatus(quote("D", "accepted", { validIn: -10 }), NOW)).toBe("accepted");
        expect(displayStatus(quote("E", "rejected", { validIn: -10 }), NOW)).toBe("rejected");
    });

    test("expiry warnings: soon within 7 days, ok beyond, expired with days since", () => {
        expect(expiryInfo(quote("A", "sent", { validIn: 7 }), NOW)).toEqual({ state: "soon", days: 7 });
        expect(expiryInfo(quote("B", "sent", { validIn: 8 }), NOW)).toEqual({ state: "ok", days: 8 });
        expect(expiryInfo(quote("C", "sent", { validIn: 0 }), NOW)).toEqual({ state: "soon", days: 0 });
        expect(expiryInfo(quote("D", "sent", { validIn: -3 }), NOW)).toEqual({ state: "expired", days: 3 });
        expect(expiryInfo(quote("E", "accepted", { validIn: -3 }), NOW)).toBeNull();
        expect(expiryInfo(quote("F", "rejected", { validIn: 2 }), NOW)).toBeNull();
    });
});

test.describe("transitions", () => {
    const ok = (q: Quotation, to: StoredQuotationStatus, converted = false) => canTransition(q, to, { now: NOW, converted });

    test("draft → sent; draft cannot be accepted or rejected directly", () => {
        expect(ok(quote("A", "draft"), "sent")).toEqual({ ok: true });
        expect(ok(quote("A", "draft"), "accepted")).toEqual({ ok: false, reason: "sendFirst" });
        expect(ok(quote("A", "draft"), "rejected")).toEqual({ ok: false, reason: "sendFirst" });
    });
    test("sent → accepted, rejected or back to draft", () => {
        const q = quote("A", "sent");
        for (const to of ["accepted", "rejected", "draft"] as const) expect(ok(q, to)).toEqual({ ok: true });
    });
    test("an expired quotation cannot be accepted, but can be rejected", () => {
        const q = quote("A", "sent", { validIn: -2 });
        expect(ok(q, "accepted")).toEqual({ ok: false, reason: "expired" });
        expect(ok(q, "rejected")).toEqual({ ok: true });
    });
    test("a quotation already past its validity cannot be sent", () => {
        expect(ok(quote("A", "draft", { validIn: -1 }), "sent")).toEqual({ ok: false, reason: "validityPast" });
        expect(ok(quote("A", "draft", { validIn: 0 }), "sent")).toEqual({ ok: true });
    });
    test("decisions must be reopened before they change", () => {
        expect(ok(quote("A", "accepted"), "rejected")).toEqual({ ok: false, reason: "reopenFirst" });
        expect(ok(quote("A", "rejected"), "accepted")).toEqual({ ok: false, reason: "reopenFirst" });
        expect(ok(quote("A", "accepted"), "draft")).toEqual({ ok: false, reason: "reopenFirst" });
        expect(ok(quote("A", "accepted"), "sent")).toEqual({ ok: true });
        expect(ok(quote("A", "rejected"), "sent")).toEqual({ ok: true });
    });
    test("a converted quotation is frozen", () => {
        const q = quote("A", "accepted");
        for (const to of ["sent", "draft", "rejected"] as const) expect(ok(q, to, true)).toEqual({ ok: false, reason: "converted" });
        expect(ok(q, "accepted", true)).toEqual({ ok: true }); // no change is always fine
    });
    test("same-status is always allowed; withStatus logs the change once", () => {
        const q = quote("A", "sent");
        expect(withStatus(q, "sent", NOW)).toBe(q);
        const accepted = withStatus(q, "accepted", NOW);
        expect(accepted.status).toBe("accepted");
        expect(accepted.events.at(-1)).toMatchObject({ kind: "accepted" });
        expect(q.status).toBe("sent"); // original untouched
    });
});

test.describe("edit / delete / convert guards", () => {
    test("accepted and converted quotations cannot be edited", () => {
        expect(canEdit(quote("A", "draft"), false)).toEqual({ ok: true });
        expect(canEdit(quote("A", "sent"), false)).toEqual({ ok: true });
        expect(canEdit(quote("A", "rejected"), false)).toEqual({ ok: true });
        expect(canEdit(quote("A", "accepted"), false)).toEqual({ ok: false, reason: "accepted" });
        expect(canEdit(quote("A", "draft"), true)).toEqual({ ok: false, reason: "converted" });
    });
    test("a converted quotation cannot be deleted", () => {
        expect(canDelete(quote("A", "sent"), false)).toEqual({ ok: true });
        expect(canDelete(quote("A", "accepted"), true)).toEqual({ ok: false, reason: "converted" });
    });
    test("only an accepted, unconverted quotation can be converted", () => {
        expect(canConvert(quote("A", "accepted"), false)).toEqual({ ok: true });
        expect(canConvert(quote("A", "accepted"), true)).toEqual({ ok: false, reason: "alreadyConverted" });
        for (const s of ["draft", "sent", "rejected"] as const) expect(canConvert(quote("A", s), false)).toEqual({ ok: false, reason: "notAccepted" });
    });
});

test.describe("numbering", () => {
    test("starts at QUO-0001 and continues the latest scheme", () => {
        expect(suggestQuotationNumber([])).toBe("QUO-0001");
        expect(suggestQuotationNumber([quote("QUO-0007", "draft")])).toBe("QUO-0008");
        expect(suggestQuotationNumber([quote("2026/Q-09", "draft")])).toBe("2026/Q-10");
    });
    test("never suggests a number already taken", () => {
        const list = [quote("QUO-0002", "draft"), quote("QUO-0001", "draft")];
        // latest is QUO-0001, so 0002 would clash and is skipped
        expect(suggestQuotationNumber(list)).toBe("QUO-0003");
    });
    test("uniqueness is case-insensitive and can exclude itself", () => {
        const a = quote("QUO-0001", "draft");
        expect(isNumberTaken([a], "quo-0001")).toBe(true);
        expect(isNumberTaken([a], " QUO-0001 ")).toBe(true);
        expect(isNumberTaken([a], "QUO-0001", a.id)).toBe(false);
        expect(isNumberTaken([a], "QUO-0002")).toBe(false);
    });
});

test.describe("sanitising", () => {
    test("rebuilds a sound record and rejects junk", () => {
        const q = quote("A", "sent");
        expect(sanitizeQuotation(q)).toMatchObject({ id: q.id, status: "sent" });
        expect(sanitizeQuotation({ ...q, status: "bogus" })?.status).toBe("draft");
        expect(sanitizeQuotation(null)).toBeNull();
        expect(sanitizeQuotation({ id: "x" })).toBeNull();
        expect(sanitizeQuotation({ ...q, id: "" })).toBeNull();
        expect(sanitizeQuotation({ ...q, doc: { ...q.doc, details: { ...q.doc.details, items: "nope" } } })).toBeNull();
    });
});

test.describe("conversion to an invoice", () => {
    const accepted = quote("QUO-0001", "accepted", { total: 1180 });
    const ctx = { invoiceNumber: "INV-0100", now: NOW, dueDays: 30 };

    test("preserves every line, with its product link, HSN, rate and unit", () => {
        const inv = quotationToInvoice(accepted, ctx);
        expect(inv.details.items).toEqual(accepted.doc.details.items);
        expect(inv.details.items[0]).toMatchObject({ productId: "p-1", hsn: "8471", gstRate: 18, unit: "pcs" });
    });

    test("preserves the GST settings and the totals exactly", () => {
        const inv = quotationToInvoice(accepted, ctx);
        expect(inv.details.gst).toEqual(accepted.doc.details.gst);
        expect(inv.details.totalAmount).toBe(1180);
        expect(inv.details.subTotal).toBe(1000);
        // recomputing the GST from the converted invoice agrees with the quotation
        expect(gstOfInvoice(inv)).toEqual(gstOfInvoice(accepted.doc));
        expect(gstOfInvoice(inv)!.total).toBe(1180);
    });

    test("carries the parties, discount, shipping and notes across", () => {
        const q = quote("QUO-0002", "accepted");
        q.doc.details.discountDetails = { amount: 10, amountType: "percentage" };
        q.doc.details.shippingDetails = { cost: 50, costType: "amount" };
        q.doc.details.additionalNotes = "Delivery in two weeks";
        const inv = quotationToInvoice(q, ctx);
        expect(inv.sender).toEqual(q.doc.sender);
        expect(inv.receiver).toEqual(q.doc.receiver);
        expect(inv.details.discountDetails).toEqual({ amount: 10, amountType: "percentage" });
        expect(inv.details.shippingDetails).toEqual({ cost: 50, costType: "amount" });
        expect(inv.details.additionalNotes).toBe("Delivery in two weeks");
    });

    test("is a draft with a new number, today's dates and a reference back", () => {
        const inv = quotationToInvoice(accepted, ctx);
        expect(inv.details.invoiceNumber).toBe("INV-0100");
        expect(inv.details.status).toBe("draft");
        expect(inv.details.quotationRef).toEqual({ id: accepted.id, number: "QUO-0001" });
        expect(inv.details.invoiceDate).toBe(NOW.toISOString());
        expect(new Date(inv.details.dueDate).getTime()).toBe(new Date(2026, 6, 15).getTime());
    });

    test("carries no payments, revisions or schedule", () => {
        const q = quote("QUO-0003", "accepted");
        Object.assign(q.doc.details, { payments: [{ id: "x", date: "2026-01-01", amount: 5 }], revisions: [{ id: "r" }], recurring: { frequency: "monthly" } });
        const inv = quotationToInvoice(q, ctx);
        expect(inv.details.payments).toBeUndefined();
        expect(inv.details.revisions).toBeUndefined();
        expect(inv.details.recurring).toBeUndefined();
    });

    test("the result is a valid invoice", () => {
        const parsed = InvoiceSchema.safeParse(quotationToInvoice(accepted, ctx));
        expect(parsed.success, JSON.stringify(parsed.success ? "" : parsed.error.issues)).toBe(true);
    });

    test("does not mutate the quotation", () => {
        const before = JSON.stringify(accepted);
        quotationToInvoice(accepted, ctx);
        expect(JSON.stringify(accepted)).toBe(before);
    });

    test("a dead product link is dropped, a live one kept", () => {
        const q = quote("QUO-0004", "accepted", {
            items: [
                { name: "Live", quantity: 1, unitPrice: 10, total: 10, productId: "live", gstRate: 18 },
                { name: "Gone", quantity: 1, unitPrice: 10, total: 10, productId: "gone", gstRate: 18 },
                { name: "Typed", quantity: 1, unitPrice: 10, total: 10 },
            ],
        });
        const inv = quotationToInvoice(q, { ...ctx, knownProductIds: new Set(["live"]) });
        expect(inv.details.items.map((i) => i.productId)).toEqual(["live", undefined, undefined]);
        // price, name and tax survive on the unlinked line
        expect(inv.details.items[1]).toMatchObject({ name: "Gone", unitPrice: 10, gstRate: 18 });
    });

    test("conversions are derived from invoices, and a duplicate invoice is not a second conversion", () => {
        const inv = quotationToInvoice(accepted, ctx);
        expect(conversionsOf([inv]).get(accepted.id)).toBe("INV-0100");
        expect(conversionsOf([]).has(accepted.id)).toBe(false);
        const copy = duplicateOf(inv, ["INV-0100"], incrementInvoiceNumber, NOW);
        expect(copy.details.quotationRef).toBeUndefined();
        expect(conversionsOf([copy]).has(accepted.id)).toBe(false);
    });
});

test.describe("stats", () => {
    const list = [
        quote("D", "draft", { total: 500 }),
        quote("S1", "sent", { validIn: 3, total: 1000 }), // pending, expiring soon
        quote("S2", "sent", { validIn: 20, total: 2000 }), // pending
        quote("X", "sent", { validIn: -2, total: 400 }), // expired
        quote("A", "accepted", { total: 3000 }),
        quote("A2", "accepted", { total: 1000, currency: "EUR" }),
        quote("R", "rejected", { total: 700 }),
    ];
    const converted = new Map([[list[4].id, "INV-1"]]);
    const s = quotationStats(list, { now: NOW, converted });

    test("counts by status", () => {
        expect(s).toMatchObject({ total: 7, draft: 1, pending: 2, accepted: 2, rejected: 1, expired: 1, expiringSoon: 1, converted: 1, issued: 6 });
    });
    test("conversion rate is accepted ÷ issued, drafts excluded", () => {
        expect(s.conversionRate).toBeCloseTo(2 / 6, 10);
        expect(quotationStats([quote("D", "draft")], { now: NOW }).conversionRate).toBeNull();
        expect(quotationStats([], { now: NOW }).conversionRate).toBeNull();
    });
    test("values are per currency and exclude drafts", () => {
        expect(s.value).toEqual({ USD: 1000 + 2000 + 400 + 3000 + 700, EUR: 1000 });
        expect(s.acceptedValue).toEqual({ USD: 3000, EUR: 1000 });
        expect(s.pendingValue).toEqual({ USD: 3000 });
        expect(s.rejectedValue).toEqual({ USD: 700 });
    });
});

test.describe("search, filter, sort", () => {
    const list = [
        quote("QUO-0001", "draft", { customer: "Acme Corp", email: "a@acme.test", total: 100, issued: -10, validIn: 20 }),
        quote("QUO-0002", "sent", { customer: "Globex Ltd", email: "g@globex.test", total: 300, issued: -5, validIn: 3 }),
        quote("QUO-0003", "sent", { customer: "Initech", email: "i@initech.test", total: 200, issued: -3, validIn: -1 }),
        quote("QUO-0010", "accepted", { customer: "Acme Corp", email: "a@acme.test", total: 400, issued: -1, validIn: 30 }),
    ];
    const numbers = (q: Partial<typeof EMPTY_QUOTATION_QUERY>, converted = new Map<string, string>()) =>
        queryQuotations(list, { ...EMPTY_QUOTATION_QUERY, ...q }, { now: NOW, converted }).map(numberOfQ);
    const numberOfQ = (q: Quotation) => q.doc.details.invoiceNumber;

    test("search matches number, customer and email", () => {
        expect(numbers({ search: "globex" })).toEqual(["QUO-0002"]);
        expect(numbers({ search: "quo-0010" })).toEqual(["QUO-0010"]);
        expect(numbers({ search: "acme.test", sort: "number", dir: "asc" })).toEqual(["QUO-0001", "QUO-0010"]);
    });
    test("status filters, including derived expired and expiring", () => {
        expect(numbers({ filter: "expired" })).toEqual(["QUO-0003"]);
        expect(numbers({ filter: "sent" })).toEqual(["QUO-0002"]); // the expired one is not "sent"
        expect(numbers({ filter: "expiring" })).toEqual(["QUO-0002"]);
        expect(numbers({ filter: "accepted" })).toEqual(["QUO-0010"]);
        expect(numbers({ filter: "converted" }, new Map([[list[3].id, "INV-9"]]))).toEqual(["QUO-0010"]);
    });
    test("filters by customer", () => {
        expect(queryQuotations(list, { ...EMPTY_QUOTATION_QUERY, customerKey: "a@acme.test" }, { now: NOW }).length).toBe(2);
    });
    test("sorts by number numerically, amount, and valid-until", () => {
        expect(numbers({ sort: "number", dir: "asc" })).toEqual(["QUO-0001", "QUO-0002", "QUO-0003", "QUO-0010"]);
        expect(numbers({ sort: "amount", dir: "desc" })).toEqual(["QUO-0010", "QUO-0002", "QUO-0003", "QUO-0001"]);
        expect(numbers({ sort: "validUntil", dir: "asc" })).toEqual(["QUO-0003", "QUO-0002", "QUO-0001", "QUO-0010"]);
        expect(numbers({ sort: "date", dir: "desc" })).toEqual(["QUO-0010", "QUO-0003", "QUO-0002", "QUO-0001"]);
    });
});

test.describe("csv", () => {
    test("one row per quotation with status, GST and the converted invoice", () => {
        const a = quote("QUO-0001", "accepted");
        const csv = quotationsToCsv([a, quote("QUO-0002", "sent", { validIn: -1 })], new Map([[a.id, "INV-5"]]), NOW);
        const lines = csv.trim().split(/\r?\n/);
        expect(lines).toHaveLength(3);
        expect(lines[1]).toContain("QUO-0001");
        expect(lines[1]).toContain("accepted");
        expect(lines[1]).toContain("INV-5");
        expect(lines[2]).toContain("expired");
    });
});
