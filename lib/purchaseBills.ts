/**
 * Purchase bills: pure logic, no React and no storage.
 *
 * A purchase bill is the supplier's invoice to you. Posting it is the moment
 * the money becomes owed: it feeds payables and, for profit and loss, it is
 * the cost of the purchase. (A purchase order commits nothing, and a goods
 * receipt moves stock but is not a debt; only the bill is.)
 *
 * MONEY IS DERIVED
 *   Totals come from the lines through the same GST engine as purchase orders
 *   and invoices (`poTotals`), never from stored figures, so the order, the bill
 *   and the books cannot disagree. How much has been paid, and so whether the
 *   bill is unpaid, partly paid, paid or overdue, is derived from supplier
 *   payments (lib/payables) and is never stored.
 *
 * STATUS
 *   Stored (user-chosen):  draft · posted · cancelled
 *   Derived for display:   unpaid · partial · paid · overdue (see lib/payables)
 *   Only a draft can be edited. A posted bill is a record of something owed;
 *   to change it, send it back to draft first, which is only possible while
 *   nothing has been paid against it.
 *
 * THREE-WAY MATCH
 *   When a bill is for a purchase order, each line is compared with what was
 *   ordered, what was actually received, and what earlier bills already
 *   charged. A difference is a WARNING to confirm, not an error: suppliers
 *   bill for freight, rounding and part deliveries all the time. Nothing here
 *   blocks a bill; it makes sure the user has seen the difference.
 *
 * INPUT TAX CREDIT
 *   `itcEligible` records whether the GST on the bill can be set against the GST
 *   you collected. It decides whether that tax counts as a cost in profit and
 *   loss. Claiming it (GSTR-3B) is a later step; this only carries the flag.
 */

import { isNumberTaken } from "@/lib/docNumbers";
import { decimalsOf, isValidDay, toDay } from "@/lib/expenses";
import { validateHsnSac } from "@/lib/gst";
import { toCsv } from "@/lib/invoiceRecords";
import { stripControlChars } from "@/lib/schemas";
import { accepted, type GoodsReceipt } from "@/lib/goodsReceipts";
import {
    MAX_AMOUNT,
    MAX_PO_LINES,
    poTotals,
    round2,
    round3,
    sanitizeLine,
    sanitizeSnapshot,
    type PoLine,
    type PoTotals,
    type PurchaseOrder,
    type SupplierSnapshot,
} from "@/lib/purchaseOrders";
import type { Expense } from "@/lib/expenses";


/* ------------------------------------------------------------------ types */

export const BILL_STATUSES = ["draft", "posted", "cancelled"] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

export type BillLine = PoLine & {
    /** The purchase-order line this bills, if the bill is for an order. */
    poLineId?: string;
};

export type BillEvent = { at: string; kind: "created" | "edited" | BillStatus };

export type PurchaseBill = {
    id: string;
    /** Your own reference for it: PB-0001. */
    number: string;
    /** The number printed on the supplier's invoice. */
    supplierBillNo: string;
    supplierId: string;
    supplier: SupplierSnapshot;
    poId?: string;
    poNumber?: string;
    /** Receipts this bill was made from, kept for reference. */
    grnIds: string[];
    /** yyyy-mm-dd */
    billDate: string;
    /** yyyy-mm-dd */
    dueDate: string;
    currency: string;
    lines: BillLine[];
    discount: { type: "amount" | "percentage"; value: number };
    freight: number;
    gstEnabled: boolean;
    /** Whether the GST on this bill can be claimed as input tax credit. */
    itcEligible: boolean;
    notes: string;
    status: BillStatus;
    log: BillEvent[];
    createdAt: string;
    updatedAt: string;
};

export const MAX_PURCHASE_BILLS = 20_000;

const clip = (v: unknown, max: number) => (typeof v === "string" ? stripControlChars(v).trim().slice(0, max) : "");
const num = (v: unknown, min: number, max: number, fallback = 0): number => {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/,/g, ""));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const day = (v: unknown) => (typeof v === "string" && isValidDay(v) ? v : "");

/* -------------------------------------------------------------- sanitise */

export function sanitizeBillLine(input: unknown): BillLine | null {
    const base = sanitizeLine(input);
    if (!base) return null;
    const poLineId = clip((input as Record<string, unknown>).poLineId, 64);
    return { ...base, ...(poLineId ? { poLineId } : {}) };
}

