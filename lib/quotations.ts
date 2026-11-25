/**
 * Quotations: pure logic, no React and no storage.
 *
 * A quotation wraps an invoice-shaped document (`doc`: sender, receiver and
 * details with items, GST, discount, shipping, theme). That is deliberate: the
 * GST engine, the product picker, the charges maths, the templates and the PDF
 * route all work on that shape already, so a quotation reuses all of them
 * rather than re-implementing any.
 *
 * Mapping onto the document's fields:
 *   quotation number  details.invoiceNumber
 *   issue date        details.invoiceDate
 *   valid until       details.dueDate
 *
 * STATUS
 *   Stored (user-chosen):  draft · sent · accepted · rejected
 *   Derived:               expired = "sent" whose valid-until date has passed
 *   "expired" is never stored, so it cannot go stale: a quotation that is
 *   still open on the last day of its validity is not expired until the day
 *   after.
 *
 * CONVERSION
 *   Whether a quotation has been converted is *derived* from the invoices: an
 *   invoice that carries `details.quotationRef` pointing at it. There is no
 *   "converted" flag to drift out of step; delete the invoice and the
 *   quotation can be converted again, which is the right behaviour.
 *   Converting creates a **draft** invoice and touches no customer or product
 *   records. Stock moves only when that draft is later issued through the
 *   normal invoice workflow.
 */

import {
    addTo,
    clientKey,
    daysBetween,
    isoDay,
    parseDate,
    startOfDay,
    toCsv,
    type CurrencyTotals,
} from "@/lib/invoiceRecords";
import { incrementInvoiceNumber } from "@/lib/invoiceNumber";
import { stripControlChars } from "@/lib/schemas";
import type { InvoiceType } from "@/types";

/* ------------------------------------------------------------------ types */

export const QUOTATION_STATUSES = ["draft", "sent", "accepted", "rejected"] as const;
export type StoredQuotationStatus = (typeof QUOTATION_STATUSES)[number];
export type QuotationStatus = StoredQuotationStatus | "expired";
export const DISPLAY_QUOTATION_STATUSES: QuotationStatus[] = ["draft", "sent", "accepted", "rejected", "expired"];

export type QuotationEvent = {
    /** ISO timestamp. */
    at: string;
    kind: "created" | "edited" | StoredQuotationStatus;
};

export type Quotation = {
    id: string;
    status: StoredQuotationStatus;
    doc: InvoiceType;
    createdAt: string;
    updatedAt: string;
    events: QuotationEvent[];
};

export const DEFAULT_VALIDITY_DAYS = 30;
/** A sent quotation this close to its end is flagged. */
export const EXPIRY_WARNING_DAYS = 7;
export const QUOTATION_PREFIX = "QUO";
export const FALLBACK_QUOTATION_NUMBER = `${QUOTATION_PREFIX}-0001`;

/* ------------------------------------------------------------- accessors */

export const numberOf = (q: Quotation) => q.doc.details.invoiceNumber;
export const issueDateOf = (q: Quotation) => parseDate(q.doc.details.invoiceDate);
export const validUntilOf = (q: Quotation) => parseDate(q.doc.details.dueDate);
export const totalOf = (q: Quotation) => {
    const n = Number(q.doc.details.totalAmount);
    return Number.isFinite(n) ? n : 0;
};
export const currencyOf = (q: Quotation) => q.doc.details.currency || "USD";
export const customerOf = (q: Quotation) => q.doc.receiver.name;
export const customerKeyOf = (q: Quotation) => clientKey(q.doc.receiver);

/* ------------------------------------------------------------- sanitising */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Accepts anything and returns a structurally sound quotation, or null.
 * Cheap on purpose (it runs on every read); the full schema runs when a
 * quotation is saved or imported.
 */
export function sanitizeQuotation(input: unknown): Quotation | null {
    if (!isRecord(input) || !isRecord(input.doc)) return null;
    const id = typeof input.id === "string" ? stripControlChars(input.id).slice(0, 64) : "";
    const doc = input.doc as Record<string, unknown>;
    const details = doc.details;
    if (!id || !isRecord(details) || !isRecord(doc.sender) || !isRecord(doc.receiver)) return null;
    if (typeof details.invoiceNumber !== "string" || !details.invoiceNumber.trim()) return null;
    if (!Array.isArray(details.items)) return null;

    const status = QUOTATION_STATUSES.find((s) => s === input.status) ?? "draft";
    const now = new Date().toISOString();
    const events: QuotationEvent[] = Array.isArray(input.events)
        ? input.events
              .filter(isRecord)
              .map((e) => ({
                  at: typeof e.at === "string" ? e.at : now,
                  kind: (e.kind === "created" || e.kind === "edited" || QUOTATION_STATUSES.find((s) => s === e.kind)
                      ? e.kind
                      : "edited") as QuotationEvent["kind"],
              }))
              .slice(-40)
        : [];

    return {
        id,
        status,
        doc: input.doc as unknown as InvoiceType,
        createdAt: typeof input.createdAt === "string" ? input.createdAt : now,
        updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : now,
        events,
    };
}

