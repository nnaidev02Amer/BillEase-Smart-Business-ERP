/**
 * Profit and loss: pure logic, no React and no storage.
 *
 * Two different questions get two different answers, and neither is allowed to
 * pose as the other:
 *
 *   CASH BASIS: "How much money moved?"
 *     collected       payments received in the period (by payment date)
 *     expenses paid   expenses dated in the period, tax included
 *     net cash flow   collected − expenses paid
 *
 *   INVOICE BASIS: "What did the period earn, if every invoice is paid?" (an estimate)
 *     invoiced        issued invoices dated in the period, tax included
 *     revenue         invoiced − the tax on those invoices. Tax you collect for
 *                     the government is not income.
 *     cost            expenses − the tax on them that is *recoverable* (an input
 *                     tax credit). Non-recoverable tax is a real cost.
 *     estimated profit  revenue − cost
 *
 *   RECEIVABLES (separate from both): what customers still owe as at the end of
 *   the period. An unpaid invoice is revenue on the invoice basis, and it is
 *   *not* cash on the cash basis, so it never inflates net cash flow.
 *
 * Only issued invoices (status "sent") count: drafts and cancelled invoices were
 * never owed. These match the dashboard's definitions (see lib/finance), so the
 * two screens agree. Every figure is for one currency; currencies are never
 * added together.
 */

import { z } from "zod";

import { roundMoney } from "@/lib/calculations";
import {
    type Expense,
    type ExpenseSummary,
    decimalsOf,
    fromDay,
    inRange,
    summariseExpenses,
    toDay,
} from "@/lib/expenses";
import { breakdownOf } from "@/lib/finance";
import { EMPTY_PURCHASE_FIGURES, purchaseFigures, purchasesByMonth, reconcileExpenses, type PurchaseData } from "@/lib/payables";
import { invoiceTotal, parseDate, paymentsOf, startOfDay, storedStatus, toCsv } from "@/lib/invoiceRecords";
import { stripControlChars } from "@/lib/schemas";
import type { InvoiceType } from "@/types";

/* ------------------------------------------------------------------ types */

export type Pnl = {
    currency: string;
    /** yyyy-mm-dd; "" = from the beginning */
    from: string;
    to: string;

    // invoice basis
    invoiced: number;
    invoicedTax: number;
    revenue: number;
    issuedCount: number;
    // cash basis
    collected: number;
    // expenses
    expenses: number;
    expenseCount: number;
    expensesTax: number;
    recoverableTax: number;
    /** Expenses less recoverable tax: the cost the profit estimate uses. */
    expensesNet: number;
    // supplier bills and payments. Manual expenses above never include these, and an
    // expense linked to a posted bill is left out of them so a purchase is counted once.
    /** Posted bills dated in the period, tax included. */
    purchases: number;
    purchasesTax: number;
    purchasesRecoverableTax: number;
    /** purchases − claimable tax: the purchase cost the profit estimate uses. */
    purchasesNet: number;
    purchaseCount: number;
    /** Money paid to suppliers in the period (cash basis). */
    supplierPaid: number;
    /** Manual expenses left out because they are linked to a posted bill. */
    linkedExpenses: number;
    // payables as at `to`
    payables: number;
    payablesOverdue: number;
    // results
    netCashFlow: number;
    estimatedProfit: number;
    /** Estimated profit as a share of revenue, or null when there is no revenue. */
    margin: number | null;
    // receivables as at `to`
    outstanding: number;
    overdue: number;
};

/**
 * `purchases` brings in supplier bills and payments. Left out, nothing changes:
 * the report is the same as it was before purchasing existed.
 */
export type PnlOptions = { currency: string; from?: string; to?: string; now?: Date; purchases?: PurchaseData };

const dayOf = (v: unknown): string | null => {
    const d = parseDate(v);
    return d ? toDay(d) : null;
};

const isIssued = (inv: InvoiceType) => storedStatus(inv) === "sent";
const mine = (invoices: InvoiceType[], currency: string) => invoices.filter((i) => (i.details.currency || "USD") === currency);

/* -------------------------------------------------------------------- pnl */

