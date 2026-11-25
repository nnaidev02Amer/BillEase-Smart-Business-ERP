/**
 * Payables: what you owe suppliers. Pure logic, derived entirely from the saved
 * bills, payments and suppliers, so it can never disagree with them.
 *
 * DEFINITIONS (stated once, so every screen agrees)
 *   owed on a bill   bill total − what posted payments have allocated to it
 *   overdue          the owed part of a posted bill whose due date has passed
 *   advance          money paid to a supplier and not (yet) allocated to a bill
 *   net payable      opening balance + owed on bills − advances. This is the
 *                    figure a supplier statement would show.
 *   cash paid        every posted payment, by payment date, allocated or not
 *
 * Money is never added across currencies: every figure here is per currency.
 * Draft and cancelled bills, and void payments, count nowhere.
 *
 * PROFIT AND LOSS
 *   The two views of profit differ on purpose and each is computed its own way
 *     invoice basis   a posted bill is a COST on its bill date, whether or not
 *                     it has been paid, less the tax you can claim back
 *     cash basis      money leaves when a PAYMENT is made, on the payment date
 *   A manual expense the user has linked to a posted bill is the same spend, so
 *   it is left out of profit and loss while the bill counts (`reconcileExpenses`).
 */

import { decimalsOf, inRange, type Expense } from "@/lib/expenses";
import { roundMoney } from "@/lib/calculations";
import { daysBetween, parseDate, startOfDay } from "@/lib/invoiceRecords";
import { billAmounts, type PurchaseBill } from "@/lib/purchaseBills";
import { allocatedTo, unallocated, type SupplierPayment } from "@/lib/supplierPayments";
import type { Supplier } from "@/lib/suppliers";

/* ------------------------------------------------------------------ bills */

export type BillDisplayStatus = "draft" | "cancelled" | "unpaid" | "partial" | "paid" | "overdue";

/** A bill's total. It does not depend on the buyer's state, only its tax split does. */
export const billTotal = (b: PurchaseBill) => billAmounts(b, "").total;

export const paidOn = (b: PurchaseBill, payments: SupplierPayment[]) => allocatedTo(payments, b.id);

/** What a bill still owes. Zero for a draft or cancelled bill, which owe nothing. */
export function owedOn(b: PurchaseBill, payments: SupplierPayment[]): number {
    if (b.status !== "posted") return 0;
    return roundMoney(Math.max(0, billTotal(b) - paidOn(b, payments)), decimalsOf(b.currency));
}

const dayOf = (v: string) => parseDate(v);

/** Days past the due date (positive), or days still to go (negative or zero). */
export function daysOverdue(b: Pick<PurchaseBill, "dueDate">, now: Date = new Date()): number {
    const due = dayOf(b.dueDate);
    return due ? daysBetween(due, startOfDay(now)) : 0;
}

export function billDisplayStatus(b: PurchaseBill, payments: SupplierPayment[], now: Date = new Date()): BillDisplayStatus {
    if (b.status !== "posted") return b.status;
    const owed = owedOn(b, payments);
    if (owed <= 0) return "paid";
    if (daysOverdue(b, now) > 0) return "overdue";
    return paidOn(b, payments) > 0 ? "partial" : "unpaid";
}

/** Whether any posted payment has been allocated to the bill. */
export const hasPayments = (b: Pick<PurchaseBill, "id">, payments: SupplierPayment[]) => allocatedTo(payments, b.id) > 0;

/* ---------------------------------------------------------------- ageing */

export const AGEING_BUCKETS = ["current", "d1_30", "d31_60", "d61_90", "d90plus"] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

export function bucketOf(daysPastDue: number): AgeingBucket {
    if (daysPastDue <= 0) return "current";
    if (daysPastDue <= 30) return "d1_30";
    if (daysPastDue <= 60) return "d31_60";
    if (daysPastDue <= 90) return "d61_90";
    return "d90plus";
}

export type AgeingRow = { bucket: AgeingBucket; amount: number; count: number };
export type Ageing = { currency: string; rows: AgeingRow[]; total: number; overdue: number };

