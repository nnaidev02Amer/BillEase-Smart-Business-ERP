import { test, expect } from "@playwright/test";

import { analyseBackup, findDuplicates, mergeInvoices } from "../lib/backup";
import { computeFinance } from "../lib/finance";
import {
    amountPaid,
    balanceDue,
    canRecordPayment,
    canTransition,
    displayStatus,
    duplicateOf,
    reminderCandidates,
    restoreRevision,
    runRecurring,
    withPayment,
    withRevision,
    withoutPayment,
} from "../lib/invoiceRecords";
import { incrementInvoiceNumber } from "../lib/invoiceNumber";
import { sniffImage } from "../lib/fileValidation";
import { InvoiceSchema, stripControlChars } from "../lib/schemas";
import { nextNumberFromScheme, sanitizeSettings, DEFAULT_SETTINGS } from "../lib/settings";
import { invoice, isoDay } from "./fixtures";
import type { InvoiceType } from "../types";

/** Pure-logic checks: no browser, no server. */

const NOW = new Date(2026, 5, 15, 12, 0, 0); // 15 June 2026
const at = (offset: number) => new Date(2026, 5, 15 + offset).toISOString();

const make = (number: string, total: number, o: Partial<{ status: string; issued: number; due: number; payments: { id: string; date: string; amount: number }[] }> = {}) => {
    const inv = invoice(number, "Acme Corp", "a@acme.test", total, { issued: o.issued ?? -10, due: o.due ?? 20, status: o.status, payments: o.payments });
    inv.details.invoiceDate = at(o.issued ?? -10);
    inv.details.dueDate = at(o.due ?? 20);
    return inv as unknown as InvoiceType;
};

