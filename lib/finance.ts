/**
 * Financial analytics, computed from the saved invoices and nothing else.
 *
 * Definitions (stated once so every screen agrees):
 *   invoiced   total of issued invoices — status "sent", i.e. not draft or
 *              cancelled — by issue date
 *   collected  money actually received — payments, by payment date
 *   outstanding unpaid balance of issued invoices
 *   tax/discount  taken from each invoice's own charge settings via
 *              computeTotals, so they match what was printed. "Tax collected"
 *              is the tax portion pro-rated by how much of the invoice has been
 *              paid.
 *
 * Money is never added across currencies: every figure is computed for one
 * currency at a time.
 */

import { computeTotals, roundMoney } from "@/lib/calculations";
import { gstOfInvoice } from "@/lib/gst";
import { fetchCurrencyDetails } from "@/lib/helpers";
import {
    amountPaid,
    balanceDue,
    clientKey,
    daysBetween,
    displayStatus,
    invoiceTotal,
    isOpen,
    parseDate,
    paymentsOf,
    startOfDay,
    storedStatus,
    type DisplayStatus,
} from "@/lib/invoiceRecords";
import type { InvoiceType } from "@/types";

/* ---------------------------------------------------------- per invoice */

export type Breakdown = {
    discount: number;
    tax: number;
    shipping: number;
};

/** Discount, tax and shipping in money terms, as the invoice itself computed them. */
export function breakdownOf(invoice: InvoiceType): Breakdown {
    const d = invoice.details;
    const decimals = fetchCurrencyDetails(d.currency)?.decimals ?? 2;
    // GST invoices carry their tax per line, not in the flat tax charge.
    const gst = gstOfInvoice(invoice, decimals);
    if (gst) return { discount: gst.discountAmount, tax: gst.totalTax, shipping: gst.shippingAmount };
    const t = computeTotals({
        subTotal: Number(d.subTotal) || 0,
        discount: { value: d.discountDetails?.amount, type: d.discountDetails?.amountType ?? "amount" },
        tax: { value: d.taxDetails?.amount, type: d.taxDetails?.amountType ?? "amount" },
        shipping: { value: d.shippingDetails?.cost, type: d.shippingDetails?.costType ?? "amount" },
        decimals,
    });
    return { discount: t.discountAmount, tax: t.taxAmount, shipping: t.shippingAmount };
}

/** Issued = sent to the client at some point and not cancelled. */
export const isIssued = (invoice: InvoiceType) => storedStatus(invoice) === "sent";

/* ------------------------------------------------------------- currency */

