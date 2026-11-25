/**
 * Pure helpers over the saved-invoice list: status, payments, transitions,
 * search/sort, recurring schedules, reminders, revisions, clients and CSV.
 *
 * No React and no storage, so every number the app shows is derived from real
 * saved data by functions a test can call directly.
 *
 * STATUS MODEL
 *   Stored (user-chosen):  draft · sent · cancelled
 *   Derived (never stored): partial · paid · overdue
 *
 * "Paid" and "partial" come from the recorded payments, "overdue" from the due
 * date. Storing them would let them contradict the payments they describe;
 * deriving them makes that impossible.
 */

import { INVOICE_STATUSES, INVOICE_STATUS_VALUES } from "@/lib/schemas";
import { roundMoney } from "@/lib/calculations";
import type { InvoiceType } from "@/types";

export type StoredStatus = (typeof INVOICE_STATUSES)[number];
export type DisplayStatus = StoredStatus | "partial" | "paid" | "overdue";
export type Payment = NonNullable<InvoiceType["details"]["payments"]>[number];
export type Recurrence = NonNullable<InvoiceType["details"]["recurring"]>;
export type Revision = NonNullable<InvoiceType["details"]["revisions"]>[number];

export const DISPLAY_STATUSES: DisplayStatus[] = [
    "draft",
    "sent",
    "partial",
    "overdue",
    "paid",
    "cancelled",
];

export const PAYMENT_METHODS = ["bank", "card", "cash", "cheque", "other"] as const;

/* ------------------------------------------------------------------ dates */

/** Saved invoices hold Date objects in memory and ISO/display strings on disk. */
export function parseDate(value: unknown): Date | null {
    if (value === null || value === undefined || value === "") return null;
    const d = value instanceof Date ? value : new Date(value as string);
    return Number.isNaN(d.getTime()) ? null : d;
}

export const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** yyyy-mm-dd in local time (toISOString would shift the day near midnight). */
export const isoDay = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const daysBetween = (from: Date, to: Date) =>
    Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / 86_400_000);

/** Adds calendar months, clamping the day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: Date, months: number): Date {
    const d = new Date(date.getFullYear(), date.getMonth() + months, 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(date.getDate(), last));
    return d;
}

export function addPeriod(date: Date, frequency: Recurrence["frequency"], times = 1): Date {
    switch (frequency) {
        case "weekly":
            return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 7 * times);
        case "monthly":
            return addMonths(date, times);
        case "quarterly":
            return addMonths(date, 3 * times);
        case "yearly":
            return addMonths(date, 12 * times);
        default:
            return date;
    }
}

/* --------------------------------------------------------------- amounts */

export const invoiceTotal = (invoice: InvoiceType): number => {
    const n = Number(invoice.details.totalAmount);
    return Number.isFinite(n) ? n : 0;
};

/** Invoices marked "paid" by the first dashboard version carry no payment rows. */
const isLegacyPaid = (invoice: InvoiceType) =>
    invoice.details.status === "paid" && !(invoice.details.payments?.length);

export function paymentsOf(invoice: InvoiceType): Payment[] {
    if (isLegacyPaid(invoice)) {
        return [
            {
                id: "legacy-paid",
                date: isoDay(parseDate(invoice.details.invoiceDate) ?? new Date()),
                amount: invoiceTotal(invoice),
                method: "other",
            },
        ].filter((p) => p.amount > 0);
    }
    return invoice.details.payments ?? [];
}

export function amountPaid(invoice: InvoiceType): number {
    const sum = paymentsOf(invoice).reduce((s, p) => s + (Number(p.amount) || 0), 0);
    return roundMoney(Math.min(sum, invoiceTotal(invoice)));
}

export const balanceDue = (invoice: InvoiceType): number =>
    roundMoney(Math.max(0, invoiceTotal(invoice) - amountPaid(invoice)));

/* ----------------------------------------------------------------- status */

/** What the user chose. Legacy values collapse onto the three real ones. */
export function storedStatus(invoice: InvoiceType): StoredStatus {
    const s = invoice.details.status;
    if (s === "draft" || s === "cancelled") return s;
    if (s && !(INVOICE_STATUS_VALUES as readonly string[]).includes(s)) return "sent";
    return "sent";
}

/**
 * What the user sees. A draft was never issued and a cancelled invoice is no
 * longer owed, so neither can be paid or overdue. For issued invoices the
 * payments decide paid / partial, and an unpaid balance past its due date is
 * overdue (taking precedence over "partial" because it is the more urgent fact).
 */