/* ----------------------------------------------------------------- status */

/** Days from today to the last valid day. Negative once it has passed. */
export function daysLeft(q: Quotation, now: Date = new Date()): number | null {
    const until = validUntilOf(q);
    return until ? daysBetween(startOfDay(now), startOfDay(until)) : null;
}

/** A quotation is valid through the whole of its valid-until day. */
export function isExpired(q: Quotation, now: Date = new Date()): boolean {
    if (q.status !== "sent") return false;
    const left = daysLeft(q, now);
    return left !== null && left < 0;
}

export const displayStatus = (q: Quotation, now: Date = new Date()): QuotationStatus =>
    isExpired(q, now) ? "expired" : q.status;

export type ExpiryInfo = { state: "expired" | "soon" | "ok"; days: number };

/**
 * Expiry warning for something still open (draft or sent). `days` is days left,
 * or days since expiry when already expired. Null once a decision is made.
 */
export function expiryInfo(q: Quotation, now: Date = new Date(), soon = EXPIRY_WARNING_DAYS): ExpiryInfo | null {
    if (q.status !== "sent" && q.status !== "draft") return null;
    const left = daysLeft(q, now);
    if (left === null) return null;
    if (left < 0) return { state: "expired", days: -left };
    return { state: left <= soon ? "soon" : "ok", days: left };
}

/* ------------------------------------------------------------ conversions */

/** quotation id → number of the invoice made from it. */
export function conversionsOf(invoices: InvoiceType[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const inv of invoices) {
        const ref = inv.details.quotationRef;
        if (ref?.id && !out.has(ref.id)) out.set(ref.id, inv.details.invoiceNumber);
    }
    return out;
}

/* ------------------------------------------------------------ transitions */

export type QuotationCheck = { ok: true } | { ok: false; reason: string };

/**
 *   draft     → sent
 *   sent      → accepted · rejected · draft
 *   accepted  → sent            (withdraw the acceptance; not once converted)
 *   rejected  → sent · draft    (reopen)
 *
 * Reason codes map to `quotations.errors.<reason>` in the locale files.
 */
export function canTransition(
    q: Quotation,
    to: StoredQuotationStatus,
    { now = new Date(), converted = false }: { now?: Date; converted?: boolean } = {}
): QuotationCheck {
    const from = q.status;
    if (from === to) return { ok: true };
    if (converted) return { ok: false, reason: "converted" };

    if (to === "sent") {
        const left = daysLeft(q, now);
        // Cannot issue something that is already past its validity.
        if (from !== "accepted" && left !== null && left < 0) return { ok: false, reason: "validityPast" };
        return { ok: true };
    }
    if (to === "draft") return from === "accepted" ? { ok: false, reason: "reopenFirst" } : { ok: true };

    // to accepted / rejected: must have been sent
    if (from === "draft") return { ok: false, reason: "sendFirst" };
    if (from === "accepted" || from === "rejected") return { ok: false, reason: "reopenFirst" };
    // from === "sent"
    if (to === "accepted" && isExpired(q, now)) return { ok: false, reason: "expired" };
    return { ok: true };
}

/** Accepted and converted quotations are read-only: their terms were agreed. */
export function canEdit(q: Quotation, converted: boolean): QuotationCheck {
    if (converted) return { ok: false, reason: "converted" };
    if (q.status === "accepted") return { ok: false, reason: "accepted" };
    return { ok: true };
}

export function canDelete(_q: Quotation, converted: boolean): QuotationCheck {
    return converted ? { ok: false, reason: "converted" } : { ok: true };
}

export function canConvert(q: Quotation, converted: boolean): QuotationCheck {
    if (converted) return { ok: false, reason: "alreadyConverted" };
    if (q.status !== "accepted") return { ok: false, reason: "notAccepted" };
    return { ok: true };
}

