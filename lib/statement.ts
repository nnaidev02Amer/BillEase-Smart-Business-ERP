/**
 * Customer account statements: pure logic, no React and no storage.
 *
 * One ledger feeds everything (the on-screen table, the CSV and the PDF), so
 * the three can never disagree.
 *
 * THE LEDGER
 *   Each issued invoice (status "sent") is a debit on its invoice date. Each
 *   payment recorded against it is a credit on its payment date. Drafts and
 *   cancelled invoices are not owed and do not appear. One currency per
 *   statement: amounts in different currencies are never added together.
 *
 * THE STATEMENT
 *   opening balance  everything before `from` (debits − credits)
 *   rows             entries from `from` to `to`, inclusive, oldest first; on one
 *                    day the invoice comes before the payment, so a same-day
 *                    payment never shows a balance below what was actually owed
 *   closing balance  opening + debits − credits
 *   open items       per invoice, what is still owed as at `to`
 *
 *   Identity (asserted by the tests): closing balance = the sum of the open
 *   items. Both are derived from the same ledger entries, per invoice.
 *
 * Dates are calendar days in the browser's local time, matching how invoice
 * and payment dates are stored.
 */

import { z } from "zod";

import { roundMoney } from "@/lib/calculations";
import {
    clientKey,
    daysBetween,
    invoiceTotal,
    isoDay,
    parseDate,
    paymentsOf,
    startOfDay,
    storedStatus,
    toCsv,
} from "@/lib/invoiceRecords";
import { stripControlChars } from "@/lib/schemas";
import type { InvoiceType } from "@/types";

/* ------------------------------------------------------------------ types */

export type LedgerEntry = {
    date: Date;
    kind: "invoice" | "payment";
    /** The invoice number this entry belongs to. */
    invoice: string;
    description: string;
    debit: number;
    credit: number;
    /** Invoice due date, carried on invoice entries for ageing. */
    due: Date | null;
    sequence: number;
};

export type StatementRow = {
    /** yyyy-mm-dd */
    date: string;
    kind: "invoice" | "payment";
    ref: string;
    description: string;
    debit: number;
    credit: number;
    balance: number;
};

export type OpenItem = {
    number: string;
    date: string;
    due: string;
    total: number;
    paid: number;
    balance: number;
    daysOverdue: number;
};

export type Aging = { current: number; d1_30: number; d31_60: number; d61_90: number; d90plus: number };

export type Statement = {
    currency: string;
    /** yyyy-mm-dd, or null for "from the beginning". */
    from: string | null;
    to: string;
    opening: number;
    closing: number;
    totals: { invoiced: number; paid: number };
    rows: StatementRow[];
    openItems: OpenItem[];
    aging: Aging;
};

/* ----------------------------------------------------------------- ledger */

const dayKey = (d: Date) => startOfDay(d).getTime();
const r2 = (n: number) => roundMoney(n);

/** Every debit and credit for one customer in one currency, unsorted. */
export function ledgerOf(invoices: InvoiceType[], key: string, currency: string): LedgerEntry[] {
    const out: LedgerEntry[] = [];
    let sequence = 0;
    for (const inv of invoices) {
        if (storedStatus(inv) !== "sent") continue;
        if (clientKey(inv.receiver) !== key) continue;
        if ((inv.details.currency || "USD") !== currency) continue;

        const issued = parseDate(inv.details.invoiceDate);
        if (!issued) continue;
        const number = inv.details.invoiceNumber;
        out.push({ date: issued, kind: "invoice", invoice: number, description: "", debit: r2(invoiceTotal(inv)), credit: 0, due: parseDate(inv.details.dueDate), sequence: sequence++ });

        for (const p of paymentsOf(inv)) {
            const when = parseDate(p.date);
            const amount = Number(p.amount) || 0;
            if (!when || amount <= 0) continue;
            out.push({
                date: when,
                kind: "payment",
                invoice: number,
                description: [p.method, p.note].filter(Boolean).join(" · "),
                debit: 0,
                credit: r2(amount),
                due: null,
                sequence: sequence++,
            });
        }
    }
    return out;
}

