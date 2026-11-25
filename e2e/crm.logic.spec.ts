import { test, expect } from "@playwright/test";

import {
    allocatePayment,
    behaviourOf,
    buildDirectory,
    customerInsights,
    documentsOf,
    dormantCustomers,
    editDistance,
    EMPTY_CUSTOMER_QUERY,
    findDuplicateGroups,
    findPotentialDuplicates,
    frequencyOf,
    frequentBuyers,
    identityOf,
    monthlyInvoiced,
    normaliseName,
    openInvoicesOf,
    queryCustomers,
    timelineOf,
    topByRevenue,
    trendOf,
    withOutstanding,
    type CustomerRecord,
} from "../lib/crm";
import { customersToCsv, mapColumns, parseCsv, planImport } from "../lib/customerImport";
import { gstinCheckChar } from "../lib/gst";
import { balanceDue, startOfDay } from "../lib/invoiceRecords";
import { cleanTags, normalise, toDocumentParty, type SavedParty } from "../lib/partyStore";
import type { Quotation } from "../lib/quotations";
import {
    buildStatement,
    ledgerCurrencies,
    ledgerOf,
    pickBusiness,
    rangeFor,
    StatementPayloadSchema,
    statementToCsv,
} from "../lib/statement";
import type { InvoiceType } from "../types";

/** Customer logic: no browser, no server. */

