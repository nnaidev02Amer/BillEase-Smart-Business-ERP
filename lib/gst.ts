/**
 * India GST arithmetic and local identifier validation.
 *
 * Pure functions, no React and no storage, so every figure on an invoice and in
 * a report comes from one tested place.
 *
 * SCOPE — what this is and is not
 *   This computes GST-style tax breakdowns (CGST + SGST within a state, IGST
 *   across states) and checks identifiers *locally* (format and check
 *   character). It does NOT contact the GST portal, verify that a GSTIN is
 *   registered or active, generate e-invoices / IRNs / e-way bills, or file
 *   returns. An invoice produced here is "GST-style", not certified compliant.
 *
 * MODEL
 *   - A line has a gross amount (qty × rate) and a GST rate.
 *   - Invoice-level discount is allocated across lines in proportion to their
 *     gross amount, so each line's taxable value is correct (GST is charged on
 *     the post-discount value).
 *   - "exclusive" pricing: tax is added on top of the taxable value.
 *     "inclusive" pricing: the entered price already contains tax, which is
 *     extracted: taxable = amount / (1 + rate).
 *   - Intra-state supply (supplier state == place of supply): tax splits into
 *     CGST + SGST halves. Inter-state: all of it is IGST.
 *   - Shipping is added after tax and is not itself taxed. To tax a freight
 *     charge, enter it as a line item with the appropriate SAC code.
 */

import { roundMoney, toAmount } from "@/lib/calculations";

/* ------------------------------------------------------------------ */
/* Reference data                                                      */
/* ------------------------------------------------------------------ */

/** Standard GST slabs. Custom rates remain possible; these are the presets. */
export const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28] as const;
export const DEFAULT_GST_RATE = 18;

/** GST state / UT codes, as used in the first two digits of a GSTIN. */
export const GST_STATES: Record<string, string> = {
    "01": "Jammu & Kashmir",
    "02": "Himachal Pradesh",
    "03": "Punjab",
    "04": "Chandigarh",
    "05": "Uttarakhand",
    "06": "Haryana",
    "07": "Delhi",
    "08": "Rajasthan",
    "09": "Uttar Pradesh",
    "10": "Bihar",
    "11": "Sikkim",
    "12": "Arunachal Pradesh",
    "13": "Nagaland",
    "14": "Manipur",
    "15": "Mizoram",
    "16": "Tripura",
    "17": "Meghalaya",
    "18": "Assam",
    "19": "West Bengal",
    "20": "Jharkhand",
    "21": "Odisha",
    "22": "Chhattisgarh",
    "23": "Madhya Pradesh",
    "24": "Gujarat",
    "26": "Dadra & Nagar Haveli and Daman & Diu",
    "27": "Maharashtra",
    "29": "Karnataka",
    "30": "Goa",
    "31": "Lakshadweep",
    "32": "Kerala",
    "33": "Tamil Nadu",
    "34": "Puducherry",
    "35": "Andaman & Nicobar Islands",
    "36": "Telangana",
    "37": "Andhra Pradesh",
    "38": "Ladakh",
    "97": "Other Territory",
    "99": "Centre Jurisdiction",
};

export const GST_STATE_OPTIONS = Object.entries(GST_STATES).map(([code, name]) => ({
    code,
    name,
    label: `${code} – ${name}`,
}));

/* ------------------------------------------------------------------ */
/* GSTIN                                                               */
/* ------------------------------------------------------------------ */

const GSTIN_FORMAT = /^(\d{2})([A-Z]{5}\d{4}[A-Z])([1-9A-Z])Z([0-9A-Z])$/;
const CHECK_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export const normaliseGstin = (value: unknown): string =>
    typeof value === "string" ? value.replace(/\s+/g, "").toUpperCase() : "";

/** The GSTIN check character for its first 14 characters (mod-36 weighted sum). */
export function gstinCheckChar(first14: string): string | null {
    let sum = 0;
    for (let i = 0; i < 14; i++) {
        const value = CHECK_ALPHABET.indexOf(first14[i]);
        if (value < 0) return null;
        const product = value * (i % 2 === 0 ? 1 : 2);
        sum += Math.floor(product / 36) + (product % 36);
    }
    return CHECK_ALPHABET[(36 - (sum % 36)) % 36];
}

export type GstinCheck =
    | { valid: true; gstin: string; stateCode: string; stateName: string; pan: string }
    | { valid: false; reason: "empty" | "length" | "format" | "state" | "checksum" };

/**
 * Validates a GSTIN locally: 15 characters, state code, embedded PAN pattern,
 * the literal "Z", and the check character. Passing this means the number is
 * *well-formed*, not that it is registered.
 */
export function validateGstin(input: unknown): GstinCheck {
    const gstin = normaliseGstin(input);
    if (!gstin) return { valid: false, reason: "empty" };
    if (gstin.length !== 15) return { valid: false, reason: "length" };
    const m = GSTIN_FORMAT.exec(gstin);
    if (!m) return { valid: false, reason: "format" };
    if (!GST_STATES[m[1]]) return { valid: false, reason: "state" };
    if (gstinCheckChar(gstin.slice(0, 14)) !== gstin[14]) return { valid: false, reason: "checksum" };
    return { valid: true, gstin, stateCode: m[1], stateName: GST_STATES[m[1]], pan: m[2] };
}

