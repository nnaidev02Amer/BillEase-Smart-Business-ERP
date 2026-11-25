import React from "react";
import { NextRequest, NextResponse } from "next/server";

import { getMessages } from "@/i18n/messages";
import ProfitLossDocument from "@/app/components/templates/report/ProfitLossDocument";
import { buildReportLabels } from "@/app/components/templates/report/reportLabels";
import { PAPER_SIZES } from "@/app/components/templates/invoice-pdf/invoiceTheme";
import { PDF_TAILWIND_CSS } from "@/lib/pdfStyles.generated";
import { ReportPayloadSchema } from "@/lib/profit";
import { getClientKey, rateLimit } from "@/lib/server/rateLimit";
import { parseJsonBody } from "@/lib/server/validateRequest";
import { DEFAULT_LOCALE, LOCALES } from "@/lib/variables";
import { withPdfPage } from "@/services/invoice/server/pdfPage";

const resolveLocale = (requested: string | null) =>
    requested && LOCALES.some((l) => l.code === requested) ? requested : DEFAULT_LOCALE;

/**
 * Renders the profit and loss report to PDF: the same Chromium page, compiled
 * stylesheet and request validation as the invoice and statement routes.
 */
export async function generateReportPdfService(req: NextRequest) {
    const limited = rateLimit(`report:${getClientKey(req)}`, 30, 60_000);
    if (!limited.allowed) {
        return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } });
    }

    const parsed = await parseJsonBody(req, ReportPayloadSchema);
    if (!parsed.ok) return parsed.response;

    const locale = resolveLocale(req.nextUrl.searchParams.get("locale"));
    try {
        const ReactDOMServer = (await import("react-dom/server")).default;
        const messages = await getMessages(locale);
        const html = ReactDOMServer.renderToStaticMarkup(
            React.createElement(ProfitLossDocument, { payload: parsed.data, labels: buildReportLabels(messages), locale })
        );

        const paper = PAPER_SIZES.a4;
        const pdf = await withPdfPage(async (page) => {
            await page.setViewport({ ...paper.viewport, deviceScaleFactor: 1 });
            await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30000 });
            await page.addStyleTag({ content: PDF_TAILWIND_CSS });
            await page.evaluate(() => document.fonts.ready.then(() => undefined)).catch(() => undefined);
            return page.pdf({ format: paper.pdfFormat, printBackground: true, margin: { top: "0", right: "0", bottom: "0", left: "0" } });
        });

        return new NextResponse(pdf, {
            status: 200,
            headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": "inline; filename=profit-and-loss.pdf",
                "Content-Length": String(pdf.byteLength),
                "Cache-Control": "no-store",
            },
        });
    } catch (error) {
        console.error("Report PDF error:", error);
        return NextResponse.json({ error: "Failed to generate PDF" }, { status: 500 });
    }
}