/** What is owed on posted bills, grouped by how far past due it is ("current" = not yet due). */
export function ageing(bills: PurchaseBill[], payments: SupplierPayment[], { currency, now = new Date() }: { currency: string; now?: Date }): Ageing {
    const dec = decimalsOf(currency);
    const rows = new Map<AgeingBucket, AgeingRow>(AGEING_BUCKETS.map((b) => [b, { bucket: b, amount: 0, count: 0 }]));
    for (const b of bills) {
        if (b.currency !== currency) continue;
        const owed = owedOn(b, payments);
        if (owed <= 0) continue;
        const row = rows.get(bucketOf(daysOverdue(b, now)))!;
        row.amount = roundMoney(row.amount + owed, dec);
        row.count += 1;
    }
    const list = AGEING_BUCKETS.map((k) => rows.get(k)!);
    const total = roundMoney(list.reduce((s, r) => s + r.amount, 0), dec);
    const current = rows.get("current")!.amount;
    return { currency, rows: list, total, overdue: roundMoney(total - current, dec) };
}

/* -------------------------------------------------------------- summary */

export type PayablesSummary = {
    currency: string;
    /** Owed on posted bills. */
    outstanding: number;
    overdue: number;
    overdueCount: number;
    /** Due within `soonDays`, not yet overdue. */
    dueSoon: number;
    dueSoonCount: number;
    /** Money paid and not allocated to any bill. */
    advances: number;
    /** Opening balances owed from before the app. */
    opening: number;
    /** What a statement would show: opening + outstanding − advances. */
    netPayable: number;
};

/** Per-currency totals for the dashboard and alerts. Currencies with nothing to show are left out. */
export function payablesSummary(suppliers: Supplier[], bills: PurchaseBill[], payments: SupplierPayment[], { now = new Date(), soonDays = 7 }: { now?: Date; soonDays?: number } = {}): PayablesSummary[] {
    const by = new Map<string, PayablesSummary>();
    const get = (currency: string) => {
        let s = by.get(currency);
        if (!s) by.set(currency, (s = { currency, outstanding: 0, overdue: 0, overdueCount: 0, dueSoon: 0, dueSoonCount: 0, advances: 0, opening: 0, netPayable: 0 }));
        return s;
    };
    for (const b of bills) {
        const owed = owedOn(b, payments);
        if (owed <= 0) continue;
        const s = get(b.currency);
        s.outstanding += owed;
        const late = daysOverdue(b, now);
        if (late > 0) {
            s.overdue += owed;
            s.overdueCount += 1;
        } else if (late >= -soonDays) {
            s.dueSoon += owed;
            s.dueSoonCount += 1;
        }
    }
    for (const p of payments) {
        const adv = unallocated(p);
        if (adv > 0) get(p.currency).advances += adv;
    }
    for (const s of suppliers) {
        if (s.openingBalance > 0) get(s.currency).opening += s.openingBalance;
    }
    return [...by.values()]
        .map((s) => {
            const r = (n: number) => roundMoney(n, decimalsOf(s.currency));
            const out = { ...s, outstanding: r(s.outstanding), overdue: r(s.overdue), dueSoon: r(s.dueSoon), advances: r(s.advances), opening: r(s.opening) };
            return { ...out, netPayable: r(out.opening + out.outstanding - out.advances) };
        })
        .filter((s) => s.outstanding > 0 || s.advances > 0 || s.opening > 0)
        .sort((a, b) => a.currency.localeCompare(b.currency));
}

/* ------------------------------------------------------------- suppliers */

export type SupplierBalance = {
    supplierId: string;
    supplierName: string;
    currency: string;
    opening: number;
    billed: number;
    paid: number;
    advances: number;
    outstanding: number;
    overdue: number;
    netPayable: number;
    /** The earliest due date among bills still owing, or "". */
    nextDue: string;
};