/** Currencies a customer has issued invoices in. */
export function ledgerCurrencies(invoices: InvoiceType[], key: string): string[] {
    const set = new Set<string>();
    for (const inv of invoices) {
        if (storedStatus(inv) === "sent" && clientKey(inv.receiver) === key) set.add(inv.details.currency || "USD");
    }
    return [...set].sort();
}

const numeric = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/* -------------------------------------------------------------- statement */

export type StatementOptions = {
    currency: string;
    from?: Date | null;
    to?: Date | null;
    now?: Date;
};

export function buildStatement(invoices: InvoiceType[], key: string, { currency, from = null, to = null, now = new Date() }: StatementOptions): Statement {
    const end = startOfDay(to ?? now);
    const start = from ? startOfDay(from) : null;
    const entries = ledgerOf(invoices, key, currency);

    const before = start ? entries.filter((e) => dayKey(e.date) < start.getTime()) : [];
    const opening = r2(before.reduce((s, e) => s + e.debit - e.credit, 0));

    const inRange = entries
        .filter((e) => dayKey(e.date) <= end.getTime() && (!start || dayKey(e.date) >= start.getTime()))
        .sort(
            (a, b) =>
                dayKey(a.date) - dayKey(b.date) ||
                // an invoice before a payment on the same day
                (a.kind === b.kind ? 0 : a.kind === "invoice" ? -1 : 1) ||
                numeric(a.invoice, b.invoice) ||
                a.sequence - b.sequence
        );

    let balance = opening;
    let invoiced = 0;
    let paid = 0;
    const rows: StatementRow[] = inRange.map((e) => {
        balance = r2(balance + e.debit - e.credit);
        invoiced = r2(invoiced + e.debit);
        paid = r2(paid + e.credit);
        return { date: isoDay(e.date), kind: e.kind, ref: e.invoice, description: e.description, debit: e.debit, credit: e.credit, balance };
    });

    // Open items: per invoice, net of everything up to `to`.
    const asAt = entries.filter((e) => dayKey(e.date) <= end.getTime());
    const per = new Map<string, { debit: number; credit: number; date: Date; due: Date | null }>();
    for (const e of asAt) {
        const cur = per.get(e.invoice) ?? { debit: 0, credit: 0, date: e.date, due: null };
        cur.debit = r2(cur.debit + e.debit);
        cur.credit = r2(cur.credit + e.credit);
        if (e.kind === "invoice") {
            cur.date = e.date;
            cur.due = e.due;
        }
        per.set(e.invoice, cur);
    }

    const aging: Aging = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
    const openItems: OpenItem[] = [];
    for (const [number, v] of per) {
        const net = r2(v.debit - v.credit);
        if (Math.abs(net) < 0.005) continue;
        const late = v.due ? Math.max(0, daysBetween(startOfDay(v.due), end)) : 0;
        if (net > 0) {
            if (late <= 0) aging.current = r2(aging.current + net);
            else if (late <= 30) aging.d1_30 = r2(aging.d1_30 + net);
            else if (late <= 60) aging.d31_60 = r2(aging.d31_60 + net);
            else if (late <= 90) aging.d61_90 = r2(aging.d61_90 + net);
            else aging.d90plus = r2(aging.d90plus + net);
        }
        openItems.push({ number, date: isoDay(v.date), due: v.due ? isoDay(v.due) : "", total: v.debit, paid: v.credit, balance: net, daysOverdue: net > 0 ? late : 0 });
    }
    openItems.sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999") || numeric(a.number, b.number));

    return {
        currency,
        from: start ? isoDay(start) : null,
        to: isoDay(end),
        opening,
        closing: r2(balance),
        totals: { invoiced, paid },
        rows,
        openItems,
        aging,
    };
}

/* ----------------------------------------------------------------- ranges */

export type RangePreset = "all" | "thisMonth" | "last3" | "thisFy" | "thisYear";

/**
 * Preset date ranges. The financial year is April to March, the Indian
 * convention this app's GST module already follows.
 */
