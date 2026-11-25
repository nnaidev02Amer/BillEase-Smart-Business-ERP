import { test, expect } from "@playwright/test";

import {
    computeGst,
    gstinCheckChar,
    gstOfInvoice,
    gstIssues,
    supplyTypeOf,
    validateGstin,
    validateHsnSac,
} from "../lib/gst";

/** Builds a GSTIN with a correct check character. */
const makeGstin = (state: string, pan: string, entity = "1") => {
    const first14 = `${state}${pan}${entity}Z`;
    return first14 + gstinCheckChar(first14);
};

test.describe("GSTIN validation", () => {
    test("accepts a well-known sample GSTIN", () => {
        const r = validateGstin("27AAPFU0939F1ZV");
        expect(r.valid).toBe(true);
        if (r.valid) {
            expect(r.stateCode).toBe("27");
            expect(r.stateName).toBe("Maharashtra");
            expect(r.pan).toBe("AAPFU0939F");
        }
    });

    test("normalises case and whitespace", () => {
        expect(validateGstin(" 27aapfu0939f1zv ").valid).toBe(true);
    });

    test("rejects wrong length, format, state and checksum", () => {
        expect(validateGstin("")).toEqual({ valid: false, reason: "empty" });
        expect(validateGstin("27AAPFU0939F1Z")).toEqual({ valid: false, reason: "length" });
        expect(validateGstin("27AAPFU0939F1XV")).toEqual({ valid: false, reason: "format" });
        expect(validateGstin(makeGstin("28", "AAPFU0939F"))).toEqual({ valid: false, reason: "state" });
        expect(validateGstin("27AAPFU0939F1ZA")).toEqual({ valid: false, reason: "checksum" });
    });

    test("generated GSTINs round-trip", () => {
        for (const state of ["07", "29", "33", "36"]) {
            expect(validateGstin(makeGstin(state, "ABCDE1234F")).valid).toBe(true);
        }
    });
});

test.describe("HSN / SAC", () => {
    test("accepts blank, 4/6/8-digit HSN and 6-digit SAC", () => {
        expect(validateHsnSac("").valid).toBe(true);
        expect(validateHsnSac("8471")).toEqual({ valid: true, kind: "HSN" });
        expect(validateHsnSac("84713010")).toEqual({ valid: true, kind: "HSN" });
        expect(validateHsnSac("998314")).toEqual({ valid: true, kind: "SAC" });
    });
    test("rejects letters and malformed SAC", () => {
        expect(validateHsnSac("84A1").valid).toBe(false);
        expect(validateHsnSac("9983").valid).toBe(false);
        expect(validateHsnSac("123456789").valid).toBe(false);
    });
});

const base = {
    discount: { value: 0, type: "amount" },
    shipping: { value: 0, type: "amount" },
};

test.describe("GST computation", () => {
    test("intra-state splits tax into CGST + SGST", () => {
        const r = computeGst({ ...base, pricing: "exclusive", supply: "intra", lines: [{ amount: 1000, rate: 18 }] });
        expect(r.taxableValue).toBe(1000);
        expect(r.cgst).toBe(90);
        expect(r.sgst).toBe(90);
        expect(r.igst).toBe(0);
        expect(r.total).toBe(1180);
    });

    test("inter-state charges IGST only", () => {
        const r = computeGst({ ...base, pricing: "exclusive", supply: "inter", lines: [{ amount: 1000, rate: 18 }] });
        expect(r.igst).toBe(180);
        expect(r.cgst + r.sgst).toBe(0);
        expect(r.total).toBe(1180);
    });

    test("tax-inclusive pricing extracts tax and keeps the total", () => {
        const r = computeGst({ ...base, pricing: "inclusive", supply: "intra", lines: [{ amount: 1180, rate: 18 }] });
        expect(r.taxableValue).toBe(1000);
        expect(r.totalTax).toBe(180);
        expect(r.total).toBe(1180);
    });

    test("odd-paise tax still sums exactly (CGST + SGST = tax)", () => {
        const r = computeGst({ ...base, pricing: "exclusive", supply: "intra", lines: [{ amount: 10.05, rate: 5 }] });
        expect(r.cgst + r.sgst).toBeCloseTo(r.totalTax, 10);
    });

    test("discount reduces taxable value per line, proportionally", () => {
        const r = computeGst({
            ...base,
            discount: { value: 10, type: "percentage" },
            pricing: "exclusive",
            supply: "intra",
            lines: [
                { amount: 1000, rate: 5 },
                { amount: 1000, rate: 18 },
            ],
        });
        expect(r.discountAmount).toBe(200);
        expect(r.lines[0].taxable).toBe(900);
        expect(r.lines[1].taxable).toBe(900);
        expect(r.totalTax).toBe(45 + 162);
        expect(r.total).toBe(1800 + 207);
    });

    test("allocated discounts always sum to the discount", () => {
        const r = computeGst({
            ...base,
            discount: { value: 10, type: "amount" },
            pricing: "exclusive",
            supply: "inter",
            lines: [{ amount: 33.33, rate: 12 }, { amount: 33.33, rate: 12 }, { amount: 33.34, rate: 12 }],
        });
        expect(r.lines.reduce((s, l) => s + l.discount, 0)).toBeCloseTo(10, 10);
    });

    test("a discount larger than the subtotal is capped", () => {
        const r = computeGst({ ...base, discount: { value: 5000, type: "amount" }, pricing: "exclusive", supply: "intra", lines: [{ amount: 100, rate: 18 }] });
        expect(r.taxableValue).toBe(0);
        expect(r.total).toBe(0);
    });

    test("shipping is added after tax and not taxed", () => {
        const r = computeGst({ ...base, shipping: { value: 50, type: "amount" }, pricing: "exclusive", supply: "inter", lines: [{ amount: 100, rate: 18 }] });
        expect(r.total).toBe(168);
        expect(r.totalTax).toBe(18);
    });

    test("0% and exempt lines produce no tax", () => {
        const r = computeGst({ ...base, pricing: "exclusive", supply: "intra", lines: [{ amount: 500, rate: 0 }] });
        expect(r.totalTax).toBe(0);
        expect(r.total).toBe(500);
    });

    test("HSN summary groups by code and rate", () => {
        const r = computeGst({
            ...base,
            pricing: "exclusive",
            supply: "intra",
            lines: [
                { amount: 100, rate: 18, hsn: "8471", quantity: 1 },
                { amount: 200, rate: 18, hsn: "8471", quantity: 2 },
                { amount: 100, rate: 5, hsn: "8471", quantity: 1 },
            ],
        });
        expect(r.hsnSummary).toHaveLength(2);
        const g = r.hsnSummary.find((h) => h.rate === 18)!;
        expect(g.taxable).toBe(300);
        expect(g.quantity).toBe(3);
    });

    test("respects zero-decimal currencies", () => {
        const r = computeGst({ ...base, pricing: "exclusive", supply: "inter", lines: [{ amount: 1001, rate: 5 }], decimals: 0 });
        expect(Number.isInteger(r.total)).toBe(true);
    });
});

