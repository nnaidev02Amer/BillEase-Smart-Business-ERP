"use client";

import { useMemo, useState } from "react";
import { useLocale } from "next-intl";

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/use-toast";
import BaseButton from "@/app/components/reusables/BaseButton";
import GuardedLink from "@/app/components/layout/GuardedLink";

import QuotationActions from "./QuotationActions";
import QuotationView from "./QuotationView";
import { ExpiryNote, QuotationStatusBadge } from "./QuotationStatusBadge";
import { useQuotationActions } from "./useQuotationActions";

import { useQuotations } from "@/contexts/useQuotations";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { useRouter } from "@/i18n/navigation";
import { formatMoney, type CurrencyTotals } from "@/lib/invoiceRecords";
import {
    DISPLAY_QUOTATION_STATUSES,
    EMPTY_QUOTATION_QUERY,
    currencyOf,
    customerOf,
    displayStatus,
    issueDateOf,
    numberOf,
    queryQuotations,
    quotationStats,
    quotationsToCsv,
    totalOf,
    validUntilOf,
    type Quotation,
    type QuotationFilter,
    type QuotationQuery,
    type QuotationSortKey,
} from "@/lib/quotations";

import { Download, FileText, Plus, Search } from "lucide-react";

const Metric = ({ label, value, sub, testId }: { label: string; value: React.ReactNode; sub?: React.ReactNode; testId: string }) => (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
        <p className="text-sm text-muted-foreground">{label}</p>
        <div className="mt-2 break-words text-xl font-semibold tabular-nums sm:text-2xl" data-testid={testId}>
            {value}
        </div>
        {sub && <div className="mt-1 min-h-4 text-xs text-muted-foreground">{sub}</div>}
    </div>
);

/** One line per currency: amounts in different currencies are never added together. */
const MoneyLines = ({ totals, empty }: { totals: CurrencyTotals; empty: string }) => {
    const locale = useLocale();
    const entries = Object.entries(totals).filter(([, v]) => v > 0);
    if (entries.length === 0) return <span className="text-muted-foreground">{empty}</span>;
    return (
        <span className="flex flex-col">
            {entries.map(([c, v]) => (
                <span key={c}>{formatMoney(v, c, locale)}</span>
            ))}
        </span>
    );
};

const FILTERS: QuotationFilter[] = ["all", ...DISPLAY_QUOTATION_STATUSES, "expiring", "converted"];
const SORTS: QuotationSortKey[] = ["date", "number", "customer", "amount", "validUntil", "status"];