export function sanitizePurchaseBill(input: unknown): PurchaseBill | null {
    if (!input || typeof input !== "object") return null;
    const o = input as Record<string, unknown>;
    const id = clip(o.id, 64);
    const number = clip(o.number, 40);
    const supplierId = clip(o.supplierId, 64);
    const billDate = day(o.billDate);
    const dueDate = day(o.dueDate);
    const status = BILL_STATUSES.find((s) => s === o.status);
    if (!id || !number || !supplierId || !billDate || !dueDate || !status) return null;

    const lines = (Array.isArray(o.lines) ? o.lines : [])
        .slice(0, MAX_PO_LINES)
        .map(sanitizeBillLine)
        .filter((l): l is BillLine => l !== null);
    const d = (o.discount && typeof o.discount === "object" ? o.discount : {}) as Record<string, unknown>;
    const type = d.type === "percentage" ? "percentage" : "amount";
    const currency = clip(o.currency, 3).toUpperCase();
    const poId = clip(o.poId, 64);
    const poNumber = clip(o.poNumber, 40);
    const now = new Date().toISOString();
    const log = (Array.isArray(o.log) ? o.log : [])
        .slice(-50)
        .map((e): BillEvent | null => {
            if (!e || typeof e !== "object") return null;
            const ev = e as Record<string, unknown>;
            const kind = ev.kind === "created" || ev.kind === "edited" ? ev.kind : BILL_STATUSES.find((s) => s === ev.kind);
            return kind && typeof ev.at === "string" ? { at: ev.at, kind } : null;
        })
        .filter((e): e is BillEvent => e !== null);

    return {
        id,
        number,
        supplierBillNo: clip(o.supplierBillNo, 60),
        supplierId,
        supplier: sanitizeSnapshot(o.supplier),
        ...(poId ? { poId } : {}),
        ...(poId && poNumber ? { poNumber } : {}),
        grnIds: (Array.isArray(o.grnIds) ? o.grnIds : []).map((g) => clip(g, 64)).filter(Boolean).slice(0, 50),
        billDate,
        dueDate,
        currency: /^[A-Z]{3}$/.test(currency) ? currency : "INR",
        lines,
        discount: { type, value: round2(num(d.value, 0, type === "percentage" ? 100 : MAX_AMOUNT)) },
        freight: round2(num(o.freight, 0, MAX_AMOUNT)),
        gstEnabled: o.gstEnabled !== false,
        itcEligible: o.itcEligible !== false,
        notes: clip(o.notes, 2000),
        status,
        log,
        createdAt: typeof o.createdAt === "string" ? o.createdAt : now,
        updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : now,
    };
}

/* ----------------------------------------------------------------- totals */

/** Totals of a bill, with the same intra/inter-state logic and rounding as a purchase order. */
export const billTotals = (bill: Pick<PurchaseBill, "lines" | "discount" | "freight" | "gstEnabled" | "currency" | "supplier">, buyerState: string): PoTotals => poTotals(bill, buyerState);

export type BillAmounts = { total: number; tax: number; taxable: number; recoverableTax: number };

/** What a bill is worth, and how much of its tax counts as claimable input tax credit. */
export function billAmounts(bill: PurchaseBill, buyerState: string): BillAmounts {
    const t = billTotals(bill, buyerState);
    return { total: t.total, tax: t.totalTax, taxable: t.taxableValue, recoverableTax: bill.gstEnabled && bill.itcEligible ? t.totalTax : 0 };
}

/* ------------------------------------------------------------- validation */

export type BillLineField = "name" | "quantity" | "unitPrice" | "taxRate" | "hsn";
export type BillErrors = {
    supplier?: string;
    supplierBillNo?: string;
    billDate?: string;
    dueDate?: string;
    number?: string;
    currency?: string;
    lines?: string;
    discount?: string;
    freight?: string;
    /** line id → field → error code */
    lineErrors: Record<string, Partial<Record<BillLineField, string>>>;
};

export type BillDraft = Pick<PurchaseBill, "supplierId" | "supplierBillNo" | "billDate" | "dueDate" | "currency" | "lines" | "discount" | "freight" | "gstEnabled"> & { number: string };