/** Currencies present, busiest (by invoiced value) first. */
export function currenciesIn(invoices: InvoiceType[]): string[] {
    const volume = new Map<string, number>();
    for (const inv of invoices) {
        const c = inv.details.currency || "USD";
        volume.set(c, (volume.get(c) ?? 0) + (isIssued(inv) ? invoiceTotal(inv) : 0) + 0.001);
    }
    return [...volume.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}

export function yearsIn(invoices: InvoiceType[], now: Date = new Date()): number[] {
    const years = new Set<number>([now.getFullYear()]);
    for (const inv of invoices) {
        const issued = parseDate(inv.details.invoiceDate);
        if (issued) years.add(issued.getFullYear());
        for (const p of paymentsOf(inv)) {
            const d = parseDate(p.date);
            if (d) years.add(d.getFullYear());
        }
    }
    return [...years].sort((a, b) => b - a);
}

/* -------------------------------------------------------------- output */

export type MonthRow = {
    /** 0–11 */
    month: number;
    key: string;
    invoiced: number;
    collected: number;
    /** Invoices created in the month, drafts included: the "generation" count. */
    count: number;
    tax: number;
    discount: number;
};

export type YearRow = { year: number; invoiced: number; collected: number; count: number };

export type ClientRow = {
    key: string;
    name: string;
    email: string;
    invoiced: number;
    collected: number;
    outstanding: number;
    count: number;
};

export type Growth = { current: number; previous: number; change: number | null };

export type FinanceReport = {
    currency: string;
    year: number;
    totals: {
        invoiced: number;
        collected: number;
        outstanding: number;
        overdue: number;
        overdueCount: number;
        averageInvoice: number;
        issuedCount: number;
        taxInvoiced: number;
        taxCollected: number;
        discounts: number;
    };
    months: MonthRow[];
    years: YearRow[];
    growth: {
        /** This month vs last month, collected. */
        month: Growth;
        /** Year to date vs the same span last year, collected. */
        ytd: Growth;
        /** This month vs last month, invoiced. */
        invoicedMonth: Growth;
    };
    statusCounts: Record<DisplayStatus, number>;
    topClients: ClientRow[];
    trends: {
        /** Mean days from issue to final payment, fully paid invoices only. */
        averageDaysToPay: number | null;
        /** Share of fully paid invoices settled on or before the due date. */
        onTimeRate: number | null;
        paidInvoiceCount: number;
        /** Mean days to pay by the month the final payment landed. */
        byMonth: { month: number; days: number | null; count: number }[];
    };
    aging: { label: "1-30" | "31-60" | "61-90" | "90+"; amount: number; count: number }[];
};

export const growth = (current: number, previous: number): Growth => ({
    current,
    previous,
    change: previous > 0 ? (current - previous) / previous : null,
});

export function computeFinance(
    invoices: InvoiceType[],
    opts: { currency: string; year: number; now?: Date }
): FinanceReport {
    const now = opts.now ?? new Date();
    const { currency, year } = opts;
    const mine = invoices.filter((i) => (i.details.currency || "USD") === currency);

    const months: MonthRow[] = Array.from({ length: 12 }, (_, month) => ({
        month,
        key: `${year}-${String(month + 1).padStart(2, "0")}`,
        invoiced: 0,
        collected: 0,
        count: 0,
        tax: 0,
        discount: 0,
    }));
    const yearMap = new Map<number, YearRow>();
    const yearRow = (y: number) => {
        let row = yearMap.get(y);
        if (!row) yearMap.set(y, (row = { year: y, invoiced: 0, collected: 0, count: 0 }));
        return row;
    };

    const statusCounts: Record<DisplayStatus, number> = {
        draft: 0, sent: 0, partial: 0, overdue: 0, paid: 0, cancelled: 0,
    };
    const clients = new Map<string, ClientRow>();
    const aging = [
        { label: "1-30" as const, amount: 0, count: 0 },
        { label: "31-60" as const, amount: 0, count: 0 },
        { label: "61-90" as const, amount: 0, count: 0 },
        { label: "90+" as const, amount: 0, count: 0 },
    ];

    let invoicedAll = 0, collectedAll = 0, outstanding = 0, overdue = 0, overdueCount = 0;
    let taxInvoiced = 0, taxCollected = 0, discounts = 0, issuedCount = 0;
    const daysToPay: number[] = [];
    let onTime = 0;
    const payMonths: { total: number; n: number }[] = Array.from({ length: 12 }, () => ({ total: 0, n: 0 }));

    // collected-by-date windows for growth
    const sumCollected = (from: Date, to: Date) => {
        let s = 0;
        for (const inv of mine) {
            for (const p of paymentsOf(inv)) {
                const d = parseDate(p.date);
                if (d && d >= from && d <= to) s += Number(p.amount) || 0;
            }
        }
        return roundMoney(s);
    };
    const sumInvoiced = (from: Date, to: Date) => {
        let s = 0;
        for (const inv of mine) {
            if (!isIssued(inv)) continue;
            const d = parseDate(inv.details.invoiceDate);
            if (d && d >= from && d <= to) s += invoiceTotal(inv);
        }
        return roundMoney(s);
    };

    for (const inv of mine) {
        const status = displayStatus(inv, now);
        statusCounts[status] += 1;

        const issued = parseDate(inv.details.invoiceDate);
        if (issued && issued.getFullYear() === year) months[issued.getMonth()].count += 1;
        if (issued) yearRow(issued.getFullYear()).count += 1;

        // Money received counts whatever the invoice later became.
        for (const p of paymentsOf(inv)) {
            const d = parseDate(p.date);
            const amt = Number(p.amount) || 0;
            collectedAll += amt;
            if (d) {
                yearRow(d.getFullYear()).collected += amt;
                if (d.getFullYear() === year) months[d.getMonth()].collected += amt;
            }
        }

        if (!isIssued(inv)) continue;
        issuedCount += 1;

        const total = invoiceTotal(inv);
        const paid = amountPaid(inv);
        const bal = balanceDue(inv);
        const b = breakdownOf(inv);
        invoicedAll += total;
        taxInvoiced += b.tax;
        taxCollected += total > 0 ? b.tax * (paid / total) : 0;
        discounts += b.discount;
        outstanding += bal;

        if (issued) {
            yearRow(issued.getFullYear()).invoiced += total;
            if (issued.getFullYear() === year) {
                const m = months[issued.getMonth()];
                m.invoiced += total;
                m.tax += b.tax;
                m.discount += b.discount;
            }
        }

        // Clients
        const key = clientKey(inv.receiver);
        if (key) {
            let c = clients.get(key);
            if (!c) {
                c = { key, name: inv.receiver.name, email: inv.receiver.email, invoiced: 0, collected: 0, outstanding: 0, count: 0 };
                clients.set(key, c);
            }
            c.invoiced += total;
            c.collected += paid;
            c.outstanding += bal;
            c.count += 1;
        }

        // Overdue + aging
        if (status === "overdue") {
            overdue += bal;
            overdueCount += 1;
            const due = parseDate(inv.details.dueDate);
            const late = due ? daysBetween(due, now) : 0;
            const bucket = late <= 30 ? 0 : late <= 60 ? 1 : late <= 90 ? 2 : 3;
            aging[bucket].amount += bal;
            aging[bucket].count += 1;
        }

        // Payment speed — only invoices that are fully paid
        if (status === "paid" && issued) {
            const last = paymentsOf(inv)
                .map((p) => parseDate(p.date))
                .filter((d): d is Date => !!d)
                .sort((a, b) => b.getTime() - a.getTime())[0];
            if (last) {
                const days = Math.max(0, daysBetween(issued, last));
                daysToPay.push(days);
                const due = parseDate(inv.details.dueDate);
                if (due && startOfDay(last) <= startOfDay(due)) onTime += 1;
                if (last.getFullYear() === year) {
                    payMonths[last.getMonth()].total += days;
                    payMonths[last.getMonth()].n += 1;
                }
            }
        }
    }

    const round = (n: number) => roundMoney(n);
    for (const m of months) {
        m.invoiced = round(m.invoiced); m.collected = round(m.collected);
        m.tax = round(m.tax); m.discount = round(m.discount);
    }

    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

    // Growth windows
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
    const prevMonthEnd = new Date(monthStart.getTime() - 1);
    const ytdStart = new Date(now.getFullYear(), 0, 1);
    const prevYtdStart = new Date(now.getFullYear() - 1, 0, 1);
    const prevYtdEnd = endOfDay(new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()));

    return {
        currency,
        year,
        totals: {
            invoiced: round(invoicedAll),
            collected: round(collectedAll),
            outstanding: round(outstanding),
            overdue: round(overdue),
            overdueCount,
            averageInvoice: issuedCount ? round(invoicedAll / issuedCount) : 0,
            issuedCount,
            taxInvoiced: round(taxInvoiced),
            taxCollected: round(taxCollected),
            discounts: round(discounts),
        },
        months,
        years: [...yearMap.values()]
            .map((y) => ({ ...y, invoiced: round(y.invoiced), collected: round(y.collected) }))
            .sort((a, b) => a.year - b.year),
        growth: {
            month: growth(sumCollected(monthStart, endOfDay(now)), sumCollected(prevMonthStart, prevMonthEnd)),
            ytd: growth(sumCollected(ytdStart, endOfDay(now)), sumCollected(prevYtdStart, prevYtdEnd)),
            invoicedMonth: growth(sumInvoiced(monthStart, endOfDay(now)), sumInvoiced(prevMonthStart, prevMonthEnd)),
        },
        statusCounts,
        topClients: [...clients.values()]
            .map((c) => ({ ...c, invoiced: round(c.invoiced), collected: round(c.collected), outstanding: round(c.outstanding) }))
            .sort((a, b) => b.invoiced - a.invoiced),
        trends: {
            averageDaysToPay: mean(daysToPay),
            onTimeRate: daysToPay.length ? onTime / daysToPay.length : null,
            paidInvoiceCount: daysToPay.length,
            byMonth: payMonths.map((p, month) => ({ month, days: p.n ? p.total / p.n : null, count: p.n })),
        },
        aging: aging.map((a) => ({ ...a, amount: round(a.amount) })),
    };
}

