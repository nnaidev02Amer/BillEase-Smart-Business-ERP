/**
 * Supplier payments: pure logic, no React and no storage.
 *
 * A supplier payment is money you paid out. It is a record in its own right,
 * and what it settles is expressed as ALLOCATIONS: "this much of this payment
 * went to that bill". One payment can settle several bills, and one bill can be
 * settled by several payments.
 *
 * ADVANCES
 *   Whatever part of a payment is not allocated to a bill is an advance (or a
 *   payment toward an opening balance owed from before you used the app). It is
 *   still money out, still counts as cash paid, and can be allocated to a bill
 *   later, so nothing has to be forced onto a bill it does not belong to.
 *
 * RULES
 *   - Allocations are to posted bills of the same supplier and the same
 *     currency; money is never added across currencies.
 *   - A bill can never be allocated more than it still owes.
 *   - The allocations of a payment never add up to more than the payment.
 *   - A void payment keeps its record but settles nothing and counts nowhere:
 *     its allocations are ignored, so the bills it had paid are owed again.
 */

import { isNumberTaken } from "@/lib/docNumbers";
import { decimalsOf, isValidDay } from "@/lib/expenses";
import { PAYMENT_METHODS, toCsv } from "@/lib/invoiceRecords";
import { stripControlChars } from "@/lib/schemas";

export const PAYMENT_STATUSES = ["posted", "void"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export type Allocation = { billId: string; amount: number };

export type SupplierPayment = {
    id: string;
    number: string;
    supplierId: string;
    supplierName: string;
    /** yyyy-mm-dd */
    date: string;
    currency: string;
    amount: number;
    method: PaymentMethod;
    /** A cheque number, bank reference or UTR. */
    reference: string;
    note: string;
    allocations: Allocation[];
    status: PaymentStatus;
    voidedAt?: string;
    voidReason?: string;
    createdAt: string;
    updatedAt: string;
};

export const MAX_SUPPLIER_PAYMENTS = 50_000;
export const MAX_PAYMENT_AMOUNT = 1e12;

const clip = (v: unknown, max: number) => (typeof v === "string" ? stripControlChars(v).trim().slice(0, max) : "");
const num = (v: unknown): number => {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/,/g, ""));
    return Number.isFinite(n) ? n : NaN;
};
export const roundTo = (n: number, currency: string) => {
    const f = 10 ** decimalsOf(currency);
    return Math.round((n + Number.EPSILON) * f) / f;
};

/* -------------------------------------------------------------- sanitise */

/**
 * Rebuilds a well-formed payment from anything, or returns null. A payment whose
 * allocations add up to more than it paid is not repaired (that would invent a
 * figure), it is rejected, so a damaged file cannot make money appear.
 */
export function sanitizeSupplierPayment(input: unknown): SupplierPayment | null {
    if (!input || typeof input !== "object") return null;
    const o = input as Record<string, unknown>;
    const id = clip(o.id, 64);
    const number = clip(o.number, 40);
    const supplierId = clip(o.supplierId, 64);
    const date = typeof o.date === "string" && isValidDay(o.date) ? o.date : "";
    const status = PAYMENT_STATUSES.find((s) => s === o.status);
    const currency = clip(o.currency, 3).toUpperCase();
    if (!id || !number || !supplierId || !date || !status || !/^[A-Z]{3}$/.test(currency)) return null;

    const amountRaw = num(o.amount);
    if (!Number.isFinite(amountRaw) || amountRaw <= 0 || amountRaw > MAX_PAYMENT_AMOUNT) return null;
    const amount = roundTo(amountRaw, currency);
    if (amount <= 0) return null;

    const byBill = new Map<string, number>();
    for (const a of Array.isArray(o.allocations) ? o.allocations : []) {
        if (!a || typeof a !== "object") continue;
        const billId = clip((a as Record<string, unknown>).billId, 64);
        const value = num((a as Record<string, unknown>).amount);
        if (!billId || !Number.isFinite(value) || value <= 0) continue;
        byBill.set(billId, roundTo((byBill.get(billId) ?? 0) + value, currency));
    }
    const allocations = [...byBill.entries()].map(([billId, value]) => ({ billId, amount: value }));
    if (roundTo(allocations.reduce((s, a) => s + a.amount, 0), currency) > amount) return null;

    const now = new Date().toISOString();
    const voidedAt = typeof o.voidedAt === "string" ? o.voidedAt : "";
    const voidReason = clip(o.voidReason, 300);
    return {
        id,
        number,
        supplierId,
        supplierName: clip(o.supplierName, 120),
        date,
        currency,
        amount,
        method: PAYMENT_METHODS.find((m) => m === o.method) ?? "other",
        reference: clip(o.reference, 80),
        note: clip(o.note, 1000),
        allocations,
        status,
        ...(status === "void" && voidedAt ? { voidedAt } : {}),
        ...(status === "void" && voidReason ? { voidReason } : {}),
        createdAt: typeof o.createdAt === "string" ? o.createdAt : now,
        updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : now,
    };
}

