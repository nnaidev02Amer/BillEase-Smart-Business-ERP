import { test, expect } from "@playwright/test";

import {
    DEFAULT_CATEGORY_IDS,
    EMPTY_EXPENSE_QUERY,
    categoryLabel,
    categoryNameTaken,
    currenciesOfExpenses,
    expensesToCsv,
    fromDay,
    isValidDay,
    queryExpenses,
    sanitizeCategory,
    sanitizeExpense,
    summariseExpenses,
    toDay,
    usageByCategory,
    validateExpense,
    withKnownCategories,
    type Expense,
    type ExpenseDraft,
} from "../lib/expenses";
import { mergeExpenseData } from "../lib/expenseStore";
import { gstinCheckChar } from "../lib/gst";
import {
    ReportPayloadSchema,
    monthlySeries,
    periodFor,
    pnlInsights,
    previousPeriod,
    profitAndLoss,
    profitLossCsv,
} from "../lib/profit";
import type { InvoiceType } from "../types";

/** Expenses and profit/loss: no browser, no server. */

const NOW = new Date(2026, 5, 15, 12, 0, 0); // 15 June 2026
const CATS = [...DEFAULT_CATEGORY_IDS, "x-fuel"] as string[];

const gstin = (state: string) => {
    const first14 = `${state}AAPFU0939F1Z`;
    return first14 + gstinCheckChar(first14);
};

const draft = (o: Partial<ExpenseDraft> = {}): ExpenseDraft => ({
    title: "Office rent",
    category: "rent",
    amount: "400",
    currency: "USD",
    date: "2026-06-01",
    ...o,
});

let seq = 0;
const exp = (title: string, category: string, amount: number, date: string, o: { currency?: string; tax?: number; recoverable?: boolean; vendor?: string; reference?: string; notes?: string; method?: string } = {}): Expense => {
    const e = sanitizeExpense({
        id: `e${++seq}`,
        title,
        category,
        amount,
        currency: o.currency ?? "USD",
        date,
        method: o.method ?? "bank",
        vendor: o.vendor ?? "",
        reference: o.reference ?? "",
        notes: o.notes ?? "",
        ...(o.tax ? { tax: { amount: o.tax, recoverable: o.recoverable === true } } : {}),
    });
    if (!e) throw new Error(`fixture expense is invalid: ${title}`);
    return e;
};

type InvOpts = { issued: string; due: string; sub: number; taxPct?: number; status?: string; currency?: string; pays?: [string, number][] };
const inv = (number: string, o: InvOpts): InvoiceType => {
    const pct = o.taxPct ?? 18;
    const total = Math.round(o.sub * (1 + pct / 100) * 100) / 100;
    return {
        sender: { name: "Sender", address: "1", zipCode: "1", city: "c", country: "x", email: "s@x.test", phone: "1" },
        receiver: { name: "Acme", address: "1", zipCode: "1", city: "c", country: "x", email: "a@acme.test", phone: "1" },
        details: {
            invoiceNumber: number,
            invoiceDate: `${o.issued}T00:00:00.000Z`,
            dueDate: `${o.due}T00:00:00.000Z`,
            currency: o.currency ?? "USD",
            language: "English",
            status: o.status ?? "sent",
            items: [{ name: "Work", quantity: 1, unitPrice: o.sub, total: o.sub }],
            subTotal: o.sub,
            taxDetails: { amount: pct, amountType: "percentage" },
            totalAmount: total,
            totalAmountInWords: "",
            paymentTerms: "Net 30",
            pdfTemplate: 1,
            payments: (o.pays ?? []).map(([date, amount], i) => ({ id: `${number}-p${i}`, date, amount })),
        },
    } as unknown as InvoiceType;
};

/* ============================================================ validation */

test.describe("expense validation", () => {
    const check = (o: Partial<ExpenseDraft>) => validateExpense(draft(o), CATS, NOW);

    test("a complete expense has no errors", () => {
        expect(check({})).toEqual({});
    });
    test("the title needs at least two characters", () => {
        expect(check({ title: "" }).title).toBe("title");
        expect(check({ title: "x" }).title).toBe("title");
        expect(check({ title: "  x  " }).title).toBe("title");
        expect(check({ title: "ab" }).title).toBeUndefined();
    });
    test("the amount must be a positive number within bounds", () => {
        for (const bad of ["", "0", "-5", "abc", "NaN"]) expect(check({ amount: bad }).amount).toBe("amount");
        expect(check({ amount: 1e13 }).amount).toBe("amountMax");
        expect(check({ amount: "0.01" }).amount).toBeUndefined();
    });
    test("the currency is a three-letter code, in any case", () => {
        for (const bad of ["", "US", "USDD", "12A", "$"]) expect(check({ currency: bad }).currency).toBe("currency");
        expect(check({ currency: "inr" }).currency).toBeUndefined();
    });
    test("the category must be one that exists", () => {
        expect(check({ category: "nonsense" }).category).toBe("category");
        expect(check({ category: "x-fuel" }).category).toBeUndefined();
        expect(validateExpense(draft({ category: "x-fuel" }), [...DEFAULT_CATEGORY_IDS], NOW).category).toBe("category");
    });
    test("the date must be a real day, not 1990-ish old and not far ahead", () => {
        for (const bad of ["", "2026-02-31", "2026-13-01", "26-06-01", "yesterday"]) expect(check({ date: bad }).date).toBe("date");
        expect(check({ date: "1980-01-01" }).date).toBe("date");
        expect(check({ date: "2026-06-16" }).date).toBeUndefined(); // tomorrow is fine (a scheduled bill)
        expect(check({ date: "2027-06-16" }).date).toBeUndefined(); // 366 days ahead is the last day allowed
        expect(check({ date: "2027-06-17" }).date).toBe("dateFuture"); // one day further
        expect(check({ date: "2028-01-01" }).date).toBe("dateFuture");
    });
    test("leap days are accepted only in leap years", () => {
        expect(isValidDay("2028-02-29")).toBe(true);
        expect(isValidDay("2026-02-29")).toBe(false);
    });
    test("tax cannot be negative, exceed the amount, or have an impossible rate", () => {
        expect(check({ taxAmount: "-1" }).taxAmount).toBe("tax");
        expect(check({ taxAmount: "x" }).taxAmount).toBe("tax");
        expect(check({ amount: "100", taxAmount: "100.01" }).taxAmount).toBe("taxExceeds");
        expect(check({ amount: "100", taxAmount: "100" }).taxAmount).toBeUndefined();
        expect(check({ taxRate: "101" }).taxRate).toBe("rate");
        expect(check({ taxRate: "-1" }).taxRate).toBe("rate");
        expect(check({ taxRate: "18" }).taxRate).toBeUndefined();
        expect(check({ taxAmount: "", taxRate: "" })).toEqual({});
    });
    test("a vendor GSTIN is checked for format when given", () => {
        expect(check({ vendorGstin: "27AAPFU0939F1ZA" }).vendorGstin).toBe("gstin");
        expect(check({ vendorGstin: gstin("27").toLowerCase() }).vendorGstin).toBeUndefined();
        expect(check({ vendorGstin: "" }).vendorGstin).toBeUndefined();
    });
    test("several problems are all reported at once", () => {
        expect(Object.keys(check({ title: "", amount: "0", currency: "x", date: "no", category: "zz" })).sort()).toEqual(["amount", "category", "currency", "date", "title"]);
    });
});

