"use client";

import { useMemo } from "react";
import { useLocale } from "next-intl";

import GuardedLink from "@/app/components/layout/GuardedLink";
import { useQuotations } from "@/contexts/useQuotations";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { formatMoney } from "@/lib/invoiceRecords";
import { quotationStats } from "@/lib/quotations";

/**
 * Quotation pipeline at a glance, from the stored quotations only. The same
 * `quotationStats` as the Quotations page, so the two can never disagree.
 */
const QuotationsCard = ({ hideWhenEmpty = false }: { hideWhenEmpty?: boolean }) => {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const { quotations, converted, loaded } = useQuotations();
    const stats = useMemo(() => quotationStats(quotations, { converted }), [quotations, converted]);

    if (!loaded || (hideWhenEmpty && quotations.length === 0)) return null;

    const rate = stats.conversionRate;
    const tiles: [string, React.ReactNode, string][] = [
        [_t("quotations.metrics.total"), stats.total, "dq-total"],
        [_t("quotations.metrics.pending"), stats.pending, "dq-pending"],
        [_t("quotations.metrics.accepted"), stats.accepted, "dq-accepted"],
        [_t("quotations.metrics.rejected"), stats.rejected, "dq-rejected"],
    ];

    return (
        <section className="rounded-xl border bg-card p-4 shadow-sm sm:p-6" data-testid="dashboard-quotations">
            <div className="mb-4 flex items-center justify-between gap-2">
                <h2 className="text-base font-semibold">{_t("quotations.dashboard.title")}</h2>
                <GuardedLink href="/quotations" className="text-xs font-medium text-primary hover:underline">
                    {_t("quotations.dashboard.viewAll")}
                </GuardedLink>
            </div>

            {quotations.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">{_t("quotations.dashboard.empty")}</p>
            ) : (
                <>
                    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        {tiles.map(([label, value, id]) => (
                            <div key={id} className="rounded-lg bg-muted/40 p-3">
                                <dt className="text-xs text-muted-foreground">{label}</dt>
                                <dd className="mt-1 text-xl font-semibold tabular-nums" data-testid={id}>{value}</dd>
                            </div>
                        ))}
                    </dl>
                    <div className="mt-4 flex flex-wrap items-end justify-between gap-3 text-sm">
                        <div>
                            <p className="text-xs text-muted-foreground">{_t("quotations.metrics.rate")}</p>
                            <p className="text-lg font-semibold tabular-nums" data-testid="dq-rate">
                                {rate === null ? _t("quotations.metrics.none") : `${Math.round(rate * 100)}%`}
                            </p>
                        </div>
                        <div className="text-end">
                            <p className="text-xs text-muted-foreground">{_t("quotations.metrics.value")}</p>
                            {Object.entries(stats.value).filter(([, v]) => v > 0).map(([c, v]) => (
                                <p key={c} className="font-semibold tabular-nums">{formatMoney(v, c, locale)}</p>
                            ))}
                        </div>
                    </div>
                    {stats.expiringSoon > 0 && (
                        <p className="mt-3 text-xs text-amber-600 dark:text-amber-400" role="status" data-testid="dq-expiring">
                            {_t("quotations.dashboard.expiring", { count: stats.expiringSoon })}
                        </p>
                    )}
                </>
            )}
        </section>
    );
};

export default QuotationsCard;
