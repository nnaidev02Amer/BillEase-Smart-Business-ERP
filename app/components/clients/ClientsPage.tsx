"use client";

import { useEffect, useMemo, useState } from "react";
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
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/use-toast";

import BaseButton from "@/app/components/reusables/BaseButton";
import GuardedLink from "@/app/components/layout/GuardedLink";
import StatusBadge from "@/app/components/dashboard/StatusBadge";
import { ExpiryNote, QuotationStatusBadge } from "@/app/components/quotations/QuotationStatusBadge";

import { CustomerDialog } from "./CustomerEditor";
import { MoneyLines, StatCard } from "./CrmWidgets";
import DuplicatesDialog from "./DuplicatesDialog";
import ImportCustomersDialog from "./ImportCustomersDialog";

import { useInvoiceContext } from "@/contexts/InvoiceContext";
import { useCustomers } from "@/contexts/useCustomers";
import { useTranslationContext } from "@/contexts/TranslationContext";
import {
    EMPTY_CUSTOMER_QUERY,
    categoriesOf,
    currenciesOf,
    dormantCustomers,
    findDuplicateGroups,
    frequentBuyers,
    identityOf,
    portfolioCurrency,
    queryCustomers,
    tagsOf,
    topByRevenue,
    withOutstanding,
    type CustomerFilter,
    type CustomerQuery,
    type CustomerRecord,
    type CustomerSort,
    type CustomerStatusFilter,
} from "@/lib/crm";
import { customersToCsv } from "@/lib/customerImport";
import { balanceDue, displayStatus, formatMoney, invoiceTotal, parseDate, type CurrencyTotals } from "@/lib/invoiceRecords";
import { readParties, replaceParties } from "@/lib/partyStore";
import { currencyOf, displayStatus as quotationStatus, numberOf as quotationNumber, totalOf as quotationTotal, validUntilOf } from "@/lib/quotations";
import { downloadBlob } from "@/lib/quotationPdf";

import { Download, Mail, Pencil, Phone, Plus, Search, StickyNote, Trash2, Upload, UserPlus, Users, Copy as CopyIcon, ArrowUpRight } from "lucide-react";

const FILTERS: CustomerFilter[] = ["all", "outstanding", "overdue", "quotations", "pendingQuotes", "inactive"];
const SORTS: CustomerSort[] = ["name", "billed", "outstanding", "recent"];

const sumTotals = (list: (CurrencyTotals | undefined)[]): CurrencyTotals => {
    const out: CurrencyTotals = {};
    for (const t of list) for (const [c, v] of Object.entries(t ?? {})) out[c] = (out[c] ?? 0) + v;
    return out;
};

