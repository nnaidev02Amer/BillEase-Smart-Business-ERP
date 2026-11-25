"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useInvoiceContext } from "@/contexts/InvoiceContext";
import { useQuotations } from "@/contexts/useQuotations";
import { buildDirectory, type CustomerRecord } from "@/lib/crm";
import { CUSTOMERS_EVENT, readParties, type SavedParty } from "@/lib/partyStore";

/**
 * Everyone you deal with, kept fresh: the address book, joined with what the
 * invoices and quotations say. Reloads whenever the address book changes (the
 * profile editor, an import, "save client" on an invoice).
 */
export function useCustomers() {
    const { savedInvoices, savedLoaded } = useInvoiceContext();
    const { quotations, converted, loaded: quotesLoaded } = useQuotations();
    const [profiles, setProfiles] = useState<SavedParty[] | null>(null);
    const [senders, setSenders] = useState<SavedParty[]>([]);

    const reload = useCallback(async () => {
        const [p, s] = await Promise.all([readParties("receiver"), readParties("sender")]);
        setProfiles(p);
        setSenders(s);
    }, []);

    useEffect(() => {
        void reload();
        window.addEventListener(CUSTOMERS_EVENT, reload);
        return () => window.removeEventListener(CUSTOMERS_EVENT, reload);
    }, [reload]);

    const records: CustomerRecord[] = useMemo(
        () => (profiles ? buildDirectory(profiles, savedInvoices, quotations, converted) : []),
        [profiles, savedInvoices, quotations, converted]
    );

    return {
        profiles: profiles ?? [],
        senders,
        records,
        invoices: savedInvoices,
        quotations,
        converted,
        loaded: profiles !== null && savedLoaded && quotesLoaded,
        reload,
    };
}
