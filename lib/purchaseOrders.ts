/**
 * Purchase orders: pure logic, no React and no storage.
 *
 * A purchase order (PO) is what you ask a supplier to deliver. It commits
 * nothing in the books by itself: stock only moves when goods are received
 * (a goods receipt), and money is only owed when a bill is posted. So a PO has
 * no effect on inventory, expenses or profit.
 *
 * MONEY IS DERIVED
 *   Totals are never stored. `poTotals` recomputes them from the lines with the
 *   same GST engine invoices use, so a PO, its PDF and later its bill cannot
 *   disagree. GST is exclusive (prices are before tax). Freight is added after
 *   tax and is not itself taxed here.
 *
 * INTRA- vs INTER-STATE
 *   Taken from the supplier's state against the buyer's state (Business
 *   Profile). If either is unknown the PO is treated as intra-state and flagged
 *   (`supplyKnown: false`) rather than silently guessed.
 *
 * STATUS
 *   Stored (user-chosen):  draft · sent · closed · cancelled
 *   Derived for display:   partiallyReceived · received (from goods receipts)
 *                          and overdue (sent, expected date passed, not received)
 *   Derived states are never stored, so they cannot go stale.
 *
 * A PO keeps a snapshot of the supplier's details as they were when it was
 * written, so editing a supplier later never rewrites history.
 */

import { computeGst, validateHsnSac, type GstResult, type SupplyType } from "@/lib/gst";
import { decimalsOf, isValidDay, toDay } from "@/lib/expenses";
import { formatPriceToString } from "@/lib/helpers";
import { isNumberTaken } from "@/lib/docNumbers";
import { toCsv } from "@/lib/invoiceRecords";
import { InvoiceSchema, stripControlChars } from "@/lib/schemas";
import { businessState, purchaseSupplyType, supplierState, type Supplier } from "@/lib/suppliers";
import type { BusinessProfile } from "@/lib/settings";
import type { InvoiceType } from "@/types";

/* ------------------------------------------------------------------ types */

export const PO_STATUSES = ["draft", "sent", "closed", "cancelled"] as const;
export type PoStatus = (typeof PO_STATUSES)[number];
export type PoDisplayStatus = PoStatus | "partiallyReceived" | "received" | "overdue";

export type PoLine = {
    id: string;
    productId?: string;
    name: string;
    description: string;
    hsn: string;
    unit: string;
    quantity: number;
    unitPrice: number;
    /** GST rate in percent. */
    taxRate: number;
};

/** The supplier as it was when the PO was written. */
export type SupplierSnapshot = Pick<
    Supplier,
    "name" | "gstin" | "state" | "address" | "city" | "zipCode" | "country" | "email" | "phone"
>;

export type PoEvent = { at: string; kind: "created" | "edited" | PoStatus };

export type PurchaseOrder = {
    id: string;
    number: string;
    supplierId: string;
    supplier: SupplierSnapshot;
    /** yyyy-mm-dd */
    date: string;
    /** yyyy-mm-dd, or "" when no delivery date was promised. */
    expectedDate: string;
    currency: string;
    lines: PoLine[];
    discount: { type: "amount" | "percentage"; value: number };
    freight: number;
    gstEnabled: boolean;
    paymentTerms: string;
    notes: string;
    terms: string;
    status: PoStatus;
    log: PoEvent[];
    createdAt: string;
    updatedAt: string;
};

export const MAX_PURCHASE_ORDERS = 10_000;
export const MAX_PO_LINES = 200;
export const MAX_AMOUNT = 1e12;

/* ---------------------------------------------------------------- numbers */

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const round3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;
const clip = (v: unknown, max: number) => (typeof v === "string" ? stripControlChars(v).trim().slice(0, max) : "");
const num = (v: unknown, min: number, max: number, fallback = 0): number => {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/,/g, ""));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/* -------------------------------------------------------------- sanitise */

export function sanitizeLine(input: unknown): PoLine | null {
    if (!input || typeof input !== "object") return null;
    const o = input as Record<string, unknown>;
    const id = clip(o.id, 64);
    const name = clip(o.name, 120);
    if (!id || !name) return null;
    const productId = clip(o.productId, 64);
    return {
        id,
        ...(productId ? { productId } : {}),
        name,
        description: clip(o.description, 500),
        hsn: clip(o.hsn, 8).replace(/\D/g, ""),
        unit: clip(o.unit, 20) || "pcs",
        quantity: round3(num(o.quantity, 0, 1e9)),
        unitPrice: round2(num(o.unitPrice, 0, MAX_AMOUNT)),
        taxRate: num(o.taxRate, 0, 100),
    };
}

