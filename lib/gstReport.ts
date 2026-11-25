/**
 * GST sales report (output tax), built from saved invoices only.
 *
 * Rules, stated once:
 *   - Only GST invoices that have been issued (status "sent", not draft or
 *     cancelled) are included, by invoice date.
 *   - One currency at a time; money is never added across currencies.
 *   - Figures are recomputed from each invoice's lines (gstOfInvoice), not read
 *     from stored derived fields.
 *   - This is the *output* tax side only. Input tax credit would need GST
 *     recorded on purchases/expenses, which this report does not cover.
 *   - It is a working summary to help prepare returns, not a GSTR filing.
 */

import { roundMoney } from "@/lib/calculations";
import { GST_STATES, gstOfInvoice, normaliseGstin, type HsnRow } from "@/lib/gst";
import { fetchCurrencyDetails } from "@/lib/helpers";
import { isoDay, parseDate, storedStatus, toCsv } from "@/lib/invoiceRecords";
import type { InvoiceType } from "@/types";

export type GstReportRow = {
    invoiceNumber: string;
    date: string;
    customer: string;
    customerGstin: string;
    placeOfSupply: string;
    supply: "intra" | "inter";
    taxable: number;
    cgst: number;
    sgst: number;
    igst: number;
    totalTax: number;
    total: number;
    reverseCharge: boolean;
};

export type SlabRow = { rate: number; taxable: number; cgst: number; sgst: number; igst: number; tax: number };

export type GstReport = {
    currency: string;
    from: string | null;
    to: string | null;
    rows: GstReportRow[];
    totals: { taxable: number; cgst: number; sgst: number; igst: number; totalTax: number; invoiced: number };
    /** Registered buyers (B2B) vs buyers without a GSTIN (B2C). */
    b2b: { count: number; taxable: number; tax: number };
    b2c: { count: number; taxable: number; tax: number };
    bySlab: SlabRow[];
    byHsn: HsnRow[];
    /** Issued GST invoices skipped because their place of supply / GSTIN is incomplete. */
    skipped: string[];
};

export type GstReportOptions = {
    currency: string;
    from?: Date | null;
    to?: Date | null;
};

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export function buildGstReport(invoices: InvoiceType[], { currency, from = null, to = null }: GstReportOptions): GstReport {
    const decimals = fetchCurrencyDetails(currency)?.decimals ?? 2;
    const r = (v: number) => roundMoney(v, decimals);

    const rows: GstReportRow[] = [];
    const skipped: string[] = [];
    const slabs = new Map<number, SlabRow>();
    const hsns = new Map<string, HsnRow>();
    const b2b = { count: 0, taxable: 0, tax: 0 };
    const b2c = { count: 0, taxable: 0, tax: 0 };

    for (const invoice of invoices) {
        const d = invoice.details;
        if (!d.gst?.enabled) continue;
        if ((d.currency || "USD") !== currency) continue;
        if (storedStatus(invoice) !== "sent") continue;

        const date = parseDate(d.invoiceDate);
        if (!date) continue;
        const t = dayStart(date);
        if (from && t < dayStart(from)) continue;
        if (to && t > dayStart(to)) continue;

        const gst = gstOfInvoice(invoice, decimals);
        if (!gst) {
            skipped.push(d.invoiceNumber);
            continue;
        }

        const buyerGstin = normaliseGstin(invoice.receiver.gstin);
        rows.push({
            invoiceNumber: d.invoiceNumber,
            date: isoDay(date),
            customer: invoice.receiver.name,
            customerGstin: buyerGstin,
            placeOfSupply: `${d.gst.placeOfSupply} – ${GST_STATES[d.gst.placeOfSupply ?? ""] ?? ""}`,
            supply: gst.supply,
            taxable: gst.taxableValue,
            cgst: gst.cgst,
            sgst: gst.sgst,
            igst: gst.igst,
            totalTax: gst.totalTax,
            total: gst.total,
            reverseCharge: d.gst.reverseCharge === true,
        });

        const bucket = buyerGstin ? b2b : b2c;
        bucket.count += 1;
        bucket.taxable = r(bucket.taxable + gst.taxableValue);
        bucket.tax = r(bucket.tax + gst.totalTax);

        for (const line of gst.lines) {
            const s = slabs.get(line.rate) ?? { rate: line.rate, taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0 };
            s.taxable = r(s.taxable + line.taxable);
            s.cgst = r(s.cgst + line.cgst);
            s.sgst = r(s.sgst + line.sgst);
            s.igst = r(s.igst + line.igst);
            s.tax = r(s.tax + line.tax);
            slabs.set(line.rate, s);
        }
        for (const h of gst.hsnSummary) {
            const key = `${h.hsn}|${h.rate}`;
            const row = hsns.get(key) ?? { ...h, quantity: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0 };
            row.quantity += h.quantity;
            row.taxable = r(row.taxable + h.taxable);
            row.cgst = r(row.cgst + h.cgst);
            row.sgst = r(row.sgst + h.sgst);
            row.igst = r(row.igst + h.igst);
            row.tax = r(row.tax + h.tax);
            hsns.set(key, row);
        }
    }

    rows.sort((a, b) => a.date.localeCompare(b.date) || a.invoiceNumber.localeCompare(b.invoiceNumber));
    const sum = (pick: (x: GstReportRow) => number) => r(rows.reduce((s, x) => s + pick(x), 0));

    return {
        currency,
        from: from ? isoDay(from) : null,
        to: to ? isoDay(to) : null,
        rows,
        totals: {
            taxable: sum((x) => x.taxable),
            cgst: sum((x) => x.cgst),
            sgst: sum((x) => x.sgst),
            igst: sum((x) => x.igst),
            totalTax: sum((x) => x.totalTax),
            invoiced: sum((x) => x.total),
        },
        b2b,
        b2c,
        bySlab: Array.from(slabs.values()).sort((a, b) => a.rate - b.rate),
        byHsn: Array.from(hsns.values()).sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate),
        skipped,
    };
}

export function gstReportCsv(report: GstReport): { filename: string; csv: string } {
    const range = report.from || report.to ? `${report.from ?? "start"}_to_${report.to ?? "now"}` : "all";
    return {
        filename: `gst-sales-${range}-${report.currency}.csv`,
        csv: toCsv(
            [
                "Invoice #",
                "Date",
                "Customer",
                "Customer GSTIN",
                "Place of supply",
                "Supply",
                "Taxable value",
                "CGST",
                "SGST",
                "IGST",
                "Total GST",
                "Invoice total",
                "Reverse charge",
                "Currency",
            ],
            report.rows.map((x) => [
                x.invoiceNumber,
                x.date,
                x.customer,
                x.customerGstin,
                x.placeOfSupply,
                x.supply === "intra" ? "Intra-state" : "Inter-state",
                x.taxable,
                x.cgst,
                x.sgst,
                x.igst,
                x.totalTax,
                x.total,
                x.reverseCharge ? "Yes" : "No",
                report.currency,
            ])
        ),
    };
}