/** One row per supplier and currency, for suppliers with any dealings. */
export function supplierBalances(suppliers: Supplier[], bills: PurchaseBill[], payments: SupplierPayment[], { now = new Date() }: { now?: Date } = {}): SupplierBalance[] {
    const rows = new Map<string, SupplierBalance>();
    const key = (id: string, cur: string) => `${id}\u0000${cur}`;
    const names = new Map(suppliers.map((s) => [s.id, s.name]));
    const get = (supplierId: string, currency: string, fallbackName: string) => {
        const k = key(supplierId, currency);
        let r = rows.get(k);
        if (!r) rows.set(k, (r = { supplierId, supplierName: names.get(supplierId) ?? fallbackName, currency, opening: 0, billed: 0, paid: 0, advances: 0, outstanding: 0, overdue: 0, netPayable: 0, nextDue: "" }));
        return r;
    };

    for (const s of suppliers) if (s.openingBalance > 0) get(s.id, s.currency, s.name).opening = s.openingBalance;
    for (const b of bills) {
        if (b.status !== "posted") continue;
        const r = get(b.supplierId, b.currency, b.supplier.name);
        r.billed += billTotal(b);
        const owed = owedOn(b, payments);
        if (owed > 0) {
            r.outstanding += owed;
            if (daysOverdue(b, now) > 0) r.overdue += owed;
            if (!r.nextDue || b.dueDate < r.nextDue) r.nextDue = b.dueDate;
        }
    }
    for (const p of payments) {
        if (p.status !== "posted") continue;
        const r = get(p.supplierId, p.currency, p.supplierName);
        r.paid += p.amount;
        r.advances += unallocated(p);
    }
    return [...rows.values()]
        .map((r) => {
            const f = (n: number) => roundMoney(n, decimalsOf(r.currency));
            const o = { ...r, opening: f(r.opening), billed: f(r.billed), paid: f(r.paid), advances: f(r.advances), outstanding: f(r.outstanding), overdue: f(r.overdue) };
            return { ...o, netPayable: f(o.opening + o.outstanding - o.advances) };
        })
        .sort((a, b) => b.netPayable - a.netPayable || a.supplierName.localeCompare(b.supplierName));
}

/* ---------------------------------------------------------------- ledger */

export type LedgerEntry = {
    date: string;
    kind: "opening" | "bill" | "payment";
    ref: string;
    detail: string;
    /** Increases what is owed. */
    debit: number;
    /** Decreases what is owed. */
    credit: number;
    balance: number;
    id: string;
};

/**
 * A supplier's statement in one currency: the opening balance, then every
 * posted bill (owed) and every posted payment (paid) in date order, with a
 * running balance that ends at the supplier's net payable.
 */
export function supplierLedger(supplier: Supplier, bills: PurchaseBill[], payments: SupplierPayment[], currency: string): LedgerEntry[] {
    const dec = decimalsOf(currency);
    const r = (n: number) => roundMoney(n, dec);
    type Raw = Omit<LedgerEntry, "balance">;
    const raw: Raw[] = [];
    if (supplier.currency === currency && supplier.openingBalance > 0) {
        raw.push({ date: "", kind: "opening", ref: "", detail: "", debit: supplier.openingBalance, credit: 0, id: `opening-${supplier.id}` });
    }
    for (const b of bills) {
        if (b.supplierId !== supplier.id || b.currency !== currency || b.status !== "posted") continue;
        raw.push({ date: b.billDate, kind: "bill", ref: b.number, detail: b.supplierBillNo, debit: billTotal(b), credit: 0, id: b.id });
    }
    for (const p of payments) {
        if (p.supplierId !== supplier.id || p.currency !== currency || p.status !== "posted") continue;
        raw.push({ date: p.date, kind: "payment", ref: p.number, detail: p.reference, debit: 0, credit: p.amount, id: p.id });
    }
    const order = { opening: 0, bill: 1, payment: 2 } as const;
    raw.sort((a, b) => a.date.localeCompare(b.date) || order[a.kind] - order[b.kind] || a.ref.localeCompare(b.ref));
    let balance = 0;
    return raw.map((e) => {
        balance = r(balance + e.debit - e.credit);
        return { ...e, balance };
    });
}

/* ------------------------------------------------- profit and loss feeds */

export type PurchaseData = { bills: PurchaseBill[]; payments: SupplierPayment[] };

/**
 * Manual expenses minus those the user linked to a posted bill. While the bill
 * is posted it is what counts, so the same spend is never counted twice; if the
 * bill is later cancelled or sent back to draft, the expense counts again.
 */