/* ================================================================ records */

test.describe("expense records", () => {
    const base = { id: "a", title: "Rent", category: "rent", amount: 400, currency: "USD", date: "2026-06-01" };

    test("a sound record survives, and is normalised", () => {
        const e = sanitizeExpense({ ...base, currency: "usd", title: "  Rent  ", method: "card", vendor: " Landlord ", amount: "400.456" })!;
        expect(e).toMatchObject({ title: "Rent", currency: "USD", method: "card", vendor: "Landlord", amount: 400.46 });
    });
    test("amounts round to the currency's own decimals", () => {
        expect(sanitizeExpense({ ...base, currency: "JPY", amount: 100.6 })!.amount).toBe(101);
        expect(sanitizeExpense({ ...base, currency: "KWD", amount: 1.23456 })!.amount).toBe(1.235);
        expect(sanitizeExpense({ ...base, currency: "JPY", amount: 0.3 })).toBeNull(); // rounds to nothing
    });
    test("unusable records are dropped rather than repaired into something false", () => {
        for (const bad of [null, "x", {}, { ...base, id: "" }, { ...base, title: "x" }, { ...base, amount: 0 }, { ...base, amount: -3 }, { ...base, amount: "abc" }, { ...base, currency: "dollars" }, { ...base, date: "2026-02-31" }, { ...base, amount: 1e13 }]) {
            expect(sanitizeExpense(bad)).toBeNull();
        }
    });
    test("defaults fill the optional fields", () => {
        const e = sanitizeExpense({ ...base, method: "teleport" })!;
        expect(e).toMatchObject({ method: "other", vendor: "", reference: "", notes: "" });
        expect(e.tax).toBeUndefined();
        expect(sanitizeExpense({ ...base, category: "" })!.category).toBe("miscellaneous");
    });
    test("tax details are kept only when sensible", () => {
        expect(sanitizeExpense({ ...base, tax: { amount: 60, rate: 18, recoverable: true, gstin: gstin("27") } })!.tax).toEqual({ amount: 60, rate: 18, recoverable: true, gstin: gstin("27") });
        expect(sanitizeExpense({ ...base, tax: { amount: 500, recoverable: true } })!.tax).toBeUndefined(); // more than was paid
        expect(sanitizeExpense({ ...base, tax: { amount: 0 } })!.tax).toBeUndefined();
        expect(sanitizeExpense({ ...base, tax: { amount: 10, gstin: "bad" } })!.tax).toEqual({ amount: 10, recoverable: false });
        expect(sanitizeExpense({ ...base, tax: { amount: 10, rate: 500 } })!.tax).toEqual({ amount: 10, recoverable: false });
    });
    test("text is cleaned and bounded", () => {
        const e = sanitizeExpense({ ...base, title: "Ren\u0000t‮", notes: "n".repeat(5000), vendor: "v".repeat(500) })!;
        expect(e.title).toBe("Rent");
        expect(e.notes).toHaveLength(1000);
        expect(e.vendor).toHaveLength(100);
    });
});

/* ============================================================== categories */

test.describe("categories", () => {
    const name = (id: string) => ({ rent: "Rent", miscellaneous: "Miscellaneous" })[id] ?? id;
    const custom = [{ id: "x-fuel", name: "Fuel" }];

    test("labels come from the translation for built-ins and the name for custom ones", () => {
        expect(categoryLabel("rent", custom, name)).toBe("Rent");
        expect(categoryLabel("x-fuel", custom, name)).toBe("Fuel");
        // a category that no longer exists reads as miscellaneous rather than as a raw id
        expect(categoryLabel("x-gone", custom, name)).toBe("Miscellaneous");
    });
    test("a custom category cannot take a built-in id, or lack a name", () => {
        expect(sanitizeCategory({ id: "rent", name: "My rent" })).toBeNull();
        expect(sanitizeCategory({ id: "x-1", name: "" })).toBeNull();
        expect(sanitizeCategory({ id: "", name: "Fuel" })).toBeNull();
        expect(sanitizeCategory({ id: "x-1", name: "  Fuel   and  oil " })).toEqual({ id: "x-1", name: "Fuel and oil" });
    });
    test("names are unique among custom categories and built-in names, ignoring case and spacing", () => {
        expect(categoryNameTaken("fuel", custom, [])).toBe(true);
        expect(categoryNameTaken("  FUEL ", custom, [])).toBe(true);
        expect(categoryNameTaken("Rent", custom, ["Rent", "Salaries"])).toBe(true);
        expect(categoryNameTaken("Fuel", custom, [], "x-fuel")).toBe(false); // renaming to its own name
        expect(categoryNameTaken("Tolls", custom, ["Rent"])).toBe(false);
    });
    test("usage counts say how many expenses use each category", () => {
        const u = usageByCategory([exp("Item A", "rent", 1, "2026-06-01"), exp("Item B", "rent", 1, "2026-06-02"), exp("Item C", "x-fuel", 1, "2026-06-03")]);
        expect(u.get("rent")).toBe(2);
        expect(u.get("x-fuel")).toBe(1);
        expect(u.get("marketing")).toBeUndefined();
    });
    test("expenses pointing at a missing category are filed under miscellaneous", () => {
        const list = withKnownCategories([exp("Item A", "x-gone", 1, "2026-06-01"), exp("Item B", "rent", 1, "2026-06-01")], new Set(CATS));
        expect(list.map((e) => e.category)).toEqual(["miscellaneous", "rent"]);
    });
});