test.describe("status model", () => {
    test("paid, partial and overdue are derived, never stored", () => {
        const sent = make("A", 100, { status: "sent" });
        expect(displayStatus(sent, NOW)).toBe("sent");

        const partial = make("B", 100, { status: "sent", payments: [{ id: "1", date: isoDay(-1), amount: 40 }] });
        expect(displayStatus(partial, NOW)).toBe("partial");
        expect(balanceDue(partial)).toBe(60);

        const paid = make("C", 100, { status: "sent", payments: [{ id: "1", date: isoDay(-1), amount: 100 }] });
        expect(displayStatus(paid, NOW)).toBe("paid");

        const overdue = make("D", 100, { status: "sent", due: -3 });
        expect(displayStatus(overdue, NOW)).toBe("overdue");

        // A part-paid invoice past due is overdue, but its balance is still correct.
        const lateAndPartial = make("E", 100, { status: "sent", due: -3, payments: [{ id: "1", date: isoDay(-5), amount: 30 }] });
        expect(displayStatus(lateAndPartial, NOW)).toBe("overdue");
        expect(balanceDue(lateAndPartial)).toBe(70);
    });

    test("drafts and cancelled invoices are never paid or overdue", () => {
        expect(displayStatus(make("A", 100, { status: "draft", due: -30 }), NOW)).toBe("draft");
        expect(displayStatus(make("B", 100, { status: "cancelled", due: -30 }), NOW)).toBe("cancelled");
    });

    test("invoices saved by the first dashboard still read correctly", () => {
        expect(displayStatus(make("A", 100, { status: "paid" }), NOW)).toBe("paid");
        expect(amountPaid(make("A", 100, { status: "paid" }))).toBe(100);
        expect(displayStatus(make("B", 100, { status: "pending", due: -2 }), NOW)).toBe("overdue");
        expect(displayStatus(make("C", 100, { status: undefined }), NOW)).toBe("sent");
    });

    test("transitions: only legitimate moves are allowed", () => {
        const draft = make("D", 100, { status: "draft" });
        expect(canTransition(draft, "sent").ok).toBe(true);
        expect(canTransition(draft, "cancelled").ok).toBe(true);

        const sent = make("S", 100, { status: "sent" });
        expect(canTransition(sent, "draft").ok).toBe(true);
        expect(canTransition(sent, "cancelled").ok).toBe(true);

        const paidSome = make("P", 100, { status: "sent", payments: [{ id: "1", date: isoDay(-1), amount: 10 }] });
        expect(canTransition(paidSome, "cancelled")).toEqual({ ok: false, reason: "hasPayments" });
        expect(canTransition(paidSome, "draft")).toEqual({ ok: false, reason: "hasPayments" });

        const cancelled = make("C", 100, { status: "cancelled" });
        expect(canTransition(cancelled, "draft").ok).toBe(true);
        expect(canTransition(cancelled, "sent")).toEqual({ ok: false, reason: "reopenFirst" });
    });

    test("payments: draft/cancelled refused, overpayment and bad dates refused", () => {
        const input = { amount: 50, date: isoDay(0) };
        expect(canRecordPayment(make("D", 100, { status: "draft" }), input, NOW)).toEqual({ ok: false, reason: "paymentOnDraft" });
        expect(canRecordPayment(make("C", 100, { status: "cancelled" }), input, NOW)).toEqual({ ok: false, reason: "paymentOnCancelled" });

        const sent = make("S", 100, { status: "sent", issued: -10 });
        const today = new Date(NOW).toISOString().slice(0, 10);
        expect(canRecordPayment(sent, { amount: 0, date: today }, NOW)).toEqual({ ok: false, reason: "amountInvalid" });
        expect(canRecordPayment(sent, { amount: -5, date: today }, NOW)).toEqual({ ok: false, reason: "amountInvalid" });
        expect(canRecordPayment(sent, { amount: 100.01, date: today }, NOW)).toEqual({ ok: false, reason: "overpayment" });
        expect(canRecordPayment(sent, { amount: 10, date: "nope" }, NOW)).toEqual({ ok: false, reason: "dateInvalid" });
        expect(canRecordPayment(sent, { amount: 10, date: "2026-06-20" }, NOW)).toEqual({ ok: false, reason: "dateFuture" });
        expect(canRecordPayment(sent, { amount: 10, date: "2026-05-01" }, NOW)).toEqual({ ok: false, reason: "dateBeforeIssue" });
        expect(canRecordPayment(sent, { amount: 100, date: today }, NOW).ok).toBe(true);
    });

    test("recording and removing payments moves the invoice between states", () => {
        let inv = make("S", 100, { status: "sent" });
        const a = withPayment(inv, { amount: 60, date: "2026-06-14" }, "p1", NOW);
        expect(a.ok).toBe(true);
        if (!a.ok) return;
        inv = a.invoice;
        expect(displayStatus(inv, NOW)).toBe("partial");

        // The remaining balance cannot be exceeded.
        const over = withPayment(inv, { amount: 41, date: "2026-06-14" }, "p2", NOW);
        expect(over.ok).toBe(false);

        const b = withPayment(inv, { amount: 40, date: "2026-06-14" }, "p2", NOW);
        if (!b.ok) throw new Error("expected ok");
        expect(displayStatus(b.invoice, NOW)).toBe("paid");

        // Removing a payment reopens the balance.
        const back = withoutPayment(b.invoice, "p2");
        expect(displayStatus(back, NOW)).toBe("partial");
        expect(balanceDue(back)).toBe(40);
    });

    test("removing a legacy paid invoice's payment really un-pays it", () => {
        const legacy = make("L", 100, { status: "paid" });
        const reopened = withoutPayment(legacy, "legacy-paid");
        expect(amountPaid(reopened)).toBe(0);
        expect(displayStatus(reopened, NOW)).toBe("sent");
    });
});

