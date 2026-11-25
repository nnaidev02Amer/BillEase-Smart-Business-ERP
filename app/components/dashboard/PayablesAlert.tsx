"use client";

import { useMemo } from "react";
import { useLocale } from "next-intl";

import { buttonVariants } from "@/components/ui/button";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { usePurchaseBills, useSupplierPayments, useSuppliers } from "@/contexts/usePurchasing";
import { Link } from "@/i18n/navigation";
import { formatMoney } from "@/lib/invoiceRecords";
import { payablesSummary } from "@/lib/payables";
import { cn } from "@/lib/utils";

import { CheckCircle2, Wallet } from "lucide-react";

/**
 * Supplier bills that are overdue or fall due within a week. Shown only once
 * there is a bill, so someone who does not use purchasing sees nothing new. As
 * with invoice reminders there is no server to send anything in the background:
 * this is surfaced whenever the app is open.
 */
const PayablesAlert = () => {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const { suppliers, loaded: sLoaded } = useSuppliers();
    const { bills, loaded: bLoaded } = usePurchaseBills();
    const { payments, loaded: pLoaded } = useSupplierPayments();

    const rows = useMemo(() => payablesSummary(suppliers, bills, payments).filter((s) => s.overdue > 0 || s.dueSoon > 0), [suppliers, bills, payments]);
    const hasBills = bills.some((b) => b.status === "posted");

    if (!sLoaded || !bLoaded || !pLoaded || !hasBills) return null;
    const urgent = rows.some((r) => r.overdueCount > 0);

    return (
        <section aria-labelledby="payables-alert-heading" className="rounded-xl border bg-card p-4 shadow-sm sm:p-6" data-testid="payables-alert" data-urgent={urgent ? "true" : "false"}>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                    <Wallet className={cn("h-4 w-4", urgent ? "text-destructive" : "text-warning")} aria-hidden />
                    <h2 id="payables-alert-heading" className="text-base font-semibold">
                        {_t("payables.alert.title")}
                    </h2>
                </div>
                <Link prefetch={false} href="/payables" className={buttonVariants({ variant: "outline", size: "sm" })} data-testid="payables-alert-link">
                    {_t("payables.alert.cta")}
                </Link>
            </div>
            {rows.length === 0 ? (
                <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
                    {_t("payables.alert.none")}
                </p>
            ) : (
                <ul className="mt-3 space-y-1.5 text-sm">
                    {rows.map((r) => (
                        <li key={r.currency} className="space-y-1">
                            {r.overdueCount > 0 && (
                                <p className="font-medium text-destructive" data-testid="payables-alert-overdue">
                                    {_t("payables.alert.overdue", { count: r.overdueCount, amount: formatMoney(r.overdue, r.currency, locale) })}
                                </p>
                            )}
                            {r.dueSoonCount > 0 && (
                                <p className="text-muted-foreground" data-testid="payables-alert-soon">
                                    {_t("payables.alert.dueSoon", { count: r.dueSoonCount, amount: formatMoney(r.dueSoon, r.currency, locale) })}
                                </p>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
};

export default PayablesAlert;