export const hasBillErrors = (e: BillErrors) => Object.entries(e).some(([k, v]) => (k === "lineErrors" ? Object.keys(v as object).length > 0 : Boolean(v)));

/** Error codes are `purchaseBills.errors.<code>` keys in the locale files. */
export function validatePurchaseBill(draft: BillDraft, suppliers: { id: string }[], existing: PurchaseBill[], id?: string): BillErrors {
    const errors: BillErrors = { lineErrors: {} };
    if (!draft.supplierId || !suppliers.some((s) => s.id === draft.supplierId)) errors.supplier = "supplierRequired";

    const ref = clip(draft.supplierBillNo, 60);
    if (!ref) errors.supplierBillNo = "supplierBillNoRequired";
    else if (existing.some((b) => b.id !== id && b.status !== "cancelled" && b.supplierId === draft.supplierId && b.supplierBillNo.toLowerCase() === ref.toLowerCase())) {
        // The same supplier invoice entered twice is how a bill gets paid twice.
        errors.supplierBillNo = "supplierBillNoTaken";
    }

    if (!isValidDay(draft.billDate)) errors.billDate = "dateInvalid";
    if (!isValidDay(draft.dueDate)) errors.dueDate = "dateInvalid";
    else if (isValidDay(draft.billDate) && draft.dueDate < draft.billDate) errors.dueDate = "dueBeforeBill";

    const number = draft.number.trim();
    if (number && isNumberTaken(number, existing, id)) errors.number = "numberTaken";
    if (!/^[A-Z]{3}$/.test(draft.currency)) errors.currency = "currencyInvalid";

    if (draft.lines.length === 0) errors.lines = "linesRequired";
    else if (draft.lines.length > MAX_PO_LINES) errors.lines = "linesLimit";
    for (const l of draft.lines) {
        const e: Partial<Record<BillLineField, string>> = {};
        if (!clip(l.name, 120)) e.name = "nameRequired";
        if (!(l.quantity > 0) || l.quantity > 1e9) e.quantity = "quantityInvalid";
        if (!(l.unitPrice > 0) || l.unitPrice > MAX_AMOUNT) e.unitPrice = "priceInvalid";
        if (!(l.taxRate >= 0 && l.taxRate <= 100)) e.taxRate = "rateInvalid";
        if (!validateHsnSac(l.hsn).valid) e.hsn = "hsnInvalid";
        if (Object.keys(e).length) errors.lineErrors[l.id] = e;
    }
    if (draft.discount.type === "percentage" ? !(draft.discount.value >= 0 && draft.discount.value <= 100) : !(draft.discount.value >= 0)) errors.discount = "discountInvalid";
    if (!(draft.freight >= 0 && draft.freight <= MAX_AMOUNT)) errors.freight = "freightInvalid";
    return errors;
}

/* ------------------------------------------------------------------ status */

const TRANSITIONS: Record<BillStatus, BillStatus[]> = {
    draft: ["posted", "cancelled"],
    posted: ["draft", "cancelled"],
    cancelled: ["draft"],
};

/** `hasPayments`: money has been paid against it, so it can only be left as it is. */
export function canTransition(from: BillStatus, to: BillStatus, { hasPayments = false }: { hasPayments?: boolean } = {}): boolean {
    if (!TRANSITIONS[from].includes(to)) return false;
    return !(hasPayments && (to === "draft" || to === "cancelled"));
}

export const canEdit = (bill: Pick<PurchaseBill, "status">) => bill.status === "draft";

/** A draft or cancelled bill that nothing has been paid against can be deleted. */
export const canDelete = (bill: Pick<PurchaseBill, "status">, { hasPayments = false }: { hasPayments?: boolean } = {}) =>
    !hasPayments && (bill.status === "draft" || bill.status === "cancelled");

/** Posted bills are what is owed and what counts as cost. Drafts and cancelled bills are neither. */
export const counts = (bill: Pick<PurchaseBill, "status">) => bill.status === "posted";

/* ------------------------------------------------------ three-way match */

/** Quantity already billed per purchase-order line, over posted bills (optionally leaving one out). */
export function billedByLine(bills: PurchaseBill[], poId: string, exceptBillId?: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const b of bills) {
        if (b.poId !== poId || b.status !== "posted" || b.id === exceptBillId) continue;
        for (const l of b.lines) if (l.poLineId) out.set(l.poLineId, round3((out.get(l.poLineId) ?? 0) + l.quantity));
    }
    return out;
}