export function profitAndLoss(invoices: InvoiceType[], allExpenses: Expense[], { currency, from = "", to, now = new Date(), purchases }: PnlOptions): Pnl {
    const end = to || toDay(now);
    const dec = decimalsOf(currency);
    const r = (n: number) => roundMoney(n, dec);
    const invs = mine(invoices, currency);

    let invoiced = 0;
    let invoicedTax = 0;
    let issuedCount = 0;
    let collected = 0;
    let outstanding = 0;
    let overdue = 0;

    for (const inv of invs) {
        // Money received counts whatever the invoice later became (as on the dashboard).
        for (const p of paymentsOf(inv)) {
            const d = dayOf(p.date);
            if (d && inRange(d, from, end)) collected += Number(p.amount) || 0;
        }

        if (!isIssued(inv)) continue;
        const issued = dayOf(inv.details.invoiceDate);
        if (!issued) continue;

        if (inRange(issued, from, end)) {
            invoiced += invoiceTotal(inv);
            invoicedTax += breakdownOf(inv).tax;
            issuedCount += 1;
        }

        // Receivables: everything issued up to the end date, less payments up to then.
        if (issued <= end) {
            const paidByThen = paymentsOf(inv).reduce((s, p) => {
                const d = dayOf(p.date);
                return d && d <= end ? s + (Number(p.amount) || 0) : s;
            }, 0);
            const owed = r(invoiceTotal(inv) - paidByThen);
            if (owed > 0) {
                outstanding += owed;
                const due = dayOf(inv.details.dueDate);
                if (due && due < end) overdue += owed;
            }
        }
    }

    // An expense linked to a posted bill is the same spend as the bill, which counts instead.
    const { expenses, linked } = purchases ? reconcileExpenses(allExpenses, purchases.bills) : { expenses: allExpenses, linked: [] as Expense[] };
    const pf = purchases ? purchaseFigures(purchases, { currency, from, to: end }) : EMPTY_PURCHASE_FIGURES;
    const sum = summariseExpenses(expenses, { currency, from, to: end });
    const revenue = r(invoiced - invoicedTax);
    const expensesNet = r(sum.total - sum.recoverableTax);
    const estimatedProfit = r(revenue - expensesNet - pf.purchasesNet);

    return {
        currency,
        from,
        to: end,
        invoiced: r(invoiced),
        invoicedTax: r(invoicedTax),
        revenue,
        issuedCount,
        collected: r(collected),
        expenses: sum.total,
        expenseCount: sum.count,
        expensesTax: sum.tax,
        recoverableTax: sum.recoverableTax,
        expensesNet,
        purchases: pf.purchases,
        purchasesTax: pf.purchasesTax,
        purchasesRecoverableTax: pf.recoverableTax,
        purchasesNet: pf.purchasesNet,
        purchaseCount: pf.count,
        supplierPaid: pf.supplierPaid,
        linkedExpenses: linked.filter((e) => e.currency === currency && inRange(e.date, from, end)).length,
        payables: pf.payables,
        payablesOverdue: pf.payablesOverdue,
        netCashFlow: r(collected - sum.total - pf.supplierPaid),
        estimatedProfit,
        margin: revenue > 0 ? estimatedProfit / revenue : null,
        outstanding: r(outstanding),
        overdue: r(overdue),
    };
}

/* ---------------------------------------------------------------- monthly */

export type MonthRow = {
    ym: string;
    invoiced: number;
    revenue: number;
    collected: number;
    expenses: number;
    expensesNet: number;
    /** Posted supplier bills dated in the month, tax included. */
    purchases: number;
    purchasesNet: number;
    /** Paid to suppliers in the month. */
    supplierPaid: number;
    estimatedProfit: number;
    netCashFlow: number;
};

const MAX_MONTHS = 120;

/**
 * One row per calendar month from `from` (or the first month with any data) to
 * `to`. Each month is built from the same rules as `profitAndLoss`, so the
 * months add up to the period totals.
 */
