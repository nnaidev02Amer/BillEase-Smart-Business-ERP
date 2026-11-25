/**
 * Customer relationship logic: pure, no React and no storage.
 *
 * Customers are not a second source of truth for money. Profiles (the address
 * book) hold who someone is; every figure about them (invoiced, paid,
 * outstanding, overdue, quotations) is *derived* from the saved invoices and
 * quotations, using the same helpers and definitions as the dashboard, so a
 * customer's numbers can never disagree with the invoice list.
 *
 * Definitions, stated once:
 *   invoiced     total of issued invoices (status "sent": not draft, not cancelled)
 *   paid         payments recorded against those invoices
 *   outstanding  unpaid balance of issued invoices
 *   overdue      the part of outstanding past its due date
 *   revenue      same as invoiced; ranking uses it, per currency
 * Money is never added across currencies: every figure is per currency.
 *
 *   days to pay  issue date → date of the final payment, fully paid invoices only
 *   on time      the final payment landed on or before the due date
 *   behaviour    needs at least 2 fully paid invoices; otherwise "unknown"
 *                (one data point is an anecdote, not a pattern)
 */

import { roundMoney } from "@/lib/calculations";
import { normaliseGstin } from "@/lib/gst";
import {
    addTo,
    balanceDue,
    clientKey,
    daysBetween,
    displayStatus,
    invoiceTotal,
    parseDate,
    paymentsOf,
    startOfDay,
    storedStatus,
    summariseClients,
    type ClientSummary,
    type CurrencyTotals,
} from "@/lib/invoiceRecords";
import type { SavedParty } from "@/lib/partyStore";
import {
    currencyOf,
    customerKeyOf,
    displayStatus as quotationStatus,
    expiryInfo,
    issueDateOf,
    numberOf as quotationNumber,
    totalOf as quotationTotal,
    type Quotation,
} from "@/lib/quotations";
import type { InvoiceType } from "@/types";

/* ------------------------------------------------------------------ types */

export type QuoteStats = {
    count: number;
    draft: number;
    pending: number;
    accepted: number;
    rejected: number;
    expired: number;
    expiringSoon: number;
    /** Accepted quotations that no invoice has been made from yet. */
    acceptedNotInvoiced: Quotation[];
    /** Value of issued (non-draft) quotations, per currency. */
    issuedValue: CurrencyTotals;
    acceptedValue: CurrencyTotals;
    pendingValue: CurrencyTotals;
    lastQuotation: Date | null;
};

export type PayClass = "unknown" | "reliable" | "mixed" | "late";

export type Behaviour = {
    paidInvoices: number;
    avgDaysToPay: number | null;
    onTimeRate: number | null;
    avgDaysLate: number | null;
    lateCount: number;
    class: PayClass;
};

export type Frequency = {
    /** Issued invoices in the 12 months to `now`. */
    count12m: number;
    /** Mean days between consecutive issued invoices, or null with fewer than 2. */
    avgGapDays: number | null;
    daysSinceLast: number | null;
    total: number;
};

export type CustomerRecord = {
    key: string;
    profile: SavedParty | null;
    name: string;
    email: string;
    phone: string;
    gstin: string;
    company: string;
    contactPerson: string;
    website: string;
    category: string;
    tags: string[];
    city: string;
    active: boolean;
    /** Invoice aggregates (the same `summariseClients` the quick view uses). */
    invoices: ClientSummary | null;
    quotes: QuoteStats;
    behaviour: Behaviour;
    frequency: Frequency;
    /** Currency with the most invoiced (else quoted) value; the default for single-currency views. */
    primaryCurrency: string;
    lastPayment: Date | null;
    lastActivity: Date | null;
};

/* --------------------------------------------------------------- helpers */

const clean = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const dayOf = (v: unknown) => parseDate(v);

const isIssued = (inv: InvoiceType) => storedStatus(inv) === "sent";

const maxDate = (...ds: (Date | null | undefined)[]) =>
    ds.reduce<Date | null>((best, d) => (d && (!best || d > best) ? d : best), null);

const primaryOf = (...maps: CurrencyTotals[]): string => {
    for (const m of maps) {
        const top = Object.entries(m).sort((a, b) => b[1] - a[1])[0];
        if (top && top[1] > 0) return top[0];
    }
    return "USD";
};