/* ================================================================== query */

test.describe("search, filters and sorting", () => {
    const nameOf = (id: string) => ({ rent: "Rent", marketing: "Marketing", "x-fuel": "Fuel" })[id] ?? id;
    const list = [
        exp("Office rent June", "rent", 400, "2026-06-01", { vendor: "Skyline Estates", reference: "R-1" }),
        exp("Facebook ads", "marketing", 150, "2026-06-10", { vendor: "Meta", method: "card", notes: "spring campaign" }),
        exp("Diesel", "x-fuel", 60, "2026-05-20", { vendor: "Indian Oil", method: "cash" }),
        exp("Office rent May", "rent", 400, "2026-05-01", { vendor: "Skyline Estates", reference: "R-0" }),
        exp("Euro lunch", "marketing", 30, "2026-06-05", { currency: "EUR" }),
    ];
    const titles = (q: Partial<typeof EMPTY_EXPENSE_QUERY>) => queryExpenses(list, { ...EMPTY_EXPENSE_QUERY, ...q }, nameOf).map((e) => e.title);

    test("search covers title, vendor, reference, notes and the category's name", () => {
        expect(titles({ search: "skyline" }).sort()).toEqual(["Office rent June", "Office rent May"]);
        expect(titles({ search: "r-0" })).toEqual(["Office rent May"]);
        expect(titles({ search: "spring" })).toEqual(["Facebook ads"]);
        expect(titles({ search: "fuel" })).toEqual(["Diesel"]); // the category name, not in any field
        expect(titles({ search: "nothing like it" })).toEqual([]);
    });
    test("category, method and currency filters", () => {
        expect(titles({ category: "rent" })).toHaveLength(2);
        expect(titles({ method: "cash" })).toEqual(["Diesel"]);
        expect(titles({ currency: "EUR" })).toEqual(["Euro lunch"]);
    });
    test("the date range is inclusive at both ends, and either end may be open", () => {
        expect(titles({ from: "2026-06-01", to: "2026-06-10" }).sort()).toEqual(["Euro lunch", "Facebook ads", "Office rent June"]);
        expect(titles({ from: "2026-06-10", to: "2026-06-10" })).toEqual(["Facebook ads"]);
        expect(titles({ to: "2026-05-20" }).sort()).toEqual(["Diesel", "Office rent May"]);
        expect(titles({ from: "2026-06-06" }).sort()).toEqual(["Facebook ads"]);
    });
    test("filters combine", () => {
        expect(titles({ category: "rent", from: "2026-06-01" })).toEqual(["Office rent June"]);
        expect(titles({ search: "office", currency: "EUR" })).toEqual([]);
    });
    test("sorting by date, amount, title and vendor, with a stable order for ties", () => {
        expect(titles({ sort: "date", dir: "desc" })[0]).toBe("Facebook ads");
        expect(titles({ sort: "date", dir: "asc" })[0]).toBe("Office rent May");
        expect(titles({ sort: "amount", dir: "desc" }).slice(0, 2)).toHaveLength(2);
        expect(queryExpenses(list, { ...EMPTY_EXPENSE_QUERY, sort: "amount", dir: "desc" }, nameOf)[0].amount).toBe(400);
        expect(titles({ sort: "title", dir: "asc" })[0]).toBe("Diesel");
        const a = titles({ sort: "amount", dir: "desc" });
        expect(titles({ sort: "amount", dir: "desc" })).toEqual(a); // repeatable
    });
    test("the currencies present are listed", () => {
        expect(currenciesOfExpenses(list)).toEqual(["EUR", "USD"]);
    });
});

/* =============================================================== summaries */

test.describe("expense summaries", () => {
    const list = [
        exp("Rent May", "rent", 400, "2026-05-10"),
        exp("Utilities", "utilities", 118, "2026-05-25", { tax: 18, recoverable: true }),
        exp("Ads", "marketing", 236, "2026-06-03", { tax: 36 }),
        exp("Salaries", "salaries", 1000, "2026-06-12"),
        exp("Rent April", "rent", 400, "2026-04-20"),
        exp("Euro transport", "transport", 50, "2026-06-05", { currency: "EUR" }),
    ];
    const s = summariseExpenses(list, { currency: "USD", from: "2026-05-01", to: "2026-06-15" });

    test("totals, tax and count for one currency over a range", () => {
        expect(s.total).toBe(1754);
        expect(s.count).toBe(4);
        expect(s.tax).toBe(54);
        expect(s.recoverableTax).toBe(18);
        expect(s.average).toBe(438.5);
        expect(s.largest?.title).toBe("Salaries");
    });
    test("another currency is never mixed in", () => {
        expect(summariseExpenses(list, { currency: "EUR" })).toMatchObject({ total: 50, count: 1 });
        expect(summariseExpenses(list, { currency: "GBP" })).toMatchObject({ total: 0, count: 0, byCategory: [], byMonth: [] });
    });
    test("by category: largest first, and the shares add up to one", () => {
        expect(s.byCategory.map((c) => [c.category, c.total])).toEqual([["salaries", 1000], ["rent", 400], ["marketing", 236], ["utilities", 118]]);
        expect(s.byCategory.reduce((sum, c) => sum + c.share, 0)).toBeCloseTo(1, 10);
        expect(s.byCategory[0].share).toBeCloseTo(1000 / 1754, 10);
    });
    test("by month: oldest first, only months that have expenses", () => {
        expect(s.byMonth).toEqual([{ ym: "2026-05", total: 518, count: 2 }, { ym: "2026-06", total: 1236, count: 2 }]);
        expect(summariseExpenses(list, { currency: "USD" }).byMonth.map((m) => m.ym)).toEqual(["2026-04", "2026-05", "2026-06"]);
    });
    test("an empty period is zeros, not an error", () => {
        const none = summariseExpenses(list, { currency: "USD", from: "2030-01-01", to: "2030-12-31" });
        expect(none).toMatchObject({ total: 0, count: 0, average: 0, largest: null });
    });
    test("cents do not accumulate float noise", () => {
        const many = Array.from({ length: 10 }, (_, i) => exp(`Item ${i}`, "supplies", 0.1, "2026-06-01"));
        expect(summariseExpenses(many, { currency: "USD" }).total).toBe(1);
    });
});