const Chip = ({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "primary" | "warn" }) => (
    <span
        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
            tone === "primary" ? "bg-primary/10 text-primary" : tone === "warn" ? "bg-amber-500/15 text-amber-700 dark:text-amber-400" : "bg-muted text-muted-foreground"
        }`}
    >
        {children}
    </span>
);

const ClientsPage = () => {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const { invoiceForClient, loadInvoice } = useInvoiceContext();
    const { records, profiles, invoices, quotations, loaded, reload } = useCustomers();

    const [query, setQuery] = useState<CustomerQuery>(EMPTY_CUSTOMER_QUERY);
    const [editing, setEditing] = useState<{ row: CustomerRecord | null } | null>(null);

    // "Add client" shortcuts link here with ?new=1. Read it in an effect, not in the initial
    // state: on a client-side navigation the URL has not changed yet when this first renders.
    useEffect(() => {
        if (new URLSearchParams(window.location.search).get("new") === "1") setEditing({ row: null });
    }, []);
    const [openKey, setOpenKey] = useState<string | null>(null);
    const [pendingDelete, setPendingDelete] = useState<CustomerRecord | null>(null);
    const [importing, setImporting] = useState(false);
    const [reviewing, setReviewing] = useState(false);
    const [currency, setCurrency] = useState<string | null>(null);

    const visible = useMemo(() => queryCustomers(records, query), [records, query]);
    const opened = records.find((r) => r.key === openKey) ?? null;
    const categories = useMemo(() => categoriesOf(records), [records]);
    const tags = useMemo(() => tagsOf(records), [records]);
    const groups = useMemo(() => findDuplicateGroups(records.map(identityOf)), [records]);
    const currencies = useMemo(() => currenciesOf(records), [records]);
    const insightCurrency = currency && currencies.includes(currency) ? currency : portfolioCurrency(records);

    const totals = useMemo(
        () => ({
            outstanding: sumTotals(records.map((r) => r.invoices?.outstanding)),
            overdue: sumTotals(records.map((r) => r.invoices?.overdue)),
            overdueCustomers: records.filter((r) => (r.invoices?.overdueCount ?? 0) > 0).length,
            awaiting: records.reduce((s, r) => s + r.quotes.pending + r.quotes.acceptedNotInvoiced.length, 0),
            active: records.filter((r) => r.active).length,
        }),
        [records]
    );

    const set = (patch: Partial<CustomerQuery>) => setQuery((q) => ({ ...q, ...patch }));
    const filtered = JSON.stringify(query) !== JSON.stringify(EMPTY_CUSTOMER_QUERY);

    const date = (d: Date | null) => (d ? d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" }) : "—");

    const remove = async (row: CustomerRecord) => {
        if (!row.profile) return;
        const list = await readParties("receiver");
        await replaceParties("receiver", list.filter((p) => p.id !== row.profile!.id));
        await reload();
        setOpenKey(null);
        toast({ title: _t("clients.toast.removed"), description: row.name });
    };

    const startInvoice = (row: CustomerRecord) => {
        const p = row.profile;
        invoiceForClient({
            name: row.name,
            email: row.email,
            phone: row.phone,
            address: p?.address ?? "",
            zipCode: p?.zipCode ?? "",
            city: p?.city ?? row.city,
            country: p?.country ?? "",
            gstin: row.gstin,
            shippingAddress: p?.shippingAddress,
        });
    };

    const exportCsv = () => {
        const csv = customersToCsv(visible, locale);
        const name = `customers-${new Date().toISOString().slice(0, 10)}.csv`;
        downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), name);
        toast({ title: _t("crm.exported"), description: _t("crm.exportedBody", { count: visible.length }) });
    };

    if (!loaded) return <Skeleton className="h-96 rounded-xl" aria-busy="true" />;

    const top = topByRevenue(records, insightCurrency, 5);
    const owing = withOutstanding(records, insightCurrency, 5);
    const frequent = frequentBuyers(records, 5);
    const dormant = dormantCustomers(records, 5);
    const lateOwing = records.filter((r) => r.behaviour.class === "late" && (r.invoices?.outstanding[insightCurrency] ?? 0) > 0).slice(0, 5);

    const profileHref = (r: CustomerRecord) => `/clients/profile?key=${encodeURIComponent(r.key)}`;

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{_t("clients.title")}</h1>
                    <p className="mt-1 text-sm text-muted-foreground">{_t("clients.subtitle")}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <BaseButton variant="outline" onClick={() => setImporting(true)} data-testid="import-customers">
                        <Upload className="h-4 w-4" />
                        {_t("crm.import.open")}
                    </BaseButton>
                    {records.length > 0 && (
                        <BaseButton variant="outline" onClick={exportCsv} data-testid="export-customers">
                            <Download className="h-4 w-4" />
                            {_t("crm.export")}
                        </BaseButton>
                    )}
                    <BaseButton onClick={() => setEditing({ row: null })}>
                        <UserPlus className="h-4 w-4" />
                        {_t("clients.add")}
                    </BaseButton>
                </div>
            </div>

            {records.length === 0 ? (
                <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center">
                    <div className="rounded-full bg-primary/10 p-4 text-primary">
                        <Users className="h-8 w-8" aria-hidden />
                    </div>
                    <h2 className="text-lg font-semibold">{_t("clients.emptyTitle")}</h2>
                    <p className="max-w-md text-sm text-muted-foreground">{_t("clients.emptyBody")}</p>
                    <BaseButton onClick={() => setEditing({ row: null })}>
                        <Plus className="h-4 w-4" />
                        {_t("clients.add")}
                    </BaseButton>
                </div>
            ) : (
                <>
                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="customer-metrics">
                        <StatCard testId="cm-total" label={_t("crm.metrics.customers")} value={records.length} sub={_t("crm.metrics.activeSplit", { active: totals.active, inactive: records.length - totals.active })} />
                        <StatCard testId="cm-outstanding" label={_t("crm.metrics.outstanding")} value={<MoneyLines totals={totals.outstanding} empty="—" />} />
                        <StatCard testId="cm-overdue" label={_t("crm.metrics.overdue")} value={totals.overdueCustomers} sub={Object.values(totals.overdue).some((v) => v > 0) ? <MoneyLines totals={totals.overdue} /> : undefined} tone={totals.overdueCustomers ? "text-destructive" : ""} />
                        <StatCard testId="cm-awaiting" label={_t("crm.metrics.awaiting")} value={totals.awaiting} sub={_t("crm.metrics.awaitingHint")} />
                    </div>

                    {groups.length > 0 && (
                        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm" data-testid="duplicates-banner">
                            <p className="flex items-center gap-2">
                                <CopyIcon className="h-4 w-4" aria-hidden />
                                {_t("crm.duplicates.banner", { count: groups.length })}
                            </p>
                            <BaseButton variant="outline" size="sm" onClick={() => setReviewing(true)} data-testid="review-duplicates">
                                {_t("crm.duplicates.review")}
                            </BaseButton>
                        </div>
                    )}

                    <details className="group rounded-xl border bg-card shadow-sm" open data-testid="intelligence">
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 sm:px-6">
                            <h2 className="text-base font-semibold">{_t("crm.intel.title")}</h2>
                            <span className="text-xs text-muted-foreground">{_t("crm.intel.toggle")}</span>
                        </summary>
                        <div className="space-y-4 border-t p-4 sm:p-6">
                            {currencies.length > 1 && (
                                <div className="flex items-center gap-2 text-sm">
                                    <span className="text-muted-foreground">{_t("crm.intel.currency")}</span>
                                    <Select value={insightCurrency} onValueChange={setCurrency}>
                                        <SelectTrigger className="h-8 w-28" aria-label={_t("crm.intel.currency")}><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                            {currencies.map((c) => (
                                                <SelectItem key={c} value={c}>{c}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                            )}
                            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                                <div data-testid="intel-top">
                                    <h3 className="mb-2 text-sm font-semibold">{_t("crm.intel.top")}</h3>
                                    {top.length === 0 ? (
                                        <p className="text-sm text-muted-foreground">{_t("crm.intel.nothing")}</p>
                                    ) : (
                                        <ol className="space-y-2">
                                            {top.map((t, i) => (
                                                <li key={t.record.key} data-testid="intel-top-row">
                                                    <div className="flex items-center justify-between gap-2 text-sm">
                                                        <GuardedLink href={profileHref(t.record)} className="truncate font-medium hover:underline">{i + 1}. {t.record.name}</GuardedLink>
                                                        <span className="shrink-0 tabular-nums">{formatMoney(t.value, insightCurrency, locale)}</span>
                                                    </div>
                                                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                                                        <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(t.share * 100)}%` }} />
                                                    </div>
                                                    <p className="mt-0.5 text-xs text-muted-foreground">{_t("crm.intel.share", { percent: Math.round(t.share * 100) })}</p>
                                                </li>
                                            ))}
                                        </ol>
                                    )}
                                </div>
                                <div data-testid="intel-owing">
                                    <h3 className="mb-2 text-sm font-semibold">{_t("crm.intel.owing")}</h3>
                                    {owing.length === 0 ? (
                                        <p className="text-sm text-muted-foreground">{_t("crm.intel.nobodyOwes")}</p>
                                    ) : (
                                        <ul className="space-y-2 text-sm">
                                            {owing.map((o) => (
                                                <li key={o.record.key} className="flex items-center justify-between gap-2" data-testid="intel-owing-row">
                                                    <GuardedLink href={profileHref(o.record)} className="truncate font-medium hover:underline">{o.record.name}</GuardedLink>
                                                    <span className="shrink-0 tabular-nums">{formatMoney(o.value, insightCurrency, locale)}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                                <div data-testid="intel-frequent">
                                    <h3 className="mb-2 text-sm font-semibold">{_t("crm.intel.frequent")}</h3>
                                    {frequent.length === 0 ? (
                                        <p className="text-sm text-muted-foreground">{_t("crm.intel.nothing")}</p>
                                    ) : (
                                        <ul className="space-y-2 text-sm">
                                            {frequent.map((r) => (
                                                <li key={r.key} className="flex items-center justify-between gap-2" data-testid="intel-frequent-row">
                                                    <GuardedLink href={profileHref(r)} className="truncate font-medium hover:underline">{r.name}</GuardedLink>
                                                    <span className="shrink-0 text-xs text-muted-foreground">{_t("crm.intel.invoicesYear", { count: r.frequency.count12m })}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                                <div data-testid="intel-attention">
                                    <h3 className="mb-2 text-sm font-semibold">{_t("crm.intel.attention")}</h3>
                                    {dormant.length === 0 && lateOwing.length === 0 ? (
                                        <p className="text-sm text-muted-foreground">{_t("crm.intel.allGood")}</p>
                                    ) : (
                                        <ul className="space-y-2 text-sm">
                                            {lateOwing.map((r) => (
                                                <li key={`l-${r.key}`} className="flex items-center justify-between gap-2" data-testid="intel-late-row">
                                                    <GuardedLink href={profileHref(r)} className="truncate font-medium hover:underline">{r.name}</GuardedLink>
                                                    <Chip tone="warn">{_t("crm.intel.paysLate")}</Chip>
                                                </li>
                                            ))}
                                            {dormant.map((r) => (
                                                <li key={`d-${r.key}`} className="flex items-center justify-between gap-2" data-testid="intel-dormant-row">
                                                    <GuardedLink href={profileHref(r)} className="truncate font-medium hover:underline">{r.name}</GuardedLink>
                                                    <span className="shrink-0 text-xs text-muted-foreground">{_t("crm.intel.quietFor", { days: r.frequency.daysSinceLast ?? 0 })}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            </div>
                        </div>
                    </details>

                    <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center">
                        <div className="relative lg:w-80">
                            <Search aria-hidden className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                type="search"
                                data-shortcut-search
                                className="ps-9"
                                value={query.search}
                                onChange={(e) => set({ search: e.target.value })}
                                placeholder={_t("clients.search")}
                                aria-label={_t("clients.search")}
                            />
                        </div>
                        <Select value={query.filter} onValueChange={(v) => set({ filter: v as CustomerFilter })}>
                            <SelectTrigger className="lg:w-48" aria-label={_t("clients.filter.label")}>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {FILTERS.map((f) => (
                                    <SelectItem key={f} value={f}>
                                        {_t(`clients.filter.${f}`)}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Select value={query.status} onValueChange={(v) => set({ status: v as CustomerStatusFilter })}>
                            <SelectTrigger className="lg:w-40" aria-label={_t("crm.filter.status")}>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {(["all", "active", "inactive"] as const).map((s) => (
                                    <SelectItem key={s} value={s}>{_t(`crm.filter.statusOptions.${s}`)}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        {categories.length > 0 && (
                            <Select value={query.category || "__all"} onValueChange={(v) => set({ category: v === "__all" ? "" : v })}>
                                <SelectTrigger className="lg:w-44" aria-label={_t("crm.filter.category")}>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="__all">{_t("crm.filter.category")}: {_t("crm.filter.any")}</SelectItem>
                                    {categories.map((c) => (
                                        <SelectItem key={c} value={c}>{c}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        )}
                        {tags.length > 0 && (
                            <Select value={query.tag || "__all"} onValueChange={(v) => set({ tag: v === "__all" ? "" : v })}>
                                <SelectTrigger className="lg:w-40" aria-label={_t("crm.filter.tag")}>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="__all">{_t("crm.filter.tag")}: {_t("crm.filter.any")}</SelectItem>
                                    {tags.map((t) => (
                                        <SelectItem key={t} value={t}>{t}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        )}
                        <Select value={query.sort} onValueChange={(v) => set({ sort: v as CustomerSort })}>
                            <SelectTrigger className="lg:w-48" aria-label={_t("dashboard.invoices.sortBy")}>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {SORTS.map((s) => (
                                    <SelectItem key={s} value={s}>
                                        {_t("dashboard.invoices.sortBy")}: {_t(`clients.sort.${s}`)}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        {filtered && (
                            <BaseButton variant="ghost" size="sm" onClick={() => setQuery(EMPTY_CUSTOMER_QUERY)} data-testid="clear-filters">
                                {_t("crm.filter.clear")}
                            </BaseButton>
                        )}
                    </div>

                    <p className="text-xs text-muted-foreground" data-testid="customer-count">{_t("crm.count", { shown: visible.length, total: records.length })}</p>

                    {visible.length === 0 ? (
                        <p className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">{_t("clients.noResults")}</p>
                    ) : (
                        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="client-list">
                            {visible.map((r) => (
                                <li key={r.key}>
                                    <button
                                        type="button"
                                        onClick={() => setOpenKey(r.key)}
                                        className={`w-full rounded-xl border bg-card p-4 text-start shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${r.active ? "" : "opacity-70"}`}
                                        data-testid="client-card"
                                        data-key={r.key}
                                    >
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0">
                                                <p className="truncate font-medium">{r.name}</p>
                                                <p className="truncate text-xs text-muted-foreground">{r.company || r.email || r.phone || "—"}</p>
                                            </div>
                                            <div className="flex shrink-0 flex-col items-end gap-1">
                                                {!r.profile && <Chip>{_t("clients.fromInvoices")}</Chip>}
                                                {!r.active && <Chip>{_t("crm.inactive")}</Chip>}
                                            </div>
                                        </div>
                                        {(r.category || r.tags.length > 0) && (
                                            <div className="mt-2 flex flex-wrap gap-1">
                                                {r.category && <Chip tone="primary">{r.category}</Chip>}
                                                {r.tags.slice(0, 3).map((t) => (
                                                    <Chip key={t}>{t}</Chip>
                                                ))}
                                                {r.tags.length > 3 && <Chip>+{r.tags.length - 3}</Chip>}
                                            </div>
                                        )}
                                        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                                            <div>
                                                <dt className="text-xs text-muted-foreground">{_t("dashboard.clients.invoices")}</dt>
                                                <dd className="font-medium tabular-nums">{r.invoices?.invoiceCount ?? 0}</dd>
                                            </div>
                                            <div>
                                                <dt className="text-xs text-muted-foreground">{_t("dashboard.clients.last")}</dt>
                                                <dd>{date(r.invoices?.lastInvoice ?? null)}</dd>
                                            </div>
                                            <div>
                                                <dt className="text-xs text-muted-foreground">{_t("dashboard.clients.billed")}</dt>
                                                <dd className="font-medium tabular-nums"><MoneyLines totals={r.invoices?.billed ?? {}} /></dd>
                                            </div>
                                            <div>
                                                <dt className="text-xs text-muted-foreground">{_t("dashboard.clients.outstanding")}</dt>
                                                <dd className={`font-medium tabular-nums ${r.invoices?.overdueCount ? "text-destructive" : ""}`}>
                                                    <MoneyLines totals={r.invoices?.outstanding ?? {}} />
                                                </dd>
                                            </div>
                                        </dl>
                                        {r.quotes.count > 0 && (
                                            <p className="mt-2 text-xs text-muted-foreground">{_t("crm.card.quotes", { count: r.quotes.count, pending: r.quotes.pending })}</p>
                                        )}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </>
            )}

            {/* Quick view (the full profile is one click away) */}
            <Sheet open={opened !== null} onOpenChange={(o) => !o && setOpenKey(null)}>
                <SheetContent side="right" className="w-full overflow-y-auto p-5 sm:max-w-lg sm:p-6">
                    {opened && (
                        <>
                            <SheetHeader className="text-start">
                                <SheetTitle>{opened.name}</SheetTitle>
                                <SheetDescription>{_t("clients.profile")}</SheetDescription>
                            </SheetHeader>

                            <div className="mt-3 flex flex-wrap gap-1">
                                {!opened.active && <Chip>{_t("crm.inactive")}</Chip>}
                                {opened.category && <Chip tone="primary">{opened.category}</Chip>}
                                {opened.tags.map((t) => (
                                    <Chip key={t}>{t}</Chip>
                                ))}
                            </div>

                            <div className="mt-4 flex flex-wrap gap-2">
                                <GuardedLink
                                    href={profileHref(opened)}
                                    data-testid="open-profile"
                                    className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                                >
                                    <ArrowUpRight className="h-4 w-4" aria-hidden />
                                    {_t("crm.openProfile")}
                                </GuardedLink>
                                <BaseButton variant="outline" onClick={() => startInvoice(opened)}>
                                    <Plus className="h-4 w-4" />
                                    {_t("clients.newInvoice")}
                                </BaseButton>
                                <GuardedLink
                                    href={`/quotations/builder?customer=${encodeURIComponent(opened.key)}`}
                                    data-testid="client-new-quotation"
                                    className="inline-flex h-10 items-center gap-2 rounded-md border border-input bg-background px-4 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                                >
                                    <Plus className="h-4 w-4" aria-hidden />
                                    {_t("clients.newQuotation")}
                                </GuardedLink>
                                <BaseButton variant="outline" onClick={() => setEditing({ row: opened })}>
                                    <Pencil className="h-4 w-4" />
                                    {opened.profile ? _t("clients.edit") : _t("clients.saveToBook")}
                                </BaseButton>
                                {opened.profile && (
                                    <BaseButton variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setPendingDelete(opened)}>
                                        <Trash2 className="h-4 w-4" />
                                        {_t("clients.remove")}
                                    </BaseButton>
                                )}
                            </div>

                            <section className="mt-6 space-y-2 text-sm">
                                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{_t("clients.contact")}</h3>
                                {opened.email && (
                                    <p className="flex items-center gap-2"><Mail className="h-4 w-4 text-muted-foreground" aria-hidden />
                                        <a className="underline-offset-4 hover:underline" href={`mailto:${opened.email}`}>{opened.email}</a>
                                    </p>
                                )}
                                {opened.phone && <p className="flex items-center gap-2"><Phone className="h-4 w-4 text-muted-foreground" aria-hidden />{opened.phone}</p>}
                                {opened.gstin && <p className="text-muted-foreground">{_t("gst.gstin")}: <span className="tabular-nums text-foreground">{opened.gstin}</span></p>}
                                {!opened.email && !opened.phone && !opened.gstin && <p className="text-muted-foreground">—</p>}
                            </section>

                            <section className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
                                <div>
                                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{_t("clients.billing")}</h3>
                                    <p className="mt-1 whitespace-pre-line">
                                        {[opened.profile?.address, [opened.profile?.zipCode, opened.profile?.city].filter(Boolean).join(" "), opened.profile?.country].filter(Boolean).join("\n") || "—"}
                                    </p>
                                </div>
                                <div>
                                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{_t("clients.shipping")}</h3>
                                    <p className="mt-1 whitespace-pre-line">
                                        {opened.profile?.shippingAddress
                                            ? [opened.profile.shippingAddress.address, [opened.profile.shippingAddress.zipCode, opened.profile.shippingAddress.city].filter(Boolean).join(" "), opened.profile.shippingAddress.country].filter(Boolean).join("\n")
                                            : _t("clients.sameAsBilling")}
                                    </p>
                                </div>
                            </section>

                            <section className="mt-5 rounded-lg bg-muted/50 p-3">
                                <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                    <StickyNote className="h-3.5 w-3.5" aria-hidden />{_t("clients.notes")}
                                </h3>
                                <p className="mt-1 whitespace-pre-line text-sm">{opened.profile?.notes || _t("clients.noNotes")}</p>
                            </section>

                            <section className="mt-5 grid grid-cols-3 gap-3 text-sm">
                                <div><p className="text-xs text-muted-foreground">{_t("dashboard.clients.billed")}</p><div className="font-semibold tabular-nums"><MoneyLines totals={opened.invoices?.billed ?? {}} /></div></div>
                                <div><p className="text-xs text-muted-foreground">{_t("invoices.payments.paid")}</p><div className="font-semibold tabular-nums text-success"><MoneyLines totals={opened.invoices?.paid ?? {}} /></div></div>
                                <div><p className="text-xs text-muted-foreground">{_t("dashboard.clients.outstanding")}</p><div className="font-semibold tabular-nums"><MoneyLines totals={opened.invoices?.outstanding ?? {}} /></div></div>
                            </section>

                            <section className="mt-6">
                                <div className="mb-2 flex items-center justify-between">
                                    <h3 className="text-sm font-semibold">{_t("clients.history")}</h3>
                                    <GuardedLink href={`/invoices?client=${encodeURIComponent(opened.name)}`} className="text-xs font-medium text-primary hover:underline">
                                        {_t("dashboard.viewAll")}
                                    </GuardedLink>
                                </div>
                                {(() => {
                                    const mine = invoices
                                        .filter((i) => (i.receiver.email || i.receiver.name).trim().toLowerCase() === opened.key)
                                        .sort((a, b) => (parseDate(b.details.invoiceDate)?.getTime() ?? 0) - (parseDate(a.details.invoiceDate)?.getTime() ?? 0));
                                    return mine.length === 0 ? (
                                        <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">{_t("clients.noInvoices")}</p>
                                    ) : (
                                        <ul className="divide-y rounded-lg border">
                                            {mine.map((inv) => (
                                                <li key={inv.details.invoiceNumber} className="flex items-center justify-between gap-3 p-3 text-sm">
                                                    <button type="button" className="min-w-0 text-start hover:underline" onClick={() => loadInvoice(inv)}>
                                                        <span className="block font-medium">{inv.details.invoiceNumber}</span>
                                                        <span className="block text-xs text-muted-foreground">
                                                            {date(parseDate(inv.details.invoiceDate))} · {formatMoney(invoiceTotal(inv), inv.details.currency, locale)}
                                                            {balanceDue(inv) > 0 ? ` · ${_t("invoices.columns.balance")} ${formatMoney(balanceDue(inv), inv.details.currency, locale)}` : ""}
                                                        </span>
                                                    </button>
                                                    <StatusBadge status={displayStatus(inv)} />
                                                </li>
                                            ))}
                                        </ul>
                                    );
                                })()}
                            </section>

                            <section className="mt-6" data-testid="client-quotations">
                                <div className="mb-2 flex items-center justify-between">
                                    <h3 className="text-sm font-semibold">{_t("quotations.customerSection.title")}</h3>
                                    <GuardedLink href={`/quotations?customer=${encodeURIComponent(opened.key)}`} className="text-xs font-medium text-primary hover:underline">
                                        {_t("dashboard.viewAll")}
                                    </GuardedLink>
                                </div>
                                {(() => {
                                    const mine = quotations.filter((q) => (q.doc.receiver.email || q.doc.receiver.name).trim().toLowerCase() === opened.key).reverse();
                                    return mine.length === 0 ? (
                                        <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">{_t("quotations.customerSection.none")}</p>
                                    ) : (
                                        <ul className="divide-y rounded-lg border">
                                            {mine.map((q) => (
                                                <li key={q.id} className="flex items-center justify-between gap-3 p-3 text-sm" data-testid="client-quotation">
                                                    <GuardedLink href={`/quotations?customer=${encodeURIComponent(opened.key)}`} className="min-w-0 text-start hover:underline">
                                                        <span className="block font-medium">{quotationNumber(q)}</span>
                                                        <span className="block text-xs text-muted-foreground">
                                                            {date(validUntilOf(q))} · {formatMoney(quotationTotal(q), currencyOf(q), locale)}
                                                        </span>
                                                        <ExpiryNote quotation={q} />
                                                    </GuardedLink>
                                                    <QuotationStatusBadge status={quotationStatus(q)} />
                                                </li>
                                            ))}
                                        </ul>
                                    );
                                })()}
                            </section>
                        </>
                    )}
                </SheetContent>
            </Sheet>

            <CustomerDialog state={editing} records={records} onClose={() => setEditing(null)} />
            <ImportCustomersDialog open={importing} existing={profiles} onClose={() => setImporting(false)} />
            <DuplicatesDialog groups={groups} open={reviewing} onClose={() => setReviewing(false)} />

            <AlertDialog open={pendingDelete !== null} onOpenChange={(o) => !o && setPendingDelete(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{_t("clients.confirmRemoveTitle", { name: pendingDelete?.name ?? "" })}</AlertDialogTitle>
                        <AlertDialogDescription>{_t("clients.confirmRemoveBody")}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>{_t("guards.cancel")}</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={() => {
                                if (pendingDelete) void remove(pendingDelete);
                                setPendingDelete(null);
                            }}
                        >
                            {_t("clients.remove")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
};

export default ClientsPage;