export type MatchKind = "lineNotOnOrder" | "noReceipts" | "qtyOverReceived" | "qtyOverOrdered" | "priceDiffersFromOrder";
export type MatchIssue = {
    kind: MatchKind;
    lineId: string;
    name: string;
    /** Quantity this bill charges, with earlier bills for the same order line. */
    billed?: number;
    received?: number;
    ordered?: number;
    billPrice?: number;
    orderPrice?: number;
};

const PRICE_TOLERANCE = 0.005;

/**
 * Differences between a bill and the order and receipts behind it. Empty for a
 * bill with no order (a direct bill has nothing to be matched against), and for
 * a bill that matches. Each issue is something to look at, not a rule broken.
 *
 *   received  accepted quantity per order line from posted receipts
 *   billedBefore  quantity already billed per order line by other posted bills
 */
export function matchBill(bill: Pick<PurchaseBill, "lines" | "poId">, po: Pick<PurchaseOrder, "lines"> | undefined, received: Map<string, number>, billedBefore: Map<string, number>): MatchIssue[] {
    if (!bill.poId || !po) return [];
    const issues: MatchIssue[] = [];
    const orderLines = new Map(po.lines.map((l) => [l.id, l]));
    const anyReceived = [...received.values()].some((q) => q > 0);

    // Several bill lines can charge the same order line; the quantities add up.
    const thisBill = new Map<string, number>();
    for (const l of bill.lines) if (l.poLineId) thisBill.set(l.poLineId, round3((thisBill.get(l.poLineId) ?? 0) + l.quantity));

    if (!anyReceived && bill.lines.length > 0) issues.push({ kind: "noReceipts", lineId: "", name: "" });

    const reported = new Set<string>();
    for (const l of bill.lines) {
        const pl = l.poLineId ? orderLines.get(l.poLineId) : undefined;
        if (!pl) {
            issues.push({ kind: "lineNotOnOrder", lineId: l.id, name: l.name });
            continue;
        }
        const billed = round3((billedBefore.get(pl.id) ?? 0) + (thisBill.get(pl.id) ?? 0));
        const got = received.get(pl.id) ?? 0;
        if (!reported.has(pl.id)) {
            reported.add(pl.id);
            if (anyReceived && billed > got) issues.push({ kind: "qtyOverReceived", lineId: l.id, name: l.name, billed, received: got });
            if (billed > pl.quantity) issues.push({ kind: "qtyOverOrdered", lineId: l.id, name: l.name, billed, ordered: pl.quantity });
        }
        if (Math.abs(l.unitPrice - pl.unitPrice) > PRICE_TOLERANCE) {
            issues.push({ kind: "priceDiffersFromOrder", lineId: l.id, name: l.name, billPrice: l.unitPrice, orderPrice: pl.unitPrice });
        }
    }
    return issues;
}

/* --------------------------------------------------- lines to start from */

/**
 * Bill lines for an order: what has been received and not yet billed, at the
 * order's prices. Lines with nothing left to bill are left out.
 */
export function linesFromOrder(po: Pick<PurchaseOrder, "lines">, received: Map<string, number>, billed: Map<string, number>, newId: () => string): BillLine[] {
    const out: BillLine[] = [];
    for (const l of po.lines) {
        const qty = round3(Math.max(0, (received.get(l.id) ?? 0) - (billed.get(l.id) ?? 0)));
        if (qty <= 0) continue;
        out.push({ ...l, id: newId(), poLineId: l.id, quantity: qty });
    }
    return out;
}

/** Bill lines from one receipt: what was accepted, at the price on the receipt. */
export function linesFromReceipt(grn: GoodsReceipt, po: Pick<PurchaseOrder, "lines"> | undefined, rateFor: (productId: string | undefined) => number, newId: () => string): BillLine[] {
    const orderLines = new Map((po?.lines ?? []).map((l) => [l.id, l]));
    const out: BillLine[] = [];
    for (const l of grn.lines) {
        const qty = accepted(l);
        if (qty <= 0) continue;
        const pl = l.poLineId ? orderLines.get(l.poLineId) : undefined;
        out.push({
            id: newId(),
            ...(l.productId ? { productId: l.productId } : {}),
            ...(pl ? { poLineId: pl.id } : {}),
            name: l.name,
            description: "",
            hsn: pl?.hsn ?? "",
            unit: l.unit,
            quantity: qty,
            unitPrice: l.unitPrice > 0 ? l.unitPrice : pl?.unitPrice ?? 0,
            taxRate: pl?.taxRate ?? rateFor(l.productId),
        });
    }
    return out;
}