/* ======================================================== profit and loss */

/**
 * The reference scenario, computed by hand. USD, 1 May to 15 June 2026.
 *
 *   I1 issued 05-05  1000 + 18% = 1180   due 06-04   500 paid on 05-20
 *   I2 issued 06-02  2000 + 18% = 2360   due 07-02   paid in full on 06-10
 *   I3 issued 06-10   500 + 18% =  590   due 06-25   unpaid
 *   I4 draft 999 · I5 cancelled 777 · I6 EUR 100 + 18%          (not in the USD figures)
 *
 *   E1 05-10 rent        400
 *   E2 05-25 utilities   118  (18 tax, recoverable)
 *   E3 06-03 marketing   236  (36 tax, not recoverable)
 *   E4 06-12 salaries   1000
 *   E5 04-20 rent        400  (before the period)
 *
 *   invoiced            1180 + 2360 + 590        = 4130
 *   tax on invoices      180 +  360 +  90        =  630
 *   revenue             4130 - 630               = 3500
 *   collected            500 + 2360              = 2860
 *   expenses             400 + 118 + 236 + 1000  = 1754   (tax 54, recoverable 18)
 *   cost                1754 - 18                = 1736
 *   net cash flow       2860 - 1754              = 1106
 *   estimated profit    3500 - 1736              = 1764
 *   outstanding (06-15)  680 (I1) + 590 (I3)     = 1270,  overdue 680 (I1 was due 06-04)
 */
const BOOKS: InvoiceType[] = [
    inv("I1", { issued: "2026-05-05", due: "2026-06-04", sub: 1000, pays: [["2026-05-20", 500]] }),
    inv("I2", { issued: "2026-06-02", due: "2026-07-02", sub: 2000, pays: [["2026-06-10", 2360]] }),
    inv("I3", { issued: "2026-06-10", due: "2026-06-25", sub: 500 }),
    inv("I4", { issued: "2026-06-05", due: "2026-07-05", sub: 999 / 1.18, status: "draft" }),
    inv("I5", { issued: "2026-05-15", due: "2026-06-15", sub: 777 / 1.18, status: "cancelled" }),
    inv("I6", { issued: "2026-06-01", due: "2026-07-01", sub: 100, currency: "EUR" }),
];
const SPEND: Expense[] = [
    exp("Rent", "rent", 400, "2026-05-10"),
    exp("Utilities", "utilities", 118, "2026-05-25", { tax: 18, recoverable: true }),
    exp("Ads", "marketing", 236, "2026-06-03", { tax: 36, recoverable: false }),
    exp("Salaries", "salaries", 1000, "2026-06-12"),
    exp("Rent April", "rent", 400, "2026-04-20"),
    exp("Euro transport", "transport", 50, "2026-06-05", { currency: "EUR" }),
];
const range = { currency: "USD", from: "2026-05-01", to: "2026-06-15", now: NOW };

test.describe("profit and loss: the hand-computed example", () => {
    const p = profitAndLoss(BOOKS, SPEND, range);

    test("invoice basis: invoiced, tax, revenue", () => {
        expect(p.invoiced).toBe(4130);
        expect(p.invoicedTax).toBe(630);
        expect(p.revenue).toBe(3500);
        expect(p.issuedCount).toBe(3);
    });
    test("cash basis: collected is money actually received in the period", () => {
        expect(p.collected).toBe(2860);
    });
    test("expenses, tax and cost", () => {
        expect(p.expenses).toBe(1754);
        expect(p.expenseCount).toBe(4);
        expect(p.expensesTax).toBe(54);
        expect(p.recoverableTax).toBe(18);
        expect(p.expensesNet).toBe(1736);
    });
    test("net cash flow and estimated profit are different numbers", () => {
        expect(p.netCashFlow).toBe(1106);
        expect(p.estimatedProfit).toBe(1764);
        expect(p.netCashFlow).not.toBe(p.estimatedProfit);
        expect(p.margin).toBeCloseTo(1764 / 3500, 10);
    });
    test("receivables are reported separately, and overdue is part of them", () => {
        expect(p.outstanding).toBe(1270);
        expect(p.overdue).toBe(680);
    });
    test("the identities that tie the report together", () => {
        expect(p.revenue + p.invoicedTax).toBeCloseTo(p.invoiced, 10);
        expect(p.netCashFlow).toBeCloseTo(p.collected - p.expenses, 10);
        expect(p.estimatedProfit).toBeCloseTo(p.revenue - p.expensesNet, 10);
        expect(p.expensesNet).toBeCloseTo(p.expenses - p.recoverableTax, 10);
    });
    test("drafts, cancelled invoices and other currencies are not in the USD figures", () => {
        // 999 (draft) and 777 (cancelled) would change these if they leaked in
        expect(p.invoiced).not.toBe(4130 + 999);
        const eur = profitAndLoss(BOOKS, SPEND, { ...range, currency: "EUR" });
        expect(eur).toMatchObject({ invoiced: 118, invoicedTax: 18, revenue: 100, expenses: 50, collected: 0, netCashFlow: -50, estimatedProfit: 50 });
    });
    test("an expense before the period is excluded", () => {
        const wide = profitAndLoss(BOOKS, SPEND, { ...range, from: "2026-04-01" });
        expect(wide.expenses).toBe(2154); // + April rent 400
        expect(p.expenses).toBe(1754);
    });
});

