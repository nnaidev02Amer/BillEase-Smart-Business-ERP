import { GENERATE_PDF_API } from "@/lib/variables";
import type { InvoiceType } from "@/types";

/**
 * Renders a purchase order to a PDF through the same endpoint and templates as
 * invoices and quotations; `kind=purchaseOrder` only changes the wording (see
 * invoiceLabels). Throws on any non-PDF response rather than handing back an
 * error body that would be saved as a "PDF".
 *
 * Saving and opening the result reuse `downloadBlob` / `openBlobInTab` from
 * lib/quotationPdf; they are not specific to quotations.
 */
export async function fetchPurchaseOrderPdf(doc: InvoiceType, locale: string): Promise<Blob> {
    const response = await fetch(`${GENERATE_PDF_API}?locale=${encodeURIComponent(locale)}&kind=purchaseOrder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(doc),
    });
    if (!response.ok) {
        const err = new Error(`PDF generation failed with status ${response.status}`) as Error & { status?: number };
        err.status = response.status;
        throw err;
    }
    const blob = await response.blob();
    if (blob.size === 0 || blob.type !== "application/pdf") throw new Error("The server did not return a PDF");
    return blob;
}
