"use client";

import GuardedLink from "@/app/components/layout/GuardedLink";
import { useTranslationContext } from "@/contexts/TranslationContext";
import InvoicesPanel from "./InvoicesPanel";

const InvoicesPage = () => {
    const { _t } = useTranslationContext();
    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{_t("invoices.title")}</h1>
                    <p className="mt-1 text-sm text-muted-foreground">{_t("invoices.subtitle")}</p>
                </div>
                <GuardedLink
                    href="/"
                    className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    {_t("dashboard.newInvoice")}
                </GuardedLink>
            </div>
            <InvoicesPanel />
        </div>
    );
};

export default InvoicesPage;