/** Applies a status change and records it in the timeline. Assumes it was checked. */
export function withStatus(q: Quotation, to: StoredQuotationStatus, now: Date = new Date()): Quotation {
    if (q.status === to) return q;
    const at = now.toISOString();
    return { ...q, status: to, updatedAt: at, events: [...q.events, { at, kind: to }].slice(-40) };
}

/* -------------------------------------------------------------- numbering */

export const isNumberTaken = (list: Quotation[], number: string, exceptId?: string) => {
    const wanted = number.trim().toLowerCase();
    return list.some((q) => q.id !== exceptId && numberOf(q).trim().toLowerCase() === wanted);
};

/** QUO-0001, QUO-0002 …, continuing whatever scheme the latest quotation used. */
export function suggestQuotationNumber(list: Quotation[]): string {
    let candidate = FALLBACK_QUOTATION_NUMBER;
    for (let i = list.length - 1; i >= 0; i--) {
        const n = numberOf(list[i]);
        if (n?.trim()) {
            candidate = incrementInvoiceNumber(n);
            break;
        }
    }
    for (let i = 0; i < 1000 && isNumberTaken(list, candidate); i++) candidate = incrementInvoiceNumber(candidate);
    return candidate;
}

/* ------------------------------------------------------------ conversion */

export type ConversionContext = {
    invoiceNumber: string;
    now?: Date;
    /** Days from today to the invoice's due date. */
    dueDays: number;
    /**
     * Product ids that exist in the catalogue. A line pointing at a product
     * that no longer exists is kept as an ordinary line (its price, tax and
     * description are on it) but loses the dead link, so stock is never
     * touched on behalf of something that is gone.
     */
    knownProductIds?: Set<string>;
};

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * The draft invoice a quotation becomes.
 *
 * Everything that defines the sale carries over untouched: parties, every line
 * (with its product link, HSN, GST rate and unit), GST settings, discount,
 * shipping, notes, terms, branding and the totals themselves, so the invoice
 * adds up exactly as the quotation did. What changes is what is *about* the
 * document: a new invoice number, today's dates, "draft" status, and a
 * reference back to the quotation. It carries no payments, revisions or
 * schedule.
 *
 * It does not touch the address book or the catalogue: the customer and the
 * products are *referred to*, never created.
 */
export function quotationToInvoice(q: Quotation, ctx: ConversionContext): InvoiceType {
    const now = ctx.now ?? new Date();
    const copy = clone(q.doc);
    const d = copy.details as Record<string, unknown>;

    delete d.payments;
    delete d.revisions;
    delete d.recurring;
    delete d.updatedAt;

    d.invoiceNumber = ctx.invoiceNumber;
    d.invoiceDate = now.toISOString();
    d.dueDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + Math.max(0, ctx.dueDays)).toISOString();
    d.status = "draft";
    d.quotationRef = { id: q.id, number: numberOf(q) };

    if (ctx.knownProductIds) {
        for (const item of copy.details.items) {
            if (item.productId && !ctx.knownProductIds.has(item.productId)) {
                delete item.productId;
            }
        }
    }
    return copy;
}

/* ------------------------------------------------------------ query / sort */

export type QuotationSortKey = "date" | "number" | "customer" | "amount" | "validUntil" | "status";
export type QuotationFilter = "all" | QuotationStatus | "expiring" | "converted";

export type QuotationQuery = {
    search: string;
    filter: QuotationFilter;
    sort: QuotationSortKey;
    dir: "asc" | "desc";
    customerKey?: string;
};

export const EMPTY_QUOTATION_QUERY: QuotationQuery = { search: "", filter: "all", sort: "date", dir: "desc" };

const STATUS_ORDER: Record<QuotationStatus, number> = { draft: 0, sent: 1, accepted: 2, rejected: 3, expired: 4 };