test.describe("duplicates, recurring and reminders", () => {
    test("a duplicate is a clean draft with a fresh number", () => {
        const src = make("INV-009", 100, { status: "sent", payments: [{ id: "1", date: isoDay(-1), amount: 100 }] });
        src.details.revisions = [{ id: "r", savedAt: at(-2), total: 90, snapshot: {} }];
        const copy = duplicateOf(src, ["INV-009", "INV-010"], incrementInvoiceNumber, NOW);
        expect(copy.details.invoiceNumber).toBe("INV-011");
        expect(copy.details.status).toBe("draft");
        expect(copy.details.payments).toBeUndefined();
        expect(copy.details.revisions).toBeUndefined();
        expect(displayStatus(copy, NOW)).toBe("draft");
        // The original is untouched.
        expect(src.details.payments).toHaveLength(1);
    });

    test("recurring catches up one draft per missed period, then stops", () => {
        const src = make("R-1", 100, { status: "sent", issued: -65, due: -35 });
        src.details.recurring = { frequency: "monthly", nextDate: "2026-04-10" };
        const { invoices, created } = runRecurring([src], incrementInvoiceNumber, NOW);
        // 10 Apr, 10 May and 10 Jun are all on or before 15 Jun.
        expect(created.map((c) => c.details.invoiceNumber)).toEqual(["R-2", "R-3", "R-4"]);
        expect(created.every((c) => c.details.status === "draft")).toBe(true);
        expect(created.every((c) => c.details.recurring?.sourceNumber === "R-1")).toBe(true);
        expect(invoices[0].details.recurring?.nextDate).toBe("2026-07-10");

        // Running again produces nothing.
        expect(runRecurring(invoices, incrementInvoiceNumber, NOW).created).toHaveLength(0);
    });

    test("recurring respects the end date and cancelled sources", () => {
        const src = make("R-1", 100, { status: "sent" });
        src.details.recurring = { frequency: "monthly", nextDate: "2026-03-10", endDate: "2026-04-30" };
        expect(runRecurring([src], incrementInvoiceNumber, NOW).created).toHaveLength(2); // Mar, Apr

        const cancelled = make("R-1", 100, { status: "cancelled" });
        cancelled.details.recurring = { frequency: "monthly", nextDate: "2026-03-10" };
        expect(runRecurring([cancelled], incrementInvoiceNumber, NOW).created).toHaveLength(0);
    });

    test("month-end schedules clamp instead of skipping a month", () => {
        const src = make("R-1", 100, { status: "sent" });
        src.details.recurring = { frequency: "monthly", nextDate: "2026-01-31" };
        const { invoices } = runRecurring([src], incrementInvoiceNumber, new Date(2026, 0, 31));
        expect(invoices[0].details.recurring?.nextDate).toBe("2026-02-28");
    });

    test("reminders: overdue first, then due soon; paid and drafts excluded", () => {
        const list = [
            make("OVER-LATE", 100, { status: "sent", due: -20 }),
            make("OVER-NEW", 100, { status: "sent", due: -2 }),
            make("SOON", 100, { status: "sent", due: 2 }),
            make("FAR", 100, { status: "sent", due: 30 }),
            make("DRAFT", 100, { status: "draft", due: -5 }),
            make("PAID", 100, { status: "sent", due: -5, payments: [{ id: "1", date: isoDay(-6), amount: 100 }] }),
        ];
        const r = reminderCandidates(list, NOW, 3);
        expect(r.map((x) => x.invoice.details.invoiceNumber)).toEqual(["OVER-LATE", "OVER-NEW", "SOON"]);
        expect(r[0]).toMatchObject({ kind: "overdue", days: 20 });
        expect(r[2]).toMatchObject({ kind: "dueSoon", days: 2 });
    });
});

test.describe("revisions", () => {
    test("a revision is recorded only when something changed, and restore keeps the books", () => {
        const v1 = make("V", 100, { status: "sent", payments: [{ id: "1", date: isoDay(-1), amount: 25 }] });
        const unchanged = withRevision(v1, JSON.parse(JSON.stringify(v1)), "r0", NOW);
        expect(unchanged.details.revisions ?? []).toHaveLength(0);

        const v2 = JSON.parse(JSON.stringify(v1)) as InvoiceType;
        v2.details.additionalNotes = "changed";
        const saved = withRevision(v1, v2, "r1", NOW);
        expect(saved.details.revisions).toHaveLength(1);

        const restored = restoreRevision(saved, saved.details.revisions![0]);
        expect(restored.details.additionalNotes).toBeUndefined();
        expect(restored.details.payments).toHaveLength(1);
        expect(restored.details.revisions).toHaveLength(1);
    });

    test("history is capped", () => {
        let inv = make("V", 100, { status: "sent" });
        for (let i = 0; i < 30; i++) {
            const next = JSON.parse(JSON.stringify(inv)) as InvoiceType;
            next.details.additionalNotes = `v${i}`;
            inv = withRevision(inv, next, `r${i}`, NOW);
        }
        expect(inv.details.revisions!.length).toBeLessThanOrEqual(15);
    });
});