/* ------------------------------------------------------------ quotations */

export function quoteStatsOf(quotations: Quotation[], converted: Map<string, string>, now: Date): QuoteStats {
    const s: QuoteStats = {
        count: quotations.length,
        draft: 0,
        pending: 0,
        accepted: 0,
        rejected: 0,
        expired: 0,
        expiringSoon: 0,
        acceptedNotInvoiced: [],
        issuedValue: {},
        acceptedValue: {},
        pendingValue: {},
        lastQuotation: null,
    };
    for (const q of quotations) {
        s.lastQuotation = maxDate(s.lastQuotation, issueDateOf(q));
        const st = quotationStatus(q, now);
        if (st === "draft") {
            s.draft++;
            continue;
        }
        const c = currencyOf(q);
        const v = quotationTotal(q);
        addTo(s.issuedValue, c, v);
        if (st === "accepted") {
            s.accepted++;
            addTo(s.acceptedValue, c, v);
            if (!converted.has(q.id)) s.acceptedNotInvoiced.push(q);
        } else if (st === "rejected") s.rejected++;
        else if (st === "expired") s.expired++;
        else {
            s.pending++;
            addTo(s.pendingValue, c, v);
            if (expiryInfo(q, now)?.state === "soon") s.expiringSoon++;
        }
    }
    return s;
}

/* -------------------------------------------------------------- behaviour */

export function behaviourOf(invoices: InvoiceType[], now: Date = new Date()): Behaviour {
    const days: number[] = [];
    const late: number[] = [];
    let onTime = 0;

    for (const inv of invoices) {
        if (!isIssued(inv) || displayStatus(inv, now) !== "paid") continue;
        const issued = dayOf(inv.details.invoiceDate);
        const last = paymentsOf(inv)
            .map((p) => dayOf(p.date))
            .filter((d): d is Date => !!d)
            .sort((a, b) => b.getTime() - a.getTime())[0];
        if (!issued || !last) continue;
        days.push(Math.max(0, daysBetween(issued, last)));
        const due = dayOf(inv.details.dueDate);
        if (due && startOfDay(last) > startOfDay(due)) late.push(daysBetween(due, last));
        else onTime++;
    }

    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const rate = days.length ? onTime / days.length : null;
    const cls: PayClass = days.length < 2 || rate === null ? "unknown" : rate >= 0.8 ? "reliable" : rate >= 0.5 ? "mixed" : "late";
    return { paidInvoices: days.length, avgDaysToPay: mean(days), onTimeRate: rate, avgDaysLate: mean(late), lateCount: late.length, class: cls };
}

export function frequencyOf(invoices: InvoiceType[], now: Date = new Date()): Frequency {
    const dates = invoices
        .filter(isIssued)
        .map((i) => dayOf(i.details.invoiceDate))
        .filter((d): d is Date => !!d)
        .sort((a, b) => a.getTime() - b.getTime());
    const yearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i - 1], dates[i]));
    return {
        total: dates.length,
        count12m: dates.filter((d) => d > yearAgo && d <= now).length,
        avgGapDays: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
        daysSinceLast: dates.length ? Math.max(0, daysBetween(dates[dates.length - 1], now)) : null,
    };
}

/* ------------------------------------------------------------ directory */

type LatestParty = { party: InvoiceType["receiver"]; at: Date };

/** The most recent party details seen on any document, per customer key. */
function latestParties(invoices: InvoiceType[], quotations: Quotation[]): Map<string, LatestParty> {
    const out = new Map<string, LatestParty>();
    const see = (party: InvoiceType["receiver"], at: Date | null) => {
        const key = clientKey(party);
        if (!key) return;
        const when = at ?? new Date(0);
        const cur = out.get(key);
        if (!cur || when >= cur.at) out.set(key, { party, at: when });
    };
    for (const i of invoices) see(i.receiver, dayOf(i.details.invoiceDate));
    for (const q of quotations) see(q.doc.receiver, issueDateOf(q));
    return out;
}

const emptyQuotes = (): QuoteStats => quoteStatsOf([], new Map(), new Date());