/* ------------------------------------------------------ expense overlap */

/**
 * Manual expenses that look like the same spend as this bill: same currency,
 * same supplier name as the vendor, and the same total. Suggestions for the
 * user to confirm, never linked automatically: only they know.
 */
export function expenseCandidates(bill: Pick<PurchaseBill, "supplier" | "currency" | "id">, total: number, expenses: Expense[]): Expense[] {
    const name = bill.supplier.name.trim().toLowerCase();
    const dec = decimalsOf(bill.currency);
    const eq = (a: number, b: number) => Math.abs(a - b) < 0.5 / 10 ** dec;
    return expenses.filter((e) => e.currency === bill.currency && (!e.billId || e.billId === bill.id) && !!name && e.vendor.trim().toLowerCase() === name && eq(e.amount, total));
}

/* ------------------------------------------------------------------ query */

export type BillQuery = { q: string; status: BillStatus | "all"; supplierId: string };
export const EMPTY_BILL_QUERY: BillQuery = { q: "", status: "all", supplierId: "" };

export function queryPurchaseBills(list: PurchaseBill[], query: BillQuery, display?: (b: PurchaseBill) => string): PurchaseBill[] {
    const q = query.q.trim().toLowerCase();
    return list
        .filter((b) => query.status === "all" || b.status === query.status)
        .filter((b) => !query.supplierId || b.supplierId === query.supplierId)
        .filter((b) => !q || [b.number, b.supplierBillNo, b.supplier.name, b.poNumber ?? ""].some((f) => f.toLowerCase().includes(q)) || b.lines.some((l) => l.name.toLowerCase().includes(q)) || (display?.(b) ?? "").includes(q))
        .sort((a, b) => (a.billDate === b.billDate ? b.number.localeCompare(a.number) : b.billDate.localeCompare(a.billDate)));
}

export function purchaseBillsCsv(list: PurchaseBill[], buyerState: string): string {
    return toCsv(
        ["Bill #", "Supplier bill no.", "Status", "Supplier", "Supplier GSTIN", "PO #", "Bill date", "Due date", "Currency", "Taxable value", "Tax", "Claimable tax", "Freight", "Total"],
        list.map((b) => {
            const a = billAmounts(b, buyerState);
            const t = billTotals(b, buyerState);
            return [b.number, b.supplierBillNo, b.status, b.supplier.name, b.supplier.gstin, b.poNumber ?? "", b.billDate, b.dueDate, b.currency, a.taxable, a.tax, a.recoverableTax, t.shippingAmount, a.total];
        })
    );
}

/** Merge for backup restore: ids held are kept; a clashing number is renumbered, never dropped. */
export function mergePurchaseBills(existing: PurchaseBill[], incoming: PurchaseBill[], remapSupplier: Map<string, string>, renumber: (taken: string[]) => string) {
    const list = [...existing];
    const ids = new Set(existing.map((b) => b.id));
    let added = 0;
    let skipped = 0;
    let renumbered = 0;
    for (const raw of incoming) {
        if (ids.has(raw.id) || list.length >= MAX_PURCHASE_BILLS) {
            skipped++;
            continue;
        }
        let b = { ...raw, supplierId: remapSupplier.get(raw.supplierId) ?? raw.supplierId };
        if (isNumberTaken(b.number, list)) {
            b = { ...b, number: renumber(list.map((x) => x.number)) };
            renumbered++;
        }
        list.push(b);
        ids.add(b.id);
        added++;
    }
    return { list, added, skipped, renumbered };
}

/** `dueDate` for a bill: the bill date plus the supplier's payment terms. */
export function dueDateFor(billDate: string, termsDays: number): string {
    const [y, m, d] = billDate.split("-").map(Number);
    return toDay(new Date(y, m - 1, d + Math.max(0, termsDays)));
}