const day = (v: unknown) => (typeof v === "string" && isValidDay(v) ? v : "");

export function sanitizeSnapshot(input: unknown): SupplierSnapshot {
    const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    return {
        name: clip(o.name, 120),
        gstin: clip(o.gstin, 15).toUpperCase(),
        state: clip(o.state, 2),
        address: clip(o.address, 120),
        city: clip(o.city, 50),
        zipCode: clip(o.zipCode, 20),
        country: clip(o.country, 70),
        email: clip(o.email, 254),
        phone: clip(o.phone, 50),
    };
}

/**
 * Rebuilds a well-formed PO from anything, or returns null if it cannot be one
 * (no id, number, supplier or valid date). Used on every read from storage and
 * on backup import.
 */
export function sanitizePurchaseOrder(input: unknown): PurchaseOrder | null {
    if (!input || typeof input !== "object") return null;
    const o = input as Record<string, unknown>;
    const id = clip(o.id, 64);
    const number = clip(o.number, 40);
    const supplierId = clip(o.supplierId, 64);
    const date = day(o.date);
    const status = PO_STATUSES.find((s) => s === o.status);
    if (!id || !number || !supplierId || !date || !status) return null;

    const lines = (Array.isArray(o.lines) ? o.lines : [])
        .slice(0, MAX_PO_LINES)
        .map(sanitizeLine)
        .filter((l): l is PoLine => l !== null);
    const d = (o.discount && typeof o.discount === "object" ? o.discount : {}) as Record<string, unknown>;
    const type = d.type === "percentage" ? "percentage" : "amount";
    const now = new Date().toISOString();
    const log = (Array.isArray(o.log) ? o.log : [])
        .slice(-50)
        .map((e): PoEvent | null => {
            if (!e || typeof e !== "object") return null;
            const ev = e as Record<string, unknown>;
            const kind = ev.kind === "created" || ev.kind === "edited" ? ev.kind : PO_STATUSES.find((s) => s === ev.kind);
            return kind && typeof ev.at === "string" ? { at: ev.at, kind } : null;
        })
        .filter((e): e is PoEvent => e !== null);
    const currency = clip(o.currency, 3).toUpperCase();

    return {
        id,
        number,
        supplierId,
        supplier: sanitizeSnapshot(o.supplier),
        date,
        expectedDate: day(o.expectedDate),
        currency: /^[A-Z]{3}$/.test(currency) ? currency : "INR",
        lines,
        discount: { type, value: round2(num(d.value, 0, type === "percentage" ? 100 : MAX_AMOUNT)) },
        freight: round2(num(o.freight, 0, MAX_AMOUNT)),
        gstEnabled: o.gstEnabled !== false,
        paymentTerms: clip(o.paymentTerms, 200),
        notes: clip(o.notes, 2000),
        terms: clip(o.terms, 2000),
        status,
        log,
        createdAt: typeof o.createdAt === "string" ? o.createdAt : now,
        updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : now,
    };
}

/* ----------------------------------------------------------------- totals */

export type PoTotals = GstResult & {
    supply: SupplyType;
    /** False when the supplier's or buyer's state is unknown, so `supply` is an assumption. */
    supplyKnown: boolean;
};

type TotalsInput = Pick<PurchaseOrder, "lines" | "discount" | "freight" | "gstEnabled" | "currency"> & { supplier: Pick<Supplier, "state" | "gstin"> };

export function poTotals(po: TotalsInput, buyerState: string): PoTotals {
    const known = purchaseSupplyType(supplierState(po.supplier), buyerState);
    const result = computeGst({
        lines: po.lines.map((l) => ({
            amount: round2(l.quantity * l.unitPrice),
            rate: po.gstEnabled ? l.taxRate : 0,
            hsn: l.hsn,
            quantity: l.quantity,
        })),
        pricing: "exclusive",
        supply: known ?? "intra",
        discount: { value: po.discount.value, type: po.discount.type },
        shipping: { value: po.freight, type: "amount" },
        decimals: decimalsOf(po.currency),
    });
    return { ...result, supply: known ?? "intra", supplyKnown: known !== null };
}

/** Grand total of a PO, tax and freight included. */
export const poTotal = (po: TotalsInput & { supplier: Pick<Supplier, "state" | "gstin"> }, buyerState: string) => poTotals(po, buyerState).total;