test.describe("analytics", () => {
    const set = [
        make("A", 1000, { status: "paid", issued: -20, due: -5 }),
        make("B", 250, { issued: -40, due: -10 }),
        make("C", 500, { status: "sent", issued: -12, due: 28, payments: [{ id: "p", date: isoDay(-1), amount: 200 }] }),
        make("D", 300, { status: "draft" }),
    ];

    test("totals only count issued invoices and money received", () => {
        const r = computeFinance(set, { currency: "USD", year: 2026, now: NOW });
        expect(r.totals.invoiced).toBe(1750);
        expect(r.totals.collected).toBe(1200);
        expect(r.totals.outstanding).toBe(550);
        expect(r.totals.overdue).toBe(250);
        expect(r.totals.overdueCount).toBe(1);
        expect(r.totals.averageInvoice).toBe(583.33);
        expect(r.statusCounts.draft).toBe(1);
    });

    test("tax and discounts are pro-rated by what was actually charged and paid", () => {
        const inv = make("T", 1000, { status: "sent", payments: [{ id: "p", date: isoDay(-1), amount: 540 }] });
        Object.assign(inv.details, {
            discountDetails: { amount: 10, amountType: "percentage" },
            taxDetails: { amount: 20, amountType: "percentage", taxID: "" },
            totalAmount: 1080,
        });
        const r = computeFinance([inv], { currency: "USD", year: 2026, now: NOW });
        expect(r.totals.discounts).toBe(100);
        expect(r.totals.taxInvoiced).toBe(180);
        expect(r.totals.taxCollected).toBe(90); // half paid -> half the tax
    });

    test("currencies are never mixed", () => {
        const eur = make("E", 999, { status: "sent" });
        eur.details.currency = "EUR";
        const r = computeFinance([...set, eur], { currency: "USD", year: 2026, now: NOW });
        expect(r.totals.invoiced).toBe(1750);
        expect(computeFinance([eur], { currency: "EUR", year: 2026, now: NOW }).totals.invoiced).toBe(999);
    });

    test("payment trends measure days from issue to the final payment", () => {
        const inv = make("Q", 100, { status: "sent", issued: -10, due: 5, payments: [{ id: "p", date: isoDay(-4), amount: 100 }] });
        // Dates relative to the real clock, to match isoDay() above.
        inv.details.invoiceDate = new Date(Date.now() - 10 * 86_400_000).toISOString();
        inv.details.dueDate = new Date(Date.now() + 5 * 86_400_000).toISOString();
        const r = computeFinance([inv], { currency: "USD", year: new Date().getFullYear() });
        expect(r.trends.paidInvoiceCount).toBe(1);
        expect(r.trends.averageDaysToPay).toBe(6);
        expect(r.trends.onTimeRate).toBe(1);
    });

    test("growth is null (not infinity) when there is no previous period", () => {
        const r = computeFinance([make("A", 100, { status: "sent", payments: [{ id: "p", date: isoDay(0), amount: 100 }] })], { currency: "USD", year: 2026 });
        expect(r.growth.ytd.change === null || Number.isFinite(r.growth.ytd.change)).toBe(true);
    });
});

test.describe("numbering and settings", () => {
    test("custom scheme continues from the highest existing number", () => {
        const n = { ...DEFAULT_SETTINGS.numbering, mode: "custom" as const, prefix: "BE", separator: "-", padding: 3, start: 10 };
        expect(nextNumberFromScheme(n, [], NOW)).toBe("BE-010");
        expect(nextNumberFromScheme(n, [make("BE-010", 1), make("BE-014", 1), make("OTHER-99", 1)], NOW)).toBe("BE-015");
        // `start` is a floor, so use a low one to see the year-scoped continuation.
        expect(nextNumberFromScheme({ ...n, start: 1, includeYear: true }, [make("BE-2026-007", 1), make("BE-2025-099", 1)], NOW)).toBe("BE-2026-008");
    });

    test("settings from storage or a backup are clamped and cleaned", () => {
        const s = sanitizeSettings({
            numbering: { mode: "custom", prefix: "<script>x", separator: "!!!!", padding: 999, start: -5 },
            reminderLeadDays: 9999,
            defaultDueDays: "abc",
        });
        expect(s.numbering.prefix).toBe("scriptx");
        expect(s.numbering.padding).toBe(10);
        expect(s.numbering.start).toBe(0);
        expect(s.reminderLeadDays).toBe(60);
        expect(s.defaultDueDays).toBe(30);
        expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    });
});