test.describe("supply type and invoice rules", () => {
    const seller = makeGstin("27", "AAPFU0939F");
    test("same state is intra, different is inter, unknown is null", () => {
        expect(supplyTypeOf(seller, "27")).toBe("intra");
        expect(supplyTypeOf(seller, "29")).toBe("inter");
        expect(supplyTypeOf(seller, "")).toBeNull();
        expect(supplyTypeOf("bad", "27")).toBeNull();
    });

    const inv = (over: Record<string, unknown> = {}) => ({
        sender: { gstin: seller },
        receiver: { gstin: "" },
        details: {
            gst: { enabled: true, pricing: "exclusive" as const, placeOfSupply: "29" },
            items: [{ quantity: 2, unitPrice: 500, total: "1000.00", hsn: "8471", gstRate: 18 }],
            discountDetails: { amount: 0, amountType: "amount" },
            shippingDetails: { cost: 0, costType: "amount" },
            ...over,
        },
    });

    test("gstOfInvoice recomputes from items", () => {
        const r = gstOfInvoice(inv())!;
        expect(r.supply).toBe("inter");
        expect(r.igst).toBe(180);
        expect(r.total).toBe(1180);
    });

    test("non-GST invoices yield null", () => {
        expect(gstOfInvoice(inv({ gst: { enabled: false } }))).toBeNull();
        expect(gstOfInvoice({ details: { items: [] } })).toBeNull();
    });

    test("rule violations are reported", () => {
        expect(gstIssues(inv())).toEqual([]);
        const bad = { ...inv(), sender: { gstin: "" }, receiver: { gstin: "XYZ" } };
        const codes = gstIssues(bad).map((i) => i.code);
        expect(codes).toContain("sellerGstinRequired");
        expect(codes).toContain("invalidGstin");
        const noPos = inv({ gst: { enabled: true, pricing: "exclusive", placeOfSupply: "" } });
        expect(gstIssues(noPos).map((i) => i.code)).toContain("placeOfSupplyRequired");
    });
});

/* ------------------------------------------------------------------ */
/* Integration with the invoice schema, finance and the GST report      */
/* ------------------------------------------------------------------ */

import { breakdownOf } from "../lib/finance";
import { buildGstReport, gstReportCsv } from "../lib/gstReport";
import { InvoiceSchema } from "../lib/schemas";
import { invoice as legacyInvoice } from "./fixtures";
import type { InvoiceType } from "../types";

const SELLER = makeGstin("27", "AAPFU0939F");
const BUYER = makeGstin("29", "AABCT1332L");

const gstInvoice = (number: string, opts: { place?: string; status?: string; buyerGstin?: string; rate?: number; amount?: number; date?: string } = {}) => {
    const amount = opts.amount ?? 1000;
    const inv = legacyInvoice(number, "Buyer Pvt Ltd", "buyer@example.com", amount, { status: opts.status ?? "sent", issued: -3, due: 27 });
    return {
        ...inv,
        sender: { ...inv.sender, gstin: SELLER },
        receiver: { ...inv.receiver, gstin: opts.buyerGstin ?? "" },
        details: {
            ...inv.details,
            ...(opts.date ? { invoiceDate: opts.date } : {}),
            gst: { enabled: true, pricing: "exclusive", placeOfSupply: opts.place ?? "27" },
            items: [{ name: "Laptop", quantity: 1, unitPrice: amount, total: amount, hsn: "8471", gstRate: opts.rate ?? 18 }],
            subTotal: amount,
            // total as the form would compute it
            totalAmount: amount * (1 + (opts.rate ?? 18) / 100),
        },
    } as unknown as InvoiceType;
};