export function monthlySeries(invoices: InvoiceType[], allExpenses: Expense[], { currency, from = "", to, now = new Date(), purchases }: PnlOptions): MonthRow[] {
    const end = to || toDay(now);
    const dec = decimalsOf(currency);
    const r = (n: number) => roundMoney(n, dec);
    const invs = mine(invoices, currency);
    const exps = (purchases ? reconcileExpenses(allExpenses, purchases.bills).expenses : allExpenses).filter((e) => e.currency === currency);

    let start = from;
    if (!start) {
        const days: string[] = [];
        for (const inv of invs) {
            const d = dayOf(inv.details.invoiceDate);
            if (d && isIssued(inv)) days.push(d);
            for (const p of paymentsOf(inv)) {
                const pd = dayOf(p.date);
                if (pd) days.push(pd);
            }
        }
        for (const e of exps) days.push(e.date);
        if (purchases) {
            for (const b of purchases.bills) if (b.currency === currency && b.status === "posted") days.push(b.billDate);
            for (const p of purchases.payments) if (p.currency === currency && p.status === "posted") days.push(p.date);
        }
        start = days.length ? days.sort()[0] : end;
    }
    if (start > end) return [];

    const rows = new Map<string, MonthRow>();
    let [y, m] = start.slice(0, 7).split("-").map(Number);
    const [ey, em] = end.slice(0, 7).split("-").map(Number);
    while (y < ey || (y === ey && m <= em)) {
        const ym = `${y}-${String(m).padStart(2, "0")}`;
        rows.set(ym, { ym, invoiced: 0, revenue: 0, collected: 0, expenses: 0, expensesNet: 0, purchases: 0, purchasesNet: 0, supplierPaid: 0, estimatedProfit: 0, netCashFlow: 0 });
        m++;
        if (m > 12) {
            m = 1;
            y++;
        }
    }

    for (const inv of invs) {
        for (const p of paymentsOf(inv)) {
            const d = dayOf(p.date);
            const row = d && inRange(d, start, end) ? rows.get(d.slice(0, 7)) : undefined;
            if (row) row.collected += Number(p.amount) || 0;
        }
        if (!isIssued(inv)) continue;
        const d = dayOf(inv.details.invoiceDate);
        const row = d && inRange(d, start, end) ? rows.get(d.slice(0, 7)) : undefined;
        if (row) {
            const total = invoiceTotal(inv);
            row.invoiced += total;
            row.revenue += total - breakdownOf(inv).tax;
        }
    }
    for (const e of exps) {
        const row = inRange(e.date, start, end) ? rows.get(e.date.slice(0, 7)) : undefined;
        if (!row) continue;
        row.expenses += e.amount;
        row.expensesNet += e.amount - (e.tax?.recoverable ? e.tax.amount : 0);
    }

    if (purchases) {
        for (const [ym, m] of purchasesByMonth(purchases, { currency, from: start, to: end })) {
            const row = rows.get(ym);
            if (!row) continue;
            row.purchases += m.purchases;
            row.purchasesNet += m.purchasesNet;
            row.supplierPaid += m.supplierPaid;
        }
    }

    const out = [...rows.values()].sort((a, b) => a.ym.localeCompare(b.ym)).map((row) => ({
        ...row,
        invoiced: r(row.invoiced),
        revenue: r(row.revenue),
        collected: r(row.collected),
        expenses: r(row.expenses),
        expensesNet: r(row.expensesNet),
        purchases: r(row.purchases),
        purchasesNet: r(row.purchasesNet),
        supplierPaid: r(row.supplierPaid),
        estimatedProfit: r(row.revenue - row.expensesNet - row.purchasesNet),
        netCashFlow: r(row.collected - row.expenses - row.supplierPaid),
    }));
    return out.slice(-MAX_MONTHS);
}

/* --------------------------------------------------------------- previous */

/** The period of equal length immediately before [from, to], or null for an open-ended period. */
export function previousPeriod(from: string, to: string): { from: string; to: string } | null {
    if (!from || !to || from > to) return null;
    const a = fromDay(from);
    const b = fromDay(to);
    const days = Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1;
    const prevTo = new Date(a.getFullYear(), a.getMonth(), a.getDate() - 1);
    const prevFrom = new Date(prevTo.getFullYear(), prevTo.getMonth(), prevTo.getDate() - (days - 1));
    return { from: toDay(prevFrom), to: toDay(prevTo) };
}

/* --------------------------------------------------------------- insights */

export type InsightTone = "positive" | "info" | "warning" | "critical";
export type PnlInsight = { id: string; tone: InsightTone; params: Record<string, string | number> };

const TONE_ORDER: Record<InsightTone, number> = { critical: 0, warning: 1, info: 2, positive: 3 };