/**
 * Everyone you deal with: saved profiles, plus anyone who only appears on an
 * invoice or a quotation. One record per customer key, so a customer is never
 * listed twice and converting a quotation can never create one.
 */
export function buildDirectory(
    profiles: SavedParty[],
    invoices: InvoiceType[],
    quotations: Quotation[],
    converted: Map<string, string> = new Map(),
    now: Date = new Date()
): CustomerRecord[] {
    const summaries = new Map(summariseClients(invoices, now).map((s) => [s.key, s]));
    const latest = latestParties(invoices, quotations);

    const invByKey = new Map<string, InvoiceType[]>();
    for (const inv of invoices) {
        const k = clientKey(inv.receiver);
        if (k) invByKey.set(k, [...(invByKey.get(k) ?? []), inv]);
    }
    const quoByKey = new Map<string, Quotation[]>();
    for (const q of quotations) {
        const k = customerKeyOf(q);
        if (k) quoByKey.set(k, [...(quoByKey.get(k) ?? []), q]);
    }

    const keys = new Map<string, SavedParty | null>();
    for (const p of profiles) keys.set(clientKey(p), p);
    for (const k of [...summaries.keys(), ...quoByKey.keys()]) if (!keys.has(k)) keys.set(k, null);

    const records: CustomerRecord[] = [];
    for (const [key, profile] of keys) {
        const summary = summaries.get(key) ?? null;
        const docParty = latest.get(key)?.party;
        const invs = invByKey.get(key) ?? [];
        const quotes = quoByKey.get(key) ?? [];
        const qs = quotes.length ? quoteStatsOf(quotes, converted, now) : emptyQuotes();

        const lastPayment = invs
            .flatMap((i) => paymentsOf(i).map((p) => dayOf(p.date)))
            .reduce<Date | null>((best, d) => maxDate(best, d), null);

        const src = profile ?? docParty;
        records.push({
            key,
            profile,
            name: profile?.name ?? summary?.name ?? docParty?.name ?? key,
            email: profile?.email ?? summary?.email ?? docParty?.email ?? "",
            phone: profile?.phone ?? summary?.phone ?? docParty?.phone ?? "",
            gstin: clean(profile?.gstin) || clean(docParty?.gstin),
            company: clean(profile?.company),
            contactPerson: clean(profile?.contactPerson),
            website: clean(profile?.website),
            category: clean(profile?.category),
            tags: profile?.tags ?? [],
            city: clean(src?.city),
            active: profile ? profile.inactive !== true : true,
            invoices: summary,
            quotes: qs,
            behaviour: behaviourOf(invs, now),
            frequency: frequencyOf(invs, now),
            primaryCurrency: primaryOf(summary?.billed ?? {}, qs.issuedValue),
            lastPayment,
            lastActivity: maxDate(summary?.lastInvoice, qs.lastQuotation, lastPayment),
        });
    }
    return records.sort((a, b) => a.name.localeCompare(b.name));
}

/** The invoices and quotations that belong to one customer, newest first. */
export function documentsOf(key: string, invoices: InvoiceType[], quotations: Quotation[]) {
    const time = (d: Date | null) => d?.getTime() ?? 0;
    return {
        invoices: invoices
            .filter((i) => clientKey(i.receiver) === key)
            .sort((a, b) => time(dayOf(b.details.invoiceDate)) - time(dayOf(a.details.invoiceDate))),
        quotations: quotations
            .filter((q) => customerKeyOf(q) === key)
            .sort((a, b) => time(issueDateOf(b)) - time(issueDateOf(a))),
    };
}

/* ----------------------------------------------------------------- query */

export type CustomerFilter = "all" | "outstanding" | "overdue" | "inactive" | "quotations" | "pendingQuotes";
export type CustomerStatusFilter = "all" | "active" | "inactive";
export type CustomerSort = "name" | "billed" | "outstanding" | "recent";

export type CustomerQuery = {
    search: string;
    filter: CustomerFilter;
    status: CustomerStatusFilter;
    category: string;
    tag: string;
    sort: CustomerSort;
};

export const EMPTY_CUSTOMER_QUERY: CustomerQuery = { search: "", filter: "all", status: "all", category: "", tag: "", sort: "name" };