/* ------------------------------------------------------------- validation */

export type PoLineField = "name" | "quantity" | "unitPrice" | "taxRate" | "hsn";
export type PoErrors = {
    supplier?: string;
    date?: string;
    expectedDate?: string;
    number?: string;
    currency?: string;
    lines?: string;
    discount?: string;
    freight?: string;
    /** line id → field → error code */
    lineErrors: Record<string, Partial<Record<PoLineField, string>>>;
};

export type PoDraft = Pick<PurchaseOrder, "supplierId" | "date" | "expectedDate" | "currency" | "lines" | "discount" | "freight" | "gstEnabled"> & {
    number: string;
};

/** Error codes are `purchaseOrders.errors.<code>` keys in the locale files. */
export function validatePurchaseOrder(draft: PoDraft, suppliers: Pick<Supplier, "id">[], existing: PurchaseOrder[], id?: string): PoErrors {
    const errors: PoErrors = { lineErrors: {} };
    if (!draft.supplierId || !suppliers.some((s) => s.id === draft.supplierId)) errors.supplier = "supplierRequired";
    if (!isValidDay(draft.date)) errors.date = "dateInvalid";
    if (draft.expectedDate) {
        if (!isValidDay(draft.expectedDate)) errors.expectedDate = "dateInvalid";
        else if (isValidDay(draft.date) && draft.expectedDate < draft.date) errors.expectedDate = "expectedBeforeDate";
    }
    const number = draft.number.trim();
    if (number && isNumberTaken(number, existing, id)) errors.number = "numberTaken";
    if (!/^[A-Z]{3}$/.test(draft.currency)) errors.currency = "currencyInvalid";

    if (draft.lines.length === 0) errors.lines = "linesRequired";
    else if (draft.lines.length > MAX_PO_LINES) errors.lines = "linesLimit";
    for (const l of draft.lines) {
        const e: Partial<Record<PoLineField, string>> = {};
        if (!clip(l.name, 120)) e.name = "nameRequired";
        // A PDF line must have a positive quantity and price (the invoice schema it renders through says so).
        if (!(l.quantity > 0) || l.quantity > 1e9) e.quantity = "quantityInvalid";
        if (!(l.unitPrice > 0) || l.unitPrice > MAX_AMOUNT) e.unitPrice = "priceInvalid";
        if (!(l.taxRate >= 0 && l.taxRate <= 100)) e.taxRate = "rateInvalid";
        if (!validateHsnSac(l.hsn).valid) e.hsn = "hsnInvalid";
        if (Object.keys(e).length) errors.lineErrors[l.id] = e;
    }

    if (draft.discount.type === "percentage" ? !(draft.discount.value >= 0 && draft.discount.value <= 100) : !(draft.discount.value >= 0)) {
        errors.discount = "discountInvalid";
    }
    if (!(draft.freight >= 0 && draft.freight <= MAX_AMOUNT)) errors.freight = "freightInvalid";
    return errors;
}

export const hasErrors = (e: PoErrors) =>
    Object.entries(e).some(([k, v]) => (k === "lineErrors" ? Object.keys(v as object).length > 0 : Boolean(v)));

/* ------------------------------------------------------------------ status */

const TRANSITIONS: Record<PoStatus, PoStatus[]> = {
    draft: ["sent", "cancelled"],
    sent: ["draft", "closed", "cancelled"],
    closed: ["sent"],
    cancelled: ["draft"],
};

/** `hasReceipts`: goods have already been received against it, so it can't go back to draft or be cancelled. */
export function canTransition(from: PoStatus, to: PoStatus, { hasReceipts = false }: { hasReceipts?: boolean } = {}): boolean {
    if (!TRANSITIONS[from].includes(to)) return false;
    if (hasReceipts && (to === "draft" || to === "cancelled")) return false;
    return true;
}

/** Drafts and sent orders can be edited; closed and cancelled ones are history. */
export const canEdit = (po: Pick<PurchaseOrder, "status">) => po.status === "draft" || po.status === "sent";

/** A PO that nothing refers to can be deleted, but only while it is a draft or cancelled. */
export const canDelete = (po: Pick<PurchaseOrder, "status">, { hasReceipts = false }: { hasReceipts?: boolean } = {}) =>
    !hasReceipts && (po.status === "draft" || po.status === "cancelled");

