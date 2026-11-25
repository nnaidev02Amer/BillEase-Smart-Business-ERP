/**
 * Expenses: pure logic, no React and no storage.
 *
 * An expense is money the business paid out. It is a record in its own right
 * (not derived from invoices), so it has its own validation, and everything
 * built on it (summaries, the profit and loss report) is computed from the
 * saved records and nothing else.
 *
 * AMOUNTS
 *   `amount` is the total paid, tax included. The optional `tax` says how much
 *   of that was tax. Whether that tax is *recoverable* (an input tax credit you
 *   can set against the GST you collected) decides how the profit estimate
 *   treats it; the default is "not recoverable", which counts it as a cost.
 *   Money is never added across currencies: every summary is for one currency.
 *
 * DATES
 *   Calendar days as `yyyy-mm-dd` text, so they compare correctly as strings
 *   and carry no time zone.
 */

import { roundMoney } from "@/lib/calculations";
import { normaliseGstin, validateGstin } from "@/lib/gst";
import { fetchCurrencyDetails } from "@/lib/helpers";
import { PAYMENT_METHODS } from "@/lib/invoiceRecords";
import { toCsv } from "@/lib/invoiceRecords";
import { stripControlChars } from "@/lib/schemas";

/* ------------------------------------------------------------- categories */

/** Built-in categories. The id is stable; the label comes from the locale files. */
export const DEFAULT_CATEGORY_IDS = [
    "rent",
    "salaries",
    "utilities",
    "transport",
    "marketing",
    "equipment",
    "supplies",
    "professional",
    "insurance",
    "miscellaneous",
] as const;

export const FALLBACK_CATEGORY = "miscellaneous";

export type ExpenseCategory = { id: string; name: string };

export const isDefaultCategory = (id: string) => (DEFAULT_CATEGORY_IDS as readonly string[]).includes(id);

export const MAX_CUSTOM_CATEGORIES = 50;
export const MAX_CATEGORY_NAME = 40;

/** A readable name for any category id: the translated default, the custom name, or the id itself. */
export function categoryLabel(id: string, custom: ExpenseCategory[], defaultName: (id: string) => string): string {
    if (isDefaultCategory(id)) return defaultName(id);
    return custom.find((c) => c.id === id)?.name ?? defaultName(FALLBACK_CATEGORY);
}

export function sanitizeCategory(input: unknown): ExpenseCategory | null {
    if (!input || typeof input !== "object") return null;
    const o = input as Record<string, unknown>;
    const id = typeof o.id === "string" ? stripControlChars(o.id).trim().slice(0, 64) : "";
    const name = typeof o.name === "string" ? stripControlChars(o.name).trim().replace(/\s+/g, " ").slice(0, MAX_CATEGORY_NAME) : "";
    if (!id || !name || isDefaultCategory(id)) return null;
    return { id, name };
}

/** Whether `name` collides with an existing custom category or a built-in's name (case-insensitively). */
export function categoryNameTaken(name: string, custom: ExpenseCategory[], reserved: string[], exceptId?: string): boolean {
    const n = name.trim().replace(/\s+/g, " ").toLowerCase();
    return custom.some((c) => c.id !== exceptId && c.name.toLowerCase() === n) || reserved.some((r) => r.toLowerCase() === n);
}

/* ---------------------------------------------------------------- expense */

export const EXPENSE_METHODS = PAYMENT_METHODS;
export type ExpenseMethod = (typeof EXPENSE_METHODS)[number];

export type ExpenseTax = {
    /** The part of `amount` that is tax. */
    amount: number;
    /** Rate in percent, for reference. */
    rate?: number;
    /** An input tax credit: set against the tax you collected, so not a cost. */
    recoverable: boolean;
    /** The vendor's GSTIN, when it is a GST invoice. */
    gstin?: string;
};