const sumOf = (t?: CurrencyTotals) => Object.values(t ?? {}).reduce((a, b) => a + b, 0);

export function queryCustomers(records: CustomerRecord[], q: CustomerQuery): CustomerRecord[] {
    const needle = q.search.trim().toLowerCase();
    return records
        .filter((r) => {
            if (q.status === "active" && !r.active) return false;
            if (q.status === "inactive" && r.active) return false;
            if (q.category && r.category !== q.category) return false;
            if (q.tag && !r.tags.some((t) => t.toLowerCase() === q.tag.toLowerCase())) return false;
            if (needle) {
                const hay = [r.name, r.email, r.phone, r.gstin, r.company, r.contactPerson, r.category, r.city, r.profile?.notes ?? "", ...r.tags].join(" ").toLowerCase();
                if (!hay.includes(needle)) return false;
            }
            switch (q.filter) {
                case "outstanding":
                    return sumOf(r.invoices?.outstanding) > 0;
                case "overdue":
                    return (r.invoices?.overdueCount ?? 0) > 0;
                case "inactive":
                    // Kept for compatibility: "No invoices yet".
                    return !r.invoices;
                case "quotations":
                    return r.quotes.count > 0;
                case "pendingQuotes":
                    return r.quotes.pending > 0 || r.quotes.acceptedNotInvoiced.length > 0;
                default:
                    return true;
            }
        })
        .sort((a, b) => {
            if (q.sort === "billed") return sumOf(b.invoices?.billed) - sumOf(a.invoices?.billed);
            if (q.sort === "outstanding") return sumOf(b.invoices?.outstanding) - sumOf(a.invoices?.outstanding);
            if (q.sort === "recent") return (b.lastActivity?.getTime() ?? 0) - (a.lastActivity?.getTime() ?? 0);
            return a.name.localeCompare(b.name);
        });
}

export const categoriesOf = (records: CustomerRecord[]) =>
    [...new Set(records.map((r) => r.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));

export const tagsOf = (records: CustomerRecord[]) => {
    const seen = new Map<string, string>();
    for (const r of records) for (const t of r.tags) if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
};

/* ------------------------------------------------------------ duplicates */

export type DuplicateReason = "email" | "gstin" | "phone" | "name" | "similarName";

const COMPANY_WORDS = new Set(["ltd", "limited", "pvt", "private", "inc", "llc", "llp", "co", "corp", "corporation", "company", "plc", "gmbh", "the", "and"]);

/** Lower-case, ASCII-ish, without punctuation or company suffixes: "Acme Pvt. Ltd." → "acme". */
export function normaliseName(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w && !COMPANY_WORDS.has(w))
        .join("");
}

export function editDistance(a: string, b: string): number {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[b.length];
}

const digits = (s: string) => s.replace(/\D/g, "");

export type Identity = { key: string; name: string; email: string; phone: string; gstin: string };

/** Why two customers might be the same person, or none if they look distinct. */
export function duplicateReasons(a: Identity, b: Identity): DuplicateReason[] {
    const reasons: DuplicateReason[] = [];
    const ea = a.email.trim().toLowerCase();
    const eb = b.email.trim().toLowerCase();
    if (ea && ea === eb) reasons.push("email");

    const ga = normaliseGstin(a.gstin);
    const gb = normaliseGstin(b.gstin);
    if (ga.length === 15 && ga === gb) reasons.push("gstin");

    const pa = digits(a.phone);
    const pb = digits(b.phone);
    if (pa.length >= 8 && pb.length >= 8 && pa.slice(-10) === pb.slice(-10)) reasons.push("phone");

    const na = normaliseName(a.name);
    const nb = normaliseName(b.name);
    if (na && na === nb) {
        reasons.push("name");
    } else {
        // Typos. Checked on the name without company suffixes ("Globxe Ltd") and on the
        // full name, because a typo inside the suffix itself ("Corporaton") would
        // otherwise survive stripping. Short names collide too easily to call a typo.
        const near = (x: string, y: string, min: number) => x !== y && x.length >= min && y.length >= min && Math.abs(x.length - y.length) <= 2 && editDistance(x, y) <= 2;
        const fa = a.name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
        const fb = b.name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
        if (near(na, nb, 6) || near(fa, fb, 8)) reasons.push("similarName");
    }
    return reasons;
}

