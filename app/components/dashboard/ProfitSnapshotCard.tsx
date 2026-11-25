"use client";

import { useMemo } from "react";
import { useLocale } from "next-intl";

import GuardedLink from "@/app/components/layout/GuardedLink";
import { InsightsList } from "@/app/components/clients/CrmWidgets";

import { useInvoiceContext } from "@/contexts/InvoiceContext";
import { useExpenses } from "@/contexts/useExpenses";
import { usePurchaseBills, useSupplierPayments } from "@/contexts/usePurchasing";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { summariseExpenses, toDay } from "@/lib/expenses";
import { formatMoney } from "@/lib/invoiceRecords";
import { pnlInsights, previousPeriod, profitAndLoss } from "@/lib/profit";

/**
 * Cash and profit for the dashboard's year, from the saved invoices and
 * expenses only. It uses the same `profitAndLoss` as the Profit & loss page,
 * so the two can never disagree, and it keeps the two bases apart: the cash
 * figures are money that moved, the profit figure is an estimate.
 */
const ProfitSnapshotCard = ({ currency, year, hideWhenEmpty = false }: { currency?: string; year: number; hideWhenEmpty?: boolean }) => {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const { savedInvoices } = useInvoiceContext();
    const { expenses, loaded, nameOf } = useExpenses();
    const { bills } = usePurchaseBills();
    const { payments } = useSupplierPayments();
    const purchases = useMemo(() => ({ bills, payments }), [bills, payments]);

    // Without invoices there is no dashboard currency; fall back to where expenses are.
    const cur = useMemo(() => {
        if (currency) return currency;
        const n = new Map<string, number>();
        for (const e of expenses) n.set(e.currency, (n.get(e.currency) ?? 0) + 1);
        return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "USD";
    }, [currency, expenses]);

    const now = new Date();
    const from = `${year}-01-01`;
    const to = year === now.getFullYear() ? toDay(now) : `${year}-12-31`;

    const data = useMemo(() => {
        const pnl = profitAndLoss(savedInvoices, expenses, { currency: cur, from, to, purchases });
        const summary = summariseExpenses(expenses, { currency: cur, from, to });
        const p = previousPeriod(from, to);
        const prev = p ? { expenses: summariseExpenses(expenses, { currency: cur, from: p.from, to: p.to }).total } : null;
        const insights = pnlInsights(pnl, summary, prev)
            .map((i) => (typeof i.params.category === "string" ? { ...i, params: { ...i.params, category: nameOf(i.params.category) } } : i))
            .slice(0, 2);
        return { pnl, summary, insights };
    }, [savedInvoices, expenses, cur, from, to, nameOf, purchases]);

    if (!loaded || (hideWhenEmpty && expenses.length === 0 && bills.length === 0)) return null;

    const { pnl, summary, insights } = data;
    const money = (v: number) => formatMoney(v, cur, locale);
    const top = summary.byCategory[0];

    const tiles: [string, string, string, string?][] = [
        [_t("profit.collected"), money(pnl.collected), "ps-collected"],
        [_t("profit.expensesPaid"), money(pnl.expenses + pnl.supplierPaid), "ps-expenses"],
        [_t("profit.netCash"), money(pnl.netCashFlow), "ps-netcash", pnl.netCashFlow < 0 ? "text-destructive" : "text-success"],
        [_t("profit.estimatedProfit"), money(pnl.estimatedProfit), "ps-profit", pnl.estimatedProfit < 0 ? "text-destructive" : ""],
    ];

    return (
        <section className="rounded-xl border bg-card p-4 shadow-sm sm:p-6" data-testid="profit-snapshot">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <div>
                    <h2 className="text-base font-semibold">{_t("profit.snapshot.title", { year })}</h2>
                    <p className="text-xs text-muted-foreground">{_t("profit.snapshot.sub", { currency: cur })}</p>
                </div>
                <div className="flex gap-3 text-xs font-medium">
                    <GuardedLink href="/profit-loss" className="text-primary hover:underline">{_t("profit.snapshot.report")}</GuardedLink>
                    <GuardedLink href="/expenses" className="text-primary hover:underline">{_t("profit.snapshot.expenses")}</GuardedLink>
                </div>
            </div>

            <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {tiles.map(([label, value, id, tone]) => (
                    <div key={id} className="min-w-0 rounded-lg bg-muted/40 p-3">
                        <dt className="text-xs text-muted-foreground">{label}</dt>
                        <dd className={`mt-1 break-words text-lg font-semibold tabular-nums ${tone ?? ""}`} data-testid={id}>{value}</dd>
                    </div>
                ))}
            </dl>

            {pnl.expenseCount === 0 ? (
                <p className="mt-4 text-sm text-muted-foreground" data-testid="ps-no-expenses">{_t("profit.snapshot.noExpenses")}</p>
            ) : (
                <>
                    {top && (
                        <p className="mt-4 text-sm" data-testid="ps-top">
                            <span className="text-muted-foreground">{_t("profit.snapshot.top")}: </span>
                            <span className="font-medium">{nameOf(top.category)}</span> · {money(top.total)} ({Math.round(top.share * 100)}%)
                        </p>
                    )}
                    {insights.length > 0 && (
                        <div className="mt-3">
                            <InsightsList insights={insights} prefix="profit.insights" />
                        </div>
                    )}
                </>
            )}
        </section>
    );
};

export default ProfitSnapshotCard;