/**
 * Plain-language observations. Each fires only on the facts it states, taken
 * from the figures above; nothing is predicted. `previous` is the same
 * calculation over the period before, for comparisons.
 */
export function pnlInsights(pnl: Pnl, summary: ExpenseSummary, previous?: { expenses: number } | null): PnlInsight[] {
    const out: PnlInsight[] = [];
    const push = (id: string, tone: InsightTone, params: Record<string, string | number> = {}) => out.push({ id, tone, params });
    const c = pnl.currency;

    if (pnl.expenseCount === 0 && pnl.purchaseCount === 0 && pnl.revenue > 0) {
        push("noExpenses", "info");
    }
    if (pnl.expenseCount > 0 || pnl.purchaseCount > 0 || pnl.revenue > 0) {
        if (pnl.estimatedProfit < 0) push("lossEstimate", "warning", { amount: Math.abs(pnl.estimatedProfit), currency: c });
        else if (pnl.estimatedProfit > 0 && pnl.margin !== null) push("profitEstimate", "positive", { amount: pnl.estimatedProfit, currency: c, margin: Math.round(pnl.margin * 100) });

        if (pnl.netCashFlow < 0) push("cashNegative", "warning", { amount: Math.abs(pnl.netCashFlow), currency: c });
        else if (pnl.netCashFlow > 0) push("cashPositive", "positive", { amount: pnl.netCashFlow, currency: c });
    }
    // Profit on paper but money not in the bank: the gap is receivables.
    if (pnl.estimatedProfit > 0 && pnl.netCashFlow < 0 && pnl.outstanding > 0) {
        push("profitNotCash", "info", { amount: pnl.outstanding, currency: c });
    }
    if (pnl.invoiced > 0 && pnl.outstanding > 0 && pnl.outstanding / pnl.invoiced >= 0.5) {
        push("receivablesHigh", "warning", { percent: Math.round((pnl.outstanding / pnl.invoiced) * 100), amount: pnl.outstanding, currency: c });
    }
    if (pnl.overdue > 0) push("overdue", "warning", { amount: pnl.overdue, currency: c });
    if (pnl.payablesOverdue > 0) push("payablesOverdue", "warning", { amount: pnl.payablesOverdue, currency: c });

    const top = summary.byCategory[0];
    if (top && summary.byCategory.length > 1 && top.share >= 0.4) {
        push("topCategory", "info", { category: top.category, percent: Math.round(top.share * 100), amount: top.total, currency: c });
    }
    if (summary.largest && summary.count >= 3) {
        push("largestExpense", "info", { title: summary.largest.title, amount: summary.largest.amount, currency: c });
    }
    if (previous && previous.expenses > 0) {
        const change = (pnl.expenses - previous.expenses) / previous.expenses;
        if (change >= 0.25) push("expensesUp", "warning", { percent: Math.round(change * 100) });
        else if (change <= -0.25) push("expensesDown", "positive", { percent: Math.round(Math.abs(change) * 100) });
    }
    return out.sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone]);
}

/* -------------------------------------------------------------------- csv */