test.describe("profit and loss: cash is not invoices", () => {
    test("an unpaid invoice adds revenue and receivables but no cash", () => {
        const before = profitAndLoss(BOOKS, SPEND, range);
        const more = [...BOOKS, inv("I7", { issued: "2026-06-12", due: "2026-07-12", sub: 1000 })];
        const after = profitAndLoss(more, SPEND, range);
        expect(after.revenue - before.revenue).toBe(1000);
        expect(after.invoiced - before.invoiced).toBe(1180);
        expect(after.outstanding - before.outstanding).toBe(1180);
        expect(after.collected).toBe(before.collected);
        expect(after.netCashFlow).toBe(before.netCashFlow); // unpaid is not cash
    });
    test("a payment moves money from receivables into cash, one for one", () => {
        const before = profitAndLoss(BOOKS, SPEND, range);
        const paid = BOOKS.map((b) => (b.details.invoiceNumber === "I3" ? { ...b, details: { ...b.details, payments: [{ id: "x", date: "2026-06-14", amount: 400 }] } } : b));
        const after = profitAndLoss(paid, SPEND, range);
        expect(after.collected - before.collected).toBe(400);
        expect(after.netCashFlow - before.netCashFlow).toBe(400);
        expect(before.outstanding - after.outstanding).toBe(400);
        // revenue (invoice basis) does not care when it is paid
        expect(after.revenue).toBe(before.revenue);
        expect(after.estimatedProfit).toBe(before.estimatedProfit);
    });
    test("cash in a period can come from an invoice issued before it", () => {
        // I1 was issued in May; look only at June: its 05-20 payment is outside, I2's is inside.
        const june = profitAndLoss(BOOKS, SPEND, { currency: "USD", from: "2026-06-01", to: "2026-06-15", now: NOW });
        expect(june.collected).toBe(2360);
        const later = [...BOOKS.slice(1), inv("I1", { issued: "2026-05-05", due: "2026-06-04", sub: 1000, pays: [["2026-06-08", 500]] })];
        expect(profitAndLoss(later, SPEND, { currency: "USD", from: "2026-06-01", to: "2026-06-15", now: NOW }).collected).toBe(2860);
        expect(profitAndLoss(later, SPEND, { currency: "USD", from: "2026-06-01", to: "2026-06-15", now: NOW }).invoiced).toBe(2950); // I1 is still May's invoice
    });
    test("receivables are as at the end date: a later payment has not happened yet", () => {
        const asAtMay31 = profitAndLoss(BOOKS, SPEND, { currency: "USD", from: "2026-05-01", to: "2026-05-31", now: NOW });
        // only I1 exists by then, with 500 of 1180 paid on 05-20
        expect(asAtMay31.outstanding).toBe(680);
        expect(asAtMay31.collected).toBe(500);
        expect(asAtMay31.overdue).toBe(0); // I1 is not due until 06-04
        const asAtMay10 = profitAndLoss(BOOKS, SPEND, { currency: "USD", from: "2026-05-01", to: "2026-05-10", now: NOW });
        expect(asAtMay10.outstanding).toBe(1180); // the 05-20 payment has not happened
    });
    test("overdue means past its due date at the end date, and only for what is still owed", () => {
        expect(profitAndLoss(BOOKS, SPEND, range).overdue).toBe(680);
        expect(profitAndLoss(BOOKS, SPEND, { ...range, to: "2026-06-04" }).overdue).toBe(0); // due that day is not yet late
        expect(profitAndLoss(BOOKS, SPEND, { ...range, to: "2026-06-05" }).overdue).toBe(680);
    });
    test("a legacy 'paid' invoice with no payment rows counts as cash on its invoice date", () => {
        const legacy = inv("L1", { issued: "2026-06-01", due: "2026-06-30", sub: 100, status: "paid" });
        delete (legacy.details as { payments?: unknown }).payments;
        const p = profitAndLoss([legacy], [], range);
        expect(p.invoiced).toBe(118);
        expect(p.collected).toBe(118);
        expect(p.outstanding).toBe(0);
    });
    test("with no expenses the estimate says nothing about cost", () => {
        const p = profitAndLoss(BOOKS, [], range);
        expect(p.expenses).toBe(0);
        expect(p.estimatedProfit).toBe(p.revenue);
        expect(p.netCashFlow).toBe(p.collected);
    });
    test("no activity at all is zeros, with no margin to speak of", () => {
        const p = profitAndLoss([], [], range);
        expect(p).toMatchObject({ invoiced: 0, collected: 0, expenses: 0, netCashFlow: 0, estimatedProfit: 0, outstanding: 0, margin: null });
    });
    test("GST invoices contribute their GST, not the flat tax charge, as the tax to exclude", () => {
        const g = inv("G1", { issued: "2026-06-02", due: "2026-07-02", sub: 1000, taxPct: 0 });
        Object.assign(g.details, {
            gst: { enabled: true, pricing: "exclusive", placeOfSupply: "27" },
            items: [{ name: "Laptop", quantity: 1, unitPrice: 1000, total: 1000, hsn: "8471", gstRate: 18 }],
            totalAmount: 1180,
        });
        g.sender = { ...g.sender, gstin: gstin("27") } as InvoiceType["sender"];
        const p = profitAndLoss([g], [], range);
        expect(p.invoiced).toBe(1180);
        expect(p.invoicedTax).toBe(180);
        expect(p.revenue).toBe(1000);
    });
    test("a loss is reported as a loss", () => {
        const p = profitAndLoss([inv("S", { issued: "2026-06-02", due: "2026-07-02", sub: 100, pays: [["2026-06-03", 118]] })], [exp("Big", "equipment", 500, "2026-06-04")], range);
        expect(p.estimatedProfit).toBe(-400);
        expect(p.netCashFlow).toBe(-382);
        expect(p.margin).toBeCloseTo(-4, 10);
    });
});