export type DuplicateMatch = { record: Identity; reasons: DuplicateReason[] };

/** Existing customers that a new or edited one might duplicate (excluding itself). */
export function findPotentialDuplicates(candidate: Identity, others: Identity[], selfKey?: string): DuplicateMatch[] {
    const out: DuplicateMatch[] = [];
    for (const o of others) {
        if (o.key === selfKey || o.key === candidate.key) continue;
        const reasons = duplicateReasons(candidate, o);
        if (reasons.length) out.push({ record: o, reasons });
    }
    return out;
}

export type DuplicateGroup = { members: Identity[]; reasons: DuplicateReason[] };

/** Clusters of customers that look like the same one, found by transitive matching. */
export function findDuplicateGroups(all: Identity[]): DuplicateGroup[] {
    const parent = all.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const reasonsByRoot = new Map<number, Set<DuplicateReason>>();
    const pairs: [number, number, DuplicateReason[]][] = [];

    for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
            const r = duplicateReasons(all[i], all[j]);
            if (r.length) pairs.push([i, j, r]);
        }
    }
    for (const [i, j] of pairs) parent[find(i)] = find(j);
    for (const [i, , r] of pairs) {
        const root = find(i);
        const set = reasonsByRoot.get(root) ?? new Set<DuplicateReason>();
        r.forEach((x) => set.add(x));
        reasonsByRoot.set(root, set);
    }

    const groups = new Map<number, Identity[]>();
    all.forEach((m, i) => {
        const root = find(i);
        if (reasonsByRoot.has(root)) groups.set(root, [...(groups.get(root) ?? []), m]);
    });
    return [...groups.entries()]
        .map(([root, members]) => ({ members, reasons: [...(reasonsByRoot.get(root) ?? [])] }))
        .sort((a, b) => b.members.length - a.members.length || a.members[0].name.localeCompare(b.members[0].name));
}

export const identityOf = (r: CustomerRecord): Identity => ({ key: r.key, name: r.name, email: r.email, phone: r.phone, gstin: r.gstin });

/* ----------------------------------------------------------------- trends */

export type MonthPoint = { ym: string; invoiced: number };

/** Invoiced per month for the last `months` months (oldest first), one currency. */
export function monthlyInvoiced(invoices: InvoiceType[], currency: string, now: Date = new Date(), months = 12): MonthPoint[] {
    const points: MonthPoint[] = [];
    const index = new Map<string, number>();
    for (let i = months - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        index.set(ym, points.length);
        points.push({ ym, invoiced: 0 });
    }
    for (const inv of invoices) {
        if (!isIssued(inv) || (inv.details.currency || "USD") !== currency) continue;
        const d = dayOf(inv.details.invoiceDate);
        if (!d) continue;
        const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const at = index.get(ym);
        if (at !== undefined) points[at].invoiced = roundMoney(points[at].invoiced + invoiceTotal(inv));
    }
    return points;
}

export type TrendDirection = "up" | "down" | "flat" | "none";

/** Last 3 months against the 3 before: more than ±15% is a trend, less is flat. */
export function trendOf(points: MonthPoint[]): { direction: TrendDirection; change: number | null } {
    const recent = points.slice(-3).reduce((s, p) => s + p.invoiced, 0);
    const before = points.slice(-6, -3).reduce((s, p) => s + p.invoiced, 0);
    if (recent === 0 && before === 0) return { direction: "none", change: null };
    if (before === 0) return { direction: "up", change: null };
    const change = (recent - before) / before;
    return { direction: change > 0.15 ? "up" : change < -0.15 ? "down" : "flat", change };
}

/* --------------------------------------------------------------- insights */

export type InsightTone = "positive" | "info" | "warning" | "critical";

export type Insight = {
    /** `crm.insights.<id>` in the locale files. */
    id: string;
    tone: InsightTone;
    /** Numbers and names the sentence needs; `amount` + `currency` are formatted by the UI. */
    params: Record<string, string | number>;
};

const TONE_ORDER: Record<InsightTone, number> = { critical: 0, warning: 1, info: 2, positive: 3 };

