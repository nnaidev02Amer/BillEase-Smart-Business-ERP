"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useInvoiceContext } from "@/contexts/InvoiceContext";
import { conversionsOf, type Quotation } from "@/lib/quotations";
import { QUOTATIONS_EVENT, readQuotations } from "@/lib/quotationStore";

/**
 * The quotations, kept fresh, together with which of them have already been
 * turned into invoices (derived from the saved invoices, never stored).
 */
export function useQuotations() {
    const { savedInvoices, savedLoaded } = useInvoiceContext();
    const [quotations, setQuotations] = useState<Quotation[]>([]);
    const [loaded, setLoaded] = useState(false);

    const reload = useCallback(async () => {
        try {
            setQuotations(await readQuotations());
        } finally {
            setLoaded(true);
        }
    }, []);

    useEffect(() => {
        void reload();
        window.addEventListener(QUOTATIONS_EVENT, reload);
        return () => window.removeEventListener(QUOTATIONS_EVENT, reload);
    }, [reload]);

    const converted = useMemo(() => conversionsOf(savedInvoices), [savedInvoices]);

    return { quotations, converted, loaded: loaded && savedLoaded, reload };
}