test.describe("schema", () => {
    test("pre-GST invoices still validate unchanged", () => {
        const legacy = legacyInvoice("OLD-1", "Acme", "a@acme.test", 100, { issued: -1, due: 29 });
        // The schema wants these; fixtures leave them off, so add the minimum.
        const ok = InvoiceSchema.safeParse({
            ...legacy,
            details: { ...legacy.details, paymentTerms: "Net 30", pdfTemplate: 1 },
        });
        expect(ok.success).toBe(true);
    });

    test("GST on without the seller GSTIN is rejected with a pointer to the field", () => {
        const inv = gstInvoice("G-1");
        const bad = { ...inv, sender: { ...inv.sender, gstin: "" } };
        const r = InvoiceSchema.safeParse(bad);
        expect(r.success).toBe(false);
        if (!r.success) expect(r.error.issues.some((i) => i.path.join(".") === "sender.gstin")).toBe(true);
    });

    test("a malformed buyer GSTIN is rejected; a valid one passes", () => {
        const bad = InvoiceSchema.safeParse(gstInvoice("G-2", { buyerGstin: "29AABCT1332L1ZZ" }));
        expect(bad.success).toBe(false);
        const good = InvoiceSchema.safeParse(gstInvoice("G-3", { buyerGstin: BUYER, place: "29" }));
        expect(good.success).toBe(true);
    });

    test("an invalid HSN on a line is rejected", () => {
        const inv = gstInvoice("G-4");
        inv.details.items[0] = { ...inv.details.items[0], hsn: "12AB" };
        const r = InvoiceSchema.safeParse(inv);
        expect(r.success).toBe(false);
    });
});

test.describe("finance picks up GST", () => {
    test("breakdownOf reports per-line GST rather than the flat tax charge", () => {
        const inv = gstInvoice("F-1", { place: "29" });
        expect(breakdownOf(inv).tax).toBe(180);
    });
});

test.describe("GST report", () => {
    const invoices = [
        gstInvoice("R-1", { place: "27", buyerGstin: "" }), // intra, B2C
        gstInvoice("R-2", { place: "29", buyerGstin: BUYER, rate: 5, amount: 2000 }), // inter, B2B
        gstInvoice("R-3", { status: "draft" }), // draft: excluded
        gstInvoice("R-4", { status: "cancelled" }), // cancelled: excluded
        legacyInvoice("NO-GST", "Acme", "a@acme.test", 999, { status: "sent", issued: -2, due: 28 }) as unknown as InvoiceType,
    ];

    test("counts only issued GST invoices, split by supply and buyer type", () => {
        const r = buildGstReport(invoices, { currency: "USD" });
        expect(r.rows.map((x) => x.invoiceNumber)).toEqual(["R-1", "R-2"]);
        expect(r.totals.cgst).toBe(90);
        expect(r.totals.sgst).toBe(90);
        expect(r.totals.igst).toBe(100); // 5% of 2000
        expect(r.totals.totalTax).toBe(280);
        expect(r.totals.taxable).toBe(3000);
        expect(r.b2b.count).toBe(1);
        expect(r.b2c.count).toBe(1);
        expect(r.bySlab.map((s) => s.rate)).toEqual([5, 18]);
    });

    test("the date range filters by invoice date, inclusive", () => {
        const old = gstInvoice("R-OLD", { date: new Date(2020, 0, 15).toISOString() });
        const all = [...invoices, old];
        const jan = buildGstReport(all, { currency: "USD", from: new Date(2020, 0, 1), to: new Date(2020, 0, 31) });
        expect(jan.rows.map((x) => x.invoiceNumber)).toEqual(["R-OLD"]);
        const edge = buildGstReport(all, { currency: "USD", from: new Date(2020, 0, 15), to: new Date(2020, 0, 15) });
        expect(edge.rows).toHaveLength(1);
    });

    test("other currencies are never mixed in", () => {
        expect(buildGstReport(invoices, { currency: "EUR" }).rows).toHaveLength(0);
    });

    test("an issued GST invoice with no place of supply is reported as skipped, not silently dropped", () => {
        const incomplete = gstInvoice("R-5", { place: "" });
        const r = buildGstReport([incomplete], { currency: "USD" });
        expect(r.rows).toHaveLength(0);
        expect(r.skipped).toEqual(["R-5"]);
    });

    test("CSV carries one line per invoice plus a header", () => {
        const { csv, filename } = gstReportCsv(buildGstReport(invoices, { currency: "USD" }));
        expect(filename).toContain("gst-sales");
        expect(csv.trim().split(/\r?\n/)).toHaveLength(3);
    });
});
