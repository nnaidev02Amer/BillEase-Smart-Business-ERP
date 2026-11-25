import { test, expect } from "@playwright/test";

import { loadBundled } from "./bundle";
import { DEFAULT_REPORT_LABELS } from "../app/components/templates/report/reportLabels";
import { summariseExpenses } from "../lib/expenses";
import { profitAndLoss } from "../lib/profit";
import { sanitizePurchaseBill } from "../lib/purchaseBills";
import { reportPayload } from "../lib/reportPdf";
import enMessages from "../i18n/locales/en.json";

/**
 * Fix 3 (PDF half): the profit and loss report keeps what is owed to suppliers
 * under its own "Payables" heading, apart from receivables and from the cost
 * lines. The on-screen half is in payables.spec.ts. Pure logic: the document is
 * a plain function of its props, rendered exactly as the PDF route renders it.
 */

const SNAP = { name: "Acme Traders", gstin: "", state: "27", address: "", city: "", zipCode: "", country: "", email: "", phone: "" };
const bill = () =>
    sanitizePurchaseBill({
        id: "b1",
        number: "PB-0001",
        supplierBillNo: "INV/1",
        supplierId: "s1",
        supplier: SNAP,
        billDate: "2026-01-10",
        dueDate: "2026-02-09",
        currency: "INR",
        lines: [{ id: "l1", name: "Widget", description: "", hsn: "8471", unit: "pcs", quantity: 10, unitPrice: 100, taxRate: 18 }],
        discount: { type: "amount", value: 0 },
        freight: 0,
        gstEnabled: true,
        itcEligible: true,
        status: "posted",
    })!;

const opts = { currency: "INR", from: "2026-01-01", to: "2026-03-31" };

// Rendered the way the PDF route does: renderToStaticMarkup(createElement(ProfitLossDocument, { payload, labels, locale })).
const { renderReport } = loadBundled<{ renderReport: (payload: unknown, labels: unknown, locale: string) => string }>(`
    import React from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import ProfitLossDocument from "./app/components/templates/report/ProfitLossDocument";
    export const renderReport = (payload: any, labels: any, locale: string) =>
        renderToStaticMarkup(React.createElement(ProfitLossDocument, { payload, labels, locale }));
`);

const pdfHtml = (purchases?: { bills: ReturnType<typeof bill>[]; payments: never[] }, locale = "en") => {
    const pnl = profitAndLoss([], [], { ...opts, ...(purchases ? { purchases } : {}) });
    const payload = reportPayload({
        pnl,
        summary: summariseExpenses([], { currency: "INR", from: opts.from, to: opts.to }),
        months: [],
        nameOf: (id) => id,
        business: { name: "Acme Ltd" },
        now: new Date(2026, 3, 1),
    });
    return renderReport(payload, DEFAULT_REPORT_LABELS, locale);
};

const section = (html: string, testid: string) => new RegExp(`<p[^>]*>([^<]*)</p>\\s*<p[^>]*>[^<]*</p>\\s*<table[^>]*data-testid="${testid}"`).exec(html);

test.describe("profit and loss PDF: Payables", () => {
    test("with money owed, Payables is its own headed block with a note", () => {
        const html = pdfHtml({ bills: [bill()], payments: [] });
        expect(html).toContain('data-testid="report-payables"');
        const heading = section(html, "report-payables");
        expect(heading?.[1]).toBe("Payables");
        expect(html).toContain(DEFAULT_REPORT_LABELS.payablesNote);
    });

    test("the block shows what is owed and how much of it is overdue", () => {
        const html = pdfHtml({ bills: [bill()], payments: [] });
        const block = /data-testid="report-payables">(.*?)<\/table>/s.exec(html)![1];
        expect(block).toContain("Outstanding");
        expect(block).toContain("of which overdue");
        // 10 x 100 at 18% tax, due 9 Feb and unpaid at 31 Mar
        expect(block.match(/INR\s?1,180\.00/g)?.length).toBe(2);
    });

    test("it sits after Receivables and before the category table, never inside either", () => {
        const html = pdfHtml({ bills: [bill()], payments: [] });
        const at = (marker: string) => html.indexOf(marker);
        expect(at('data-testid="report-receivables"')).toBeGreaterThan(-1);
        expect(at('data-testid="report-payables"')).toBeGreaterThan(at('data-testid="report-receivables"'));
        expect(at('data-testid="report-categories"')).toBeGreaterThan(at('data-testid="report-payables"'));
        const receivables = /data-testid="report-receivables">(.*?)<\/table>/s.exec(html)![1];
        expect(receivables).not.toContain(DEFAULT_REPORT_LABELS.payables);
    });

    test("the heading is not the cost line, which keeps its own name", () => {
        const html = pdfHtml({ bills: [bill()], payments: [] });
        expect(DEFAULT_REPORT_LABELS.payables).toBe("Payables");
        expect(DEFAULT_REPORT_LABELS.purchaseCost).not.toBe(DEFAULT_REPORT_LABELS.payables);
        const cost = /data-testid="report-invoice">(.*?)<\/table>/s.exec(html)![1];
        expect(cost).not.toContain(">Payables<");
    });

    test("with nothing owed there is no Payables heading, block or note", () => {
        const html = pdfHtml();
        expect(html).not.toContain('data-testid="report-payables"');
        expect(html).not.toContain(DEFAULT_REPORT_LABELS.payablesNote);
        expect(html).not.toContain(">Payables<");
        // the receivables block is still there, unchanged
        expect(html).toContain('data-testid="report-receivables"');
    });

    test("a fully settled bill leaves no Payables block", () => {
        const b = bill();
        const paid = {
            id: "p1",
            number: "PAY-0001",
            supplierId: "s1",
            supplierName: "Acme Traders",
            date: "2026-01-20",
            currency: "INR",
            amount: 1180,
            method: "bank",
            allocations: [{ billId: b.id, amount: 1180 }],
            status: "posted",
        };
        const pnl = profitAndLoss([], [], { ...opts, purchases: { bills: [b], payments: [paid as never] } });
        expect(pnl.payables).toBe(0);
    });
});

test.describe("report labels", () => {
    test("every report label the document needs exists in English", () => {
        for (const key of ["payables", "payablesNote", "outstanding", "overdue", "receivables", "receivablesNote"] as const) {
            expect(typeof DEFAULT_REPORT_LABELS[key], key).toBe("string");
            expect(DEFAULT_REPORT_LABELS[key].length, key).toBeGreaterThan(0);
        }
    });

    test("the on-screen page and the PDF share the word 'Payables'", () => {
        expect(enMessages.payables.title).toBe("Payables");
        expect(enMessages.reportDocument.payables).toBe("Payables");
    });
});
