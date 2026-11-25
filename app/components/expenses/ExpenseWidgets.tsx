"use client";

import { useMemo, useState } from "react";
import { useLocale } from "next-intl";

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { useTranslationContext } from "@/contexts/TranslationContext";
import { isValidDay, toDay, type CategoryTotal } from "@/lib/expenses";
import { formatMoney } from "@/lib/invoiceRecords";
import { periodFor, type PeriodPreset } from "@/lib/profit";

export type PeriodChoice = PeriodPreset | "custom";
const PRESETS: PeriodPreset[] = ["all", "thisMonth", "lastMonth", "last3", "thisFy", "thisYear"];

/**
 * End of the period a preset names. The expense *list* runs to the end of the
 * month or year rather than to today, so a bill you have already entered for
 * later this month still shows up in "This month". The profit and loss report
 * stops at today instead (see `periodFor`): money that has not moved yet is not
 * cash flow.
 */
function listEnd(preset: PeriodPreset, now: Date): string {
    const y = now.getFullYear();
    const m = now.getMonth();
    switch (preset) {
        case "thisMonth":
        case "last3":
            return toDay(new Date(y, m + 1, 0));
        case "lastMonth":
            return toDay(new Date(y, m, 0));
        case "thisFy":
            return toDay(new Date(m >= 3 ? y + 1 : y, 2, 31));
        case "thisYear":
            return toDay(new Date(y, 11, 31));
        default:
            return "";
    }
}

/** A period choice: a preset or a custom pair of dates, and the range it means. */
export function usePeriod(initial: PeriodChoice, mode: "list" | "report") {
    const [choice, setChoice] = useState<PeriodChoice>(initial);
    const [from, setFrom] = useState("");
    const [to, setTo] = useState("");

    const range = useMemo(() => {
        const now = new Date();
        if (choice === "custom") return { from: isValidDay(from) ? from : "", to: isValidDay(to) ? to : "" };
        const p = periodFor(choice, now);
        if (mode === "list") return { from: p.from, to: listEnd(choice, now) };
        return p;
    }, [choice, from, to, mode]);

    const invalid = choice === "custom" && !!range.from && !!range.to && range.from > range.to;
    return { choice, setChoice, from, setFrom, to, setTo, range, invalid };
}

export function PeriodPicker({ period, testId = "period" }: { period: ReturnType<typeof usePeriod>; testId?: string }) {
    const { _t } = useTranslationContext();
    return (
        <div className="flex flex-wrap items-end gap-2" data-testid={testId}>
            <Select value={period.choice} onValueChange={(v) => period.setChoice(v as PeriodChoice)}>
                <SelectTrigger className="h-10 w-56" aria-label={_t("expenses.period.label")}>
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {PRESETS.map((p) => (
                        <SelectItem key={p} value={p}>{_t(`expenses.period.${p}`)}</SelectItem>
                    ))}
                    <SelectItem value="custom">{_t("expenses.period.custom")}</SelectItem>
                </SelectContent>
            </Select>
            {period.choice === "custom" && (
                <>
                    <label className="space-y-1 text-xs text-muted-foreground">
                        {_t("expenses.period.from")}
                        <Input type="date" value={period.from} max={period.to || undefined} onChange={(e) => period.setFrom(e.target.value)} className="h-10 w-40 text-foreground" data-testid="period-from" />
                    </label>
                    <label className="space-y-1 text-xs text-muted-foreground">
                        {_t("expenses.period.to")}
                        <Input type="date" value={period.to} min={period.from || undefined} onChange={(e) => period.setTo(e.target.value)} className="h-10 w-40 text-foreground" data-testid="period-to" />
                    </label>
                </>
            )}
        </div>
    );
}

/** Horizontal bars, largest first. The shares printed are the real shares and add up to 100%. */
export function CategoryBars({ rows, nameOf, currency, limit }: { rows: CategoryTotal[]; nameOf: (id: string) => string; currency: string; limit?: number }) {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const shown = limit ? rows.slice(0, limit) : rows;
    if (shown.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">{_t("expenses.noneInPeriod")}</p>;
    return (
        <ol className="space-y-3" data-testid="category-bars">
            {shown.map((r) => (
                <li key={r.category} data-testid="category-row" data-category={r.category}>
                    <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="min-w-0 truncate font-medium">{nameOf(r.category)}</span>
                        <span className="shrink-0 tabular-nums">{formatMoney(r.total, currency, locale)}</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                        <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(2, Math.round(r.share * 100))}%` }} />
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{_t("expenses.shareOf", { percent: Math.round(r.share * 100), count: r.count })}</p>
                </li>
            ))}
        </ol>
    );
}
