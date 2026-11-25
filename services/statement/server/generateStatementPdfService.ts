import React from "react";
import { NextRequest, NextResponse } from "next/server";

import { getMessages } from "@/i18n/messages";
import { buildStatementLabels } from "@/app/components/templates/statement/statementLabels";
import StatementDocument from "@/app/components/templates/statement/StatementDocument";
import { StatementPayloadSchema } from "@/lib/statement";
import { getClientKey, rateLimit } from "@/lib/server/rateLimit";
import { parseJsonBody } from "@/lib/server/validateRequest";
import { PDF_TAILWIND_CSS } from "@/lib/pdfStyles.generated";
import { DEFAULT_LOCALE, LOCALES } from "@/lib/variables";

import { withPdfPage } from "@/services/invoice/server/pdfPage";
import { PAPER_SIZES } from "@/app/components/templates/invoice-pdf/invoiceTheme";

const resolveLocale = (requested: string | null) =>
    requested && LOCALES.some((l) => l.code === requested) ? requested : DEFAULT_LOCALE;

/**
 * Renders a customer account statement to PDF.
 *
 * Same machinery as the invoice route (the shared Chromium page, the compiled
 * stylesheet, no network at render time), and the same posture on input: the
 * body is size-capped and validated before anything is rendered.
 */
export async function generateStatementPdfService(req: NextRequest) {
    const limited = rateLimit(`statement:${getClientKey(req)}`, 30, 60_000);
    if (!limited.allowed) {
        return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } });
    }

    const parsed = await parseJsonBody(req, StatementPayloadSchema);
    if (!parsed.ok) return parsed.response;

    const locale = resolveLocale(req.nextUrl.searchParams.get("locale"));

    try {
        const ReactDOMServer = (await import("react-dom/server")).default;
        const messages = await getMessages(locale);
        const html = ReactDOMServer.renderToStaticMarkup(
            React.createElement(StatementDocument, { payload: parsed.data, labels: buildStatementLabels(messages), locale })
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
                "Content-Disposition": "inline; filename=statement.pdf",
                "Content-Length": String(pdf.byteLength),
                "Cache-Control": "no-store",
            },
        });
    } catch (error) {
        console.error("Statement PDF error:", error);
        return NextResponse.json({ error: "Failed to generate PDF" }, { status: 500 });
    }
}