/** Quantity received so far for each line id (supplied by goods receipts; empty until then). */
export type ReceivedByLine = Map<string, number>;

export function receiptProgress(po: Pick<PurchaseOrder, "lines">, received: ReceivedByLine = new Map()) {
    let ordered = 0;
    let got = 0;
    for (const l of po.lines) {
        ordered += l.quantity;
        got += Math.min(l.quantity, received.get(l.id) ?? 0);
    }
    ordered = round3(ordered);
    got = round3(got);
    return { ordered, received: got, fraction: ordered > 0 ? Math.min(1, got / ordered) : 0 };
}

export function displayStatus(po: PurchaseOrder, received: ReceivedByLine = new Map(), now: Date = new Date()): PoDisplayStatus {
    if (po.status !== "sent") return po.status;
    const p = receiptProgress(po, received);
    if (p.ordered > 0 && p.received >= p.ordered) return "received";
    if (po.expectedDate && toDay(now) > po.expectedDate) return "overdue";
    return p.received > 0 ? "partiallyReceived" : "sent";
}

/** Orders still waiting on goods: sent and not fully received. */
export const isOpen = (po: PurchaseOrder, received: ReceivedByLine = new Map()) =>
    po.status === "sent" && receiptProgress(po, received).fraction < 1;

/* ---------------------------------------------------------------- summary */

export type PoSummary = { open: number; draft: number; overdue: number; openValue: Record<string, number> };

/** Open-order value is per currency: money is never added across currencies. */
export function summarisePurchaseOrders(list: PurchaseOrder[], buyerState: string, received: ReceivedByLine = new Map(), now: Date = new Date()): PoSummary {
    const out: PoSummary = { open: 0, draft: 0, overdue: 0, openValue: {} };
    for (const po of list) {
        if (po.status === "draft") out.draft++;
        if (!isOpen(po, received)) continue;
        out.open++;
        if (displayStatus(po, received, now) === "overdue") out.overdue++;
        out.openValue[po.currency] = round2((out.openValue[po.currency] ?? 0) + poTotals(po, buyerState).total);
    }
    return out;
}

/* ------------------------------------------------------------------ query */

export type PoQuery = { q: string; status: PoDisplayStatus | "all"; supplierId: string };
export const EMPTY_PO_QUERY: PoQuery = { q: "", status: "all", supplierId: "" };

export function queryPurchaseOrders(list: PurchaseOrder[], query: PoQuery, received: ReceivedByLine = new Map(), now: Date = new Date()): PurchaseOrder[] {
    const q = query.q.trim().toLowerCase();
    return list
        .filter((po) => query.status === "all" || displayStatus(po, received, now) === query.status)
        .filter((po) => !query.supplierId || po.supplierId === query.supplierId)
        .filter((po) => !q || po.number.toLowerCase().includes(q) || po.supplier.name.toLowerCase().includes(q) || po.lines.some((l) => l.name.toLowerCase().includes(q)))
        .sort((a, b) => (a.date === b.date ? b.number.localeCompare(a.number) : b.date.localeCompare(a.date)));
}

export function purchaseOrdersCsv(list: PurchaseOrder[], buyerState: string): string {
    return toCsv(
        ["PO #", "Status", "Supplier", "Supplier GSTIN", "Date", "Expected", "Currency", "Taxable value", "Tax", "Freight", "Total"],
        list.map((po) => {
            const t = poTotals(po, buyerState);
            return [po.number, po.status, po.supplier.name, po.supplier.gstin, po.date, po.expectedDate, po.currency, t.taxableValue, t.totalTax, t.shippingAmount, t.total];
        })
    );
}

/* ------------------------------------------------------------------- misc */

export const snapshotOf = (s: Supplier): SupplierSnapshot => ({
    name: s.name,
    gstin: s.gstin,
    state: supplierState(s),
    address: s.address,
    city: s.city,
    zipCode: s.zipCode,
    country: s.country,
    email: s.email,
    phone: s.phone,
});

/** "Net 30 days", the wording used on a PO for a supplier's payment terms. */
export const termsText = (days: number) => (days <= 0 ? "Due on receipt" : `Net ${days} days`);

/** `dayString` plus `n` calendar days, as yyyy-mm-dd (used for due dates from payment terms). */
export function addDays(dayString: string, n: number): string {
    const [y, m, d] = dayString.split("-").map(Number);
    return toDay(new Date(y, m - 1, d + n));
}