/** The report as one CSV: summary lines, then by category, then by month. */
export function profitLossCsv(pnl: Pnl, summary: ExpenseSummary, months: MonthRow[], nameOf: (categoryId: string) => string): { filename: string; csv: string } {
    const c = pnl.currency;
    const rows: unknown[][] = [
        ["Period", `${pnl.from || "start"} to ${pnl.to}`, "", c],
        ["Invoice basis", "Invoiced (incl. tax)", pnl.invoiced, c],
        ["Invoice basis", "Tax on invoices", pnl.invoicedTax, c],
        ["Invoice basis", "Revenue (excl. tax)", pnl.revenue, c],
        ["Invoice basis", "Expenses (incl. tax)", pnl.expenses, c],
        ["Invoice basis", "Recoverable tax on expenses", pnl.recoverableTax, c],
        ["Invoice basis", "Cost (expenses less recoverable tax)", pnl.expensesNet, c],
        ...(pnl.purchaseCount > 0
            ? [
                  ["Invoice basis", "Supplier bills (incl. tax)", pnl.purchases, c],
                  ["Invoice basis", "Claimable tax on supplier bills", pnl.purchasesRecoverableTax, c],
                  ["Invoice basis", "Purchase cost (bills less claimable tax)", pnl.purchasesNet, c],
              ]
            : []),
        ["Invoice basis", "Estimated profit", pnl.estimatedProfit, c],
        ["Cash basis", "Collected (payments received)", pnl.collected, c],
        ["Cash basis", "Expenses paid", pnl.expenses, c],
        ...(pnl.supplierPaid > 0 ? [["Cash basis", "Paid to suppliers", pnl.supplierPaid, c]] : []),
        ["Cash basis", "Net cash flow", pnl.netCashFlow, c],
        ["Receivables", "Outstanding at end date", pnl.outstanding, c],
        ["Receivables", "of which overdue", pnl.overdue, c],
        ...(pnl.payables > 0
            ? [
                  ["Payables", "Owed to suppliers at end date", pnl.payables, c],
                  ["Payables", "of which overdue", pnl.payablesOverdue, c],
              ]
            : []),
        ...summary.byCategory.map((x) => ["Expenses by category", nameOf(x.category), x.total, c]),
        ...months.map((m) => ["Month " + m.ym, "Revenue / Collected / Expenses / Profit / Net cash", [m.revenue, m.collected, m.expenses, m.estimatedProfit, m.netCashFlow].join(" / "), c]),
    ];
    return {
        filename: `profit-and-loss-${pnl.from || "start"}_to_${pnl.to}-${c}.csv`,
        csv: toCsv(["Section", "Item", "Amount", "Currency"], rows),
    };
}

/* ---------------------------------------------------------- pdf payload */

const text = (max: number) => z.string().max(max).transform((v) => stripControlChars(v));
const money = z.number().finite().min(-1e12).max(1e12);
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** What the report PDF route accepts: bounded, cleaned, figures precomputed. */
export const ReportPayloadSchema = z.object({
    generatedAt: ymd,
    business: z.object({ name: text(120), gstin: text(20).optional() }),
    pnl: z.object({
        currency: z.string().min(1).max(8),
        from: z.union([ymd, z.literal("")]),
        to: ymd,
        invoiced: money,
        invoicedTax: money,
        revenue: money,
        issuedCount: z.number().int().min(0).max(1e7),
        collected: money,
        expenses: money,
        expenseCount: z.number().int().min(0).max(1e7),
        expensesTax: money,
        recoverableTax: money,
        expensesNet: money,
        purchases: money.default(0),
        purchasesTax: money.default(0),
        purchasesRecoverableTax: money.default(0),
        purchasesNet: money.default(0),
        purchaseCount: z.number().int().min(0).max(1e7).default(0),
        supplierPaid: money.default(0),
        payables: money.default(0),
        payablesOverdue: money.default(0),
        netCashFlow: money,
        estimatedProfit: money,
        margin: z.number().finite().nullable(),
        outstanding: money,
        overdue: money,
    }),
    categories: z.array(z.object({ name: text(80), total: money, count: z.number().int().min(0), share: z.number().min(0).max(1) })).max(100),
    months: z
        .array(z.object({ ym: z.string().regex(/^\d{4}-\d{2}$/), revenue: money, collected: money, expenses: money, estimatedProfit: money, netCashFlow: money }))
        .max(MAX_MONTHS),
});

export type ReportPayload = z.infer<typeof ReportPayloadSchema>;

/* ---------------------------------------------------------- date presets */

export type PeriodPreset = "thisMonth" | "lastMonth" | "last3" | "thisFy" | "thisYear" | "all";

/**
 * Preset periods as yyyy-mm-dd. The financial year is April to March, the
 * Indian convention the GST module and statements already follow.
 */
export function periodFor(preset: PeriodPreset, now: Date = new Date()): { from: string; to: string } {
    const today = toDay(startOfDay(now));
    const y = now.getFullYear();
    const m = now.getMonth();
    switch (preset) {
        case "thisMonth":
            return { from: toDay(new Date(y, m, 1)), to: today };
        case "lastMonth":
            return { from: toDay(new Date(y, m - 1, 1)), to: toDay(new Date(y, m, 0)) };
        case "last3":
            return { from: toDay(new Date(y, m - 2, 1)), to: today };
        case "thisFy":
            return { from: toDay(new Date(m >= 3 ? y : y - 1, 3, 1)), to: today };
        case "thisYear":
            return { from: toDay(new Date(y, 0, 1)), to: today };
        default:
            return { from: "", to: today };
    }
}