export function queryQuotations(
    list: Quotation[],
    query: QuotationQuery,
    { now = new Date(), converted = new Map<string, string>() }: { now?: Date; converted?: Map<string, string> } = {}
): Quotation[] {
    const needle = query.search.trim().toLowerCase();
    const out = list.filter((q) => {
        if (query.customerKey && customerKeyOf(q) !== query.customerKey) return false;
        if (needle) {
            const hay = [numberOf(q), q.doc.receiver.name, q.doc.receiver.email, q.doc.details.additionalNotes ?? ""].join(" ").toLowerCase();
            if (!hay.includes(needle)) return false;
        }
        switch (query.filter) {
            case "all":
                return true;
            case "converted":
                return converted.has(q.id);
            case "expiring": {
                const info = expiryInfo(q, now);
                return q.status === "sent" && info?.state === "soon";
            }
            default:
                return displayStatus(q, now) === query.filter;
        }
    });

    const dir = query.dir === "asc" ? 1 : -1;
    const time = (d: Date | null) => d?.getTime() ?? 0;
    return out.sort((a, b) => {
        let cmp = 0;
        switch (query.sort) {
            case "number":
                cmp = numberOf(a).localeCompare(numberOf(b), undefined, { numeric: true });
                break;
            case "customer":
                cmp = customerOf(a).localeCompare(customerOf(b));
                break;
            case "amount":
                cmp = totalOf(a) - totalOf(b);
                break;
            case "validUntil":
                cmp = time(validUntilOf(a)) - time(validUntilOf(b));
                break;
            case "status":
                cmp = STATUS_ORDER[displayStatus(a, now)] - STATUS_ORDER[displayStatus(b, now)];
                break;
            default:
                cmp = time(issueDateOf(a)) - time(issueDateOf(b));
        }
        // Stable tiebreak so equal keys do not shuffle between renders.
        return (cmp || numberOf(a).localeCompare(numberOf(b), undefined, { numeric: true })) * dir;
    });
}

/* ------------------------------------------------------------------ stats */

export type QuotationStats = {
    total: number;
    draft: number;
    /** Sent and still within validity: waiting for an answer. */
    pending: number;
    accepted: number;
    rejected: number;
    expired: number;
    expiringSoon: number;
    converted: number;
    /** Quotations that have left draft. The denominator of the conversion rate. */
    issued: number;
    /** accepted ÷ issued, or null when nothing has been issued. */
    conversionRate: number | null;
    /** Value of everything issued (not draft), per currency. */
    value: CurrencyTotals;
    acceptedValue: CurrencyTotals;
    pendingValue: CurrencyTotals;
    rejectedValue: CurrencyTotals;
};

/**
 * Definitions, stated once:
 *   issued           not a draft
 *   pending          sent and not yet expired
 *   conversion rate  accepted ÷ issued
 *   value            sum of issued quotations, per currency (never across)
 * `converted` counts accepted quotations that became an invoice, a separate,
 * stricter measure than acceptance.
 */
export function quotationStats(
    list: Quotation[],
    { now = new Date(), converted = new Map<string, string>() }: { now?: Date; converted?: Map<string, string> } = {}
): QuotationStats {
    const stats: QuotationStats = {
        total: list.length,
        draft: 0,
        pending: 0,
        accepted: 0,
        rejected: 0,
        expired: 0,
        expiringSoon: 0,
        converted: 0,
        issued: 0,
        conversionRate: null,
        value: {},
        acceptedValue: {},
        pendingValue: {},
        rejectedValue: {},
    };

    for (const q of list) {
        const status = displayStatus(q, now);
        const c = currencyOf(q);
        const v = totalOf(q);
        if (status === "draft") {
            stats.draft++;
            continue;
        }
        stats.issued++;
        addTo(stats.value, c, v);
        if (status === "accepted") {
            stats.accepted++;
            addTo(stats.acceptedValue, c, v);
            if (converted.has(q.id)) stats.converted++;
        } else if (status === "rejected") {
            stats.rejected++;
            addTo(stats.rejectedValue, c, v);
        } else if (status === "expired") {
            stats.expired++;
        } else {
            stats.pending++;
            addTo(stats.pendingValue, c, v);
            if (expiryInfo(q, now)?.state === "soon") stats.expiringSoon++;
        }
    }
    stats.conversionRate = stats.issued > 0 ? stats.accepted / stats.issued : null;
    return stats;
}

/* -------------------------------------------------------------------- csv */

export function quotationsToCsv(list: Quotation[], converted: Map<string, string>, now: Date = new Date()): string {
    return toCsv(
        ["Quotation #", "Customer", "Email", "Issued", "Valid until", "Status", "Subtotal", "GST", "Total", "Currency", "Converted to invoice"],
        list.map((q) => {
            const issued = issueDateOf(q);
            const until = validUntilOf(q);
            return [
                numberOf(q),
                customerOf(q),
                q.doc.receiver.email,
                issued ? isoDay(issued) : "",
                until ? isoDay(until) : "",
                displayStatus(q, now),
                Number(q.doc.details.subTotal) || 0,
                q.doc.details.gst?.enabled ? q.doc.details.gst.totalTax ?? 0 : 0,
                totalOf(q),
                currencyOf(q),
                converted.get(q.id) ?? "",
            ];
        })
    );
}