/**
 * Merge for backup restore. Ids already present are kept. A PO whose supplier
 * was skipped as a duplicate is pointed at the existing supplier (`remap`), and
 * a number that collides with a different PO is renumbered rather than dropped.
 */
export function mergePurchaseOrders(
    existing: PurchaseOrder[],
    incoming: PurchaseOrder[],
    remap: Map<string, string>,
    renumber: (taken: string[]) => string
) {
    const list = [...existing];
    const ids = new Set(existing.map((p) => p.id));
    let added = 0;
    let skipped = 0;
    let renumbered = 0;
    for (const raw of incoming) {
        if (ids.has(raw.id) || list.length >= MAX_PURCHASE_ORDERS) {
            skipped++;
            continue;
        }
        let po = { ...raw, supplierId: remap.get(raw.supplierId) ?? raw.supplierId };
        if (isNumberTaken(po.number, list)) {
            po = { ...po, number: renumber(list.map((p) => p.number)) };
            renumbered++;
        }
        list.push(po);
        ids.add(po.id);
        added++;
    }
    return { list, added, skipped, renumbered };
}

/* -------------------------------------------------------------------- PDF */

/**
 * The PO as an invoice-shaped document, so it renders through the same PDF
 * endpoint and templates as quotations (`kind=purchaseOrder` only changes the
 * wording). The sender is *your* business and the receiver is the supplier.
 *
 * GST: the invoice engine decides intra/inter by comparing the *sender's* GSTIN
 * state with the place of supply. Here the goods move from the supplier to you,
 * so the place of supply is set to the supplier's state: it equals your state
 * exactly when the purchase is intra-state, which is the same answer.
 */
export function poToDocument(po: PurchaseOrder, business: BusinessProfile, language = "en"): InvoiceType {
    const t = poTotals(po, businessState(business));
    const items = po.lines.map((l) => ({
        name: l.name,
        description: l.description || undefined,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        total: round2(l.quantity * l.unitPrice),
        hsn: l.hsn || undefined,
        gstRate: po.gstEnabled ? l.taxRate : undefined,
        productId: l.productId,
        unit: l.unit,
    }));
    const doc = {
        sender: {
            name: business.name.slice(0, 50),
            address: business.address.slice(0, 70),
            zipCode: business.zipCode,
            city: business.city,
            country: business.country,
            email: business.email,
            phone: business.phone,
            gstin: business.gstin || undefined,
        },
        receiver: {
            name: po.supplier.name.slice(0, 50),
            address: po.supplier.address.slice(0, 70),
            zipCode: po.supplier.zipCode,
            city: po.supplier.city,
            country: po.supplier.country,
            email: po.supplier.email,
            phone: po.supplier.phone,
            gstin: po.supplier.gstin || undefined,
        },
        details: {
            invoiceNumber: po.number,
            invoiceDate: po.date,
            dueDate: po.expectedDate || po.date,
            currency: po.currency,
            language,
            items,
            subTotal: t.subTotal,
            totalAmount: t.total,
            totalAmountInWords: formatPriceToString(t.total, po.currency),
            paymentTerms: po.paymentTerms || "As agreed",
            additionalNotes: po.notes || undefined,
            terms: po.terms || undefined,
            discountDetails: { amount: po.discount.value, amountType: po.discount.type },
            shippingDetails: { cost: po.freight, costType: "amount" },
            ...(po.gstEnabled ? { gst: { enabled: true, pricing: "exclusive" as const, placeOfSupply: po.supplier.state } } : {}),
            pdfTemplate: 1,
        },
    };
    return doc as unknown as InvoiceType;
}

/**
 * What stops this PO from rendering to a PDF, as `["sender.address", …]`.
 * Empty means it is ready. Reported by field so the UI can say which party
 * (your Business Profile or the supplier) needs completing.
 */
export function poPdfIssues(po: PurchaseOrder, business: BusinessProfile): string[] {
    const parsed = InvoiceSchema.safeParse(poToDocument(po, business));
    if (parsed.success) return [];
    const seen = new Set<string>();
    for (const issue of parsed.error.issues) {
        const [scope, field] = issue.path.map(String);
        if (scope === "sender" || scope === "receiver") seen.add(`${scope}.${field}`);
        else if (scope === "details" && field === "gst") seen.add("gst");
        else seen.add(issue.path.map(String).join("."));
    }
    return [...seen];
}

export const purchaseOrderFilename = (number: string) => `purchase-order-${number.replace(/[^\w.-]+/g, "_")}.pdf`;