export type Expense = {
    id: string;
    title: string;
    category: string;
    amount: number;
    currency: string;
    /** yyyy-mm-dd */
    date: string;
    method: ExpenseMethod;
    vendor: string;
    reference: string;
    notes: string;
    tax?: ExpenseTax;
    /**
     * The purchase bill this expense is the same spend as, if the user linked them.
     * While that bill is posted the bill is what counts toward profit and loss, and
     * this expense is left out of it, so one purchase is never counted twice.
     */
    billId?: string;
    createdAt: string;
    updatedAt: string;
};

export const MAX_AMOUNT = 1e12;
/** An expense may be dated a little ahead (a bill you have scheduled), not years. */
export const MAX_DAYS_AHEAD = 366;

const clip = (v: unknown, max: number) => (typeof v === "string" ? stripControlChars(v).trim().slice(0, max) : "");

/** Valid calendar day as yyyy-mm-dd (rejects 2026-02-31). */
export function isValidDay(value: unknown): value is string {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y, m, d] = value.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

export const toDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const fromDay = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
};

export const decimalsOf = (currency: string) => fetchCurrencyDetails(currency)?.decimals ?? 2;
export const normaliseCurrency = (v: unknown) => (typeof v === "string" ? v.trim().toUpperCase() : "");
export const isCurrencyCode = (v: string) => /^[A-Z]{3}$/.test(v);

/**
 * Rebuilds a well-formed expense from anything, or returns null if it cannot be
 * one. Used on every read from storage and on backup import, so a hand-edited
 * or older record can never put a malformed expense into a total.
 */
export function sanitizeExpense(input: unknown): Expense | null {
    if (!input || typeof input !== "object") return null;
    const o = input as Record<string, unknown>;

    const id = clip(o.id, 64);
    const title = clip(o.title, 120);
    const currency = normaliseCurrency(o.currency);
    const amountRaw = typeof o.amount === "number" ? o.amount : parseFloat(String(o.amount ?? ""));
    if (!id || title.length < 2 || !isCurrencyCode(currency) || !isValidDay(o.date)) return null;
    if (!Number.isFinite(amountRaw) || amountRaw <= 0 || amountRaw > MAX_AMOUNT) return null;

    const decimals = decimalsOf(currency);
    const amount = roundMoney(amountRaw, decimals);
    if (amount <= 0) return null;

    let tax: ExpenseTax | undefined;
    if (o.tax && typeof o.tax === "object") {
        const t = o.tax as Record<string, unknown>;
        const taxAmount = roundMoney(typeof t.amount === "number" ? t.amount : parseFloat(String(t.amount ?? "")), decimals);
        if (Number.isFinite(taxAmount) && taxAmount > 0 && taxAmount <= amount) {
            const rate = typeof t.rate === "number" ? t.rate : parseFloat(String(t.rate ?? ""));
            const gstin = normaliseGstin(t.gstin);
            tax = {
                amount: taxAmount,
                recoverable: t.recoverable === true,
                ...(Number.isFinite(rate) && rate >= 0 && rate <= 100 ? { rate } : {}),
                ...(gstin && validateGstin(gstin).valid ? { gstin } : {}),
            };
        }
    }

    const billId = clip(o.billId, 64);
    const now = new Date().toISOString();
    return {
        id,
        title,
        category: clip(o.category, 64) || FALLBACK_CATEGORY,
        amount,
        currency,
        date: o.date,
        method: EXPENSE_METHODS.find((m) => m === o.method) ?? "other",
        vendor: clip(o.vendor, 100),
        reference: clip(o.reference, 60),
        notes: clip(o.notes, 1000),
        ...(tax ? { tax } : {}),
        ...(billId ? { billId } : {}),
        createdAt: typeof o.createdAt === "string" ? o.createdAt : now,
        updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : now,
    };
}

/* ------------------------------------------------------------ validation */

export type ExpenseDraft = {
    title: string;
    category: string;
    amount: string | number;
    currency: string;
    date: string;
    vendor?: string;
    reference?: string;
    notes?: string;
    taxAmount?: string | number;
    taxRate?: string | number;
    vendorGstin?: string;
};