test.describe("zero-decimal currencies", () => {
    test("JPY stays in whole yen", () => {
        const jpy = inv("J1", { issued: "2026-06-02", due: "2026-07-02", sub: 1000, currency: "JPY", pays: [["2026-06-03", 500]] });
        const e = exp("Rent", "rent", 300.4, "2026-06-04", { currency: "JPY" });
        expect(e.amount).toBe(300);
        const p = profitAndLoss([jpy], [e], { currency: "JPY", from: "2026-06-01", to: "2026-06-30", now: NOW });
        expect(Number.isInteger(p.invoiced) && Number.isInteger(p.collected) && Number.isInteger(p.expenses)).toBe(true);
        expect(p.netCashFlow).toBe(200);
    });
});

/* ================================================================ monthly */

test.describe("monthly series", () => {
    const rows = monthlySeries(BOOKS, SPEND, range);

    test("one row per month, each worked out by hand", () => {
        expect(rows.map((r) => r.ym)).toEqual(["2026-05", "2026-06"]);
        expect(rows[0]).toMatchObject({ invoiced: 1180, revenue: 1000, collected: 500, expenses: 518, expensesNet: 500, estimatedProfit: 500, netCashFlow: -18 });
        expect(rows[1]).toMatchObject({ invoiced: 2950, revenue: 2500, collected: 2360, expenses: 1236, expensesNet: 1236, estimatedProfit: 1264, netCashFlow: 1124 });
    });
    test("the months add up to the period", () => {
        const p = profitAndLoss(BOOKS, SPEND, range);
        const sum = (k: keyof (typeof rows)[number]) => rows.reduce((s, r) => s + (r[k] as number), 0);
        expect(sum("revenue")).toBeCloseTo(p.revenue, 6);
        expect(sum("collected")).toBeCloseTo(p.collected, 6);
        expect(sum("expenses")).toBeCloseTo(p.expenses, 6);
        expect(sum("estimatedProfit")).toBeCloseTo(p.estimatedProfit, 6);
        expect(sum("netCashFlow")).toBeCloseTo(p.netCashFlow, 6);
    });
    test("months with nothing in them are still shown, as zeros", () => {
        const r = monthlySeries(BOOKS, SPEND, { currency: "USD", from: "2026-03-01", to: "2026-06-15", now: NOW });
        expect(r.map((x) => x.ym)).toEqual(["2026-03", "2026-04", "2026-05", "2026-06"]);
        expect(r[0]).toMatchObject({ revenue: 0, collected: 0, expenses: 0 });
        expect(r[1].expenses).toBe(400); // April rent
    });
    test("without a start date it begins at the first month with any activity", () => {
        expect(monthlySeries(BOOKS, SPEND, { currency: "USD", to: "2026-06-15", now: NOW })[0].ym).toBe("2026-04");
    });
    test("an empty book still gives a well-formed (single) row, and a reversed range gives none", () => {
        expect(monthlySeries([], [], { currency: "USD", to: "2026-06-15", now: NOW })).toHaveLength(1);
        expect(monthlySeries(BOOKS, SPEND, { currency: "USD", from: "2026-07-01", to: "2026-06-01", now: NOW })).toEqual([]);
    });
    test("randomised books: months always add up to the period, for any range", () => {
        let x = 987654321;
        const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
        const day = (off: number) => toDay(new Date(2026, 5, 15 - off));
        for (let round = 0; round < 40; round++) {
            const books: InvoiceType[] = [];
            for (let i = 0; i < 1 + Math.floor(rnd() * 5); i++) {
                const issuedOff = Math.floor(rnd() * 200);
                const sub = Math.round((50 + rnd() * 1500) * 100) / 100;
                const total = Math.round(sub * 118) / 100;
                const pays: [string, number][] = rnd() < 0.7 ? [[day(Math.max(0, issuedOff - Math.floor(rnd() * 90))), Math.round(total * rnd() * 100) / 100 || 1]] : [];
                books.push(inv(`R${round}-${i}`, { issued: day(issuedOff), due: day(issuedOff - 30), sub, pays, status: rnd() < 0.15 ? "draft" : "sent" }));
            }
            const spend = Array.from({ length: Math.floor(rnd() * 6) }, (_, i) => exp(`E${round}-${i}`, CATS[i % CATS.length], Math.round((5 + rnd() * 700) * 100) / 100, day(Math.floor(rnd() * 220)), rnd() < 0.4 ? { tax: 1, recoverable: rnd() < 0.5 } : {}));
            for (let k = 0; k < 4; k++) {
                const a = Math.floor(rnd() * 220);
                const from = day(a);
                const to = day(Math.max(0, a - Math.floor(rnd() * 150)));
                if (from > to) continue;
                const opts = { currency: "USD", from, to, now: NOW };
                const p = profitAndLoss(books, spend, opts);
                const months = monthlySeries(books, spend, opts);
                const sum = (key: keyof (typeof months)[number]) => months.reduce((s, r) => s + (r[key] as number), 0);
                expect(sum("revenue")).toBeCloseTo(p.revenue, 5);
                expect(sum("collected")).toBeCloseTo(p.collected, 5);
                expect(sum("expenses")).toBeCloseTo(p.expenses, 5);
                expect(sum("estimatedProfit")).toBeCloseTo(p.estimatedProfit, 5);
                expect(sum("netCashFlow")).toBeCloseTo(p.netCashFlow, 5);
                // and the report's own identities
                expect(p.revenue + p.invoicedTax).toBeCloseTo(p.invoiced, 5);
                expect(p.netCashFlow).toBeCloseTo(p.collected - p.expenses, 5);
                expect(p.estimatedProfit).toBeCloseTo(p.revenue - p.expensesNet, 5);
            }
        }
    });
});

/* ============================================================= periods */