export const stateOfGstin = (gstin: unknown): string | null => {
    const check = validateGstin(gstin);
    return check.valid ? check.stateCode : null;
};

/* ------------------------------------------------------------------ */
/* HSN / SAC                                                           */
/* ------------------------------------------------------------------ */

/**
 * HSN codes (goods) are 2–8 digits; SAC codes (services) are 6 digits starting
 * with 99. Empty is allowed — small taxpayers may omit HSN.
 */
export function validateHsnSac(input: unknown): { valid: boolean; kind?: "HSN" | "SAC" } {
    const code = typeof input === "string" ? input.trim() : "";
    if (!code) return { valid: true };
    if (!/^\d{2,8}$/.test(code)) return { valid: false };
    if (code.length === 6 && code.startsWith("99")) return { valid: true, kind: "SAC" };
    if (code.startsWith("99")) return { valid: false };
    return { valid: true, kind: "HSN" };
}

/* ------------------------------------------------------------------ */
/* Calculation                                                         */
/* ------------------------------------------------------------------ */

export type GstPricing = "exclusive" | "inclusive";
export type SupplyType = "intra" | "inter";

export type GstLineInput = {
    /** qty × unit price, as entered (tax-inclusive when pricing is inclusive). */
    amount: number;
    /** GST rate in percent. */
    rate: number;
    hsn?: string;
    quantity?: number;
};

export type GstInput = {
    lines: GstLineInput[];
    pricing: GstPricing;
    supply: SupplyType;
    discount: { value: unknown; type: string };
    shipping: { value: unknown; type: string };
    decimals?: number;
};

export type GstLine = {
    gross: number;
    discount: number;
    taxable: number;
    rate: number;
    cgst: number;
    sgst: number;
    igst: number;
    tax: number;
    /** What the customer pays for this line (taxable + tax). */
    total: number;
};

export type HsnRow = {
    hsn: string;
    rate: number;
    quantity: number;
    taxable: number;
    cgst: number;
    sgst: number;
    igst: number;
    tax: number;
};

export type GstResult = {
    lines: GstLine[];
    subTotal: number;
    discountAmount: number;
    taxableValue: number;
    cgst: number;
    sgst: number;
    igst: number;
    totalTax: number;
    shippingAmount: number;
    total: number;
    hsnSummary: HsnRow[];
};

const clampRate = (rate: unknown) => {
    const n = toAmount(rate);
    return Math.min(n, 100);
};

export function computeGst(input: GstInput): GstResult {
    const decimals = input.decimals ?? 2;
    const r = (v: number) => roundMoney(v, decimals);

    const grosses = input.lines.map((l) => r(toAmount(l.amount)));
    const subTotal = r(grosses.reduce((s, g) => s + g, 0));

    // Discount: percentage of the subtotal, or a fixed amount; never more than
    // the subtotal (matches lib/calculations).
    const rawDiscount =
        input.discount.type === "percentage"
            ? subTotal * (toAmount(input.discount.value) / 100)
            : toAmount(input.discount.value);
    const discountAmount = r(Math.min(rawDiscount, subTotal));

    // Allocate the discount in proportion to each gross; the last non-zero line
    // absorbs the rounding remainder so the parts sum exactly.
    const lastIdx = grosses.reduce((acc, g, i) => (g > 0 ? i : acc), -1);
    let allocated = 0;
    const discounts = grosses.map((g, i) => {
        if (subTotal <= 0 || g <= 0) return 0;
        if (i === lastIdx) return r(discountAmount - allocated);
        const share = r((discountAmount * g) / subTotal);
        allocated += share;
        return share;
    });

    const lines: GstLine[] = input.lines.map((line, i) => {
        const rate = clampRate(line.rate);
        const net = r(grosses[i] - discounts[i]); // after discount, before/with tax
        let taxable: number;
        let tax: number;
        if (input.pricing === "inclusive") {
            taxable = r(net / (1 + rate / 100));
            tax = r(net - taxable);
        } else {
            taxable = net;
            tax = r(net * (rate / 100));
        }

        let cgst = 0;
        let sgst = 0;
        let igst = 0;
        if (input.supply === "intra") {
            cgst = r(tax / 2);
            sgst = r(tax - cgst);
        } else {
            igst = tax;
        }
        return {
            gross: grosses[i],
            discount: discounts[i],
            taxable,
            rate,
            cgst,
            sgst,
            igst,
            tax,
            total: r(taxable + tax),
        };
    });

    const sum = (pick: (l: GstLine) => number) => r(lines.reduce((s, l) => s + pick(l), 0));
    const taxableValue = sum((l) => l.taxable);
    const cgst = sum((l) => l.cgst);
    const sgst = sum((l) => l.sgst);
    const igst = sum((l) => l.igst);
    const totalTax = r(cgst + sgst + igst);
    const afterTax = r(taxableValue + totalTax);

    const shippingAmount = r(
        input.shipping.type === "percentage"
            ? afterTax * (toAmount(input.shipping.value) / 100)
            : toAmount(input.shipping.value)
    );

    // HSN summary: group by code + rate, as printed on a GST invoice.
    const groups = new Map<string, HsnRow>();
    input.lines.forEach((line, i) => {
        const l = lines[i];
        const hsn = (line.hsn ?? "").trim();
        const key = `${hsn}|${l.rate}`;
        const row =
            groups.get(key) ??
            { hsn, rate: l.rate, quantity: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0 };
        row.quantity += toAmount(line.quantity);
        row.taxable = r(row.taxable + l.taxable);
        row.cgst = r(row.cgst + l.cgst);
        row.sgst = r(row.sgst + l.sgst);
        row.igst = r(row.igst + l.igst);
        row.tax = r(row.tax + l.tax);
        groups.set(key, row);
    });

    return {
        lines,
        subTotal,
        discountAmount,
        taxableValue,
        cgst,
        sgst,
        igst,
        totalTax,
        shippingAmount,
        total: r(afterTax + shippingAmount),
        hsnSummary: Array.from(groups.values()),
    };
}