export type ExpenseErrors = Partial<Record<"title" | "category" | "amount" | "currency" | "date" | "taxAmount" | "taxRate" | "vendorGstin", string>>;

/**
 * Field-level problems as error codes (`expenses.errors.<code>`). `categoryIds`
 * is every category that exists, so an expense cannot point at one that does not.
 */
export function validateExpense(draft: ExpenseDraft, categoryIds: string[], now: Date = new Date()): ExpenseErrors {
    const errors: ExpenseErrors = {};
    if (clip(draft.title, 120).length < 2) errors.title = "title";
    if (!categoryIds.includes(draft.category)) errors.category = "category";

    const amount = Number(draft.amount);
    if (draft.amount === "" || !Number.isFinite(amount) || amount <= 0) errors.amount = "amount";
    else if (amount > MAX_AMOUNT) errors.amount = "amountMax";

    const currency = normaliseCurrency(draft.currency);
    if (!isCurrencyCode(currency)) errors.currency = "currency";

    if (!isValidDay(draft.date)) errors.date = "date";
    else {
        const limit = new Date(now.getFullYear(), now.getMonth(), now.getDate() + MAX_DAYS_AHEAD);
        if (fromDay(draft.date) > limit) errors.date = "dateFuture";
        else if (draft.date < "1990-01-01") errors.date = "date";
    }

    const hasTax = draft.taxAmount !== undefined && draft.taxAmount !== "";
    if (hasTax) {
        const tax = Number(draft.taxAmount);
        if (!Number.isFinite(tax) || tax < 0) errors.taxAmount = "tax";
        else if (Number.isFinite(amount) && tax > amount) errors.taxAmount = "taxExceeds";
    }
    if (draft.taxRate !== undefined && draft.taxRate !== "") {
        const rate = Number(draft.taxRate);
        if (!Number.isFinite(rate) || rate < 0 || rate > 100) errors.taxRate = "rate";
    }
    const gstin = normaliseGstin(draft.vendorGstin);
    if (gstin && !validateGstin(gstin).valid) errors.vendorGstin = "gstin";
    return errors;
}

/* ----------------------------------------------------------------- query */

export type ExpenseSortKey = "date" | "amount" | "title" | "category" | "vendor";

export type ExpenseQuery = {
    search: string;
    category: string;
    method: string;
    currency: string;
    /** yyyy-mm-dd, inclusive; "" means unbounded. */
    from: string;
    to: string;
    sort: ExpenseSortKey;
    dir: "asc" | "desc";
};

export const EMPTY_EXPENSE_QUERY: ExpenseQuery = { search: "", category: "", method: "", currency: "", from: "", to: "", sort: "date", dir: "desc" };

export const inRange = (day: string, from: string, to: string) => (!from || day >= from) && (!to || day <= to);

export function queryExpenses(list: Expense[], q: ExpenseQuery, nameOf: (categoryId: string) => string): Expense[] {
    const needle = q.search.trim().toLowerCase();
    const dir = q.dir === "asc" ? 1 : -1;
    return list
        .filter((e) => {
            if (q.category && e.category !== q.category) return false;
            if (q.method && e.method !== q.method) return false;
            if (q.currency && e.currency !== q.currency) return false;
            if (!inRange(e.date, q.from, q.to)) return false;
            if (needle) {
                const hay = [e.title, e.vendor, e.reference, e.notes, nameOf(e.category)].join(" ").toLowerCase();
                if (!hay.includes(needle)) return false;
            }
            return true;
        })
        .sort((a, b) => {
            let cmp = 0;
            switch (q.sort) {
                case "amount":
                    cmp = a.amount - b.amount;
                    break;
                case "title":
                    cmp = a.title.localeCompare(b.title);
                    break;
                case "category":
                    cmp = nameOf(a.category).localeCompare(nameOf(b.category));
                    break;
                case "vendor":
                    cmp = a.vendor.localeCompare(b.vendor);
                    break;
                default:
                    cmp = a.date.localeCompare(b.date);
            }
            // Stable tiebreaks so equal keys do not shuffle between renders.
            return (cmp || a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)) * dir;
        });
}