test.describe("periods", () => {
    test("the previous period has the same length and ends the day before", () => {
        expect(previousPeriod("2026-06-01", "2026-06-15")).toEqual({ from: "2026-05-17", to: "2026-05-31" });
        expect(previousPeriod("2026-06-10", "2026-06-10")).toEqual({ from: "2026-06-09", to: "2026-06-09" });
        expect(previousPeriod("", "2026-06-15")).toBeNull();
        expect(previousPeriod("2026-06-15", "2026-06-01")).toBeNull();
    });
    test("presets, including the April-March financial year", () => {
        expect(periodFor("thisMonth", NOW)).toEqual({ from: "2026-06-01", to: "2026-06-15" });
        expect(periodFor("lastMonth", NOW)).toEqual({ from: "2026-05-01", to: "2026-05-31" });
        expect(periodFor("last3", NOW)).toEqual({ from: "2026-04-01", to: "2026-06-15" });
        expect(periodFor("thisFy", NOW)).toEqual({ from: "2026-04-01", to: "2026-06-15" });
        expect(periodFor("thisFy", new Date(2026, 1, 10))).toEqual({ from: "2025-04-01", to: "2026-02-10" });
        expect(periodFor("thisYear", NOW)).toEqual({ from: "2026-01-01", to: "2026-06-15" });
        expect(periodFor("all", NOW)).toEqual({ from: "", to: "2026-06-15" });
        expect(periodFor("lastMonth", new Date(2026, 0, 10))).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    });
    test("day helpers round-trip", () => {
        expect(toDay(fromDay("2026-06-05"))).toBe("2026-06-05");
    });
});

/* ============================================================ insights */

test.describe("rule-based observations", () => {
    const insights = (invoices: InvoiceType[], expenses: Expense[], opts = range, prev: { expenses: number } | null = null) => {
        const p = profitAndLoss(invoices, expenses, opts);
        return pnlInsights(p, summariseExpenses(expenses, { currency: opts.currency, from: opts.from, to: opts.to }), prev);
    };
    const ids = (l: { id: string }[]) => l.map((i) => i.id);

    test("the example: profit on paper, cash positive, a large receivable, an overdue amount", () => {
        const list = insights(BOOKS, SPEND);
        expect(ids(list)).toEqual(expect.arrayContaining(["profitEstimate", "cashPositive", "overdue"]));
        expect(ids(list)).not.toContain("lossEstimate");
        expect(list.find((i) => i.id === "overdue")!.params).toMatchObject({ amount: 680, currency: "USD" });
    });
    test("revenue with no expenses warns that profit is probably overstated", () => {
        expect(ids(insights(BOOKS, []))).toContain("noExpenses");
        expect(ids(insights(BOOKS, SPEND))).not.toContain("noExpenses");
    });
    test("a loss and negative cash are flagged with their real amounts", () => {
        const list = insights([inv("S", { issued: "2026-06-02", due: "2026-07-02", sub: 100, pays: [["2026-06-03", 118]] })], [exp("Big", "equipment", 500, "2026-06-04")]);
        expect(list.find((i) => i.id === "lossEstimate")!.params.amount).toBe(400);
        expect(list.find((i) => i.id === "cashNegative")!.params.amount).toBe(382);
        expect(list[0].tone).toBe("warning");
    });
    test("profit that is not yet cash points at receivables", () => {
        const books = [inv("U", { issued: "2026-06-02", due: "2026-07-02", sub: 5000 })]; // big, unpaid
        const list = insights(books, [exp("Rent", "rent", 400, "2026-06-04")]);
        expect(ids(list)).toContain("profitNotCash");
        expect(ids(list)).toContain("receivablesHigh");
        expect(ids(list)).not.toContain("cashPositive");
    });
    test("a dominant category is named, but only when there is more than one and it is 40% or more", () => {
        const spend = [exp("Item A", "rent", 700, "2026-06-01"), exp("Item B", "marketing", 200, "2026-06-02"), exp("Item C", "supplies", 100, "2026-06-03")];
        const top = insights(BOOKS, spend).find((i) => i.id === "topCategory")!;
        expect(top.params).toMatchObject({ category: "rent", percent: 70 });
        expect(ids(insights(BOOKS, [exp("Item A", "rent", 700, "2026-06-01")]))).not.toContain("topCategory");
        const even = [exp("Item A", "rent", 340, "2026-06-01"), exp("Item B", "marketing", 330, "2026-06-02"), exp("Item C", "supplies", 330, "2026-06-03")];
        expect(ids(insights(BOOKS, even))).not.toContain("topCategory");
    });
    test("spending that jumps against the previous period is flagged, and a drop is welcomed", () => {
        expect(insights(BOOKS, SPEND, range, { expenses: 1000 }).find((i) => i.id === "expensesUp")!.params.percent).toBe(75);
        expect(ids(insights(BOOKS, SPEND, range, { expenses: 1700 }))).not.toContain("expensesUp");
        expect(ids(insights(BOOKS, SPEND, range, { expenses: 4000 }))).toContain("expensesDown");
        expect(ids(insights(BOOKS, SPEND, range, null))).not.toContain("expensesUp");
    });
    test("nothing recorded, nothing said", () => {
        expect(insights([], [])).toEqual([]);
    });
    test("the most urgent come first", () => {
        const list = insights([inv("S", { issued: "2026-06-02", due: "2026-07-02", sub: 100 })], [exp("Big", "equipment", 500, "2026-06-04")]);
        const tones = list.map((i) => i.tone);
        expect(tones).toEqual([...tones].sort((a, b) => ["critical", "warning", "info", "positive"].indexOf(a) - ["critical", "warning", "info", "positive"].indexOf(b)));
    });
});

/* ============================================================ exports */

