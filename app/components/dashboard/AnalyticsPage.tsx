"use client";

import { useMemo } from "react";
import { useLocale } from "next-intl";

import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/use-toast";
import BaseButton from "@/app/components/reusables/BaseButton";
import GuardedLink from "@/app/components/layout/GuardedLink";
import { BarChart, Delta, SegmentBar } from "./Charts";
import { FinanceControls, useFinanceView } from "./FinanceControls";
import { STATUS_STYLES } from "./StatusBadge";
import GstReportPanel from "./GstReportPanel";

import { useInvoiceContext } from "@/contexts/InvoiceContext";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { reportCsv, type ReportKind } from "@/lib/finance";
import { formatMoney } from "@/lib/invoiceRecords";

import { BarChart3, Download } from "lucide-react";

const REPORTS: ReportKind[] = ["monthly", "yearly", "clients", "tax", "outstanding"];

const Metric = ({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) => (
    <div className="rounded-xl border bg-card p-4 shadow-sm sm:p-5">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="mt-2 truncate text-2xl font-semibold tabular-nums" data-testid="metric-value">{value}</p>
        {sub && <div className="mt-1 min-h-4 text-xs text-muted-foreground">{sub}</div>}
    </div>
);

const Panel = ({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) => (
    <section className={`rounded-xl border bg-card p-4 shadow-sm sm:p-6 ${className}`}>
        <h2 className="mb-4 text-base font-semibold">{title}</h2>
        {children}
    </section>
);

/**
 * Every figure here comes from `computeFinance` over the saved invoices; the
 * definitions (invoiced, collected, outstanding, tax collected) are documented
 * in lib/finance.ts and repeated in the page footer so nobody has to guess.
 */
const AnalyticsPage = () => {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const { savedInvoices, savedLoaded } = useInvoiceContext();
    const view = useFinanceView(savedInvoices);
    const { report, currency } = view;
    const money = (v: number) => formatMoney(v, currency, locale);

    const monthNames = useMemo(
        () => Array.from({ length: 12 }, (_, m) => new Date(2000, m, 1).toLocaleDateString(locale, { month: "short" })),
        [locale]
    );

    const download = (kind: ReportKind) => {
        const { filename, csv } = reportCsv(kind, report, savedInvoices);
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast({ title: _t("analytics.exported"), description: filename });
    };

    if (!savedLoaded) return <Skeleton className="h-96 rounded-xl" aria-busy="true" />;

    if (savedInvoices.length === 0) {
        return (
            <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center">
                <div className="rounded-full bg-primary/10 p-4 text-primary">
                    <BarChart3 className="h-8 w-8" aria-hidden />
                </div>
                <h1 className="text-lg font-semibold">{_t("analytics.emptyTitle")}</h1>
                <p className="max-w-md text-sm text-muted-foreground">{_t("analytics.emptyBody")}</p>
                <GuardedLink href="/" className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">
                    {_t("dashboard.empty.cta")}
                </GuardedLink>
            </div>
        );
    }

    const t = report.totals;
    const tr = report.trends;
    const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

    const series = [
        { name: _t("dashboard.charts.invoiced"), color: "hsl(var(--primary) / 0.3)" },
        { name: _t("dashboard.charts.collected"), color: "hsl(var(--primary))" },
    ];

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{_t("analytics.title")}</h1>
                    <p className="mt-1 text-sm text-muted-foreground">{_t("analytics.subtitle")}</p>
                </div>
                <FinanceControls view={view} />
            </div>

            <section aria-label={_t("analytics.title")} className="grid grid-cols-2 gap-4 lg:grid-cols-3">
                <Metric label={_t("analytics.invoiced")} value={money(t.invoiced)} sub={_t("analytics.issuedCount", { count: t.issuedCount })} />
                <Metric
                    label={_t("dashboard.stats.revenue")}
                    value={money(t.collected)}
                    sub={<Delta change={report.growth.month.change} label={_t("dashboard.vsLastMonth")} />}
                />
                <Metric label={_t("dashboard.stats.outstanding")} value={money(t.outstanding)} sub={_t("analytics.overdueOf", { amount: money(t.overdue) })} />
                <Metric label={_t("dashboard.stats.average")} value={money(t.averageInvoice)} />
                <Metric label={_t("analytics.taxCollected")} value={money(t.taxCollected)} sub={_t("analytics.taxInvoiced", { amount: money(t.taxInvoiced) })} />
                <Metric label={_t("analytics.discounts")} value={money(t.discounts)} />
            </section>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                <Panel title={`${_t("dashboard.charts.monthlyRevenue")} · ${view.year}`}>
                    <BarChart
                        ariaLabel={_t("dashboard.charts.monthlyRevenue")}
                        format={money}
                        series={series}
                        data={report.months.map((m) => ({
                            label: monthNames[m.month],
                            values: [m.invoiced, m.collected],
                            title: `${monthNames[m.month]}: ${money(m.invoiced)} / ${money(m.collected)}`,
                        }))}
                    />
                </Panel>
                <Panel title={_t("dashboard.charts.yearlyRevenue")}>
                    <BarChart
                        ariaLabel={_t("dashboard.charts.yearlyRevenue")}
                        format={money}
                        series={series}
                        data={report.years.map((y) => ({
                            label: String(y.year),
                            values: [y.invoiced, y.collected],
                            title: `${y.year}: ${money(y.invoiced)} / ${money(y.collected)}`,
                        }))}
                    />
                    <p className="mt-3 text-xs text-muted-foreground">
                        <Delta change={report.growth.ytd.change} label={_t("dashboard.vsLastYear")} />
                    </p>
                </Panel>

                <Panel title={_t("analytics.aging")}>
                    {t.overdueCount === 0 ? (
                        <p className="py-6 text-center text-sm text-muted-foreground">{_t("analytics.noOverdue")}</p>
                    ) : (
                        <SegmentBar
                            ariaLabel={_t("analytics.aging")}
                            segments={report.aging.map((a, i) => ({
                                label: _t("analytics.days", { range: a.label }),
                                value: a.amount,
                                color: ["hsl(var(--warning))", "hsl(var(--warning) / 0.75)", "hsl(var(--destructive) / 0.7)", "hsl(var(--destructive))"][i],
                                display: `${money(a.amount)} (${a.count})`,
                            }))}
                        />
                    )}
                </Panel>
                <Panel title={_t("analytics.paymentTrends")}>
                    <dl className="mb-4 grid grid-cols-3 gap-3 text-sm">
                        <div>
                            <dt className="text-xs text-muted-foreground">{_t("analytics.avgDays")}</dt>
                            <dd className="font-semibold tabular-nums">{tr.averageDaysToPay === null ? "—" : tr.averageDaysToPay.toFixed(1)}</dd>
                        </div>
                        <div>
                            <dt className="text-xs text-muted-foreground">{_t("analytics.onTime")}</dt>
                            <dd className="font-semibold tabular-nums">{pct(tr.onTimeRate)}</dd>
                        </div>
                        <div>
                            <dt className="text-xs text-muted-foreground">{_t("analytics.paidInvoices")}</dt>
                            <dd className="font-semibold tabular-nums">{tr.paidInvoiceCount}</dd>
                        </div>
                    </dl>
                    {tr.paidInvoiceCount === 0 ? (
                        <p className="py-4 text-center text-sm text-muted-foreground">{_t("analytics.noTrends")}</p>
                    ) : (
                        <BarChart
                            height={170}
                            ariaLabel={_t("analytics.paymentTrends")}
                            format={(v) => `${v.toFixed(1)}`}
                            axis={(v) => String(Math.round(v))}
                            series={[{ name: _t("analytics.avgDays"), color: STATUS_STYLES.paid.swatch }]}
                            data={tr.byMonth.map((m) => ({
                                label: monthNames[m.month],
                                values: [m.days ?? 0],
                                title: `${monthNames[m.month]}: ${m.days === null ? "—" : m.days.toFixed(1)}`,
                            }))}
                        />
                    )}
                </Panel>
            </div>

            <Panel title={_t("analytics.bestClients")}>
                {report.topClients.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">{_t("dashboard.noClientsYet")}</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b text-start text-xs text-muted-foreground">
                                    <th className="py-2 text-start font-medium">{_t("dashboard.invoices.columns.client")}</th>
                                    <th className="py-2 text-end font-medium">{_t("dashboard.clients.invoices")}</th>
                                    <th className="py-2 text-end font-medium">{_t("analytics.invoiced")}</th>
                                    <th className="py-2 text-end font-medium">{_t("invoices.payments.paid")}</th>
                                    <th className="py-2 text-end font-medium">{_t("dashboard.clients.outstanding")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {report.topClients.slice(0, 10).map((c) => (
                                    <tr key={c.key} className="border-b last:border-0">
                                        <td className="max-w-[14rem] truncate py-2 font-medium">{c.name}</td>
                                        <td className="py-2 text-end tabular-nums">{c.count}</td>
                                        <td className="py-2 text-end tabular-nums">{money(c.invoiced)}</td>
                                        <td className="py-2 text-end tabular-nums text-success">{money(c.collected)}</td>
                                        <td className="py-2 text-end tabular-nums">{money(c.outstanding)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Panel>

            <Panel title={_t("analytics.reports")}>
                <p className="mb-3 text-sm text-muted-foreground">{_t("analytics.reportsHint", { currency, year: view.year })}</p>
                <div className="flex flex-wrap gap-2">
                    {REPORTS.map((k) => (
                        <BaseButton key={k} variant="outline" size="sm" onClick={() => download(k)}>
                            <Download className="h-4 w-4" />
                            {_t(`analytics.report.${k}`)}
                        </BaseButton>
                    ))}
                </div>
            </Panel>

            <GstReportPanel invoices={savedInvoices} currency={currency} />

            <p className="text-xs text-muted-foreground">{_t("analytics.definitions")}</p>
        </div>
    );
};

export default AnalyticsPage;