export const currenciesOfExpenses = (list: Expense[]) => [...new Set(list.map((e) => e.currency))].sort();

/* -------------------------------------------------------------- summaries */

export type CategoryTotal = { category: string; total: number; count: number; share: number };
export type MonthTotal = { ym: string; total: number; count: number };

export type ExpenseSummary = {
    currency: string;
    count: number;
    total: number;
    /** The tax portion of `total`, and the part of that which is recoverable. */
    tax: number;
    recoverableTax: number;
    average: number;
    largest: Expense | null;
    byCategory: CategoryTotal[];
    byMonth: MonthTotal[];
};

/**
 * Totals for one currency over an optional date range. `byCategory` is largest
 * first and its shares add up to 1; `byMonth` is oldest first and only holds
 * months that have expenses.
 */
export function summariseExpenses(list: Expense[], { currency, from = "", to = "" }: { currency: string; from?: string; to?: string }): ExpenseSummary {
    const rows = list.filter((e) => e.currency === currency && inRange(e.date, from, to));
    const dec = decimalsOf(currency);
    const r = (n: number) => roundMoney(n, dec);

    let total = 0;
    let tax = 0;
    let recoverable = 0;
    let largest: Expense | null = null;
    const cats = new Map<string, CategoryTotal>();
    const months = new Map<string, MonthTotal>();

    for (const e of rows) {
        total += e.amount;
        if (e.tax) {
            tax += e.tax.amount;
            if (e.tax.recoverable) recoverable += e.tax.amount;
        }
        if (!largest || e.amount > largest.amount) largest = e;

        const c = cats.get(e.category) ?? { category: e.category, total: 0, count: 0, share: 0 };
        c.total = r(c.total + e.amount);
        c.count += 1;
        cats.set(e.category, c);

        const ym = e.date.slice(0, 7);
        const m = months.get(ym) ?? { ym, total: 0, count: 0 };
        m.total = r(m.total + e.amount);
        m.count += 1;
        months.set(ym, m);
    }

    total = r(total);
    const byCategory = [...cats.values()]
        .map((c) => ({ ...c, share: total > 0 ? c.total / total : 0 }))
        .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category));

    return {
        currency,
        count: rows.length,
        total,
        tax: r(tax),
        recoverableTax: r(recoverable),
        average: rows.length ? r(total / rows.length) : 0,
        largest,
        byCategory,
        byMonth: [...months.values()].sort((a, b) => a.ym.localeCompare(b.ym)),
    };
}

/** How many expenses use each category. */
export function usageByCategory(list: Expense[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const e of list) out.set(e.category, (out.get(e.category) ?? 0) + 1);
    return out;
}

/** Points every expense at a category that exists, falling back to miscellaneous. */
export function withKnownCategories(list: Expense[], known: Set<string>): Expense[] {
    return list.map((e) => (known.has(e.category) ? e : { ...e, category: FALLBACK_CATEGORY }));
}

/* -------------------------------------------------------------------- csv */

export function expensesToCsv(list: Expense[], nameOf: (categoryId: string) => string): string {
    return toCsv(
        ["Date", "Title", "Category", "Vendor", "Reference", "Method", "Amount", "Tax", "Tax recoverable", "Vendor GSTIN", "Currency", "Notes"],
        list.map((e) => [
            e.date,
            e.title,
            nameOf(e.category),
            e.vendor,
            e.reference,
            e.method,
            e.amount,
            e.tax?.amount ?? "",
            e.tax ? (e.tax.recoverable ? "Yes" : "No") : "",
            e.tax?.gstin ?? "",
            e.currency,
            e.notes,
        ])
    );
}
