"use client";

import { useCallback } from "react";
import { useLocale } from "next-intl";

import { toast } from "@/components/ui/use-toast";

import { useInvoiceContext } from "@/contexts/InvoiceContext";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { numberOf, type Quotation, type StoredQuotationStatus } from "@/lib/quotations";
import { fetchQuotationPdf, downloadBlob, openBlobInTab, quotationFilename } from "@/lib/quotationPdf";
import { changeQuotationStatus, deleteQuotation } from "@/lib/quotationStore";

/**
 * Every action a quotation offers, in one place, so the list, the detail view
 * and the customer profile behave identically and report problems the same way.
 */
export function useQuotationActions(converted: Map<string, string>) {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const { convertQuotation, loadInvoice, savedInvoices } = useInvoiceContext();

    const fail = useCallback(
        (reason: string, message?: string) =>
            toast({
                variant: "destructive",
                title: _t(`quotations.errors.${reason}`, { message: message ?? "" }),
            }),
        [_t]
    );

    const setStatus = useCallback(
        async (q: Quotation, to: StoredQuotationStatus) => {
            const result = await changeQuotationStatus(q.id, to, converted);
            if (result.ok) {
                toast({ title: _t("quotations.toast.updated"), description: `${numberOf(q)}: ${_t(`quotations.status.${to}`)}` });
            } else {
                fail(result.reason);
            }
            return result.ok;
        },
        [converted, _t, fail]
    );

    const remove = useCallback(
        async (q: Quotation) => {
            const result = await deleteQuotation(q.id, converted);
            if (result.ok) toast({ title: _t("quotations.toast.deleted"), description: numberOf(q) });
            else fail(result.reason);
            return result.ok;
        },
        [converted, _t, fail]
    );

    const convert = useCallback(
        async (q: Quotation) => {
            const result = await convertQuotation(q.id);
            if (result.ok) {
                toast({
                    title: _t("quotations.toast.converted", { invoice: result.invoiceNumber }),
                    description: _t("quotations.toast.convertedBody"),
                });
            } else {
                fail(result.reason, result.message);
            }
            return result;
        },
        [convertQuotation, _t, fail]
    );

    const pdfFailed = useCallback(
        () => toast({ variant: "destructive", title: _t("quotations.toast.pdfFailed"), description: _t("quotations.toast.pdfFailedBody") }),
        [_t]
    );

    const download = useCallback(
        async (q: Quotation) => {
            try {
                downloadBlob(await fetchQuotationPdf(q.doc, locale), quotationFilename(numberOf(q)));
                return true;
            } catch (e) {
                console.error(e);
                pdfFailed();
                return false;
            }
        },
        [locale, pdfFailed]
    );

    const print = useCallback(
        async (q: Quotation) => {
            try {
                openBlobInTab(await fetchQuotationPdf(q.doc, locale));
                return true;
            } catch (e) {
                console.error(e);
                pdfFailed();
                return false;
            }
        },
        [locale, pdfFailed]
    );

    /** Opens the invoice made from a quotation in the invoice builder. */
    const openInvoice = useCallback(
        (invoiceNumber: string) => {
            const inv = savedInvoices.find((i) => i.details.invoiceNumber === invoiceNumber);
            if (inv) loadInvoice(inv);
        },
        [savedInvoices, loadInvoice]
    );

    return { setStatus, remove, convert, download, print, openInvoice, fail, pdfFailed };
}
