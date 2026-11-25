import type { Statement, StatementPayload } from "@/lib/statement";
import { downloadBlob, openBlobInTab } from "@/lib/quotationPdf";
import type { InvoiceType } from "@/types";

export const STATEMENT_PDF_API = "/api/statement/generate";

type Party = InvoiceType["receiver"];

/** What the PDF route needs: the statement plus who it is from and for. */
export function statementPayload(args: {
    statement: Statement;
    business: Party;
    logo?: string;
    customer: Party;
    now?: Date;
}): StatementPayload {
    const d = args.now ?? new Date();
    const pick = (p: Party) => ({
        name: p.name,
        address: p.address,
        zipCode: p.zipCode,
        city: p.city,
        country: p.country,
        email: p.email,
        phone: p.phone,
        ...(p.gstin ? { gstin: p.gstin } : {}),
    });
    return {
        generatedAt: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
        business: pick(args.business),
        ...(args.logo ? { logo: args.logo } : {}),
        customer: pick(args.customer),
        statement: args.statement,
    };
}

/** Throws on any non-PDF response, so an error body is never saved as a "PDF". */
export async function fetchStatementPdf(payload: StatementPayload, locale: string): Promise<Blob> {
    const response = await fetch(`${STATEMENT_PDF_API}?locale=${encodeURIComponent(locale)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Statement PDF failed with status ${response.status}`);
    const blob = await response.blob();
    if (blob.size === 0 || blob.type !== "application/pdf") throw new Error("The server did not return a PDF");
    return blob;
}

export const statementFilename = (customer: string, s: Statement) =>
    `statement-${customer.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "customer"}-${s.currency}-${s.from ?? "start"}_to_${s.to}.pdf`;

export { downloadBlob, openBlobInTab };
