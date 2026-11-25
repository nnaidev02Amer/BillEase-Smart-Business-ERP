import { GENERATE_PDF_API } from "@/lib/variables";
import type { InvoiceType } from "@/types";

/**
 * Renders a quotation to a PDF through the same endpoint and templates as
 * invoices; `kind=quotation` only changes the wording (see invoiceLabels).
 * Throws on any non-PDF response rather than handing back an error body that
 * would be saved as a "PDF".
 */
export async function fetchQuotationPdf(doc: InvoiceType, locale: string): Promise<Blob> {
    const response = await fetch(`${GENERATE_PDF_API}?locale=${encodeURIComponent(locale)}&kind=quotation`, {
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

export function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoking synchronously can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Opens the PDF in a new tab, where the browser's viewer offers Print. */
export function openBlobInTab(blob: Blob): boolean {
    const url = URL.createObjectURL(blob);
    const win = window.open(url, "_blank");
    // The tab needs the URL for as long as it is open; a minute is ample to load it.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return win !== null;
}

/** A file name that is safe on every OS, from the quotation number. */
export const quotationFilename = (number: string) => `quotation-${number.replace(/[^\w.-]+/g, "_")}.pdf`;