/* ------------------------------------------------------------ payments */

export type TransactionRow = {
    id: string;
    invoiceNumber: string;
    client: string;
    currency: string;
    amount: number;
    date: Date;
    method?: string;
};

/** Every recorded payment across all invoices, newest first. */
export function transactions(invoices: InvoiceType[]): TransactionRow[] {
    const rows: TransactionRow[] = [];
    for (const inv of invoices) {
        for (const p of paymentsOf(inv)) {
            const date = parseDate(p.date);
            if (!date) continue;
            rows.push({
                id: `${inv.details.invoiceNumber}:${p.id}`,
                invoiceNumber: inv.details.invoiceNumber,
                client: inv.receiver.name,
                currency: inv.details.currency,
                amount: Number(p.amount) || 0,
                date,
                method: p.method,
            });
        }
    }
    return rows.sort((a, b) => b.date.getTime() - a.date.getTime());
}

/* -------------------------------------------------------------- exports */

import { toCsv } from "@/lib/invoiceRecords";

export type ReportKind = "monthly" | "yearly" | "clients" | "tax" | "outstanding";

const MONTH = (i: number) => String(i + 1).padStart(2, "0");

/** CSV for one report, built from the same numbers the screen shows. */
export function reportCsv(
    kind: ReportKind,
    report: FinanceReport,
    invoices: InvoiceType[],
    now: Date = new Date()
): { filename: string; csv: string } {
    const c = report.currency;
    switch (kind) {
        case "monthly":
            return {
                filename: `revenue-by-month-${report.year}-${c}.csv`,
                csv: toCsv(
                    ["Month", "Invoiced", "Collected", "Invoices created", "Tax", "Discounts", "Currency"],
                    report.months.map((m) => [`${report.year}-${MONTH(m.month)}`, m.invoiced, m.collected, m.count, m.tax, m.discount, c])
                ),
            };
        case "yearly":
            return {
                filename: `revenue-by-year-${c}.csv`,
                csv: toCsv(
                    ["Year", "Invoiced", "Collected", "Invoices", "Currency"],
                    report.years.map((y) => [y.year, y.invoiced, y.collected, y.count, c])
                ),
            };
        case "clients":
            return {
                filename: `clients-${c}.csv`,
                csv: toCsv(
                    ["Client", "Email", "Invoices", "Invoiced", "Collected", "Outstanding", "Currency"],
                    report.topClients.map((x) => [x.name, x.email, x.count, x.invoiced, x.collected, x.outstanding, c])
                ),
            };
        case "tax":
            return {
                filename: `tax-and-discounts-${report.year}-${c}.csv`,
                csv: toCsv(
                    ["Month", "Tax on issued invoices", "Discounts given", "Currency"],
                    report.months.map((m) => [`${report.year}-${MONTH(m.month)}`, m.tax, m.discount, c])
                ),
            };
        case "outstanding":
        default: {
            const rows = invoices
                .filter((i) => (i.details.currency || "USD") === c && isOpen(displayStatus(i, now)))
                .map((i) => {
                    const due = parseDate(i.details.dueDate);
                    return [
                        i.details.invoiceNumber,
                        i.receiver.name,
                        due ? `${due.getFullYear()}-${MONTH(due.getMonth())}-${String(due.getDate()).padStart(2, "0")}` : "",
                        displayStatus(i, now),
                        invoiceTotal(i),
                        amountPaid(i),
                        balanceDue(i),
                        c,
                    ];
                });
            return {
                filename: `outstanding-${c}.csv`,
                csv: toCsv(["Invoice #", "Client", "Due", "Status", "Total", "Paid", "Balance", "Currency"], rows),
            };
        }
    }
}