/* ------------------------------------------------------------------ */
/* Invoice helpers                                                     */
/* ------------------------------------------------------------------ */

type GstInvoiceLike = {
    sender?: { gstin?: string };
    receiver?: { gstin?: string };
    details: {
        currency?: string;
        gst?: { enabled?: boolean; pricing?: GstPricing; placeOfSupply?: string };
        items: { quantity?: unknown; unitPrice?: unknown; total?: unknown; hsn?: string; gstRate?: number }[];
        discountDetails?: { amount?: unknown; amountType?: string };
        shippingDetails?: { cost?: unknown; costType?: string };
    };
};

/** Whether the supply is within the supplier's state. Null if it can't be told. */
export function supplyTypeOf(sellerGstin: unknown, placeOfSupply: unknown): SupplyType | null {
    const seller = stateOfGstin(sellerGstin);
    const pos = typeof placeOfSupply === "string" ? placeOfSupply : "";
    if (!seller || !GST_STATES[pos]) return null;
    return seller === pos ? "intra" : "inter";
}

export const isGstInvoice = (invoice: GstInvoiceLike) => invoice.details.gst?.enabled === true;

/**
 * Recomputes an invoice's GST from its stored inputs. Reports use this rather
 * than trusting stored figures, so a hand-edited or imported file cannot make
 * the GST report disagree with the invoice's own lines.
 */
export function gstOfInvoice(invoice: GstInvoiceLike, decimals = 2): (GstResult & { supply: SupplyType }) | null {
    const gst = invoice.details.gst;
    if (!gst?.enabled) return null;
    const supply = supplyTypeOf(invoice.sender?.gstin, gst.placeOfSupply);
    if (!supply) return null;
    const result = computeGst({
        lines: invoice.details.items.map((item) => ({
            amount: toAmount(item.total) || toAmount(item.quantity) * toAmount(item.unitPrice),
            rate: item.gstRate ?? 0,
            hsn: item.hsn,
            quantity: toAmount(item.quantity),
        })),
        pricing: gst.pricing === "inclusive" ? "inclusive" : "exclusive",
        supply,
        discount: {
            value: invoice.details.discountDetails?.amount,
            type: invoice.details.discountDetails?.amountType ?? "amount",
        },
        shipping: {
            value: invoice.details.shippingDetails?.cost,
            type: invoice.details.shippingDetails?.costType ?? "amount",
        },
        decimals,
    });
    return { ...result, supply };
}

/* ------------------------------------------------------------------ */
/* Validation messages                                                 */
/* ------------------------------------------------------------------ */

export type GstIssue = { path: (string | number)[]; code: string };

/**
 * Cross-field GST rules, shared by the zod schema so the browser form and the
 * server PDF route enforce the same thing.
 */
export function gstIssues(invoice: GstInvoiceLike): GstIssue[] {
    const issues: GstIssue[] = [];
    const sellerGstin = normaliseGstin(invoice.sender?.gstin);
    const buyerGstin = normaliseGstin(invoice.receiver?.gstin);

    if (sellerGstin && !validateGstin(sellerGstin).valid) issues.push({ path: ["sender", "gstin"], code: "invalidGstin" });
    if (buyerGstin && !validateGstin(buyerGstin).valid) issues.push({ path: ["receiver", "gstin"], code: "invalidGstin" });

    invoice.details.items.forEach((item, i) => {
        if (!validateHsnSac(item.hsn).valid) issues.push({ path: ["details", "items", i, "hsn"], code: "invalidHsn" });
    });

    const gst = invoice.details.gst;
    if (gst?.enabled) {
        if (!sellerGstin) issues.push({ path: ["sender", "gstin"], code: "sellerGstinRequired" });
        if (!gst.placeOfSupply || !GST_STATES[gst.placeOfSupply]) {
            issues.push({ path: ["details", "gst", "placeOfSupply"], code: "placeOfSupplyRequired" });
        }
    }
    return issues;
}