export function displayStatus(
    invoice: InvoiceType,
    now: Date = new Date()
): DisplayStatus {
    const stored = storedStatus(invoice);
    if (stored !== "sent") return stored;

    const total = invoiceTotal(invoice);
    const paid = amountPaid(invoice);
    if (total > 0 && paid >= total) return "paid";

    const due = parseDate(invoice.details.dueDate);
    if (due && startOfDay(due) < startOfDay(now)) return "overdue";

    return paid > 0 ? "partial" : "sent";
}

export const isOpen = (s: DisplayStatus) =>
    s === "sent" || s === "partial" || s === "overdue";

/* ------------------------------------------------------------ transitions */

/** `detail` is optional human-readable context (e.g. which products are short). */
export type TransitionResult = { ok: true } | { ok: false; reason: string; detail?: string };

/**
 * Which user-chosen state changes are legitimate.
 *
 *   draft      → sent, cancelled
 *   sent       → draft, cancelled      (only while nothing has been paid)
 *   cancelled  → draft                 (reopen; it must be re-issued)
 *
 * Money in the books blocks moving an invoice back to draft or cancelling it:
 * remove or refund the payments first. Reason codes map to
 * `invoices.errors.<reason>` in the locale files.
 */
export function canTransition(invoice: InvoiceType, to: StoredStatus): TransitionResult {
    const from = storedStatus(invoice);
    if (from === to) return { ok: true };

    const hasPayments = amountPaid(invoice) > 0;
    if (from === "draft") return { ok: true };
    if (from === "cancelled") {
        return to === "draft" ? { ok: true } : { ok: false, reason: "reopenFirst" };
    }
    // from === "sent"
    if (hasPayments) return { ok: false, reason: "hasPayments" };
    return { ok: true };
}

export type PaymentInput = {
    amount: number;
    date: string;
    method?: string;
    note?: string;
};

/** Validates a payment against the invoice without changing anything. */
export function canRecordPayment(
    invoice: InvoiceType,
    input: PaymentInput,
    now: Date = new Date()
): TransitionResult {
    const status = storedStatus(invoice);
    if (status === "draft") return { ok: false, reason: "paymentOnDraft" };
    if (status === "cancelled") return { ok: false, reason: "paymentOnCancelled" };

    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "amountInvalid" };
    if (roundMoney(amount) > balanceDue(invoice)) return { ok: false, reason: "overpayment" };

    const date = parseDate(input.date);
    if (!date) return { ok: false, reason: "dateInvalid" };
    if (startOfDay(date) > startOfDay(now)) return { ok: false, reason: "dateFuture" };
    const issued = parseDate(invoice.details.invoiceDate);
    if (issued && startOfDay(date) < startOfDay(issued)) return { ok: false, reason: "dateBeforeIssue" };

    return { ok: true };
}

/** Returns the updated invoice, or the reason the payment was refused. */
export function withPayment(
    invoice: InvoiceType,
    input: PaymentInput,
    id: string,
    now: Date = new Date()
): { ok: true; invoice: InvoiceType } | { ok: false; reason: string } {
    const check = canRecordPayment(invoice, input, now);
    if (!check.ok) return check;

    // Legacy "paid" invoices have no rows, so there is no balance to add to.
    const existing = isLegacyPaid(invoice) ? [] : invoice.details.payments ?? [];
    const payment: Payment = {
        id,
        date: input.date,
        amount: roundMoney(Number(input.amount)),
        ...(input.method ? { method: input.method } : {}),
        ...(input.note ? { note: input.note } : {}),
    };
    return {
        ok: true,
        invoice: {
            ...invoice,
            details: { ...invoice.details, status: "sent", payments: [...existing, payment] },
        },
    };
}

export function withoutPayment(invoice: InvoiceType, paymentId: string): InvoiceType {
    // A legacy "paid" invoice is materialised first so the removal is real.
    const base = paymentsOf(invoice);
    return {
        ...invoice,
        details: {
            ...invoice.details,
            status: storedStatus(invoice),
            payments: base.filter((p) => p.id !== paymentId),
        },
    };
}

/* ------------------------------------------------------------------ money */

export function formatMoney(amount: number, currency: string, locale = "en"): string {
    try {
        return new Intl.NumberFormat(locale, {
            style: "currency",
            currency,
            maximumFractionDigits: 2,
        }).format(amount);
    } catch {
        // Unknown ISO code or locale: still show something honest.
        return `${amount.toLocaleString(locale, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        })} ${currency}`;
    }
}