export function reconcileExpenses(expenses: Expense[], bills: PurchaseBill[]): { expenses: Expense[]; linked: Expense[] } {
    const posted = new Set(bills.filter((b) => b.status === "posted").map((b) => b.id));
    const linked: Expense[] = [];
    const kept: Expense[] = [];
    for (const e of expenses) (e.billId && posted.has(e.billId) ? linked : kept).push(e);
    return { expenses: kept, linked };
}

export type PurchaseFigures = {
    /** Posted bills dated in the period, tax included (invoice basis). */
    purchases: number;
    purchasesTax: number;
    /** The part of that tax that can be claimed back. */
    recoverableTax: number;
    /** purchases − recoverableTax: the cost the profit estimate uses. */
    purchasesNet: number;
    count: number;
    /** Money paid to suppliers in the period, advances included (cash basis). */
    supplierPaid: number;
    /** Owed on bills dated up to `to`, as at `to`. */
    payables: number;
    payablesOverdue: number;
};

export const EMPTY_PURCHASE_FIGURES: PurchaseFigures = { purchases: 0, purchasesTax: 0, recoverableTax: 0, purchasesNet: 0, count: 0, supplierPaid: 0, payables: 0, payablesOverdue: 0 };

/** The supplier side of profit and loss for one currency and period. */
export function purchaseFigures({ bills, payments }: PurchaseData, { currency, from, to }: { currency: string; from: string; to: string }): PurchaseFigures {
    const dec = decimalsOf(currency);
    const r = (n: number) => roundMoney(n, dec);
    const f = { ...EMPTY_PURCHASE_FIGURES };

    for (const b of bills) {
        if (b.currency !== currency || b.status !== "posted") continue;
        const a = billAmounts(b, "");
        if (inRange(b.billDate, from, to)) {
            f.purchases += a.total;
            f.purchasesTax += a.tax;
            f.recoverableTax += a.recoverableTax;
            f.count += 1;
        }
        // Payables as at the end date: bills up to then, less what had been paid by then.
        if (b.billDate <= to) {
            const paidByThen = payments.reduce((s, p) => {
                if (p.status !== "posted" || p.date > to) return s;
                return s + p.allocations.filter((x) => x.billId === b.id).reduce((t, x) => t + x.amount, 0);
            }, 0);
            const owed = r(a.total - paidByThen);
            if (owed > 0) {
                f.payables += owed;
                if (b.dueDate < to) f.payablesOverdue += owed;
            }
        }
    }
    for (const p of payments) {
        if (p.currency === currency && p.status === "posted" && inRange(p.date, from, to)) f.supplierPaid += p.amount;
    }
    return {
        purchases: r(f.purchases),
        purchasesTax: r(f.purchasesTax),
        recoverableTax: r(f.recoverableTax),
        purchasesNet: r(f.purchases - f.recoverableTax),
        count: f.count,
        supplierPaid: r(f.supplierPaid),
        payables: r(f.payables),
        payablesOverdue: r(f.payablesOverdue),
    };
}

export type MonthPurchases = { purchases: number; purchasesNet: number; supplierPaid: number };

/** Purchases and supplier payments per calendar month (yyyy-mm), within [from, to]. */
export function purchasesByMonth({ bills, payments }: PurchaseData, { currency, from, to }: { currency: string; from: string; to: string }): Map<string, MonthPurchases> {
    const out = new Map<string, MonthPurchases>();
    const row = (ym: string) => {
        let m = out.get(ym);
        if (!m) out.set(ym, (m = { purchases: 0, purchasesNet: 0, supplierPaid: 0 }));
        return m;
    };
    for (const b of bills) {
        if (b.currency !== currency || b.status !== "posted" || !inRange(b.billDate, from, to)) continue;
        const a = billAmounts(b, "");
        const m = row(b.billDate.slice(0, 7));
        m.purchases += a.total;
        m.purchasesNet += a.total - a.recoverableTax;
    }
    for (const p of payments) {
        if (p.currency === currency && p.status === "posted" && inRange(p.date, from, to)) row(p.date.slice(0, 7)).supplierPaid += p.amount;
    }
    return out;
}