export function rangeFor(preset: RangePreset, now: Date = new Date()): { from: Date | null; to: Date } {
    const today = startOfDay(now);
    switch (preset) {
        case "thisMonth":
            return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: today };
        case "last3":
            return { from: new Date(now.getFullYear(), now.getMonth() - 2, 1), to: today };
        case "thisFy": {
            const startYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
            return { from: new Date(startYear, 3, 1), to: today };
        }
        case "thisYear":
            return { from: new Date(now.getFullYear(), 0, 1), to: today };
        default:
            return { from: null, to: today };
    }
}

/* -------------------------------------------------------------------- csv */

export function statementToCsv(s: Statement, customer: string): { filename: string; csv: string } {
    const c = s.currency;
    const rows: unknown[][] = [
        [s.from ?? "", "", "", "Opening balance", "", "", s.opening, c],
        ...s.rows.map((r) => [r.date, r.kind === "invoice" ? "Invoice" : "Payment", r.ref, r.description, r.debit || "", r.credit || "", r.balance, c]),
        [s.to, "", "", "Closing balance", "", "", s.closing, c],
    ];
    const safe = customer.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "customer";
    return {
        filename: `statement-${safe}-${c}-${s.from ?? "start"}_to_${s.to}.csv`,
        csv: toCsv(["Date", "Type", "Reference", "Description", "Debit", "Credit", "Balance", "Currency"], rows),
    };
}

/* ---------------------------------------------------------------- business */

type Party = InvoiceType["sender"];

/**
 * Who the statement is *from*: the sender on your latest invoice to this
 * customer, else on your latest invoice at all, else the first saved sender.
 */
export function pickBusiness(
    invoices: InvoiceType[],
    key: string,
    senders: Party[] = []
): { business: Party; logo: string } | null {
    const time = (i: InvoiceType) => parseDate(i.details.invoiceDate)?.getTime() ?? 0;
    const latest = (list: InvoiceType[]) => [...list].sort((a, b) => time(b) - time(a))[0];
    const own = latest(invoices.filter((i) => clientKey(i.receiver) === key));
    const any = own ?? latest(invoices);
    if (any) return { business: any.sender, logo: typeof any.details.invoiceLogo === "string" ? any.details.invoiceLogo : "" };
    return senders[0] ? { business: senders[0], logo: "" } : null;
}

/* ------------------------------------------------------- request payload */

const text = (max: number) =>
    z
        .string()
        .max(max)
        .transform((v) => stripControlChars(v));
const money = z.number().finite().min(-1e12).max(1e12);
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const PartySchema = z.object({
    name: text(120),
    address: text(200).optional(),
    zipCode: text(30).optional(),
    city: text(80).optional(),
    country: text(80).optional(),
    email: text(254).optional(),
    phone: text(50).optional(),
    gstin: text(20).optional(),
});

/**
 * What the PDF route accepts. The figures arrive pre-computed (they are the
 * user's own and the route only typesets them), but everything is bounded and
 * cleaned: sizes are capped, text is stripped of control characters, and the
 * logo must be an embedded image, never a URL the server would fetch.
 */
export const StatementPayloadSchema = z.object({
    generatedAt: ymd,
    business: PartySchema,
    logo: z
        .string()
        .max(3_000_000)
        .refine((v) => v === "" || /^data:image\/[a-z0-9.+-]+;base64,/i.test(v), { message: "Logo must be an embedded image" })
        .optional(),
    customer: PartySchema,
    statement: z.object({
        currency: z.string().min(1).max(8),
        from: ymd.nullable(),
        to: ymd,
        opening: money,
        closing: money,
        totals: z.object({ invoiced: money, paid: money }),
        rows: z
            .array(z.object({ date: ymd, kind: z.enum(["invoice", "payment"]), ref: text(100), description: text(200), debit: money, credit: money, balance: money }))
            .max(2000),
        openItems: z
            .array(z.object({ number: text(100), date: ymd, due: z.union([ymd, z.literal("")]), total: money, paid: money, balance: money, daysOverdue: z.number().int().min(0).max(100000) }))
            .max(500),
        aging: z.object({ current: money, d1_30: money, d31_60: money, d61_90: money, d90plus: money }),
    }),
});

export type StatementPayload = z.infer<typeof StatementPayloadSchema>;