export type CurrencyTotals = Record<string, number>;

export const addTo = (totals: CurrencyTotals, currency: string, amount: number) => {
    totals[currency] = roundMoney((totals[currency] ?? 0) + amount);
};

/* ------------------------------------------------------- search and sort */

export type SortKey = "date" | "amount" | "status" | "number" | "client" | "due" | "balance";
export type SortDir = "asc" | "desc";

export type InvoiceQuery = {
    search: string;
    status: DisplayStatus | "all";
    sortKey: SortKey;
    sortDir: SortDir;
    /** Exact client name (case-insensitive). */
    client?: string;
    currency?: string;
    minAmount?: number | null;
    maxAmount?: number | null;
    /** Issue-date range, inclusive, yyyy-mm-dd. */
    from?: string;
    to?: string;
    recurringOnly?: boolean;
};

export const EMPTY_QUERY: InvoiceQuery = {
    search: "",
    status: "all",
    sortKey: "date",
    sortDir: "desc",
};

/** True when anything other than the sort differs from the empty query. */
export const hasActiveFilters = (q: InvoiceQuery) =>
    q.search.trim() !== "" ||
    q.status !== "all" ||
    !!q.client ||
    !!q.currency ||
    (q.minAmount ?? null) !== null ||
    (q.maxAmount ?? null) !== null ||
    !!q.from ||
    !!q.to ||
    !!q.recurringOnly;

const STATUS_ORDER: Record<DisplayStatus, number> = {
    overdue: 0,
    partial: 1,
    sent: 2,
    draft: 3,
    paid: 4,
    cancelled: 5,
};

export function queryInvoices(
    invoices: InvoiceType[],
    q: InvoiceQuery,
    now: Date = new Date()
): InvoiceType[] {
    const needle = q.search.trim().toLowerCase();
    const from = q.from ? parseDate(`${q.from}T00:00:00`) : null;
    const to = q.to ? parseDate(`${q.to}T23:59:59`) : null;
    const client = q.client?.trim().toLowerCase();

    const rows = invoices.filter((inv) => {
        if (q.status !== "all" && displayStatus(inv, now) !== q.status) return false;
        if (client && inv.receiver.name.trim().toLowerCase() !== client) return false;
        if (q.currency && inv.details.currency !== q.currency) return false;

        const total = invoiceTotal(inv);
        if (q.minAmount !== null && q.minAmount !== undefined && total < q.minAmount) return false;
        if (q.maxAmount !== null && q.maxAmount !== undefined && total > q.maxAmount) return false;

        if (from || to) {
            const issued = parseDate(inv.details.invoiceDate);
            if (!issued) return false;
            if (from && issued < from) return false;
            if (to && issued > to) return false;
        }
        if (q.recurringOnly && (inv.details.recurring?.frequency ?? "none") === "none") return false;

        if (!needle) return true;
        const haystack = [
            inv.details.invoiceNumber,
            inv.receiver.name,
            inv.receiver.email,
            inv.sender.name,
            inv.details.currency,
            String(inv.details.totalAmount),
            inv.details.purchaseOrderNumber ?? "",
            inv.details.additionalNotes ?? "",
        ]
            .join(" ")
            .toLowerCase();
        return haystack.includes(needle);
    });

    const dir = q.sortDir === "asc" ? 1 : -1;
    const cmp = (a: InvoiceType, b: InvoiceType): number => {
        switch (q.sortKey) {
            case "amount":
                return invoiceTotal(a) - invoiceTotal(b);
            case "balance":
                return balanceDue(a) - balanceDue(b);
            case "status":
                return STATUS_ORDER[displayStatus(a, now)] - STATUS_ORDER[displayStatus(b, now)];
            case "number":
                return a.details.invoiceNumber.localeCompare(b.details.invoiceNumber, undefined, {
                    numeric: true,
                });
            case "client":
                return a.receiver.name.localeCompare(b.receiver.name);
            case "due":
                return (
                    (parseDate(a.details.dueDate)?.getTime() ?? 0) -
                    (parseDate(b.details.dueDate)?.getTime() ?? 0)
                );
            case "date":
            default:
                return (
                    (parseDate(a.details.invoiceDate)?.getTime() ?? 0) -
                    (parseDate(b.details.invoiceDate)?.getTime() ?? 0)
                );
        }
    };

    // Array.prototype.sort is stable, so ties keep their saved order.
    return [...rows].sort((a, b) => dir * cmp(a, b));
}

