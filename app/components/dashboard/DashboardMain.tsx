"use client";

import { useMemo } from "react";
import { useLocale } from "next-intl";

import { Skeleton } from "@/components/ui/skeleton";
import GuardedLink from "@/app/components/layout/GuardedLink";
import { BarChart, Delta, SegmentBar } from "./Charts";
import { FinanceControls, useFinanceView } from "./FinanceControls";
import NeedsAttention from "./NeedsAttention";
import PayablesAlert from "./PayablesAlert";
import ProfitSnapshotCard from "./ProfitSnapshotCard";
import QuotationsCard from "./QuotationsCard";
import QuickActions from "./QuickActions";
import StatusBadge, { STATUS_STYLES } from "./StatusBadge";

import { useInvoiceContext } from "@/contexts/InvoiceContext";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { transactions } from "@/lib/finance";
import { displayStatus, formatMoney } from "@/lib/invoiceRecords";

import { FilePlus2 } from "lucide-react";

const Stat = ({
    label,
    value,
    sub,
    tone,
}: {
    label: string;
    value: React.ReactNode;
    sub?: React.ReactNode;
    tone?: string;
}) => (
    <div className="rounded-xl border bg-card p-4 shadow-sm transition-shadow hover:shadow-md sm:p-5">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className={`mt-2 truncate text-2xl font-semibold tabular-nums ${tone ?? ""}`} data-testid="stat-value">
            {value}
        </p>
        {sub && <div className="mt-1 min-h-4">{sub}</div>}
    </div>
);

const Card = ({
    title,
    children,
    className = "",
    action,
}: {
    title: string;
    children: React.ReactNode;
    className?: string;
    action?: React.ReactNode;
}) => (
    <section className={`rounded-xl border bg-card p-4 shadow-sm sm:p-6 ${className}`}>
        <div className="mb-4 flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold">{title}</h2>
            {action}
        </div>
        {children}
    </section>
);

