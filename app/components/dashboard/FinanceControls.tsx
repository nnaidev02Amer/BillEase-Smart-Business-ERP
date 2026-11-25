"use client";

import { useMemo, useState } from "react";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { computeFinance, currenciesIn, yearsIn } from "@/lib/finance";
import type { InvoiceType } from "@/types";

/**
 * Money is never summed across currencies, so every financial view works on one
 * currency and one year at a time. This owns that choice and the report built
 * from it, so the dashboard and analytics agree.
 */
export function useFinanceView(invoices: InvoiceType[]) {
    const [pickedCurrency, setCurrency] = useState<string | null>(null);
    const [pickedYear, setYear] = useState<number | null>(null);

    const currencies = useMemo(() => currenciesIn(invoices), [invoices]);
    const years = useMemo(() => yearsIn(invoices), [invoices]);

    const currency = pickedCurrency && currencies.includes(pickedCurrency) ? pickedCurrency : currencies[0] ?? "USD";
    const year = pickedYear && years.includes(pickedYear) ? pickedYear : years[0] ?? new Date().getFullYear();

    const report = useMemo(() => computeFinance(invoices, { currency, year }), [invoices, currency, year]);

    return { currency, year, currencies, years, setCurrency, setYear, report };
}

export const FinanceControls = ({ view }: { view: ReturnType<typeof useFinanceView> }) => {
    const { _t } = useTranslationContext();
    return (
        <div className="flex flex-wrap items-center gap-2">
            {view.currencies.length > 1 && (
                <Select value={view.currency} onValueChange={view.setCurrency}>
                    <SelectTrigger className="h-9 w-28" aria-label={_t("finance.currency")}>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {view.currencies.map((c) => (
                            <SelectItem key={c} value={c}>
                                {c}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            )}
            <Select value={String(view.year)} onValueChange={(v) => view.setYear(Number(v))}>
                <SelectTrigger className="h-9 w-24" aria-label={_t("finance.year")}>
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {view.years.map((y) => (
                        <SelectItem key={y} value={String(y)}>
                            {y}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );
};