/* ---------------------------------------------------------------- clients */

export type ClientSummary = {
    key: string;
    name: string;
    email: string;
    phone: string;
    invoiceCount: number;
    /** Invoices that have been issued (not draft, not cancelled). */
    issuedCount: number;
    /** Invoiced (excludes drafts and cancelled), per currency. */
    billed: CurrencyTotals;
    paid: CurrencyTotals;
    outstanding: CurrencyTotals;
    /** The part of `outstanding` that is past its due date, per currency. */
    overdue: CurrencyTotals;
    overdueCount: number;
    lastInvoice: Date | null;
};

export const clientKey = (party: { email?: string; name: string }) =>
    (party.email || party.name).trim().toLowerCase();

/** Clients are whoever you billed; invoices stay the source of truth for money. */
export function summariseClients(
    invoices: InvoiceType[],
    now: Date = new Date()
): ClientSummary[] {
    const map = new Map<string, ClientSummary>();

    for (const inv of invoices) {
        const { name, email, phone } = inv.receiver;
        const key = clientKey(inv.receiver);
        if (!key) continue;

        let c = map.get(key);
        if (!c) {
            c = {
                key,
                name,
                email,
                phone,
                invoiceCount: 0,
                issuedCount: 0,
                billed: {},
                paid: {},
                outstanding: {},
                overdue: {},
                overdueCount: 0,
                lastInvoice: null,
            };
            map.set(key, c);
        }

        const status = displayStatus(inv, now);
        const currency = inv.details.currency || "USD";
        c.invoiceCount += 1;

        if (status !== "draft" && status !== "cancelled") {
            c.issuedCount += 1;
            addTo(c.billed, currency, invoiceTotal(inv));
            addTo(c.paid, currency, amountPaid(inv));
            addTo(c.outstanding, currency, balanceDue(inv));
        }
        if (status === "overdue") {
            c.overdueCount += 1;
            addTo(c.overdue, currency, balanceDue(inv));
        }

        const issued = parseDate(inv.details.invoiceDate);
        if (issued && (!c.lastInvoice || issued > c.lastInvoice)) {
            c.lastInvoice = issued;
            // The most recent details win: addresses and emails change.
            c.name = name;
            c.email = email;
            c.phone = phone;
        }
    }

    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* -------------------------------------------------------------- duplicate */

/** Heavy or history-bearing parts that a copy must not inherit. */
const detach = (invoice: InvoiceType): InvoiceType => {
    const copy = JSON.parse(JSON.stringify(invoice)) as InvoiceType;
    delete copy.details.payments;
    delete copy.details.revisions;
    delete copy.details.recurring;
    delete copy.details.updatedAt;
    // A copy is a new sale, not a second conversion of the same quotation.
    delete copy.details.quotationRef;
    return copy;
};

/** Term length in ms between issue and due, never negative. */
const termMs = (invoice: InvoiceType) => {
    const issued = parseDate(invoice.details.invoiceDate);
    const due = parseDate(invoice.details.dueDate);
    return issued && due ? Math.max(0, due.getTime() - issued.getTime()) : 0;
};

/**
 * A copy for re-billing: new number, today's date, the same payment term
 * length, back to draft, with no payments, history or schedule of its own.
 * Logo and signature are kept.
 */
export function duplicateOf(
    source: InvoiceType,
    existingNumbers: string[],
    nextNumber: (previous: string) => string,
    now: Date = new Date()
): InvoiceType {
    const taken = new Set(existingNumbers);
    let number = nextNumber(source.details.invoiceNumber);
    // Bounded so a pathological scheme cannot loop forever.
    for (let i = 0; i < 1000 && taken.has(number); i++) number = nextNumber(number);

    const copy = detach(source);
    copy.details.invoiceNumber = number;
    copy.details.status = "draft";
    (copy.details as { invoiceDate: unknown }).invoiceDate = now;
    (copy.details as { dueDate: unknown }).dueDate = new Date(now.getTime() + termMs(source));
    return copy;
}

/* -------------------------------------------------------------- recurring */

export const MAX_RECURRING_PER_RUN = 12;

/**
 * Generates the drafts that a recurring schedule owes up to `now`.
 *
 * There is no server, so this runs when the app opens: a schedule that was due
 * while the app was closed is caught up on the next visit, one draft per
 * missed period (capped), each dated to the period it belongs to. Generated
 * invoices are drafts — nothing is ever sent on the user's behalf.
 */
export function runRecurring(
    invoices: InvoiceType[],
    nextNumber: (previous: string) => string,
    now: Date = new Date()
): { invoices: InvoiceType[]; created: InvoiceType[] } {
    const created: InvoiceType[] = [];
    const taken = new Set(invoices.map((i) => i.details.invoiceNumber));

    const updated = invoices.map((source) => {
        const rec = source.details.recurring;
        if (!rec || rec.frequency === "none" || storedStatus(source) === "cancelled") return source;

        let next = parseDate(rec.nextDate);
        if (!next) return source;
        const end = parseDate(rec.endDate);
        const term = termMs(source);

        let produced = 0;
        while (
            startOfDay(next) <= startOfDay(now) &&
            (!end || startOfDay(next) <= startOfDay(end)) &&
            produced < MAX_RECURRING_PER_RUN
        ) {
            let number = nextNumber(created.at(-1)?.details.invoiceNumber ?? source.details.invoiceNumber);
            for (let i = 0; i < 1000 && taken.has(number); i++) number = nextNumber(number);
            taken.add(number);

            const copy = detach(source);
            copy.details.invoiceNumber = number;
            copy.details.status = "draft";
            (copy.details as { invoiceDate: unknown }).invoiceDate = next;
            (copy.details as { dueDate: unknown }).dueDate = new Date(next.getTime() + term);
            copy.details.recurring = {
                frequency: "none",
                sourceNumber: source.details.invoiceNumber,
            };
            created.push(copy);

            next = addPeriod(next, rec.frequency);
            produced += 1;
        }

        if (produced === 0) return source;
        return {
            ...source,
            details: {
                ...source.details,
                recurring: { ...rec, nextDate: isoDay(next) },
            },
        };
    });

    return { invoices: [...updated, ...created], created };
}

/* --------------------------------------------------------------- reminders */

export type Reminder = {
    invoice: InvoiceType;
    kind: "overdue" | "dueSoon";
    /** Days past due (overdue) or until due (dueSoon). */
    days: number;
    balance: number;
};

/**
 * Invoices that need chasing: open balances that are overdue, or fall due
 * within `leadDays`. Most urgent first.
 */
export function reminderCandidates(
    invoices: InvoiceType[],
    now: Date = new Date(),
    leadDays = 3
): Reminder[] {
    const out: Reminder[] = [];
    for (const invoice of invoices) {
        const status = displayStatus(invoice, now);
        if (!isOpen(status)) continue;
        const due = parseDate(invoice.details.dueDate);
        if (!due) continue;
        const diff = daysBetween(now, due); // negative once overdue
        const balance = balanceDue(invoice);
        if (diff < 0) out.push({ invoice, kind: "overdue", days: -diff, balance });
        else if (diff <= leadDays) out.push({ invoice, kind: "dueSoon", days: diff, balance });
    }
    return out.sort((a, b) =>
        a.kind === b.kind ? (a.kind === "overdue" ? b.days - a.days : a.days - b.days) : a.kind === "overdue" ? -1 : 1
    );
}

/**
 * A mailto: link, so a reminder is composed in the user's own mail client with
 * no server and no credentials involved. Subject and body are caller-supplied
 * (localised) templates with [number], [amount], [due], [client] and [sender] placeholders.
 */
export function reminderMailto(
    invoice: InvoiceType,
    templates: { subject: string; body: string },
    locale = "en"
): string {
    const fill = (text: string) =>
        text
            .replace(/\[number\]/g, invoice.details.invoiceNumber)
            .replace(/\[client\]/g, invoice.receiver.name)
            .replace(/\[amount\]/g, formatMoney(balanceDue(invoice), invoice.details.currency, locale))
            .replace(
                /\[due\]/g,
                parseDate(invoice.details.dueDate)?.toLocaleDateString(locale, {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                }) ?? ""
            )
            .replace(/\[sender\]/g, invoice.sender.name);
    return `mailto:${encodeURIComponent(invoice.receiver.email.trim()).replace(/%40/g, "@")}?subject=${encodeURIComponent(
        fill(templates.subject)
    )}&body=${encodeURIComponent(fill(templates.body))}`;
}

/* -------------------------------------------------------------- revisions */

export const MAX_REVISIONS = 15;

/** Removes what makes a snapshot expensive or meaningless to compare. */
export function snapshotOf(invoice: InvoiceType): Record<string, unknown> {
    const copy = JSON.parse(JSON.stringify(invoice)) as InvoiceType;
    delete copy.details.revisions;
    delete copy.details.payments;
    delete copy.details.updatedAt;
    delete copy.details.invoiceLogo;
    if (copy.details.signature?.data?.startsWith("data:")) copy.details.signature.data = "";
    return copy as unknown as Record<string, unknown>;
}

const stable = (value: unknown): string =>
    JSON.stringify(value, (_k, v) =>
        v && typeof v === "object" && !Array.isArray(v)
            ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
            : v
    );

/** True when saving `next` over `prev` would change anything worth recording. */
export const hasMeaningfulChange = (prev: InvoiceType, next: InvoiceType) =>
    stable(snapshotOf(prev)) !== stable(snapshotOf(next));

/** Adds `prev` to the revision list that `next` will carry. */
export function withRevision(
    prev: InvoiceType,
    next: InvoiceType,
    id: string,
    now: Date = new Date()
): InvoiceType {
    const history = [...(prev.details.revisions ?? [])];
    if (hasMeaningfulChange(prev, next)) {
        history.push({
            id,
            savedAt: now.toISOString(),
            total: invoiceTotal(prev),
            status: storedStatus(prev),
            snapshot: snapshotOf(prev),
        });
    }
    return {
        ...next,
        details: { ...next.details, revisions: history.slice(-MAX_REVISIONS) },
    };
}

/** Applies a revision over the current invoice, keeping logo, signature, payments and history. */
export function restoreRevision(current: InvoiceType, revision: Revision): InvoiceType {
    const snap = revision.snapshot as unknown as InvoiceType;
    return {
        ...snap,
        details: {
            ...snap.details,
            invoiceLogo: current.details.invoiceLogo,
            signature: snap.details.signature?.data ? snap.details.signature : current.details.signature,
            payments: current.details.payments,
            revisions: current.details.revisions,
            // Restoring never un-pays: status follows the current books.
            status: storedStatus(current),
        },
    };
}

/* -------------------------------------------------------------------- CSV */

/** Quotes a cell and defuses spreadsheet formula injection (=, +, -, @). */
export const csvCell = (value: unknown): string => {
    let s = String(value ?? "");
    // A real number (a negative balance, say) is data, not a formula: leave it
    // numeric. Only text that merely looks like a formula is defused.
    if (!(typeof value === "number" && Number.isFinite(value)) && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
};

export const toCsv = (header: string[], rows: unknown[][]): string =>
    [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");

export function invoicesToCsv(invoices: InvoiceType[], now: Date = new Date()): string {
    const day = (v: unknown) => {
        const d = parseDate(v);
        return d ? isoDay(d) : "";
    };
    return toCsv(
        [
            "Invoice #",
            "Status",
            "Client",
            "Client email",
            "Invoice date",
            "Due date",
            "Currency",
            "Subtotal",
            "Total",
            "Paid",
            "Balance",
        ],
        invoices.map((inv) => [
            inv.details.invoiceNumber,
            displayStatus(inv, now),
            inv.receiver.name,
            inv.receiver.email,
            day(inv.details.invoiceDate),
            day(inv.details.dueDate),
            inv.details.currency,
            inv.details.subTotal,
            inv.details.totalAmount,
            amountPaid(inv),
            balanceDue(inv),
        ])
    );
}

/* ------------------------------------------------------- unsaved changes */

/** Keys that change without the user editing anything, or are too heavy to compare. */
const SIGNATURE_SKIP = new Set([
    "invoiceLogo",
    "updatedAt",
    "revisions",
    "payments",
    "subTotal",
    "totalAmount",
    "totalAmountInWords",
]);

/**
 * A comparable fingerprint of the form. Derived totals, the logo's megabytes of
 * base64 and the saved-record bookkeeping are left out, and keys are sorted so
 * a form that was reset from a saved invoice compares equal to the same data
 * typed by hand.
 */
export function formSignature(values: unknown): string {
    return JSON.stringify(values, (key, value) => {
        if (SIGNATURE_SKIP.has(key)) return undefined;
        if (typeof value === "string" && value.startsWith("data:")) return undefined;
        if (value && typeof value === "object" && !Array.isArray(value)) {
            return Object.fromEntries(
                Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
            );
        }
        return value;
    });
}

/** True once the user has typed anything meaningful. */
export function formHasContent(v: InvoiceType): boolean {
    return !!(
        v?.sender?.name?.trim() ||
        v?.receiver?.name?.trim() ||
        v?.details?.items?.some((i) => i?.name?.trim())
    );
}