const QuotationsPage = ({ initialCustomer }: { initialCustomer?: string }) => {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const router = useRouter();
    const { quotations, converted, loaded } = useQuotations();
    const actions = useQuotationActions(converted);

    const [query, setQuery] = useState<QuotationQuery>({ ...EMPTY_QUOTATION_QUERY, customerKey: initialCustomer });
    const [viewId, setViewId] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<Quotation | null>(null);
    const [converting, setConverting] = useState<Quotation | null>(null);

    const now = new Date();
    const stats = useMemo(() => quotationStats(quotations, { converted }), [quotations, converted]);
    const rows = useMemo(() => queryQuotations(quotations, query, { converted }), [quotations, query, converted]);
    const viewing = quotations.find((q) => q.id === viewId) ?? null;

    const set = (patch: Partial<QuotationQuery>) => setQuery((q) => ({ ...q, ...patch }));
    const filtered = query.search !== "" || query.filter !== "all" || !!query.customerKey;

    const edit = (q: Quotation) => router.push(`/quotations/builder?id=${encodeURIComponent(q.id)}`);

    const exportCsv = () => {
        const csv = quotationsToCsv(rows, converted);
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = `quotations-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast({ title: _t("quotations.exported"), description: a.download });
    };

    const date = (d: Date | null) => (d ? d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" }) : "—");
    const money = (q: Quotation) => formatMoney(totalOf(q), currencyOf(q), locale);

    if (!loaded) return <Skeleton className="h-96 rounded-xl" aria-busy="true" />;

    const rate = stats.conversionRate;

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{_t("quotations.title")}</h1>
                    <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{_t("quotations.subtitle")}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                    {quotations.length > 0 && (
                        <BaseButton variant="outline" onClick={exportCsv} data-testid="export-quotations">
                            <Download className="h-4 w-4" />
                            {_t("quotations.export")}
                        </BaseButton>
                    )}
                    <GuardedLink
                        href="/quotations/builder?new=1"
                        data-testid="new-quotation"
                        className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                        <Plus className="h-4 w-4" aria-hidden />
                        {_t("quotations.new")}
                    </GuardedLink>
                </div>
            </div>

            {quotations.length === 0 ? (
                <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center">
                    <div className="rounded-full bg-primary/10 p-4 text-primary">
                        <FileText className="h-8 w-8" aria-hidden />
                    </div>
                    <h2 className="text-lg font-semibold">{_t("quotations.empty.title")}</h2>
                    <p className="max-w-md text-sm text-muted-foreground">{_t("quotations.empty.body")}</p>
                    <GuardedLink
                        href="/quotations/builder?new=1"
                        className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                    >
                        <Plus className="h-4 w-4" aria-hidden />
                        {_t("quotations.empty.cta")}
                    </GuardedLink>
                </div>
            ) : (
                <>
                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6" data-testid="quotation-metrics">
                        <Metric testId="m-total" label={_t("quotations.metrics.total")} value={stats.total} sub={stats.expired ? _t("quotations.metrics.expired", { count: stats.expired }) : undefined} />
                        <Metric testId="m-accepted" label={_t("quotations.metrics.accepted")} value={stats.accepted} sub={_t("quotations.metrics.acceptedHint", { count: stats.converted })} />
                        <Metric testId="m-rejected" label={_t("quotations.metrics.rejected")} value={stats.rejected} />
                        <Metric testId="m-pending" label={_t("quotations.metrics.pending")} value={stats.pending} sub={stats.expiringSoon ? _t("quotations.metrics.pendingHint", { count: stats.expiringSoon }) : undefined} />
                        <Metric
                            testId="m-rate"
                            label={_t("quotations.metrics.rate")}
                            value={rate === null ? _t("quotations.metrics.none") : `${Math.round(rate * 100)}%`}
                            sub={_t("quotations.metrics.rateHint", { accepted: stats.accepted, issued: stats.issued })}
                        />
                        <Metric testId="m-value" label={_t("quotations.metrics.value")} value={<MoneyLines totals={stats.value} empty={_t("quotations.metrics.none")} />} sub={_t("quotations.metrics.valueHint")} />
                    </div>

                    <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
                        <div className="relative lg:w-80">
                            <Search aria-hidden className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input type="search" data-shortcut-search className="ps-9" value={query.search} onChange={(e) => set({ search: e.target.value })} placeholder={_t("quotations.search")} aria-label={_t("quotations.search")} />
                        </div>
                        <Select value={query.filter} onValueChange={(v) => set({ filter: v as QuotationFilter })}>
                            <SelectTrigger className="lg:w-48" aria-label={_t("quotations.columns.status")}><SelectValue /></SelectTrigger>
                            <SelectContent>
                                {FILTERS.map((f) => (
                                    <SelectItem key={f} value={f}>{_t(`quotations.filters.${f}`)}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Select value={query.sort} onValueChange={(v) => set({ sort: v as QuotationSortKey })}>
                            <SelectTrigger className="lg:w-52" aria-label={_t("quotations.sortBy")}><SelectValue /></SelectTrigger>
                            <SelectContent>
                                {SORTS.map((s) => (
                                    <SelectItem key={s} value={s}>{_t("quotations.sortBy")}: {_t(`quotations.sort.${s}`)}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <BaseButton variant="outline" onClick={() => set({ dir: query.dir === "asc" ? "desc" : "asc" })} aria-label={query.dir === "asc" ? "Ascending" : "Descending"} data-testid="sort-dir">
                            {query.dir === "asc" ? "↑" : "↓"}
                        </BaseButton>
                        {query.customerKey && (
                            <BaseButton variant="ghost" onClick={() => set({ customerKey: undefined })}>
                                × {query.customerKey}
                            </BaseButton>
                        )}
                    </div>

                    {rows.length === 0 ? (
                        <p className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">{filtered ? _t("quotations.empty.filtered") : _t("quotations.empty.title")}</p>
                    ) : (
                        <>
                            <div className="hidden overflow-x-auto rounded-xl border bg-card shadow-sm md:block">
                                <table className="w-full text-sm" data-testid="quotation-table">
                                    <thead className="bg-muted/50 text-xs text-muted-foreground">
                                        <tr>
                                            <th className="px-4 py-3 text-start font-medium">{_t("quotations.columns.number")}</th>
                                            <th className="px-4 py-3 text-start font-medium">{_t("quotations.columns.customer")}</th>
                                            <th className="px-4 py-3 text-start font-medium">{_t("quotations.columns.validUntil")}</th>
                                            <th className="px-4 py-3 text-end font-medium">{_t("quotations.columns.amount")}</th>
                                            <th className="px-4 py-3 text-start font-medium">{_t("quotations.columns.status")}</th>
                                            <th className="px-4 py-3 text-end font-medium">{_t("quotations.columns.actions")}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {rows.map((q) => (
                                            <tr key={q.id} className="border-t" data-testid="quotation-row" data-number={numberOf(q)}>
                                                <td className="px-4 py-3">
                                                    <button type="button" className="font-medium hover:underline" onClick={() => setViewId(q.id)}>
                                                        {numberOf(q)}
                                                    </button>
                                                    <p className="text-xs text-muted-foreground">{date(issueDateOf(q))}</p>
                                                </td>
                                                <td className="px-4 py-3">
                                                    <p>{customerOf(q)}</p>
                                                    <p className="text-xs text-muted-foreground">{q.doc.receiver.email}</p>
                                                </td>
                                                <td className="px-4 py-3">
                                                    <p>{date(validUntilOf(q))}</p>
                                                    <ExpiryNote quotation={q} now={now} />
                                                </td>
                                                <td className="px-4 py-3 text-end tabular-nums">{money(q)}</td>
                                                <td className="px-4 py-3">
                                                    <div className="flex flex-col items-start gap-1">
                                                        <QuotationStatusBadge status={displayStatus(q, now)} />
                                                        {converted.has(q.id) && <span className="text-xs text-success" data-testid="invoiced-badge">{_t("quotations.convertedBadge")} · {converted.get(q.id)}</span>}
                                                    </div>
                                                </td>
                                                <td className="px-4 py-3">
                                                    <QuotationActions variant="row" quotation={q} invoiceNumber={converted.get(q.id)} actions={actions} onEdit={edit} onDelete={setDeleting} onConvert={setConverting} />
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>

                            <ul className="grid grid-cols-1 gap-3 md:hidden" data-testid="quotation-cards">
                                {rows.map((q) => (
                                    <li key={q.id} className="rounded-xl border bg-card p-4 shadow-sm" data-testid="quotation-row" data-number={numberOf(q)}>
                                        <div className="flex items-start justify-between gap-2">
                                            <button type="button" className="min-w-0 text-start" onClick={() => setViewId(q.id)}>
                                                <p className="truncate font-medium hover:underline">{numberOf(q)}</p>
                                                <p className="truncate text-xs text-muted-foreground">{customerOf(q)}</p>
                                            </button>
                                            <QuotationStatusBadge status={displayStatus(q, now)} />
                                        </div>
                                        <div className="mt-2 flex items-center justify-between text-sm">
                                            <span className="tabular-nums">{money(q)}</span>
                                            <span className="text-xs text-muted-foreground">{_t("quotations.columns.validUntil")}: {date(validUntilOf(q))}</span>
                                        </div>
                                        <div className="mt-1"><ExpiryNote quotation={q} now={now} /></div>
                                        {converted.has(q.id) && <p className="mt-1 text-xs text-success" data-testid="invoiced-badge">{_t("quotations.convertedBadge")} · {converted.get(q.id)}</p>}
                                        <div className="mt-3">
                                            <QuotationActions variant="row" quotation={q} invoiceNumber={converted.get(q.id)} actions={actions} onEdit={edit} onDelete={setDeleting} onConvert={setConverting} />
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                    <p className="text-xs text-muted-foreground">{_t("quotations.definitions")}</p>
                </>
            )}

            <QuotationView
                quotation={viewing}
                invoiceNumber={viewing ? converted.get(viewing.id) : undefined}
                actions={actions}
                onClose={() => setViewId(null)}
                onEdit={(q) => {
                    setViewId(null);
                    edit(q);
                }}
                onDelete={setDeleting}
                onConvert={setConverting}
            />

            <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{_t("quotations.confirm.deleteTitle", { number: deleting ? numberOf(deleting) : "" })}</AlertDialogTitle>
                        <AlertDialogDescription>{_t("quotations.confirm.deleteBody")}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>{_t("quotations.confirm.cancel")}</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={async () => {
                                const q = deleting;
                                setDeleting(null);
                                if (q && (await actions.remove(q))) setViewId((id) => (id === q.id ? null : id));
                            }}
                        >
                            {_t("quotations.actions.delete")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            <AlertDialog open={converting !== null} onOpenChange={(o) => !o && setConverting(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{_t("quotations.confirm.convertTitle", { number: converting ? numberOf(converting) : "" })}</AlertDialogTitle>
                        <AlertDialogDescription>{_t("quotations.confirm.convertBody")}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>{_t("quotations.confirm.cancel")}</AlertDialogCancel>
                        <AlertDialogAction
                            data-testid="confirm-convert"
                            onClick={async () => {
                                const q = converting;
                                setConverting(null);
                                if (q) await actions.convert(q);
                            }}
                        >
                            {_t("quotations.confirm.convert")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
};

export default QuotationsPage;