/** Share of `currency` revenue (issued) a customer accounts for, 0..1. */
export const shareOf = (record: CustomerRecord, all: CustomerRecord[], currency: string): number => {
    const total = all.reduce((s, r) => s + (r.invoices?.billed[currency] ?? 0), 0);
    return total > 0 ? (record.invoices?.billed[currency] ?? 0) / total : 0;
};

/**
 * Plain-language observations about one customer. Every rule fires only on the
 * facts it states (a count, an amount, a date) taken from the records; there is
 * no scoring model and nothing is estimated.
 */
export function customerInsights(
    record: CustomerRecord,
    docs: { invoices: InvoiceType[]; quotations: Quotation[] },
    opts: { now?: Date; all?: CustomerRecord[] } = {}
): Insight[] {
    const now = opts.now ?? new Date();
    const out: Insight[] = [];
    const push = (id: string, tone: InsightTone, params: Record<string, string | number> = {}) => out.push({ id, tone, params });
    const inv = record.invoices;

    if (!inv && record.quotes.count === 0) {
        push("noActivity", "info");
        return out;
    }

    // Overdue, per currency, with how late the oldest is.
    for (const [currency, amount] of Object.entries(inv?.overdue ?? {})) {
        if (amount <= 0) continue;
        const open = docs.invoices.filter((i) => displayStatus(i, now) === "overdue" && (i.details.currency || "USD") === currency);
        const oldest = Math.max(0, ...open.map((i) => daysBetween(dayOf(i.details.dueDate) ?? now, now)));
        push("overdue", oldest > 60 ? "critical" : "warning", { count: open.length, amount, currency, days: oldest });
    }

    const b = record.behaviour;
    if (b.class === "late") push("paysLate", "warning", { days: Math.round(b.avgDaysLate ?? 0), rate: Math.round((b.onTimeRate ?? 0) * 100) });
    else if (b.class === "reliable") push("paysOnTime", "positive", { rate: Math.round((b.onTimeRate ?? 0) * 100), days: Math.round(b.avgDaysToPay ?? 0) });
    else if (b.class === "mixed") push("paysMixed", "info", { rate: Math.round((b.onTimeRate ?? 0) * 100) });

    const f = record.frequency;
    if (f.total >= 3 && f.avgGapDays !== null && f.daysSinceLast !== null) {
        const expected = Math.max(30, f.avgGapDays * 2);
        if (f.daysSinceLast > expected && f.daysSinceLast > 60) push("dormant", "info", { days: f.daysSinceLast, usual: Math.round(f.avgGapDays) });
    }
    if (f.count12m >= 6 || (f.count12m >= 3 && f.avgGapDays !== null && f.avgGapDays <= 45)) {
        push("frequent", "positive", { count: f.count12m, days: Math.round(f.avgGapDays ?? 0) });
    }

    const q = record.quotes;
    if (q.acceptedNotInvoiced.length > 0) {
        const first = q.acceptedNotInvoiced[0];
        const amount = q.acceptedNotInvoiced.filter((x) => currencyOf(x) === currencyOf(first)).reduce((s, x) => s + quotationTotal(x), 0);
        push("acceptedNotInvoiced", "info", { count: q.acceptedNotInvoiced.length, number: quotationNumber(first), amount, currency: currencyOf(first) });
    }
    if (q.expiringSoon > 0) push("quotesExpiring", "warning", { count: q.expiringSoon });

    const trend = trendOf(monthlyInvoiced(docs.invoices, record.primaryCurrency, now));
    if (trend.direction === "up" && trend.change !== null) push("trendUp", "positive", { percent: Math.round(trend.change * 100) });
    if (trend.direction === "down" && trend.change !== null) push("trendDown", "warning", { percent: Math.round(Math.abs(trend.change) * 100) });

    if (opts.all && opts.all.length >= 3) {
        const share = shareOf(record, opts.all, record.primaryCurrency);
        if (share >= 0.3) push("largeShare", "info", { percent: Math.round(share * 100), currency: record.primaryCurrency });
    }

    return out.sort((a, b2) => TONE_ORDER[a.tone] - TONE_ORDER[b2.tone]);
}