test.describe("exports", () => {
    const nameOf = (id: string) => ({ rent: "Rent", marketing: "Marketing", utilities: "Utilities", salaries: "Salaries" })[id] ?? id;
    const p = profitAndLoss(BOOKS, SPEND, range);
    const summary = summariseExpenses(SPEND, { currency: "USD", from: range.from, to: range.to });
    const months = monthlySeries(BOOKS, SPEND, range);

    test("the expense CSV has one row per expense, and spreadsheet formulas are neutralised", () => {
        const csv = expensesToCsv([exp("=HYPERLINK(\"http://x\")", "rent", 5, "2026-06-01", { vendor: "+cmd" }), SPEND[1]], nameOf);
        const lines = csv.split("\r\n");
        expect(lines[0]).toBe('"Date","Title","Category","Vendor","Reference","Method","Amount","Tax","Tax recoverable","Vendor GSTIN","Currency","Notes"');
        expect(lines).toHaveLength(3);
        expect(lines[1]).toContain(`"'=HYPERLINK(""http://x"")"`);
        expect(lines[1]).toContain(`"'+cmd"`);
        expect(lines[2]).toContain('"Utilities"');
        expect(lines[2]).toContain('"Yes"'); // recoverable
    });
    test("the report CSV carries both bases, receivables, categories and months", () => {
        const { csv, filename } = profitLossCsv(p, summary, months, nameOf);
        expect(filename).toBe("profit-and-loss-2026-05-01_to_2026-06-15-USD.csv");
        expect(csv).toContain('"Invoice basis","Revenue (excl. tax)","3500","USD"');
        expect(csv).toContain('"Invoice basis","Estimated profit","1764","USD"');
        expect(csv).toContain('"Cash basis","Net cash flow","1106","USD"');
        expect(csv).toContain('"Receivables","Outstanding at end date","1270","USD"');
        expect(csv).toContain('"Expenses by category","Salaries","1000","USD"');
        expect(csv).toContain('"Month 2026-06"');
        // categories + months + 13 summary lines + header
        expect(csv.split("\r\n")).toHaveLength(1 + 13 + summary.byCategory.length + months.length);
    });

    const payload = (over: Record<string, unknown> = {}) => ({
        generatedAt: "2026-06-15",
        business: { name: "Sharma Traders", gstin: gstin("27") },
        pnl: p,
        categories: summary.byCategory.map((c) => ({ name: nameOf(c.category), total: c.total, count: c.count, share: c.share })),
        months,
        ...over,
    });
    test("the PDF payload schema accepts a real report", () => {
        expect(ReportPayloadSchema.safeParse(payload()).success).toBe(true);
    });
    test("and refuses malformed, oversize and non-finite input", () => {
        expect(ReportPayloadSchema.safeParse(payload({ generatedAt: "today" })).success).toBe(false);
        expect(ReportPayloadSchema.safeParse(payload({ pnl: { ...p, revenue: Infinity } })).success).toBe(false);
        expect(ReportPayloadSchema.safeParse(payload({ categories: Array(101).fill({ name: "x", total: 1, count: 1, share: 0.1 }) })).success).toBe(false);
        expect(ReportPayloadSchema.safeParse(payload({ months: Array(121).fill(months[0]) })).success).toBe(false);
        expect(ReportPayloadSchema.safeParse(payload({ categories: [{ name: "x", total: 1, count: 1, share: 2 }] })).success).toBe(false);
        expect(ReportPayloadSchema.safeParse({}).success).toBe(false);
    });
    test("control characters are stripped from names", () => {
        const parsed = ReportPayloadSchema.parse(payload({ business: { name: "Sha\u0000rma‮" } }));
        expect(parsed.business.name).toBe("Sharma");
    });
});

/* =============================================================== merging */

test.describe("merging imported expenses", () => {
    const fuel = { id: "x-fuel", name: "Fuel" };
    const a = exp("Rent", "rent", 400, "2026-06-01");

    test("an expense already held is skipped, never overwritten", () => {
        const changed = { ...a, amount: 999 };
        const r = mergeExpenseData({ expenses: [a], categories: [] }, { expenses: [changed], categories: [] });
        expect(r.expenses).toHaveLength(1);
        expect(r.expenses[0].amount).toBe(400);
        expect(r).toMatchObject({ added: 0, skipped: 1 });
    });
    test("new expenses are added", () => {
        const b = exp("Ads", "marketing", 100, "2026-06-02");
        const r = mergeExpenseData({ expenses: [a], categories: [] }, { expenses: [a, b], categories: [] });
        expect(r.expenses.map((e) => e.title).sort()).toEqual(["Ads", "Rent"]);
        expect(r).toMatchObject({ added: 1, skipped: 1 });
    });
    test("a custom category is added with its expenses", () => {
        const e = exp("Diesel", "x-fuel", 60, "2026-06-03");
        const r = mergeExpenseData({ expenses: [], categories: [] }, { expenses: [e], categories: [fuel] });
        expect(r.categories).toEqual([fuel]);
        expect(r.expenses[0].category).toBe("x-fuel");
        expect(r.addedCategories).toBe(1);
    });
    test("a category with the same name is the same category: no second 'Fuel'", () => {
        const e = exp("Diesel", "x-theirs", 60, "2026-06-03");
        const r = mergeExpenseData({ expenses: [], categories: [{ id: "x-mine", name: "fuel" }] }, { expenses: [e], categories: [{ id: "x-theirs", name: "Fuel" }] });
        expect(r.categories).toHaveLength(1);
        expect(r.expenses[0].category).toBe("x-mine");
        expect(r.addedCategories).toBe(0);
    });
    test("an expense whose category exists nowhere is filed under miscellaneous, and counted", () => {
        const e = exp("Mystery", "x-nowhere", 10, "2026-06-03");
        const r = mergeExpenseData({ expenses: [], categories: [] }, { expenses: [e], categories: [] });
        expect(r.expenses[0].category).toBe("miscellaneous");
        expect(r.refiled).toBe(1);
    });
    test("built-in categories always resolve", () => {
        const r = mergeExpenseData({ expenses: [], categories: [] }, { expenses: [exp("Rent", "rent", 1, "2026-06-01")], categories: [] });
        expect(r.expenses[0].category).toBe("rent");
        expect(r.refiled).toBe(0);
    });
});