const DashboardMain = () => {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const { savedInvoices, savedLoaded, recentNumbers, loadInvoice } = useInvoiceContext();

    const view = useFinanceView(savedInvoices);
    const { report, currency } = view;
    const money = (v: number) => formatMoney(v, currency, locale);

    const monthNames = useMemo(
        () => Array.from({ length: 12 }, (_, m) => new Date(2000, m, 1).toLocaleDateString(locale, { month: "short" })),
        [locale]
    );
    const recentTx = useMemo(
        () => transactions(savedInvoices).filter((t) => t.currency === currency).slice(0, 6),
        [savedInvoices, currency]
    );
    const recentlyViewed = useMemo(
        () =>
            recentNumbers
                .map((n) => savedInvoices.find((i) => i.details.invoiceNumber === n))
                .filter((i): i is NonNullable<typeof i> => !!i)
                .slice(0, 5),
        [recentNumbers, savedInvoices]
    );

    const header = (
        <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{_t("dashboard.title")}</h1>
                    <p className="mt-1 text-sm text-muted-foreground">{_t("dashboard.subtitle")}</p>
                </div>
                {savedInvoices.length > 0 && <FinanceControls view={view} />}
            </div>
            <QuickActions />
        </div>
    );

    if (!savedLoaded) {
        return (
            <div className="space-y-6" aria-busy="true">
                {header}
                <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
                    {Array.from({ length: 6 }).map((_, i) => (
                        <Skeleton key={i} className="h-28 rounded-xl" />
                    ))}
                </div>
                <Skeleton className="h-72 rounded-xl" />
            </div>
        );
    }

    if (savedInvoices.length === 0) {
        return (
            <div className="space-y-6">
                {header}
                {/* Quotations can exist before the first invoice does. */}
                <QuotationsCard hideWhenEmpty />
                <ProfitSnapshotCard year={new Date().getFullYear()} hideWhenEmpty />
                {/* Supplier bills can be overdue before the first invoice exists. */}
                <PayablesAlert />
                <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center">
                    <div className="rounded-full bg-primary/10 p-4 text-primary">
                        <FilePlus2 className="h-8 w-8" aria-hidden />
                    </div>
                    <h2 className="text-lg font-semibold">{_t("dashboard.empty.title")}</h2>
                    <p className="max-w-md text-sm text-muted-foreground">{_t("dashboard.empty.body")}</p>
                    <ol className="max-w-md list-decimal space-y-1 ps-5 text-start text-sm text-muted-foreground">
                        <li>{_t("dashboard.empty.step1")}</li>
                        <li>{_t("dashboard.empty.step2")}</li>
                        <li>{_t("dashboard.empty.step3")}</li>
                    </ol>
                    <GuardedLink
                        href="/settings#backup"
                        className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                    >
                        {_t("dashboard.empty.restore")}
                    </GuardedLink>
                </div>
            </div>
        );
    }

    const t = report.totals;
    const unpaidNotDue = Math.max(0, t.outstanding - t.overdue);
    const topClients = report.topClients.slice(0, 5);
    const topMax = Math.max(1, ...topClients.map((c) => c.invoiced));

    return (
        <div className="space-y-6">
            {header}

            <section aria-label={_t("dashboard.kpis")} className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
                <Stat
                    label={_t("dashboard.stats.revenue")}
                    value={money(t.collected)}
                    sub={<Delta change={report.growth.month.change} label={_t("dashboard.vsLastMonth")} />}
                />
                <Stat
                    label={_t("dashboard.stats.collectedYtd")}
                    value={money(report.growth.ytd.current)}
                    sub={<Delta change={report.growth.ytd.change} label={_t("dashboard.vsLastYear")} />}
                />
                <Stat label={_t("dashboard.stats.outstanding")} value={money(t.outstanding)} />
                <Stat
                    label={_t("dashboard.stats.overdue")}
                    value={money(t.overdue)}
                    tone={t.overdueCount ? "text-destructive" : ""}
                    sub={
                        <span className="text-xs text-muted-foreground">
                            {_t("dashboard.stats.overdueCount", { count: t.overdueCount })}
                        </span>
                    }
                />
                <Stat label={_t("dashboard.stats.average")} value={money(t.averageInvoice)} />
                <Stat
                    label={_t("dashboard.stats.total")}
                    value={savedInvoices.length}
                    sub={
                        <span className="text-xs text-muted-foreground">
                            {_t("dashboard.stats.paidCount", { count: report.statusCounts.paid })}
                        </span>
                    }
                />
            </section>

            <ProfitSnapshotCard currency={currency} year={view.year} />

            <QuotationsCard />

            <PayablesAlert />

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
                <NeedsAttention />
                <Card title={_t("dashboard.charts.paidVsUnpaid")} className="xl:col-span-2">
                    <SegmentBar
                        ariaLabel={_t("dashboard.charts.paidVsUnpaid")}
                        segments={[
                            { label: _t("dashboard.status.paid"), value: t.collected, color: STATUS_STYLES.paid.swatch, display: money(t.collected) },
                            { label: _t("dashboard.charts.unpaidNotDue"), value: unpaidNotDue, color: STATUS_STYLES.sent.swatch, display: money(unpaidNotDue) },
                            { label: _t("dashboard.status.overdue"), value: t.overdue, color: STATUS_STYLES.overdue.swatch, display: money(t.overdue) },
                        ]}
                    />
                </Card>
            </div>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                <Card title={`${_t("dashboard.charts.monthlyRevenue")} · ${view.year}`}>
                    <BarChart
                        ariaLabel={_t("dashboard.charts.monthlyRevenue")}
                        format={money}
                        series={[
                            { name: _t("dashboard.charts.invoiced"), color: "hsl(var(--primary) / 0.3)" },
                            { name: _t("dashboard.charts.collected"), color: "hsl(var(--primary))" },
                        ]}
                        data={report.months.map((m) => ({
                            label: monthNames[m.month],
                            values: [m.invoiced, m.collected],
                            title: `${monthNames[m.month]} ${view.year}: ${_t("dashboard.charts.invoiced")} ${money(m.invoiced)}, ${_t("dashboard.charts.collected")} ${money(m.collected)}`,
                        }))}
                    />
                </Card>
                <Card title={_t("dashboard.charts.yearlyRevenue")}>
                    <BarChart
                        ariaLabel={_t("dashboard.charts.yearlyRevenue")}
                        format={money}
                        series={[
                            { name: _t("dashboard.charts.invoiced"), color: "hsl(var(--primary) / 0.3)" },
                            { name: _t("dashboard.charts.collected"), color: "hsl(var(--primary))" },
                        ]}
                        data={report.years.map((y) => ({
                            label: String(y.year),
                            values: [y.invoiced, y.collected],
                            title: `${y.year}: ${_t("dashboard.charts.invoiced")} ${money(y.invoiced)}, ${_t("dashboard.charts.collected")} ${money(y.collected)}`,
                        }))}
                    />
                </Card>
                <Card title={`${_t("dashboard.charts.generated")} · ${view.year}`}>
                    <BarChart
                        ariaLabel={_t("dashboard.charts.generated")}
                        format={(v) => String(v)}
                        axis={(v) => String(Math.round(v))}
                        series={[{ name: _t("dashboard.charts.invoicesCreated"), color: "hsl(var(--primary))" }]}
                        data={report.months.map((m) => ({
                            label: monthNames[m.month],
                            values: [m.count],
                            title: `${monthNames[m.month]}: ${m.count}`,
                        }))}
                    />
                </Card>
                <Card
                    title={_t("dashboard.topClients")}
                    action={
                        <GuardedLink href="/clients" className="text-xs font-medium text-primary hover:underline">
                            {_t("dashboard.viewAll")}
                        </GuardedLink>
                    }
                >
                    {topClients.length === 0 ? (
                        <p className="py-6 text-center text-sm text-muted-foreground">{_t("dashboard.noClientsYet")}</p>
                    ) : (
                        <ol className="space-y-3">
                            {topClients.map((c, i) => (
                                <li key={c.key}>
                                    <div className="flex items-center justify-between gap-3 text-sm">
                                        <span className="truncate font-medium">
                                            {i + 1}. {c.name}
                                        </span>
                                        <span className="shrink-0 tabular-nums">{money(c.invoiced)}</span>
                                    </div>
                                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                                        <div className="h-full rounded-full bg-primary" style={{ width: `${(c.invoiced / topMax) * 100}%` }} />
                                    </div>
                                </li>
                            ))}
                        </ol>
                    )}
                </Card>
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <Card title={_t("dashboard.recentTransactions")}>
                    {recentTx.length === 0 ? (
                        <p className="py-6 text-center text-sm text-muted-foreground">{_t("dashboard.noPayments")}</p>
                    ) : (
                        <ul className="divide-y">
                            {recentTx.map((tx) => (
                                <li key={tx.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                                    <div className="min-w-0">
                                        <p className="truncate font-medium">{tx.client}</p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {tx.invoiceNumber} · {tx.date.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" })}
                                        </p>
                                    </div>
                                    <span className="shrink-0 font-medium tabular-nums text-success">+{money(tx.amount)}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </Card>
                <Card title={_t("dashboard.recentlyViewed")}>
                    {recentlyViewed.length === 0 ? (
                        <p className="py-6 text-center text-sm text-muted-foreground">{_t("dashboard.noRecent")}</p>
                    ) : (
                        <ul className="divide-y">
                            {recentlyViewed.map((inv) => (
                                <li key={inv.details.invoiceNumber} className="flex items-center justify-between gap-3 py-2.5">
                                    <button
                                        type="button"
                                        onClick={() => loadInvoice(inv)}
                                        className="min-w-0 rounded text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    >
                                        <span className="block truncate text-sm font-medium hover:underline">
                                            {inv.details.invoiceNumber}
                                        </span>
                                        <span className="block truncate text-xs text-muted-foreground">
                                            {inv.receiver.name} · {formatMoney(Number(inv.details.totalAmount), inv.details.currency, locale)}
                                        </span>
                                    </button>
                                    <StatusBadge status={displayStatus(inv)} />
                                </li>
                            ))}
                        </ul>
                    )}
                </Card>
            </div>
        </div>
    );
};

export default DashboardMain;