/* --------------------------------------------------------------- timeline */

export type TimelineKind =
    | "customerAdded"
    | "invoiceIssued"
    | "payment"
    | "invoiceOverdue"
    | "quotationCreated"
    | "quotationSent"
    | "quotationAccepted"
    | "quotationRejected"
    | "quotationConverted";

export type TimelineEvent = {
    at: Date;
    kind: TimelineKind;
    /** The document the event is about (invoice or quotation number). */
    ref: string;
    /** For a conversion: the invoice it became. */
    to?: string;
    amount?: number;
    currency?: string;
};

/**
 * What has happened with this customer, newest first. Every event is a recorded
 * fact with its own date: an invoice's issue date, a payment's date, a
 * quotation's logged status changes. "Became overdue" is the day after the due
 * date of an invoice that is still unpaid.
 */
export function timelineOf(
    profile: SavedParty | null,
    docs: { invoices: InvoiceType[]; quotations: Quotation[] },
    now: Date = new Date()
): TimelineEvent[] {
    const out: TimelineEvent[] = [];
    const created = dayOf(profile?.createdAt);
    if (created) out.push({ at: created, kind: "customerAdded", ref: profile!.name });

    for (const inv of docs.invoices) {
        const number = inv.details.invoiceNumber;
        const currency = inv.details.currency || "USD";
        const issued = dayOf(inv.details.invoiceDate);

        // A conversion creates a *draft* invoice, so this must not wait for it to be issued.
        const ref = inv.details.quotationRef;
        if (ref?.number && issued && storedStatus(inv) !== "cancelled") {
            out.push({ at: issued, kind: "quotationConverted", ref: ref.number, to: number, amount: invoiceTotal(inv), currency });
        }

        if (!isIssued(inv)) continue;
        if (issued) out.push({ at: issued, kind: "invoiceIssued", ref: number, amount: invoiceTotal(inv), currency });

        for (const p of paymentsOf(inv)) {
            const when = dayOf(p.date);
            if (when) out.push({ at: when, kind: "payment", ref: number, amount: Number(p.amount) || 0, currency });
        }

        const due = dayOf(inv.details.dueDate);
        if (due && balanceDue(inv) > 0) {
            const overdueFrom = new Date(due.getFullYear(), due.getMonth(), due.getDate() + 1);
            if (overdueFrom <= now) out.push({ at: overdueFrom, kind: "invoiceOverdue", ref: number, amount: balanceDue(inv), currency });
        }
    }

    const kindOf: Record<string, TimelineKind | undefined> = {
        created: "quotationCreated",
        sent: "quotationSent",
        accepted: "quotationAccepted",
        rejected: "quotationRejected",
    };
    for (const q of docs.quotations) {
        for (const e of q.events) {
            const kind = kindOf[e.kind];
            const at = dayOf(e.at);
            if (kind && at) out.push({ at, kind, ref: quotationNumber(q), amount: quotationTotal(q), currency: currencyOf(q) });
        }
    }

    // Newest first; on one day, later-in-the-story events first (stable otherwise).
    return out.sort((a, b) => b.at.getTime() - a.at.getTime());
}

/* --------------------------------------------------------- portfolio view */

export type Ranked = { record: CustomerRecord; value: number; share: number };

/** Customers ranked by issued invoices in one currency. */
export function topByRevenue(records: CustomerRecord[], currency: string, limit = 5): Ranked[] {
    const total = records.reduce((s, r) => s + (r.invoices?.billed[currency] ?? 0), 0);
    return records
        .map((record) => ({ record, value: record.invoices?.billed[currency] ?? 0, share: total > 0 ? (record.invoices?.billed[currency] ?? 0) / total : 0 }))
        .filter((r) => r.value > 0)
        .sort((a, b) => b.value - a.value || a.record.name.localeCompare(b.record.name))
        .slice(0, limit);
}

export const withOutstanding = (records: CustomerRecord[], currency: string, limit = 5): Ranked[] =>
    records
        .map((record) => ({ record, value: record.invoices?.outstanding[currency] ?? 0, share: 0 }))
        .filter((r) => r.value > 0)
        .sort((a, b) => b.value - a.value || a.record.name.localeCompare(b.record.name))
        .slice(0, limit);

