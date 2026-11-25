"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale } from "next-intl";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/use-toast";
import BaseButton from "@/app/components/reusables/BaseButton";
import GuardedLink from "@/app/components/layout/GuardedLink";
import { BarChart } from "@/app/components/dashboard/Charts";
import { InsightsList, Panel, StatCard } from "@/app/components/clients/CrmWidgets";

import { CategoryBars, PeriodPicker, usePeriod } from "./ExpenseWidgets";

import { useInvoiceContext } from "@/contexts/InvoiceContext";
import { useExpenses } from "@/contexts/useExpenses";
import { usePurchaseBills, useSupplierPayments } from "@/contexts/usePurchasing";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { currenciesOfExpenses, summariseExpenses } from "@/lib/expenses";
import { currenciesIn } from "@/lib/finance";
import { formatMoney } from "@/lib/invoiceRecords";
import { readParties, type SavedParty } from "@/lib/partyStore";
import { monthlySeries, pnlInsights, previousPeriod, profitAndLoss, profitLossCsv } from "@/lib/profit";
import { downloadBlob, fetchReportPdf, openBlobInTab, reportFilename, reportPayload } from "@/lib/reportPdf";
import { pickBusiness } from "@/lib/statement";

import { Download, FileSpreadsheet, Info, Plus, Printer, Receipt } from "lucide-react";

type Basis = "invoice" | "cash";

const Row = ({ id, label, value, strong = false, indent = false, tone }: { id: string; label: string; value: string; strong?: boolean; indent?: boolean; tone?: "good" | "bad" }) => (
    <tr className="border-t first:border-t-0" data-testid={`pl-${id}`}>
        <td className={`py-2 pe-3 ${indent ? "ps-5 text-muted-foreground" : ""} ${strong ? "font-semibold" : ""}`}>{label}</td>
        <td className={`py-2 text-end tabular-nums ${strong ? "font-semibold" : ""} ${tone === "good" ? "text-success" : tone === "bad" ? "text-destructive" : ""}`} data-testid={`pl-${id}-value`}>
            {value}
        </td>
    </tr>
);

