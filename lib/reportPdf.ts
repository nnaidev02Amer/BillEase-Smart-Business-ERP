import type { ExpenseSummary } from "@/lib/expenses";
import type { MonthRow, Pnl, ReportPayload } from "@/lib/profit";
import { downloadBlob, openBlobInTab } from "@/lib/quotationPdf";

export const REPORT_PDF_API = "/api/report/profit-loss";

export function reportPayload(args: {
    pnl: Pnl;
    summary: ExpenseSummary;
    months: MonthRow[];
    nameOf: (categoryId: string) => string;
    business: { name: string; gstin?: string };
    now?: Date;
}): ReportPayload {
    const d = args.now ?? new Date();
    return {
        generatedAt: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
        business: { name: args.business.name, ...(args.business.gstin ? { gstin: args.business.gstin } : {}) },
        pnl: args.pnl,
        categories: args.summary.byCategory.map((c) => ({ name: args.nameOf(c.category), total: c.total, count: c.count, share: c.share })),
        months: args.months.map((m) => ({
            ym: m.ym,
            revenue: m.revenue,
            collected: m.collected,
            // Money out of the business that month: expenses plus supplier payments, so the table adds up with net cash flow.
            expenses: Math.round((m.expenses + m.supplierPaid) * 100) / 100,
            estimatedProfit: m.estimatedProfit,
            netCashFlow: m.netCashFlow,
        })),
    };
}

/** Throws on any non-PDF response, so an error body is never saved as a "PDF". */
export async function fetchReportPdf(payload: ReportPayload, locale: string): Promise<Blob> {
    const response = await fetch(`${REPORT_PDF_API}?locale=${encodeURIComponent(locale)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Report PDF failed with status ${response.status}`);
    const blob = await response.blob();
    if (blob.size === 0 || blob.type !== "application/pdf") throw new Error("The server did not return a PDF");
    return blob;
}

export const reportFilename = (p: Pick<Pnl, "from" | "to" | "currency">) => `profit-and-loss-${p.from || "start"}_to_${p.to}-${p.currency}.pdf`;

export { downloadBlob, openBlobInTab };