test.describe("sanitising and uploads", () => {
    test("control and bidi-override characters are stripped, ordinary text is not", () => {
        expect(stripControlChars("Pay\u0000ment‮ gnp⁦")).toBe("Payment gnp");
        expect(stripControlChars("line1\nline2\tok")).toBe("line1\nline2\tok");
        expect(stripControlChars("Zoë — 日本語")).toBe("Zoë — 日本語");
    });

    test("the schema cleans new free-text fields and rejects oversized ones", () => {
        const base = make("S", 10) as unknown as Record<string, unknown>;
        const ok = InvoiceSchema.safeParse({
            ...base,
            details: { ...(base.details as object), terms: "No\u0000 refunds", theme: { headerText: "Hi‮" } },
        });
        expect(ok.success).toBe(true);
        if (ok.success) {
            expect(ok.data.details.terms).toBe("No refunds");
            expect(ok.data.details.theme?.headerText).toBe("Hi");
        }
        const tooLong = InvoiceSchema.safeParse({ ...base, details: { ...(base.details as object), terms: "x".repeat(2001) } });
        expect(tooLong.success).toBe(false);
    });

    test("images are recognised by their bytes, not their names", () => {
        expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
        expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
        expect(sniffImage(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39]))).toBe("image/gif");
        const webp = new Uint8Array(16);
        webp.set([0x52, 0x49, 0x46, 0x46], 0);
        webp.set([0x57, 0x45, 0x42, 0x50], 8);
        expect(sniffImage(webp)).toBe("image/webp");
        // An .exe renamed to .png is not an image.
        expect(sniffImage(new Uint8Array([0x4d, 0x5a, 0x90, 0x00]))).toBeNull();
    });
});

test.describe("backup validation", () => {
    test("rejects non-backups and oversized input before parsing", async () => {
        expect(await analyseBackup("{")).toEqual({ ok: false, error: "notJson" });
        expect(await analyseBackup("42")).toEqual({ ok: false, error: "unrecognised" });
        expect(await analyseBackup(JSON.stringify({ format: "invoify-backup", version: 99, data: {} }))).toEqual({ ok: false, error: "newerVersion" });
    });

    test("itemises invalid invoices instead of failing the whole file", async () => {
        const good = make("G", 100);
        const bad = { ...make("B", 100), receiver: { name: "x" } };
        const r = await analyseBackup(JSON.stringify({ invoices: [good, bad] }));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.data.invoices).toHaveLength(1);
        expect(r.issues).toHaveLength(1);
        expect(r.issues[0]).toMatchObject({ kind: "invoice", index: 2 });
        expect(r.checksum).toBe("missing");
    });

    test("duplicates are detected, and each strategy does what it says", () => {
        const a = make("INV-1", 100);
        const changed = JSON.parse(JSON.stringify(a)) as InvoiceType;
        changed.details.additionalNotes = "new";
        const fresh = make("INV-2", 50);

        const dups = findDuplicates([a], [a, changed, fresh]);
        expect(dups).toEqual([
            { number: "INV-1", identical: true },
            { number: "INV-1", identical: false },
        ]);

        expect(mergeInvoices([a], [changed, fresh], "skip", incrementInvoiceNumber)).toMatchObject({ added: 1, skipped: 1, overwritten: 0 });
        const over = mergeInvoices([a], [changed], "overwrite", incrementInvoiceNumber);
        expect(over).toMatchObject({ overwritten: 1 });
        expect(over.list[0].details.additionalNotes).toBe("new");
        const both = mergeInvoices([a], [changed], "keepBoth", incrementInvoiceNumber);
        expect(both.list.map((i) => i.details.invoiceNumber)).toEqual(["INV-1", "INV-2"]);
    });
});