/** Customers who buy often: most issued invoices in the last 12 months. */
export const frequentBuyers = (records: CustomerRecord[], limit = 5, minCount = 2) =>
    records
        .filter((r) => r.frequency.count12m >= minCount)
        .sort((a, b) => b.frequency.count12m - a.frequency.count12m || a.name.localeCompare(b.name))
        .slice(0, limit);

/** Customers who used to order regularly but have gone quiet. */
export const dormantCustomers = (records: CustomerRecord[], limit = 5) =>
    records
        .filter((r) => {
            const f = r.frequency;
            return r.active && f.total >= 3 && f.avgGapDays !== null && f.daysSinceLast !== null && f.daysSinceLast > Math.max(60, f.avgGapDays * 2);
        })
        .sort((a, b) => (b.frequency.daysSinceLast ?? 0) - (a.frequency.daysSinceLast ?? 0))
        .slice(0, limit);

/** The currency with the most issued revenue across all customers. */
export function portfolioCurrency(records: CustomerRecord[]): string {
    const totals: CurrencyTotals = {};
    for (const r of records) for (const [c, v] of Object.entries(r.invoices?.billed ?? {})) addTo(totals, c, v);
    return primaryOf(totals);
}

export const currenciesOf = (records: CustomerRecord[]): string[] => {
    const set = new Set<string>();
    for (const r of records) {
        Object.keys(r.invoices?.billed ?? {}).forEach((c) => set.add(c));
        Object.keys(r.quotes.issuedValue).forEach((c) => set.add(c));
    }
    return [...set].sort();
};

/* ------------------------------------------------------- payment allocation */

export type OpenInvoice = { number: string; currency: string; due: Date | null; issued: Date | null; balance: number };

/** Issued invoices with something still owed, oldest due date first. */
export function openInvoicesOf(invoices: InvoiceType[], currency?: string): OpenInvoice[] {
    const time = (d: Date | null) => d?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return invoices
        .filter((i) => isIssued(i) && balanceDue(i) > 0 && (!currency || (i.details.currency || "USD") === currency))
        .map((i) => ({
            number: i.details.invoiceNumber,
            currency: i.details.currency || "USD",
            due: dayOf(i.details.dueDate),
            issued: dayOf(i.details.invoiceDate),
            balance: balanceDue(i),
        }))
        .sort((a, b) => time(a.due) - time(b.due) || time(a.issued) - time(b.issued) || a.number.localeCompare(b.number, undefined, { numeric: true }));
}

export type Allocation = { number: string; amount: number };

export type AllocationResult =
    | { ok: true; allocations: Allocation[] }
    | { ok: false; reason: "amount" | "nothingOwed" | "exceeds" | "notFound"; owed?: number };

/**
 * Splits a customer's payment across their open invoices, oldest due date
 * first, or applies all of it to one named invoice. A payment larger than what
 * is owed is refused rather than recorded: the app has no customer credit, and
 * silently dropping the excess would lose money.
 */
export function allocatePayment(
    open: OpenInvoice[],
    amount: number,
    target: { mode: "oldest" } | { mode: "invoice"; number: string }
): AllocationResult {
    const total = roundMoney(amount);
    if (!Number.isFinite(total) || total <= 0) return { ok: false, reason: "amount" };

    if (target.mode === "invoice") {
        const inv = open.find((o) => o.number === target.number);
        if (!inv) return { ok: false, reason: "notFound" };
        if (total > inv.balance) return { ok: false, reason: "exceeds", owed: inv.balance };
        return { ok: true, allocations: [{ number: inv.number, amount: total }] };
    }

    const owed = roundMoney(open.reduce((s, o) => s + o.balance, 0));
    if (owed <= 0) return { ok: false, reason: "nothingOwed" };
    if (total > owed) return { ok: false, reason: "exceeds", owed };

    let left = total;
    const allocations: Allocation[] = [];
    for (const o of open) {
        if (left <= 0) break;
        const part = roundMoney(Math.min(left, o.balance));
        if (part > 0) allocations.push({ number: o.number, amount: part });
        left = roundMoney(left - part);
    }
    return { ok: true, allocations };
}