const NOW = new Date(2026, 5, 15, 12, 0, 0); // 15 June 2026
const off = (n: number) => new Date(2026, 5, 15 + n);
const iso = (n: number) => off(n).toISOString();
const ymd = (n: number) => {
    const d = off(n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const gstin = (state: string, pan = "AAPFU0939F") => {
    const first14 = `${state}${pan}1Z`;
    return first14 + gstinCheckChar(first14);
};

type Pay = [offset: number, amount: number];
type InvOpts = {
    email?: string;
    status?: string;
    issued: number;
    due: number;
    total: number;
    currency?: string;
    pays?: Pay[];
    gstin?: string;
    phone?: string;
};

let seq = 0;
const inv = (number: string, client: string, o: InvOpts): InvoiceType =>
    ({
        sender: { name: "Sender Co", address: "1 Main", zipCode: "12345", city: "Town", country: "Land", email: "s@example.com", phone: "555", gstin: gstin("27") },
        receiver: {
            name: client,
            address: "2 Side",
            zipCode: "54321",
            city: "Burg",
            country: "Land",
            email: o.email ?? `${client.toLowerCase().replace(/\W+/g, "")}@example.com`,
            phone: o.phone ?? "555-0100",
            ...(o.gstin ? { gstin: o.gstin } : {}),
        },
        details: {
            invoiceNumber: number,
            invoiceDate: iso(o.issued),
            dueDate: iso(o.due),
            currency: o.currency ?? "USD",
            language: "English",
            status: o.status ?? "sent",
            items: [{ name: "Work", quantity: 1, unitPrice: o.total, total: o.total }],
            subTotal: o.total,
            totalAmount: o.total,
            totalAmountInWords: "",
            paymentTerms: "Net 30",
            pdfTemplate: 1,
            payments: (o.pays ?? []).map(([d, amount]) => ({ id: `p${++seq}`, date: ymd(d), amount })),
        },
    }) as unknown as InvoiceType;

const quote = (id: string, number: string, status: Quotation["status"], client: string, o: { email?: string; total?: number; validIn?: number; currency?: string } = {}): Quotation => ({
    id,
    status,
    createdAt: iso(-20),
    updatedAt: iso(-20),
    events: [{ at: iso(-20), kind: "created" }],
    doc: {
        sender: { name: "Sender Co", address: "1 Main", zipCode: "12345", city: "Town", country: "Land", email: "s@example.com", phone: "555" },
        receiver: { name: client, address: "2 Side", zipCode: "54321", city: "Burg", country: "Land", email: o.email ?? `${client.toLowerCase().replace(/\W+/g, "")}@example.com`, phone: "555-0100" },
        details: {
            invoiceNumber: number,
            invoiceDate: iso(-25),
            dueDate: iso(o.validIn ?? 20),
            currency: o.currency ?? "USD",
            items: [{ name: "Thing", quantity: 1, unitPrice: 1, total: 1 }],
            subTotal: 1,
            totalAmount: o.total ?? 1000,
            totalAmountInWords: "",
            paymentTerms: "Net 30",
            pdfTemplate: 1,
        },
    } as unknown as InvoiceType,
});

const profile = (name: string, o: Partial<SavedParty> = {}): SavedParty =>
    ({ id: `id-${name}`, name, email: `${name.toLowerCase().replace(/\W+/g, "")}@example.com`, phone: "", address: "", zipCode: "", city: "", country: "", customInputs: [], ...o }) as SavedParty;

const dir = (profiles: SavedParty[], invoices: InvoiceType[], quotations: Quotation[] = [], converted = new Map<string, string>()) =>
    buildDirectory(profiles, invoices, quotations, converted, NOW);
const rec = (records: CustomerRecord[], name: string) => records.find((r) => r.name === name)!;

/* ================================================================ money */

test.describe("customer financials", () => {
    const invoices = [
        inv("A1", "Acme", { issued: -60, due: -30, total: 1000, pays: [[-40, 1000]] }), // paid
        inv("A2", "Acme", { issued: -40, due: -10, total: 500 }), // overdue, 500 owed
        inv("A3", "Acme", { issued: -10, due: 20, total: 800, pays: [[-5, 300]] }), // partial, 500 owed, not overdue
        inv("A4", "Acme", { issued: -5, due: 25, total: 999, status: "draft" }), // draft: not counted
        inv("A5", "Acme", { issued: -50, due: -20, total: 777, status: "cancelled" }), // cancelled: not counted
        inv("A6", "Acme", { issued: -3, due: 27, total: 200, currency: "EUR" }), // separate currency
    ];
    const r = rec(dir([], invoices), "Acme");
    // The shared aggregator records a currency with nothing in it as 0; what matters is the non-zero figures.
    const nz = (t: Record<string, number>) => Object.fromEntries(Object.entries(t).filter(([, v]) => v > 0));

    test("invoiced, paid, outstanding and overdue come from issued invoices only", () => {
        expect(nz(r.invoices!.billed)).toEqual({ USD: 2300, EUR: 200 });
        expect(nz(r.invoices!.paid)).toEqual({ USD: 1300 });
        expect(nz(r.invoices!.outstanding)).toEqual({ USD: 1000, EUR: 200 });
        expect(nz(r.invoices!.overdue)).toEqual({ USD: 500 });
        expect(r.invoices!.overdueCount).toBe(1);
    });

    test("outstanding equals invoiced minus paid, per currency", () => {
        for (const c of Object.keys(r.invoices!.billed)) {
            expect(r.invoices!.billed[c] - (r.invoices!.paid[c] ?? 0)).toBeCloseTo(r.invoices!.outstanding[c] ?? 0, 10);
        }
    });

    test("overdue never exceeds outstanding", () => {
        for (const [c, v] of Object.entries(r.invoices!.overdue)) expect(v).toBeLessThanOrEqual(r.invoices!.outstanding[c]);
    });

    test("a legacy 'paid' invoice with no payment rows counts as paid in full", () => {
        const legacy = inv("L1", "Old Co", { issued: -30, due: -1, total: 400, status: "paid" });
        delete (legacy.details as { payments?: unknown }).payments;
        const o = rec(dir([], [legacy]), "Old Co");
        expect(o.invoices!.paid).toEqual({ USD: 400 });
        expect(o.invoices!.outstanding.USD ?? 0).toBe(0);
    });
});

/* ========================================================== directory */

test.describe("directory", () => {
    test("one record per customer, whether they come from a profile, invoices or quotations", () => {
        const profiles = [profile("Acme", { email: "buyer@acme.test" })];
        const invoices = [inv("I1", "Acme", { email: "buyer@acme.test", issued: -10, due: 20, total: 100 }), inv("I2", "Globex", { issued: -5, due: 25, total: 50 })];
        const quotes = [quote("q1", "Q1", "sent", "Acme", { email: "buyer@acme.test" }), quote("q2", "Q2", "sent", "Initech")];
        const d = dir(profiles, invoices, quotes);
        expect(d.map((r) => r.name).sort()).toEqual(["Acme", "Globex", "Initech"]);
        expect(d.filter((r) => r.key === "buyer@acme.test")).toHaveLength(1);
        expect(rec(d, "Acme").profile).not.toBeNull();
        expect(rec(d, "Globex").profile).toBeNull();
        expect(rec(d, "Initech").invoices).toBeNull();
    });

    test("quotation figures are per customer and honour conversion", () => {
        const quotes = [
            quote("a", "QA", "accepted", "Acme", { total: 3000 }),
            quote("b", "QB", "accepted", "Acme", { total: 1000 }),
            quote("c", "QC", "sent", "Acme", { total: 500, validIn: 3 }),
            quote("d", "QD", "rejected", "Acme", { total: 200 }),
            quote("e", "QE", "draft", "Acme", { total: 9999 }),
            quote("f", "QF", "sent", "Acme", { total: 400, validIn: -2 }),
        ];
        const r = rec(dir([], [], quotes, new Map([["a", "INV-1"]])), "Acme");
        expect(r.quotes).toMatchObject({ count: 6, draft: 1, pending: 1, accepted: 2, rejected: 1, expired: 1, expiringSoon: 1 });
        expect(r.quotes.acceptedValue).toEqual({ USD: 4000 });
        expect(r.quotes.pendingValue).toEqual({ USD: 500 });
        expect(r.quotes.issuedValue).toEqual({ USD: 5100 }); // drafts excluded
        // QA was converted, so only QB is waiting to be invoiced
        expect(r.quotes.acceptedNotInvoiced.map((q) => q.id)).toEqual(["b"]);
    });

    test("profile fields come through, and a customer is active unless marked inactive", () => {
        const d = dir([profile("Acme", { category: "Wholesale", tags: ["vip", "north"], company: "Acme Pvt Ltd", gstin: gstin("27"), inactive: true }), profile("Beta")], []);
        expect(rec(d, "Acme")).toMatchObject({ category: "Wholesale", tags: ["vip", "north"], company: "Acme Pvt Ltd", active: false });
        expect(rec(d, "Beta").active).toBe(true);
    });

    test("documentsOf returns only that customer's, newest first", () => {
        const invoices = [inv("I1", "Acme", { issued: -30, due: 0, total: 1 }), inv("I2", "Acme", { issued: -5, due: 25, total: 1 }), inv("I3", "Globex", { issued: -1, due: 29, total: 1 })];
        const docs = documentsOf("acme@example.com", invoices, []);
        expect(docs.invoices.map((i) => i.details.invoiceNumber)).toEqual(["I2", "I1"]);
    });
});

/* ===================================================== search & filters */

test.describe("search and filters", () => {
    const profiles = [
        profile("Acme Corp", { category: "Wholesale", tags: ["vip", "north"], gstin: gstin("27"), city: "Mumbai", company: "Acme Pvt Ltd" }),
        profile("Beta Ltd", { category: "Retail", tags: ["north"], inactive: true }),
        profile("Gamma", { category: "Retail", notes: "prefers email" }),
    ];
    const invoices = [inv("I1", "Acme Corp", { email: "acmecorp@example.com", issued: -40, due: -10, total: 500 }), inv("I2", "Gamma", { issued: -2, due: 28, total: 100, pays: [[-1, 100]] })];
    const all = dir(profiles, invoices);
    const names = (q: Partial<typeof EMPTY_CUSTOMER_QUERY>) => queryCustomers(all, { ...EMPTY_CUSTOMER_QUERY, ...q }).map((r) => r.name);

    test("search covers name, GSTIN, company, city, tags and notes", () => {
        expect(names({ search: "pvt" })).toEqual(["Acme Corp"]);
        expect(names({ search: "mumbai" })).toEqual(["Acme Corp"]);
        expect(names({ search: gstin("27").slice(0, 8) })).toEqual(["Acme Corp"]);
        expect(names({ search: "vip" })).toEqual(["Acme Corp"]);
        expect(names({ search: "prefers" })).toEqual(["Gamma"]);
    });
    test("status, category and tag filters combine", () => {
        expect(names({ status: "inactive" })).toEqual(["Beta Ltd"]);
        expect(names({ status: "active" })).toEqual(["Acme Corp", "Gamma"]);
        expect(names({ category: "Retail" })).toEqual(["Beta Ltd", "Gamma"]);
        expect(names({ category: "Retail", status: "active" })).toEqual(["Gamma"]);
        expect(names({ tag: "NORTH" })).toEqual(["Acme Corp", "Beta Ltd"]);
    });
    test("financial filters use the real balances", () => {
        expect(names({ filter: "outstanding" })).toEqual(["Acme Corp"]);
        expect(names({ filter: "overdue" })).toEqual(["Acme Corp"]);
        expect(names({ filter: "inactive" })).toEqual(["Beta Ltd"]); // no invoices yet
    });
    test("sorting by amount and outstanding", () => {
        expect(names({ sort: "billed" })[0]).toBe("Acme Corp");
        expect(names({ sort: "outstanding" })[0]).toBe("Acme Corp");
    });
});

/* ===================================================== payment behaviour */

test.describe("payment behaviour", () => {
    test("on-time payers are reliable", () => {
        const b = behaviourOf([
            inv("1", "X", { issued: -90, due: -60, total: 100, pays: [[-65, 100]] }), // 25 days, on time
            inv("2", "X", { issued: -60, due: -30, total: 100, pays: [[-35, 100]] }), // on time
            inv("3", "X", { issued: -30, due: -5, total: 100, pays: [[-10, 100]] }), // on time
        ], NOW);
        expect(b).toMatchObject({ paidInvoices: 3, onTimeRate: 1, lateCount: 0, class: "reliable" });
        expect(b.avgDaysToPay).toBeCloseTo((25 + 25 + 20) / 3, 10);
    });
    test("late payers are measured by how late", () => {
        const b = behaviourOf([
            inv("1", "X", { issued: -90, due: -60, total: 100, pays: [[-50, 100]] }), // 10 days late
            inv("2", "X", { issued: -60, due: -30, total: 100, pays: [[-10, 100]] }), // 20 days late
            inv("3", "X", { issued: -30, due: -5, total: 100, pays: [[-6, 100]] }), // on time
        ], NOW);
        expect(b.lateCount).toBe(2);
        expect(b.avgDaysLate).toBeCloseTo(15, 10);
        expect(b.onTimeRate).toBeCloseTo(1 / 3, 10);
        expect(b.class).toBe("late");
    });
    test("one paid invoice is not enough to call a pattern", () => {
        expect(behaviourOf([inv("1", "X", { issued: -30, due: -5, total: 100, pays: [[-10, 100]] })], NOW).class).toBe("unknown");
        expect(behaviourOf([], NOW).class).toBe("unknown");
    });
    test("partly paid, unpaid and draft invoices are ignored", () => {
        const b = behaviourOf([
            inv("1", "X", { issued: -30, due: -5, total: 100, pays: [[-10, 50]] }),
            inv("2", "X", { issued: -30, due: 5, total: 100 }),
            inv("3", "X", { issued: -30, due: -5, total: 100, status: "draft", pays: [[-10, 100]] }),
        ], NOW);
        expect(b.paidInvoices).toBe(0);
    });
});

/* ========================================================= frequency */

test.describe("purchase frequency and trends", () => {
    test("gaps, recency and the 12-month count", () => {
        const f = frequencyOf([inv("1", "X", { issued: -100, due: -70, total: 1 }), inv("2", "X", { issued: -70, due: -40, total: 1 }), inv("3", "X", { issued: -10, due: 20, total: 1 }), inv("4", "X", { issued: -400, due: -370, total: 1 })], NOW);
        expect(f.total).toBe(4);
        expect(f.count12m).toBe(3);
        expect(f.daysSinceLast).toBe(10);
        expect(f.avgGapDays).toBeCloseTo((300 + 30 + 60) / 3, 10);
    });
    test("buyers are ranked by recent frequency and dormancy is detected", () => {
        const invoices = [
            ...[-20, -50, -80, -110].map((o, i) => inv(`F${i}`, "Frequent", { issued: o, due: o + 30, total: 1 })),
            ...[-500, -470, -440, -410, -380].map((o, i) => inv(`D${i}`, "Dormant", { issued: o, due: o + 30, total: 1 })),
        ];
        const d = dir([], invoices);
        expect(frequentBuyers(d, 5, 2).map((r) => r.name)).toEqual(["Frequent"]);
        expect(dormantCustomers(d).map((r) => r.name)).toEqual(["Dormant"]);
    });
    test("monthly totals cover twelve months, one currency, issued only", () => {
        const pts = monthlyInvoiced([inv("1", "X", { issued: -5, due: 25, total: 100 }), inv("2", "X", { issued: -40, due: -10, total: 50 }), inv("3", "X", { issued: -5, due: 25, total: 70, currency: "EUR" }), inv("4", "X", { issued: -5, due: 25, total: 999, status: "draft" })], "USD", NOW);
        expect(pts).toHaveLength(12);
        expect(pts.at(-1)).toEqual({ ym: "2026-06", invoiced: 100 });
        expect(pts.at(-2)).toEqual({ ym: "2026-05", invoiced: 50 });
    });
    test("trend compares the last three months with the three before", () => {
        const pt = (...v: number[]) => v.map((x, i) => ({ ym: `m${i}`, invoiced: x }));
        expect(trendOf(pt(100, 100, 100, 200, 200, 200)).direction).toBe("up");
        expect(trendOf(pt(200, 200, 200, 100, 100, 100)).direction).toBe("down");
        expect(trendOf(pt(100, 100, 100, 105, 105, 105)).direction).toBe("flat");
        expect(trendOf(pt(0, 0, 0, 0, 0, 0)).direction).toBe("none");
        expect(trendOf(pt(0, 0, 0, 100, 0, 0)).direction).toBe("up");
    });
});

/* =========================================================== rankings */

test.describe("portfolio rankings", () => {
    const invoices = [
        inv("1", "Big", { issued: -10, due: 20, total: 5000, pays: [[-5, 1000]] }),
        inv("2", "Mid", { issued: -10, due: 20, total: 3000 }),
        inv("3", "Small", { issued: -10, due: 20, total: 1000, pays: [[-5, 1000]] }),
        inv("4", "Euro", { issued: -10, due: 20, total: 9000, currency: "EUR" }),
        inv("5", "Draft", { issued: -10, due: 20, total: 99999, status: "draft" }),
    ];
    const d = dir([], invoices);

    test("top customers by revenue, per currency, with their share", () => {
        const top = topByRevenue(d, "USD", 5);
        expect(top.map((t) => t.record.name)).toEqual(["Big", "Mid", "Small"]);
        expect(top[0].share).toBeCloseTo(5000 / 9000, 10);
        expect(top.reduce((s, t) => s + t.share, 0)).toBeCloseTo(1, 10);
        expect(topByRevenue(d, "EUR").map((t) => t.record.name)).toEqual(["Euro"]);
    });
    test("customers with balances, largest first, excluding settled ones", () => {
        expect(withOutstanding(d, "USD").map((t) => [t.record.name, t.value])).toEqual([["Big", 4000], ["Mid", 3000]]);
    });
});

/* ============================================================ insights */

test.describe("rule-based insights", () => {
    const insightsOf = (invoices: InvoiceType[], quotes: Quotation[] = [], converted = new Map<string, string>(), name = "X") => {
        const d = dir([], invoices, quotes, converted);
        const r = rec(d, name);
        return customerInsights(r, documentsOf(r.key, invoices, quotes), { now: NOW, all: d });
    };
    const ids = (list: { id: string }[]) => list.map((i) => i.id);

    test("a customer with nothing recorded says so, and nothing else", () => {
        const d = buildDirectory([profile("X")], [], [], new Map(), NOW);
        expect(customerInsights(d[0], { invoices: [], quotations: [] }, { now: NOW })).toEqual([{ id: "noActivity", tone: "info", params: {} }]);
    });

    test("overdue invoices are reported with the real amount and how late", () => {
        const list = insightsOf([inv("1", "X", { issued: -90, due: -70, total: 800 }), inv("2", "X", { issued: -40, due: -10, total: 200 })]);
        const o = list.find((i) => i.id === "overdue")!;
        expect(o.params).toMatchObject({ count: 2, amount: 1000, currency: "USD", days: 70 });
        expect(o.tone).toBe("critical"); // more than 60 days late
    });
    test("a recent overdue is a warning, not critical", () => {
        const o = insightsOf([inv("1", "X", { issued: -40, due: -10, total: 200 })]).find((i) => i.id === "overdue")!;
        expect(o.tone).toBe("warning");
    });
    test("nothing owed means no overdue insight", () => {
        expect(ids(insightsOf([inv("1", "X", { issued: -40, due: -10, total: 200, pays: [[-12, 200]] })]))).not.toContain("overdue");
    });

    test("payment habits need a pattern, then say what it is", () => {
        const late = insightsOf([
            inv("1", "X", { issued: -90, due: -60, total: 10, pays: [[-50, 10]] }),
            inv("2", "X", { issued: -60, due: -30, total: 10, pays: [[-10, 10]] }),
        ]);
        expect(late.find((i) => i.id === "paysLate")!.params.days).toBe(15);
        const good = insightsOf([
            inv("1", "X", { issued: -90, due: -60, total: 10, pays: [[-65, 10]] }),
            inv("2", "X", { issued: -60, due: -30, total: 10, pays: [[-35, 10]] }),
        ]);
        expect(ids(good)).toContain("paysOnTime");
        expect(ids(good)).not.toContain("paysLate");
    });

    test("an accepted quotation that was never invoiced is flagged until it is converted", () => {
        const quotes = [quote("a", "QA", "accepted", "X", { total: 2500 })];
        const waiting = insightsOf([], quotes).find((i) => i.id === "acceptedNotInvoiced")!;
        expect(waiting.params).toMatchObject({ count: 1, number: "QA", amount: 2500, currency: "USD" });
        expect(ids(insightsOf([], quotes, new Map([["a", "INV-1"]])))).not.toContain("acceptedNotInvoiced");
    });
    test("quotations about to expire are flagged", () => {
        expect(insightsOf([], [quote("s", "QS", "sent", "X", { validIn: 3 })]).find((i) => i.id === "quotesExpiring")!.params.count).toBe(1);
        expect(ids(insightsOf([], [quote("s", "QS", "sent", "X", { validIn: 30 })]))).not.toContain("quotesExpiring");
    });
    test("going quiet is noticed only for customers with a rhythm", () => {
        const quiet = [-300, -270, -240, -210, -180].map((o, i) => inv(`D${i}`, "X", { issued: o, due: o + 30, total: 1, pays: [[o + 5, 1]] }));
        expect(insightsOf(quiet).find((i) => i.id === "dormant")!.params).toMatchObject({ days: 180, usual: 30 });
        expect(ids(insightsOf([inv("1", "X", { issued: -200, due: -170, total: 1, pays: [[-190, 1]] })]))).not.toContain("dormant");
    });
    test("a customer that dominates revenue is called out", () => {
        const invoices = [inv("1", "X", { issued: -5, due: 25, total: 8000 }), inv("2", "A", { issued: -5, due: 25, total: 1000 }), inv("3", "B", { issued: -5, due: 25, total: 1000 })];
        const share = insightsOf(invoices).find((i) => i.id === "largeShare")!;
        expect(share.params.percent).toBe(80);
    });
    test("the most urgent insights come first", () => {
        const list = insightsOf([inv("1", "X", { issued: -90, due: -70, total: 800 })], [quote("s", "QS", "sent", "X", { validIn: 3 })]);
        expect(list[0].tone).toBe("critical");
    });
});

/* ========================================================= duplicates */

test.describe("duplicate detection", () => {
    const id = (name: string, o: { email?: string; phone?: string; gstin?: string } = {}) => ({ key: `${name}|${o.email ?? ""}|${o.phone ?? ""}|${o.gstin ?? ""}`.toLowerCase(), name, email: o.email ?? "", phone: o.phone ?? "", gstin: o.gstin ?? "" });

    test("name normalisation ignores punctuation, case and company suffixes", () => {
        expect(normaliseName("Acme Pvt. Ltd.")).toBe("acme");
        expect(normaliseName("ACME Private Limited")).toBe("acme");
        expect(normaliseName("The Acme Co.")).toBe("acme");
        expect(editDistance("kitten", "sitting")).toBe(3);
    });

    test("each reason is detected", () => {
        const reasons = (a: ReturnType<typeof id>, b: ReturnType<typeof id>) => findPotentialDuplicates(a, [b])[0]?.reasons ?? [];
        expect(reasons(id("Acme", { email: "a@x.test" }), id("Acme Two", { email: "A@X.test" }))).toContain("email");
        expect(reasons(id("A", { gstin: gstin("27") }), id("B", { gstin: gstin("27").toLowerCase() }))).toContain("gstin");
        expect(reasons(id("A", { phone: "+91 98765 43210" }), id("B", { phone: "098765-43210" }))).toContain("phone");
        expect(reasons(id("Acme Pvt Ltd", { email: "a@x.test" }), id("Acme Limited", { email: "b@y.test" }))).toContain("name");
        expect(reasons(id("Globex Corporation", { email: "a@x.test" }), id("Globex Corporaton", { email: "b@y.test" }))).toContain("similarName");
    });

    test("genuinely different customers are not flagged", () => {
        const reasons = (a: ReturnType<typeof id>, b: ReturnType<typeof id>) => findPotentialDuplicates(a, [b])[0]?.reasons ?? [];
        expect(reasons(id("Acme", { email: "a@x.test", phone: "9876543210" }), id("Globex", { email: "g@y.test", phone: "9123456780" }))).toEqual([]);
        // short names are too easy to collide to call a typo
        expect(reasons(id("Ace", { email: "a@x.test" }), id("Ice", { email: "b@y.test" }))).toEqual([]);
        // blank fields never match each other
        expect(reasons(id("One"), id("Other"))).toEqual([]);
    });

    test("a customer is never a duplicate of itself", () => {
        const a = id("Acme", { email: "a@x.test" });
        expect(findPotentialDuplicates(a, [a], a.key)).toEqual([]);
    });

    test("groups are transitive and carry their reasons", () => {
        const groups = findDuplicateGroups([
            id("Acme Pvt Ltd", { email: "a@x.test", phone: "9876543210" }),
            id("Acme Limited", { email: "b@y.test", phone: "9876543210" }), // same phone as the first
            id("ACME", { email: "c@z.test" }), // same normalised name as both
            id("Globex", { email: "g@y.test" }),
        ]);
        expect(groups).toHaveLength(1);
        expect(groups[0].members.map((m) => m.name).sort()).toEqual(["ACME", "Acme Limited", "Acme Pvt Ltd"]);
        expect(groups[0].reasons).toEqual(expect.arrayContaining(["phone", "name"]));
    });

    test("directory records feed straight into detection", () => {
        const d = dir([profile("Acme Pvt Ltd", { email: "a@x.test" }), profile("Acme Ltd", { email: "b@y.test" }), profile("Other", { email: "o@z.test" })], []);
        expect(findDuplicateGroups(d.map(identityOf))).toHaveLength(1);
    });
});

/* ======================================================= allocation */

test.describe("payment allocation", () => {
    const invoices = [
        inv("B", "X", { issued: -30, due: 5, total: 300 }),
        inv("A", "X", { issued: -60, due: -20, total: 500, pays: [[-30, 100]] }), // 400 owed, oldest due
        inv("C", "X", { issued: -10, due: 20, total: 250 }),
        inv("E", "X", { issued: -10, due: -1, total: 90, currency: "EUR" }),
        inv("D", "X", { issued: -10, due: 20, total: 70, status: "draft" }),
    ];
    const open = openInvoicesOf(invoices, "USD");

    test("only issued invoices with a balance in the chosen currency are open, oldest due first", () => {
        expect(open.map((o) => [o.number, o.balance])).toEqual([["A", 400], ["B", 300], ["C", 250]]);
    });
    test("a payment settles the oldest first and spills over", () => {
        const r = allocatePayment(open, 550, { mode: "oldest" });
        expect(r).toEqual({ ok: true, allocations: [{ number: "A", amount: 400 }, { number: "B", amount: 150 }] });
    });
    test("allocations always add up to the payment, to the cent", () => {
        const o = [{ number: "1", currency: "USD", due: null, issued: null, balance: 33.33 }, { number: "2", currency: "USD", due: null, issued: null, balance: 33.34 }, { number: "3", currency: "USD", due: null, issued: null, balance: 33.33 }];
        const r = allocatePayment(o, 100, { mode: "oldest" });
        expect(r.ok && Math.round(r.allocations.reduce((s, a) => s + a.amount, 0) * 100)).toBe(10000);
    });
    test("a payment may be aimed at one invoice", () => {
        expect(allocatePayment(open, 100, { mode: "invoice", number: "C" })).toEqual({ ok: true, allocations: [{ number: "C", amount: 100 }] });
        expect(allocatePayment(open, 100, { mode: "invoice", number: "ZZ" })).toEqual({ ok: false, reason: "notFound" });
    });
    test("overpaying is refused rather than silently dropped", () => {
        expect(allocatePayment(open, 951, { mode: "oldest" })).toEqual({ ok: false, reason: "exceeds", owed: 950 });
        expect(allocatePayment(open, 401, { mode: "invoice", number: "A" })).toEqual({ ok: false, reason: "exceeds", owed: 400 });
        expect(allocatePayment(open, 950, { mode: "oldest" }).ok).toBe(true);
    });
    test("nonsense amounts and empty books are refused", () => {
        for (const bad of [0, -5, NaN]) expect(allocatePayment(open, bad, { mode: "oldest" })).toEqual({ ok: false, reason: "amount" });
        expect(allocatePayment([], 10, { mode: "oldest" })).toEqual({ ok: false, reason: "nothingOwed" });
    });
});

/* ========================================================= statements */

test.describe("account statements", () => {
    const KEY = "acme@example.com";
    const invoices = [
        inv("I1", "Acme", { issued: -90, due: -60, total: 1000, pays: [[-80, 400], [-30, 600]] }),
        inv("I2", "Acme", { issued: -40, due: -10, total: 500, pays: [[-5, 100]] }),
        inv("I3", "Acme", { issued: -10, due: 20, total: 250 }),
        inv("I4", "Acme", { issued: -35, due: -5, total: 777, status: "draft" }),
        inv("I5", "Acme", { issued: -35, due: -5, total: 888, status: "cancelled" }),
        inv("E1", "Acme", { issued: -20, due: 10, total: 99, currency: "EUR" }),
        inv("O1", "Other", { issued: -20, due: 10, total: 4242 }),
    ];
    const s = (o: Partial<Parameters<typeof buildStatement>[2]> = {}) => buildStatement(invoices, KEY, { currency: "USD", now: NOW, ...o });

    test("the whole history: every invoice and payment, with a running balance", () => {
        const st = s();
        expect(st.opening).toBe(0);
        expect(st.rows.map((r) => [r.ref, r.kind, r.debit || r.credit, r.balance])).toEqual([
            ["I1", "invoice", 1000, 1000],
            ["I1", "payment", 400, 600],
            ["I2", "invoice", 500, 1100],
            ["I1", "payment", 600, 500],
            ["I3", "invoice", 250, 750],
            ["I2", "payment", 100, 650],
        ]);
        expect(st.totals).toEqual({ invoiced: 1750, paid: 1100 });
        expect(st.closing).toBe(650);
    });

    test("drafts, cancelled invoices, other currencies and other customers are not in it", () => {
        const refs = s().rows.map((r) => r.ref);
        for (const no of ["I4", "I5", "E1", "O1"]) expect(refs).not.toContain(no);
        expect(buildStatement(invoices, KEY, { currency: "EUR", now: NOW }).closing).toBe(99);
        expect(ledgerCurrencies(invoices, KEY)).toEqual(["EUR", "USD"]);
    });

    test("closing = opening + invoiced - paid, always", () => {
        for (const from of [null, off(-100), off(-60), off(-35), off(-6), off(0)]) {
            const st = s({ from });
            expect(st.closing).toBeCloseTo(st.opening + st.totals.invoiced - st.totals.paid, 10);
        }
    });

    test("a date range starts from the correct opening balance", () => {
        const st = s({ from: off(-45), to: off(-1) });
        // before day -45: I1 invoiced 1000, paid 400 (day -80)  => 600
        expect(st.opening).toBe(600);
        expect(st.rows.map((r) => r.ref + ":" + r.kind)).toEqual(["I2:invoice", "I1:payment", "I3:invoice", "I2:payment"]);
        // 600 + 500 (I2) - 600 (I1 paid) + 250 (I3) - 100 (I2 paid)
        expect(st.closing).toBe(650);
        expect(st.from).toBe(ymd(-45));
        expect(st.to).toBe(ymd(-1));
    });

    test("the range is inclusive at both ends", () => {
        const onDay = s({ from: off(-40), to: off(-40) });
        expect(onDay.rows.map((r) => r.ref)).toEqual(["I2"]);
        expect(s({ from: off(-5), to: off(-5) }).rows.map((r) => r.ref + r.kind)).toEqual(["I2payment"]);
    });

    test("on one day the invoice comes before its payment, so the balance never dips below what was owed", () => {
        const same = [inv("S1", "Acme", { issued: -3, due: 27, total: 200, pays: [[-3, 200]] })];
        const st = buildStatement(same, KEY, { currency: "USD", now: NOW });
        expect(st.rows.map((r) => r.kind)).toEqual(["invoice", "payment"]);
        expect(st.rows.map((r) => r.balance)).toEqual([200, 0]);
    });

    test("later payments do not leak into an earlier statement", () => {
        const st = s({ to: off(-45) });
        // as at day -45: I1 invoiced (1000) and 400 paid; I2 (day -40) is not issued yet and
        // I1's second payment (day -30) has not happened
        expect(st.closing).toBe(600);
        expect(st.openItems.map((o) => [o.number, o.balance])).toEqual([["I1", 600]]);
        // and a day later, I2 is in
        expect(s({ to: off(-40) }).closing).toBe(1100);
    });

    test("open items and their sum agree with the closing balance (the identity)", () => {
        for (const to of [off(-85), off(-45), off(-20), off(0)]) {
            const st = s({ to });
            expect(st.openItems.reduce((sum, o) => sum + o.balance, 0)).toBeCloseTo(st.closing, 10);
        }
    });

    test("today's closing balance equals what the invoice list says is outstanding", () => {
        const owed = invoices.filter((i) => i.receiver.email === KEY && i.details.currency === "USD" && i.details.status === "sent").reduce((sum, i) => sum + balanceDue(i), 0);
        expect(s().closing).toBe(owed);
        expect(owed).toBe(650);
    });

    test("ageing buckets by days past due, as at the statement date", () => {
        const st = s();
        // I2: 400 owed, due day -10 => 10 days late (1-30). I3: 250, due +20 => current. I1 settled.
        expect(st.aging).toEqual({ current: 250, d1_30: 400, d31_60: 0, d61_90: 0, d90plus: 0 });
        const old = buildStatement([inv("X1", "Acme", { issued: -200, due: -170, total: 100 }), inv("X2", "Acme", { issued: -200, due: -100, total: 50 }), inv("X3", "Acme", { issued: -200, due: -70, total: 25 }), inv("X4", "Acme", { issued: -200, due: -40, total: 10 })], KEY, { currency: "USD", now: NOW });
        expect(old.aging).toEqual({ current: 0, d1_30: 0, d31_60: 10, d61_90: 25, d90plus: 150 });
    });

    test("a legacy 'paid' invoice with no payment rows is settled", () => {
        const legacy = inv("L1", "Acme", { issued: -30, due: -1, total: 300, status: "paid" });
        delete (legacy.details as { payments?: unknown }).payments;
        const st = buildStatement([legacy], KEY, { currency: "USD", now: NOW });
        expect(st.closing).toBe(0);
        expect(st.totals).toEqual({ invoiced: 300, paid: 300 });
    });

    test("with nothing to show, a statement is empty but well-formed", () => {
        const st = buildStatement([], KEY, { currency: "USD", now: NOW });
        expect(st).toMatchObject({ opening: 0, closing: 0, rows: [], openItems: [] });
    });

    test("randomised books: the identities hold for every range", () => {
        // A small deterministic PRNG so a failure is reproducible.
        let x = 123456789;
        const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
        for (let round = 0; round < 40; round++) {
            const books: InvoiceType[] = [];
            const n = 1 + Math.floor(rnd() * 6);
            for (let i = 0; i < n; i++) {
                const issued = -Math.floor(rnd() * 200);
                const total = Math.round((50 + rnd() * 2000) * 100) / 100;
                const pays: Pay[] = [];
                let left = total;
                for (let p = 0; p < Math.floor(rnd() * 4) && left > 0.01; p++) {
                    const when = Math.min(0, issued + Math.floor(rnd() * 120));
                    const amt = Math.min(left, Math.round((total * (0.1 + rnd() * 0.5)) * 100) / 100);
                    if (amt > 0) {
                        pays.push([when, amt]);
                        left = Math.round((left - amt) * 100) / 100;
                    }
                }
                books.push(inv(`R${round}-${i}`, "Acme", { issued, due: issued + 30, total, pays, status: rnd() < 0.15 ? "draft" : "sent" }));
            }
            const owed = books.filter((b) => b.details.status === "sent").reduce((sum, b) => sum + balanceDue(b), 0);
            const all = buildStatement(books, KEY, { currency: "USD", now: NOW });
            expect(all.closing).toBeCloseTo(owed, 6);
            expect(all.openItems.reduce((sum, o) => sum + o.balance, 0)).toBeCloseTo(owed, 6);
            // running balance ends where the closing balance says
            expect(all.rows.at(-1)?.balance ?? 0).toBeCloseTo(all.closing, 6);

            for (let k = 0; k < 5; k++) {
                const a = -Math.floor(rnd() * 220);
                const b = a + Math.floor(rnd() * 120);
                const st = buildStatement(books, KEY, { currency: "USD", from: off(a), to: off(Math.min(0, b)), now: NOW });
                expect(st.closing).toBeCloseTo(st.opening + st.totals.invoiced - st.totals.paid, 6);
                expect(st.openItems.reduce((sum, o) => sum + o.balance, 0)).toBeCloseTo(st.closing, 6);
            }
        }
    });

    test("preset ranges, including the April-March financial year", () => {
        const fy = (d: Date) => rangeFor("thisFy", d).from!;
        expect(fy(new Date(2026, 5, 15))).toEqual(new Date(2026, 3, 1)); // June → this April
        expect(fy(new Date(2026, 1, 10))).toEqual(new Date(2025, 3, 1)); // February → last April
        expect(fy(new Date(2026, 3, 1))).toEqual(new Date(2026, 3, 1)); // 1 April itself
        expect(rangeFor("all", NOW).from).toBeNull();
        expect(rangeFor("thisMonth", NOW).from).toEqual(new Date(2026, 5, 1));
        expect(rangeFor("last3", NOW).from).toEqual(new Date(2026, 3, 1));
        expect(startOfDay(rangeFor("thisYear", NOW).to)).toEqual(startOfDay(NOW));
    });

    test("the ledger is one source for the rows and the open items", () => {
        const entries = ledgerOf(invoices, KEY, "USD");
        expect(entries.filter((e) => e.kind === "invoice")).toHaveLength(3);
        expect(entries.reduce((sum, e) => sum + e.debit - e.credit, 0)).toBe(650);
    });
});

/* ============================================================ csv & pdf */

test.describe("statement exports", () => {
    const books = [inv("I1", "Acme", { issued: -30, due: 0, total: 1000, pays: [[-10, 400]] }), inv("I2", "Acme", { issued: -5, due: 25, total: 250 })];
    const st = buildStatement(books, "acme@example.com", { currency: "USD", now: NOW });

    test("CSV has an opening line, every row, and a closing line that matches", () => {
        const { csv, filename } = statementToCsv(st, "Acme Corp");
        const lines = csv.split("\r\n");
        expect(lines[0]).toBe('"Date","Type","Reference","Description","Debit","Credit","Balance","Currency"');
        expect(lines[1]).toContain("Opening balance");
        expect(lines).toHaveLength(2 + st.rows.length + 1);
        expect(lines.at(-1)).toContain("Closing balance");
        expect(lines.at(-1)).toContain(`"${st.closing}"`);
        expect(filename).toMatch(/^statement-Acme_Corp-USD-start_to_\d{4}-\d{2}-\d{2}\.csv$/);
    });

    test("the CSV carries the same numbers as the statement", () => {
        const body = statementToCsv(st, "Acme").csv;
        for (const r of st.rows) expect(body).toContain(`"${r.balance}"`);
    });

    test("spreadsheet formulas in descriptions are neutralised", () => {
        const evil = { ...st, rows: [{ ...st.rows[0], description: "=HYPERLINK(\"http://x\")" }] };
        expect(statementToCsv(evil, "A").csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    });

    const payload = (over: Record<string, unknown> = {}) => ({
        generatedAt: "2026-06-15",
        business: { name: "Sharma Traders", address: "12 MG Road", gstin: gstin("27") },
        customer: { name: "Acme" },
        statement: st,
        ...over,
    });

    test("the PDF payload schema accepts a real statement", () => {
        expect(StatementPayloadSchema.safeParse(payload()).success).toBe(true);
    });
    test("and refuses oversize, malformed and unsafe input", () => {
        expect(StatementPayloadSchema.safeParse(payload({ statement: { ...st, rows: Array(2001).fill(st.rows[0]) } })).success).toBe(false);
        expect(StatementPayloadSchema.safeParse(payload({ logo: "http://169.254.169.254/latest/meta-data" })).success).toBe(false);
        expect(StatementPayloadSchema.safeParse(payload({ logo: "data:image/png;base64,AAAA" })).success).toBe(true);
        expect(StatementPayloadSchema.safeParse(payload({ generatedAt: "yesterday" })).success).toBe(false);
        expect(StatementPayloadSchema.safeParse(payload({ statement: { ...st, closing: Infinity } })).success).toBe(false);
        expect(StatementPayloadSchema.safeParse(payload({ statement: { ...st, rows: [{ ...st.rows[0], kind: "refund" }] } })).success).toBe(false);
    });
    test("control characters are stripped from text", () => {
        const parsed = StatementPayloadSchema.parse(payload({ customer: { name: "Ac\u0000me‮" } }));
        expect(parsed.customer.name).toBe("Acme");
    });

    test("the business on a statement is whoever invoiced this customer most recently", () => {
        const a = inv("A", "Acme", { issued: -50, due: -20, total: 1 });
        const b = inv("B", "Acme", { issued: -5, due: 25, total: 1 });
        b.sender = { ...b.sender, name: "New Trading Name" };
        a.details.invoiceLogo = "data:image/png;base64,OLD";
        b.details.invoiceLogo = "data:image/png;base64,NEW";
        const picked = pickBusiness([a, b], "acme@example.com", []);
        expect(picked?.business.name).toBe("New Trading Name");
        expect(picked?.logo).toBe("data:image/png;base64,NEW");
        expect(pickBusiness([], "x", [{ name: "Saved Sender" } as InvoiceType["sender"]])?.business.name).toBe("Saved Sender");
        expect(pickBusiness([], "x", [])).toBeNull();
    });
});

/* ===================================================== import & export */

test.describe("customer import", () => {
    let n = 0;
    const plan = (csv: string, existing: SavedParty[] = [], strategy: "skip" | "update" = "skip") => planImport(csv, existing, strategy, { newId: () => `new-${++n}`, now: NOW });
    const ok = (p: ReturnType<typeof plan>) => {
        if (!p.ok) throw new Error(`plan failed: ${p.error}`);
        return p;
    };

    test("the CSV reader handles quotes, commas, newlines, CRLF and a BOM", () => {
        const t = parseCsv('﻿Name,Notes\r\n"Acme, Inc.","Line one\nLine two"\r\n"He said ""hi""",x\n\n');
        expect(t).toEqual([["Name", "Notes"], ["Acme, Inc.", "Line one\nLine two"], ['He said "hi"', "x"]]);
    });

    test("headers are matched by common aliases", () => {
        const m = mapColumns(["Customer Name", "E-mail", "Mobile", "Business Name", "PIN Code", "GST No", "Group", "Labels", "Active"]);
        expect(m).toMatchObject({ name: 0, phone: 2, company: 3, zipCode: 4, gstin: 5, category: 6, tags: 7, status: 8 });
        expect(mapColumns(["Name", "Email"]).email).toBe(1);
    });

    test("new customers are created with every field cleaned", () => {
        const p = ok(plan(`Name,Email,Phone,GSTIN,Category,Tags,Status,City\n"Acme Corp",BUYER@acme.test,555-0100,${gstin("27").toLowerCase()},Wholesale,"vip; north; VIP",Inactive,Mumbai`));
        expect(p.counts).toMatchObject({ new: 1, invalid: 0 });
        const row = p.rows[0].party!;
        expect(row).toMatchObject({ name: "Acme Corp", email: "BUYER@acme.test", gstin: gstin("27"), category: "Wholesale", tags: ["vip", "north"], inactive: true, city: "Mumbai" });
        expect(row.id).toMatch(/^new-/);
    });

    test("invalid rows are reported with the reason and are not imported", () => {
        const p = ok(plan(`Name,Email,GSTIN\nA,a@x.test,\nGood One,not-an-email,\nGood Two,g@x.test,27AAPFU0939F1ZA\n${"x".repeat(51)},,\nValid Co,v@x.test,`));
        expect(p.rows.map((r) => [r.line, r.outcome, r.issue])).toEqual([
            [2, "invalid", "name"],
            [3, "invalid", "email"],
            [4, "invalid", "gstin"],
            [5, "invalid", "nameTooLong"],
            [6, "new", undefined],
        ]);
        expect(p.result.map((r) => r.name)).toEqual(["Valid Co"]);
    });

    test("a customer already in the book is skipped by default and never duplicated", () => {
        const existing = [profile("Acme", { email: "a@x.test", phone: "111" })];
        const p = ok(plan("Name,Email,Phone\nAcme,A@X.test,999\nNewbie,n@x.test,", existing, "skip"));
        expect(p.counts).toMatchObject({ new: 1, skip: 1 });
        expect(p.result).toHaveLength(2);
        expect(p.result.find((r) => r.email === "a@x.test")!.phone).toBe("111"); // untouched
    });

    test("update fills in what the file knows and keeps what it leaves blank", () => {
        const existing = [profile("Acme", { email: "a@x.test", phone: "111", notes: "keep me", createdAt: "2020-01-01T00:00:00Z" })];
        const p = ok(plan("Name,Email,Phone,Category\nAcme,a@x.test,,Wholesale", existing, "update"));
        const u = p.result[0];
        expect(u).toMatchObject({ id: existing[0].id, phone: "111", notes: "keep me", category: "Wholesale", createdAt: "2020-01-01T00:00:00Z" });
        expect(p.counts.update).toBe(1);
        expect(p.result).toHaveLength(1);
    });

    test("the same customer twice in one file is imported once", () => {
        const p = ok(plan("Name,Email\nAcme,a@x.test\nAcme Again,A@X.TEST"));
        expect(p.counts).toMatchObject({ new: 1, duplicateInFile: 1 });
    });

    test("look-alikes are warned about, not merged", () => {
        const existing = [profile("Globex Corporation", { email: "g@y.test" })];
        const p = ok(plan("Name,Email\nGlobex Corporaton,new@z.test", existing));
        expect(p.counts).toMatchObject({ new: 1, similar: 1 });
        expect(p.rows[0].similar[0]).toMatchObject({ name: "Globex Corporation", reasons: ["similarName"] });
        expect(p.result).toHaveLength(2);
    });

    test("files that cannot be used are refused up front", () => {
        expect(plan("")).toEqual({ ok: false, error: "empty" });
        expect(plan("Name,Email\n")).toEqual({ ok: false, error: "empty" });
        expect(plan("Email,Phone\na@x.test,1")).toEqual({ ok: false, error: "noNameColumn" });
        expect(plan("Name\n" + Array(5001).fill("X Y").join("\n"))).toEqual({ ok: false, error: "tooManyRows" });
        expect(plan("x".repeat(6 * 1024 * 1024))).toEqual({ ok: false, error: "tooLarge" });
    });

    test("an export imports back to the same customers (round trip)", () => {
        const profiles = [
            profile("Acme Corp", { email: "buyer@acme.test", phone: "+91 98765 43210", gstin: gstin("27"), category: "Wholesale", tags: ["vip", "north"], company: "Acme Pvt Ltd", contactPerson: "Asha", website: "acme.test", notes: "Line one\nLine two, with comma", city: "Mumbai", address: "12 MG Road", zipCode: "400001", country: "India", shippingAddress: { address: "Dock 4", zipCode: "400002", city: "Pune", country: "India" } }),
            profile("Beta Ltd", { inactive: true }),
        ];
        const csv = customersToCsv(dir(profiles, []));
        const back = ok(plan(csv));
        expect(back.counts).toMatchObject({ new: 2, invalid: 0 });
        const a = back.result.find((r) => r.name === "Acme Corp")!;
        expect(a).toMatchObject({ email: "buyer@acme.test", phone: "+91 98765 43210", gstin: gstin("27"), category: "Wholesale", tags: ["vip", "north"], company: "Acme Pvt Ltd", contactPerson: "Asha", notes: "Line one\nLine two, with comma", city: "Mumbai", address: "12 MG Road", shippingAddress: { address: "Dock 4", city: "Pune" } });
        expect(back.result.find((r) => r.name === "Beta Ltd")!.inactive).toBe(true);
    });

    test("the export is safe to open in a spreadsheet and carries real balances", () => {
        const d = dir([profile("=cmd|' /C calc'!A0", { email: "e@x.test" }), profile("Acme", { email: "a@x.test" })], [inv("I1", "Acme", { email: "a@x.test", issued: -10, due: 20, total: 500, pays: [[-2, 200]] })]);
        const csv = customersToCsv(d);
        expect(csv).toContain(`"'=cmd|' /C calc'!A0"`);
        const acme = csv.split("\r\n").find((l) => l.startsWith('"Acme"'))!;
        expect(acme).toContain("$500.00"); // invoiced
        expect(acme).toContain("$300.00"); // outstanding
    });
});

/* ============================================================== store */

test.describe("customer records and invoices", () => {
    test("the new fields are normalised and bounded; old records load unchanged", () => {
        const p = normalise({ name: "Acme", company: "  Acme Pvt  ", category: "x".repeat(80), tags: ["a", "A", " b ", "", 5], inactive: true, contactPerson: "Asha", website: "acme.test" })!;
        expect(p.company).toBe("Acme Pvt");
        expect(p.category).toHaveLength(40);
        expect(p.tags).toEqual(["a", "b"]);
        expect(p.inactive).toBe(true);
        const old = normalise({ name: "Old Client", email: "o@x.test", phone: "1", address: "a", zipCode: "1", city: "c", country: "x" })!;
        expect(old.tags).toBeUndefined();
        expect(old.inactive).toBeUndefined();
        expect(old.category).toBeUndefined();
    });
    test("inactive is only ever true", () => {
        expect(normalise({ name: "A", inactive: false })!.inactive).toBeUndefined();
        expect(normalise({ name: "A", inactive: "yes" })!.inactive).toBeUndefined();
    });
    test("tags are trimmed, de-duplicated case-insensitively and capped", () => {
        expect(cleanTags("vip, VIP ; north|south")).toEqual(["vip", "north", "south"]);
        expect(cleanTags(Array.from({ length: 40 }, (_, i) => `t${i}`))).toHaveLength(20);
        expect(cleanTags(null)).toEqual([]);
    });
    test("relationship fields never travel onto an invoice or quotation", () => {
        const doc = toDocumentParty(profile("Acme", { notes: "private", category: "VIP", tags: ["x"], company: "C", inactive: true, gstin: gstin("27"), website: "w", contactPerson: "p" }));
        expect(Object.keys(doc).sort()).toEqual(["address", "city", "country", "customInputs", "email", "gstin", "name", "phone", "zipCode"]);
    });
});

/* =========================================================== timeline */

test.describe("activity timeline", () => {
    const events = (invoices: InvoiceType[], quotes: Quotation[] = [], p: SavedParty | null = null) =>
        timelineOf(p, { invoices, quotations: quotes }, NOW);

    test("every event is a recorded fact with its own date, newest first", () => {
        const list = events([inv("I1", "X", { issued: -30, due: 0, total: 500, pays: [[-10, 200]] })], [], profile("X", { createdAt: iso(-60) }));
        expect(list.map((e) => [e.kind, e.ref])).toEqual([
            ["payment", "I1"],
            ["invoiceIssued", "I1"],
            ["customerAdded", "X"],
        ]);
        expect(list[0].amount).toBe(200);
        expect(list.map((e) => e.at.getTime())).toEqual([...list.map((e) => e.at.getTime())].sort((a, b) => b - a));
    });

    test("an unpaid invoice becomes overdue the day after its due date, and only while unpaid", () => {
        const late = events([inv("I1", "X", { issued: -30, due: -10, total: 500 })]).find((e) => e.kind === "invoiceOverdue")!;
        expect(late.at.getTime()).toBe(off(-9).getTime());
        expect(late.amount).toBe(500);
        expect(events([inv("I1", "X", { issued: -30, due: -10, total: 500, pays: [[-12, 500]] })]).some((e) => e.kind === "invoiceOverdue")).toBe(false);
        expect(events([inv("I1", "X", { issued: -30, due: 10, total: 500 })]).some((e) => e.kind === "invoiceOverdue")).toBe(false);
    });

    test("drafts and cancelled invoices are not issued, so they leave no issue or payment events", () => {
        expect(events([inv("D", "X", { issued: -5, due: 25, total: 9, status: "draft" }), inv("C", "X", { issued: -5, due: 25, total: 9, status: "cancelled" })])).toEqual([]);
    });

    test("a conversion shows up even though the invoice it made is still a draft", () => {
        const draft = inv("INV-9", "X", { issued: -2, due: 28, total: 900, status: "draft" });
        draft.details.quotationRef = { id: "q1", number: "QUO-1" };
        const list = events([draft]);
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ kind: "quotationConverted", ref: "QUO-1", to: "INV-9", amount: 900 });
        // a cancelled conversion is not a live fact
        const cancelled = inv("INV-10", "X", { issued: -2, due: 28, total: 900, status: "cancelled" });
        cancelled.details.quotationRef = { id: "q2", number: "QUO-2" };
        expect(events([cancelled])).toEqual([]);
    });

    test("quotation events come from the quotation's own log; edits and drafts are not shown", () => {
        const q = quote("q", "QUO-1", "accepted", "X");
        q.events = [
            { at: iso(-20), kind: "created" },
            { at: iso(-19), kind: "edited" },
            { at: iso(-18), kind: "sent" },
            { at: iso(-17), kind: "draft" },
            { at: iso(-15), kind: "accepted" },
        ];
        expect(events([], [q]).map((e) => e.kind)).toEqual(["quotationAccepted", "quotationSent", "quotationCreated"]);
    });
});