const ProfitLossPage = () => {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const { savedInvoices, savedLoaded } = useInvoiceContext();
    const { expenses, loaded, nameOf } = useExpenses();
    const { bills: purchaseBills, loaded: billsLoaded } = usePurchaseBills();
    const { payments: supplierPayments, loaded: paymentsLoaded } = useSupplierPayments();
    // Supplier bills and payments join the report; manual expenses linked to a posted bill drop out of it.
    const purchases = useMemo(() => ({ bills: purchaseBills, payments: supplierPayments }), [purchaseBills, supplierPayments]);

    const period = usePeriod("thisFy", "report");
    const [basis, setBasis] = useState<Basis>("invoice");
    const [picked, setPicked] = useState<string | null>(null);
    const [senders, setSenders] = useState<SavedParty[]>([]);
    const [busy, setBusy] = useState<null | "pdf" | "print">(null);

    useEffect(() => {
        void readParties("sender").then(setSenders);
    }, []);

    // Money is never added across currencies, so the whole report is in one.
    const currencies = useMemo(() => [...new Set([...currenciesIn(savedInvoices), ...currenciesOfExpenses(expenses), ...purchaseBills.map((b) => b.currency), ...supplierPayments.map((p) => p.currency)])].sort(), [savedInvoices, expenses, purchaseBills, supplierPayments]);
    const busiest = useMemo(() => {
        const n = new Map<string, number>();
        for (const i of savedInvoices) n.set(i.details.currency || "USD", (n.get(i.details.currency || "USD") ?? 0) + 1);
        for (const e of expenses) n.set(e.currency, (n.get(e.currency) ?? 0) + 1);
        for (const b of purchaseBills) n.set(b.currency, (n.get(b.currency) ?? 0) + 1);
        for (const p of supplierPayments) n.set(p.currency, (n.get(p.currency) ?? 0) + 1);
        return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "USD";
    }, [savedInvoices, expenses, purchaseBills, supplierPayments]);
    const currency = picked && currencies.includes(picked) ? picked : busiest;

    const { from, to } = period.range;
    const opts = useMemo(() => ({ currency, from, to: to || undefined, purchases }), [currency, from, to, purchases]);

    const pnl = useMemo(() => profitAndLoss(savedInvoices, expenses, opts), [savedInvoices, expenses, opts]);
    const summary = useMemo(() => summariseExpenses(expenses, { currency, from, to: pnl.to }), [expenses, currency, from, pnl.to]);
    const months = useMemo(() => monthlySeries(savedInvoices, expenses, opts), [savedInvoices, expenses, opts]);
    const prev = useMemo(() => {
        const p = previousPeriod(from, pnl.to);
        return p ? { expenses: summariseExpenses(expenses, { currency, from: p.from, to: p.to }).total } : null;
    }, [expenses, currency, from, pnl.to]);
    const insights = useMemo(
        () => pnlInsights(pnl, summary, prev).map((i) => (typeof i.params.category === "string" ? { ...i, params: { ...i.params, category: nameOf(i.params.category) } } : i)),
        [pnl, summary, prev, nameOf]
    );

    const money = (v: number) => formatMoney(v, currency, locale);
    const day = (ymd: string) => {
        const [y, m, d] = ymd.split("-").map(Number);
        return new Date(y, m - 1, d).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
    };
    const monthLabel = (ym: string) => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5)) - 1, 1).toLocaleDateString(locale, { month: "short", year: "2-digit" });

    const business = useMemo(() => {
        const picked = pickBusiness(savedInvoices, "", senders);
        return { name: picked?.business.name || _t("profit.yourBusiness"), gstin: picked?.business.gstin };
    }, [savedInvoices, senders, _t]);

    const csv = () => {
        const { filename, csv: text } = profitLossCsv(pnl, summary, months, nameOf);
        downloadBlob(new Blob([text], { type: "text/csv;charset=utf-8" }), filename);
        toast({ title: _t("profit.csvReady"), description: filename });
    };

    const pdf = async (mode: "pdf" | "print") => {
        setBusy(mode);
        try {
            const blob = await fetchReportPdf(reportPayload({ pnl, summary, months, nameOf, business }), locale);
            if (mode === "pdf") {
                downloadBlob(blob, reportFilename(pnl));
                toast({ title: _t("profit.pdfReady") });
            } else openBlobInTab(blob);
        } catch (e) {
            console.error(e);
            toast({ variant: "destructive", title: _t("profit.pdfFailed"), description: _t("profit.pdfFailedBody") });
        } finally {
            setBusy(null);
        }
    };

    if (!loaded || !savedLoaded || !billsLoaded || !paymentsLoaded) return <Skeleton className="h-96 rounded-xl" aria-busy="true" />;

    const empty = savedInvoices.length === 0 && expenses.length === 0 && purchaseBills.length === 0 && supplierPayments.length === 0;
    const profitTone = pnl.estimatedProfit >= 0 ? "text-success" : "text-destructive";
    const cashTone = pnl.netCashFlow >= 0 ? "text-success" : "text-destructive";

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{_t("profit.title")}</h1>
                    <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{_t("profit.subtitle")}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <BaseButton variant="outline" onClick={() => pdf("print")} loading={busy === "print"} disabled={busy !== null || period.invalid || empty} data-testid="report-print">
                        <Printer className="h-4 w-4" />
                        {_t("profit.print")}
                    </BaseButton>
                    <BaseButton variant="outline" onClick={csv} disabled={period.invalid || empty} data-testid="report-csv">
                        <FileSpreadsheet className="h-4 w-4" />
                        CSV
                    </BaseButton>
                    <BaseButton onClick={() => pdf("pdf")} loading={busy === "pdf"} disabled={busy !== null || period.invalid || empty} data-testid="report-pdf">
                        <Download className="h-4 w-4" />
                        PDF
                    </BaseButton>
                </div>
            </div>

            {empty ? (
                <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center" data-testid="profit-empty">
                    <div className="rounded-full bg-primary/10 p-4 text-primary">
                        <Receipt className="h-8 w-8" aria-hidden />
                    </div>
                    <h2 className="text-lg font-semibold">{_t("profit.empty.title")}</h2>
                    <p className="max-w-md text-sm text-muted-foreground">{_t("profit.empty.body")}</p>
                    <GuardedLink href="/expenses" className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">
                        <Plus className="h-4 w-4" aria-hidden />
                        {_t("profit.empty.cta")}
                    </GuardedLink>
                </div>
            ) : (
                <>
                    <div className="flex flex-wrap items-end gap-3">
                        <PeriodPicker period={period} />
                        {currencies.length > 1 && (
                            <Select value={currency} onValueChange={setPicked}>
                                <SelectTrigger className="h-10 w-28" aria-label={_t("profit.currency")}><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {currencies.map((c) => (
                                        <SelectItem key={c} value={c}>{c}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        )}
                        <p className="text-xs text-muted-foreground" data-testid="period-summary">
                            {from ? _t("profit.periodRange", { from: day(from), to: day(pnl.to) }) : _t("profit.periodAll", { to: day(pnl.to) })}
                            {currencies.length > 1 ? ` · ${_t("expenses.neverMixed")}` : ""}
                        </p>
                    </div>
                    {period.invalid && <p role="alert" className="text-sm text-destructive">{_t("expenses.period.badRange")}</p>}

                    <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm" role="note" data-testid="basis-note">
                        <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                        <p>{_t("profit.basisNote")}</p>
                    </div>

                    <div className="grid gap-6 xl:grid-cols-2">
                        <section aria-labelledby="cash-h" className="space-y-3" data-testid="cash-basis">
                            <div>
                                <h2 id="cash-h" className="text-base font-semibold">{_t("profit.cash.title")}</h2>
                                <p className="text-xs text-muted-foreground">{_t("profit.cash.note")}</p>
                            </div>
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                                <StatCard testId="k-collected" label={_t("profit.collected")} value={money(pnl.collected)} sub={_t("profit.collectedHint")} />
                                <StatCard testId="k-expenses" label={_t("profit.expensesPaid")} value={money(pnl.expenses)} sub={_t("profit.expenseCount", { count: pnl.expenseCount })} />
                                <StatCard testId="k-netcash" label={_t("profit.netCash")} value={money(pnl.netCashFlow)} tone={cashTone} sub={pnl.netCashFlow >= 0 ? _t("profit.cashIn") : _t("profit.cashOut")} />
                            </div>
                        </section>

                        <section aria-labelledby="inv-h" className="space-y-3" data-testid="invoice-basis">
                            <div>
                                <h2 id="inv-h" className="text-base font-semibold">{_t("profit.invoice.title")}</h2>
                                <p className="text-xs text-muted-foreground">{_t("profit.invoice.note")}</p>
                            </div>
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                                <StatCard testId="k-invoiced" label={_t("profit.invoiced")} value={money(pnl.invoiced)} sub={_t("profit.invoicedHint", { count: pnl.issuedCount })} />
                                <StatCard testId="k-revenue" label={_t("profit.revenue")} value={money(pnl.revenue)} sub={_t("profit.revenueHint", { tax: money(pnl.invoicedTax) })} />
                                <StatCard testId="k-profit" label={_t("profit.estimatedProfit")} value={money(pnl.estimatedProfit)} tone={profitTone} sub={pnl.margin === null ? undefined : _t("profit.margin", { percent: Math.round(pnl.margin * 100) })} />
                            </div>
                        </section>
                    </div>

                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 lg:max-w-xl" data-testid="receivables">
                        <StatCard testId="k-outstanding" label={_t("profit.outstanding")} value={money(pnl.outstanding)} sub={_t("profit.outstandingHint")} />
                        <StatCard testId="k-overdue" label={_t("profit.overdue")} value={money(pnl.overdue)} tone={pnl.overdue > 0 ? "text-destructive" : ""} sub={_t("profit.overdueHint")} />
                    </div>

                    <Panel title={_t("profit.statement")} testId="pl-statement">
                        <div className="overflow-x-auto">
                            <table className="w-full min-w-[18rem] text-sm">
                                <caption className="sr-only">{_t("profit.statement")}</caption>
                                <tbody>
                                    <tr><th colSpan={2} className="pb-1 pt-1 text-start text-xs font-semibold uppercase tracking-wide text-muted-foreground">{_t("profit.invoice.title")}</th></tr>
                                    <Row id="invoiced" label={_t("profit.lines.invoiced")} value={money(pnl.invoiced)} />
                                    <Row id="invoiced-tax" label={_t("profit.lines.lessTax")} value={money(-pnl.invoicedTax)} indent />
                                    <Row id="revenue" label={_t("profit.lines.revenue")} value={money(pnl.revenue)} strong />
                                    <Row id="exp-total" label={_t("profit.lines.expenses")} value={money(pnl.expenses)} />
                                    <Row id="exp-recoverable" label={_t("profit.lines.lessRecoverable")} value={money(-pnl.recoverableTax)} indent />
                                    <Row id="cost" label={_t("profit.lines.cost")} value={money(pnl.expensesNet)} strong />
                                    {pnl.purchaseCount > 0 && (
                                        <>
                                            <Row id="purchases" label={_t("profit.lines.purchases")} value={money(pnl.purchases)} />
                                            <Row id="purchases-claimable" label={_t("profit.lines.lessClaimable")} value={money(-pnl.purchasesRecoverableTax)} indent />
                                            <Row id="purchase-cost" label={_t("profit.lines.purchaseCost")} value={money(pnl.purchasesNet)} strong />
                                        </>
                                    )}
                                    <Row id="profit" label={_t("profit.lines.estimatedProfit")} value={money(pnl.estimatedProfit)} strong tone={pnl.estimatedProfit >= 0 ? "good" : "bad"} />
                                    <tr><th colSpan={2} className="pb-1 pt-5 text-start text-xs font-semibold uppercase tracking-wide text-muted-foreground">{_t("profit.cash.title")}</th></tr>
                                    <Row id="collected" label={_t("profit.lines.collected")} value={money(pnl.collected)} />
                                    <Row id="paid" label={_t("profit.lines.expensesPaid")} value={money(pnl.expenses)} />
                                    {pnl.supplierPaid > 0 && <Row id="paid-suppliers" label={_t("profit.lines.paidSuppliers")} value={money(pnl.supplierPaid)} />}
                                    <Row id="netcash" label={_t("profit.lines.netCash")} value={money(pnl.netCashFlow)} strong tone={pnl.netCashFlow >= 0 ? "good" : "bad"} />
                                    <tr><th colSpan={2} className="pb-1 pt-5 text-start text-xs font-semibold uppercase tracking-wide text-muted-foreground">{_t("profit.receivables")}</th></tr>
                                    <Row id="outstanding" label={_t("profit.lines.outstanding")} value={money(pnl.outstanding)} />
                                    <Row id="overdue" label={_t("profit.lines.overdue")} value={money(pnl.overdue)} indent />
                                    {pnl.payables > 0 && (
                                        <>
                                            <tr><th colSpan={2} className="pb-1 pt-5 text-start text-xs font-semibold uppercase tracking-wide text-muted-foreground">{_t("payables.title")}</th></tr>
                                            <Row id="payables" label={_t("profit.lines.payables")} value={money(pnl.payables)} />
                                            <Row id="payables-overdue" label={_t("profit.lines.payablesOverdue")} value={money(pnl.payablesOverdue)} indent />
                                        </>
                                    )}
                                </tbody>
                            </table>
                        </div>
                        <p className="mt-3 text-xs text-muted-foreground">{_t("profit.definitions")}</p>
                        {pnl.linkedExpenses > 0 && (
                            <p className="mt-1 text-xs text-muted-foreground" data-testid="linked-note">
                                {_t("profit.linkedNote", { count: pnl.linkedExpenses })}
                            </p>
                        )}
                    </Panel>

                    <div className="grid gap-6 xl:grid-cols-2">
                        <Panel
                            title={_t("profit.monthly")}
                            testId="monthly"
                            action={
                                <div className="flex rounded-md border p-0.5 text-xs" role="group" aria-label={_t("profit.basis")}>
                                    {(["invoice", "cash"] as const).map((b) => (
                                        <button
                                            key={b}
                                            type="button"
                                            onClick={() => setBasis(b)}
                                            aria-pressed={basis === b}
                                            data-testid={`basis-${b}`}
                                            className={`rounded px-2.5 py-1 font-medium transition-colors ${basis === b ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                                        >
                                            {_t(`profit.basisOptions.${b}`)}
                                        </button>
                                    ))}
                                </div>
                            }
                        >
                            <BarChart
                                ariaLabel={_t("profit.monthly")}
                                format={(v) => money(v)}
                                series={
                                    basis === "invoice"
                                        ? [{ name: _t("profit.revenue"), color: "hsl(var(--primary))" }, { name: _t("profit.lines.cost"), color: "hsl(var(--destructive) / 0.7)" }]
                                        : [{ name: _t("profit.collected"), color: "hsl(var(--primary))" }, { name: _t("profit.expensesPaid"), color: "hsl(var(--destructive) / 0.7)" }]
                                }
                                data={months.map((m) => {
                                    const a = basis === "invoice" ? m.revenue : m.collected;
                                    // Cost includes supplier bills (less claimable tax); cash out includes supplier payments.
                                    const b = basis === "invoice" ? m.expensesNet + m.purchasesNet : m.expenses + m.supplierPaid;
                                    return { label: monthLabel(m.ym), values: [a, b], title: `${monthLabel(m.ym)}: ${money(a)} / ${money(b)}` };
                                })}
                            />
                            <p className="mt-2 text-xs text-muted-foreground" data-testid="monthly-note">{basis === "invoice" ? _t("profit.monthlyInvoiceNote") : _t("profit.monthlyCashNote")}</p>
                        </Panel>

                        <Panel title={_t("profit.byCategory")} testId="pl-categories" action={<GuardedLink href="/expenses" className="text-xs font-medium text-primary hover:underline">{_t("profit.viewExpenses")}</GuardedLink>}>
                            <CategoryBars rows={summary.byCategory} nameOf={nameOf} currency={currency} limit={8} />
                        </Panel>
                    </div>

                    <div className="grid gap-6 xl:grid-cols-2">
                        <Panel title={_t("profit.topCategories")} testId="top-categories">
                            {summary.byCategory.length === 0 ? (
                                <p className="text-sm text-muted-foreground">{_t("expenses.noneInPeriod")}</p>
                            ) : (
                                <ol className="space-y-2 text-sm">
                                    {summary.byCategory.slice(0, 3).map((c, i) => (
                                        <li key={c.category} className="flex items-center justify-between gap-3" data-testid="top-category">
                                            <span className="truncate font-medium">{i + 1}. {nameOf(c.category)}</span>
                                            <span className="shrink-0 tabular-nums">{money(c.total)} <span className="text-xs text-muted-foreground">({Math.round(c.share * 100)}%)</span></span>
                                        </li>
                                    ))}
                                </ol>
                            )}
                        </Panel>
                        <Panel title={_t("profit.observations")} testId="observations">
                            <InsightsList insights={insights} prefix="profit.insights" empty={_t("profit.insights.none")} />
                        </Panel>
                    </div>
                </>
            )}
        </div>
    );
};

export default ProfitLossPage;