/* ------------------------------------------------------------ allocations */

/** The part of a payment not allocated to any bill (an advance). Zero for a void payment. */
export const unallocated = (p: Pick<SupplierPayment, "amount" | "allocations" | "status" | "currency">) =>
    p.status === "void" ? 0 : roundTo(Math.max(0, p.amount - p.allocations.reduce((s, a) => s + a.amount, 0)), p.currency);

/** Everything allocated to a bill by posted payments, optionally leaving one payment out. */
export function allocatedTo(payments: SupplierPayment[], billId: string, exceptPaymentId?: string): number {
    let total = 0;
    let currency = "";
    for (const p of payments) {
        if (p.status !== "posted" || p.id === exceptPaymentId) continue;
        for (const a of p.allocations) {
            if (a.billId === billId) {
                total += a.amount;
                currency = p.currency;
            }
        }
    }
    return currency ? roundTo(total, currency) : 0;
}

export type OpenBill = { id: string; dueDate: string; outstanding: number };

/**
 * Settles the oldest-due bills first with `amount`. Returns the allocations and
 * what is left over (the advance). Bills are taken in due-date order, ties by id.
 */
export function allocateOldestFirst(amount: number, bills: OpenBill[], currency: string): { allocations: Allocation[]; remainder: number } {
    let left = roundTo(amount, currency);
    const allocations: Allocation[] = [];
    for (const b of [...bills].sort((x, y) => x.dueDate.localeCompare(y.dueDate) || x.id.localeCompare(y.id))) {
        if (left <= 0) break;
        if (b.outstanding <= 0) continue;
        const take = roundTo(Math.min(left, b.outstanding), currency);
        allocations.push({ billId: b.id, amount: take });
        left = roundTo(left - take, currency);
    }
    return { allocations, remainder: left };
}

/* ------------------------------------------------------------- validation */

export type PaymentErrors = {
    supplier?: string;
    date?: string;
    amount?: string;
    currency?: string;
    method?: string;
    number?: string;
    allocations?: string;
    /** bill id → error code */
    allocationErrors: Record<string, string>;
};

export type PaymentDraft = {
    number: string;
    supplierId: string;
    date: string;
    currency: string;
    amount: number;
    method: string;
    allocations: Allocation[];
};

export const hasPaymentErrors = (e: PaymentErrors) => Object.entries(e).some(([k, v]) => (k === "allocationErrors" ? Object.keys(v as object).length > 0 : Boolean(v)));

type BillView = { id: string; supplierId: string; currency: string; status: string };

/**
 * Error codes are `payables.errors.<code>` keys in the locale files.
 * `outstandingOf(billId)` is what the bill still owes with this payment's own
 * allocations taken out, so editing a payment does not count it against itself.
 */
export function validateSupplierPayment(
    draft: PaymentDraft,
    ctx: { suppliers: { id: string }[]; bills: BillView[]; payments: SupplierPayment[]; outstandingOf: (billId: string) => number },
    id?: string
): PaymentErrors {
    const errors: PaymentErrors = { allocationErrors: {} };
    if (!draft.supplierId || !ctx.suppliers.some((s) => s.id === draft.supplierId)) errors.supplier = "supplierRequired";
    if (!isValidDay(draft.date)) errors.date = "dateInvalid";
    if (!/^[A-Z]{3}$/.test(draft.currency)) errors.currency = "currencyInvalid";
    if (!(draft.amount > 0) || draft.amount > MAX_PAYMENT_AMOUNT) errors.amount = "amountInvalid";
    if (!PAYMENT_METHODS.some((m) => m === draft.method)) errors.method = "methodInvalid";
    const number = draft.number.trim();
    if (number && isNumberTaken(number, ctx.payments, id)) errors.number = "numberTaken";

    const seen = new Set<string>();
    let total = 0;
    for (const a of draft.allocations) {
        const bill = ctx.bills.find((b) => b.id === a.billId);
        if (seen.has(a.billId)) errors.allocationErrors[a.billId] = "duplicateAllocation";
        else if (!bill) errors.allocationErrors[a.billId] = "billNotFound";
        else if (bill.status !== "posted") errors.allocationErrors[a.billId] = "billNotPosted";
        else if (bill.supplierId !== draft.supplierId) errors.allocationErrors[a.billId] = "billOtherSupplier";
        else if (bill.currency !== draft.currency) errors.allocationErrors[a.billId] = "billOtherCurrency";
        else if (!(a.amount > 0)) errors.allocationErrors[a.billId] = "allocationInvalid";
        else if (a.amount > ctx.outstandingOf(a.billId) + 1e-9) errors.allocationErrors[a.billId] = "overBill";
        seen.add(a.billId);
        total += a.amount;
    }
    if (roundTo(total, draft.currency || "INR") > draft.amount + 1e-9) errors.allocations = "overPayment";
    return errors;
}

/* ------------------------------------------------------------------ query */

export type PaymentQuery = { q: string; status: PaymentStatus | "all"; supplierId: string };
export const EMPTY_PAYMENT_QUERY: PaymentQuery = { q: "", status: "all", supplierId: "" };

export function querySupplierPayments(list: SupplierPayment[], query: PaymentQuery): SupplierPayment[] {
    const q = query.q.trim().toLowerCase();
    return list
        .filter((p) => query.status === "all" || p.status === query.status)
        .filter((p) => !query.supplierId || p.supplierId === query.supplierId)
        .filter((p) => !q || [p.number, p.supplierName, p.reference].some((f) => f.toLowerCase().includes(q)))
        .sort((a, b) => (a.date === b.date ? b.number.localeCompare(a.number) : b.date.localeCompare(a.date)));
}

export function supplierPaymentsCsv(list: SupplierPayment[]): string {
    return toCsv(
        ["Payment #", "Status", "Supplier", "Date", "Method", "Reference", "Currency", "Amount", "Allocated", "Advance"],
        list.map((p) => [p.number, p.status, p.supplierName, p.date, p.method, p.reference, p.currency, p.amount, roundTo(p.allocations.reduce((s, a) => s + a.amount, 0), p.currency), unallocated(p)])
    );
}

/** Merge for backup restore: ids held are kept; a clashing number is renumbered, never dropped. */
export function mergeSupplierPayments(existing: SupplierPayment[], incoming: SupplierPayment[], remapSupplier: Map<string, string>, renumber: (taken: string[]) => string) {
    const list = [...existing];
    const ids = new Set(existing.map((p) => p.id));
    let added = 0;
    let skipped = 0;
    let renumbered = 0;
    for (const raw of incoming) {
        if (ids.has(raw.id) || list.length >= MAX_SUPPLIER_PAYMENTS) {
            skipped++;
            continue;
        }
        let p = { ...raw, supplierId: remapSupplier.get(raw.supplierId) ?? raw.supplierId };
        if (isNumberTaken(p.number, list)) {
            p = { ...p, number: renumber(list.map((x) => x.number)) };
            renumbered++;
        }
        list.push(p);
        ids.add(p.id);
        added++;
    }
    return { list, added, skipped, renumbered };
}
