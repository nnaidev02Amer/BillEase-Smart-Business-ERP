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
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/use-toast";

import BaseButton from "@/app/components/reusables/BaseButton";
import GuardedLink from "@/app/components/layout/GuardedLink";
import HistoryDialog from "./HistoryDialog";
import PaymentsDialog from "./PaymentsDialog";
import StatusBadge from "./StatusBadge";

import { useInvoiceContext } from "@/contexts/InvoiceContext";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { INVOICE_STATUSES } from "@/lib/schemas";
import {
    DISPLAY_STATUSES,
    EMPTY_QUERY,
    balanceDue,
    displayStatus,
    formatMoney,
    hasActiveFilters,
    invoiceTotal,
    invoicesToCsv,
    parseDate,
    queryInvoices,
    storedStatus,
    type DisplayStatus,
    type InvoiceQuery,
    type SortKey,
    type StoredStatus,
} from "@/lib/invoiceRecords";
import type { InvoiceType } from "@/types";

import {
    ArrowDown,
    ArrowUp,
    Banknote,
    Copy,
    Download,
    FilePlus2,
    History,
    Pencil,
    Repeat,
    Search,
    SlidersHorizontal,
    Trash2,
} from "lucide-react";

const SORT_KEYS: SortKey[] = ["date", "due", "amount", "balance", "status", "number", "client"];

const RowButton = ({
    label,
    number,
    onClick,
    children,
    danger,
}: {
    label: string;
    number: string;
    onClick: () => void;
    children: React.ReactNode;
    danger?: boolean;
}) => (
    <BaseButton
        variant="ghost"
        size="icon"
        className={danger ? "text-destructive hover:text-destructive" : undefined}
        aria-label={`${label} ${number}`}
        tooltipLabel={label}
        onClick={onClick}
    >
        {children}
    </BaseButton>
);

const InvoicesPanel = () => {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const { savedInvoices: invoices, savedLoaded, loadInvoice, duplicateInvoice, deleteInvoiceByNumber, changeStatus } =
        useInvoiceContext();

    const [query, setQuery] = useState<InvoiceQuery>(EMPTY_QUERY);
    const [advanced, setAdvanced] = useState(false);
    const [pendingDelete, setPendingDelete] = useState<string | null>(null);
    const [paymentsFor, setPaymentsFor] = useState<string | null>(null);
    const [historyFor, setHistoryFor] = useState<string | null>(null);

    const patch = (p: Partial<InvoiceQuery>) => setQuery((q) => ({ ...q, ...p }));

    // Links from elsewhere (a client profile) arrive pre-filtered.
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const client = params.get("client");
        const status = params.get("status") as DisplayStatus | null;
        if (client || status) {
            setQuery((q) => ({
                ...q,
                client: client ?? undefined,
                status: status && DISPLAY_STATUSES.includes(status) ? status : "all",
            }));
            if (client) setAdvanced(true);
        }
    }, []);

    const clients = useMemo(
        () => [...new Set(invoices.map((i) => i.receiver.name))].sort((a, b) => a.localeCompare(b)),
        [invoices]
    );
    const currencies = useMemo(() => [...new Set(invoices.map((i) => i.details.currency))].sort(), [invoices]);

    const rows = useMemo(() => queryInvoices(invoices, query), [invoices, query]);
    const filtered = hasActiveFilters(query);
    const date = (v: unknown) =>
        parseDate(v)?.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" }) ?? "—";

    const onDuplicate = (number: string) => {
        const created = duplicateInvoice(number);
        if (created)
            toast({
                title: _t("dashboard.toast.duplicated"),
                description: _t("dashboard.toast.duplicatedBody", { number: created }),
            });
    };

    const onStatus = (number: string, next: StoredStatus) => {
        const result = changeStatus(number, next);
        toast(
            result.ok
                ? { title: _t("dashboard.toast.statusUpdated"), description: `${number}: ${_t(`dashboard.status.${next}`)}` }
                : { variant: "destructive", title: _t(`invoices.errors.${result.reason}`), description: result.detail }
        );
    };

    const onConfirmDelete = () => {
        if (pendingDelete === null) return;
        deleteInvoiceByNumber(pendingDelete);
        setPendingDelete(null);
        toast({ title: _t("dashboard.toast.deleted") });
    };

    const exportCsv = () => {
        const blob = new Blob([invoicesToCsv(rows)], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `invoices-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast({ title: _t("dashboard.toast.exported") });
    };

    const actions = (inv: InvoiceType) => {
        const n = inv.details.invoiceNumber;
        return (
            <div className="flex items-center justify-end gap-0.5">
                <RowButton number={n} label={_t("dashboard.invoices.edit")} onClick={() => loadInvoice(inv)}>
                    <Pencil className="h-4 w-4" />
                </RowButton>
                <RowButton number={n} label={_t("invoices.payments.open")} onClick={() => setPaymentsFor(n)}>
                    <Banknote className="h-4 w-4" />
                </RowButton>
                <RowButton number={n} label={_t("invoices.history.open")} onClick={() => setHistoryFor(n)}>
                    <History className="h-4 w-4" />
                </RowButton>
                <RowButton number={n} label={_t("dashboard.invoices.duplicate")} onClick={() => onDuplicate(n)}>
                    <Copy className="h-4 w-4" />
                </RowButton>
                <RowButton number={n} label={_t("dashboard.invoices.delete")} onClick={() => setPendingDelete(n)} danger>
                    <Trash2 className="h-4 w-4" />
                </RowButton>
            </div>
        );
    };

    const statusSelect = (inv: InvoiceType) => (
        <Select value={storedStatus(inv)} onValueChange={(v) => onStatus(inv.details.invoiceNumber, v as StoredStatus)}>
            <SelectTrigger
                className="h-8 w-[9.5rem]"
                aria-label={`${_t("dashboard.invoices.setStatus")} ${inv.details.invoiceNumber}`}
            >
                {/* Shows the derived status, so paid / partial / overdue are visible. */}
                <SelectValue>
                    <StatusBadge status={displayStatus(inv)} />
                </SelectValue>
            </SelectTrigger>
            <SelectContent>
                {INVOICE_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                        {_t(`dashboard.status.${s}`)}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );

    const recurringMark = (inv: InvoiceType) =>
        (inv.details.recurring?.frequency ?? "none") !== "none" ? (
            <span title={_t("invoices.recurring")} className="ms-1.5 inline-flex align-middle text-primary">
                <Repeat className="h-3.5 w-3.5" aria-label={_t("invoices.recurring")} />
            </span>
        ) : null;

    if (!savedLoaded) return <Skeleton className="h-96 rounded-xl" aria-busy="true" />;

    if (invoices.length === 0) {
        return (
            <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center">
                <div className="rounded-full bg-primary/10 p-4 text-primary">
                    <FilePlus2 className="h-8 w-8" aria-hidden />
                </div>
                <h2 className="text-lg font-semibold">{_t("dashboard.empty.title")}</h2>
                <p className="max-w-md text-sm text-muted-foreground">{_t("dashboard.empty.body")}</p>
                <GuardedLink
                    href="/"
                    className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                    {_t("dashboard.empty.cta")}
                </GuardedLink>
            </div>
        );
    }

    return (
        <section aria-labelledby="invoices-heading" className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <h2 id="invoices-heading" className="text-lg font-semibold">
                    {_t("dashboard.invoices.heading")}
                </h2>

                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                    <div className="relative">
                        <Search
                            aria-hidden
                            className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                        />
                        <Input
                            type="search"
                            data-shortcut-search
                            value={query.search}
                            onChange={(e) => patch({ search: e.target.value })}
                            placeholder={_t("dashboard.invoices.search")}
                            aria-label={_t("dashboard.invoices.search")}
                            className="ps-9 sm:w-72"
                        />
                    </div>

                    <Select value={query.status} onValueChange={(v) => patch({ status: v as DisplayStatus | "all" })}>
                        <SelectTrigger className="sm:w-40" aria-label={_t("dashboard.status.all")}>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">{_t("dashboard.status.all")}</SelectItem>
                            {DISPLAY_STATUSES.map((s) => (
                                <SelectItem key={s} value={s}>
                                    {_t(`dashboard.status.${s}`)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>

                    <div className="flex gap-2">
                        <Select value={query.sortKey} onValueChange={(v) => patch({ sortKey: v as SortKey })}>
                            <SelectTrigger className="w-full sm:w-40" aria-label={_t("dashboard.invoices.sortBy")}>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {SORT_KEYS.map((k) => (
                                    <SelectItem key={k} value={k}>
                                        {_t("dashboard.invoices.sortBy")}: {_t(`dashboard.invoices.sort.${k}`)}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <BaseButton
                            variant="outline"
                            size="icon"
                            aria-label={query.sortDir === "asc" ? _t("dashboard.invoices.asc") : _t("dashboard.invoices.desc")}
                            tooltipLabel={query.sortDir === "asc" ? _t("dashboard.invoices.asc") : _t("dashboard.invoices.desc")}
                            onClick={() => patch({ sortDir: query.sortDir === "asc" ? "desc" : "asc" })}
                        >
                            {query.sortDir === "asc" ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
                        </BaseButton>
                        <BaseButton
                            variant={advanced ? "secondary" : "outline"}
                            size="icon"
                            aria-pressed={advanced}
                            aria-label={_t("invoices.filters.toggle")}
                            tooltipLabel={_t("invoices.filters.toggle")}
                            onClick={() => setAdvanced((a) => !a)}
                        >
                            <SlidersHorizontal className="h-4 w-4" />
                        </BaseButton>
                        <BaseButton
                            variant="outline"
                            size="icon"
                            aria-label={_t("dashboard.invoices.exportCsv")}
                            tooltipLabel={_t("dashboard.invoices.exportCsv")}
                            onClick={exportCsv}
                            disabled={rows.length === 0}
                        >
                            <Download className="h-4 w-4" />
                        </BaseButton>
                    </div>
                </div>
            </div>

            {advanced && (
                <div className="mt-4 grid grid-cols-1 gap-3 rounded-lg bg-muted/40 p-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="advanced-filters">
                    <div className="space-y-1.5">
                        <Label>{_t("invoices.filters.client")}</Label>
                        <Select value={query.client ?? "__all"} onValueChange={(v) => patch({ client: v === "__all" ? undefined : v })}>
                            <SelectTrigger aria-label={_t("invoices.filters.client")}>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="__all">{_t("invoices.filters.anyClient")}</SelectItem>
                                {clients.map((c) => (
                                    <SelectItem key={c} value={c}>
                                        {c}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-1.5">
                        <Label>{_t("invoices.filters.currency")}</Label>
                        <Select value={query.currency ?? "__all"} onValueChange={(v) => patch({ currency: v === "__all" ? undefined : v })}>
                            <SelectTrigger aria-label={_t("invoices.filters.currency")}>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="__all">{_t("invoices.filters.anyCurrency")}</SelectItem>
                                {currencies.map((c) => (
                                    <SelectItem key={c} value={c}>
                                        {c}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1.5">
                            <Label htmlFor="f-min">{_t("invoices.filters.min")}</Label>
                            <Input
                                id="f-min"
                                type="number"
                                min="0"
                                inputMode="decimal"
                                value={query.minAmount ?? ""}
                                onChange={(e) => patch({ minAmount: e.target.value === "" ? null : Number(e.target.value) })}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="f-max">{_t("invoices.filters.max")}</Label>
                            <Input
                                id="f-max"
                                type="number"
                                min="0"
                                inputMode="decimal"
                                value={query.maxAmount ?? ""}
                                onChange={(e) => patch({ maxAmount: e.target.value === "" ? null : Number(e.target.value) })}
                            />
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1.5">
                            <Label htmlFor="f-from">{_t("invoices.filters.from")}</Label>
                            <Input id="f-from" type="date" value={query.from ?? ""} onChange={(e) => patch({ from: e.target.value || undefined })} />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="f-to">{_t("invoices.filters.to")}</Label>
                            <Input id="f-to" type="date" value={query.to ?? ""} onChange={(e) => patch({ to: e.target.value || undefined })} />
                        </div>
                    </div>
                    <label className="flex items-center gap-2 text-sm sm:col-span-2 lg:col-span-4">
                        <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-input"
                            checked={!!query.recurringOnly}
                            onChange={(e) => patch({ recurringOnly: e.target.checked })}
                        />
                        {_t("invoices.filters.recurringOnly")}
                    </label>
                </div>
            )}

            <div className="mt-3 flex items-center gap-3 text-sm text-muted-foreground">
                <p aria-live="polite">{_t("dashboard.invoices.count", { shown: rows.length, total: invoices.length })}</p>
                {filtered && (
                    <button
                        type="button"
                        className="rounded font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => setQuery((q) => ({ ...EMPTY_QUERY, sortKey: q.sortKey, sortDir: q.sortDir }))}
                    >
                        {_t("dashboard.invoices.clearFilters")}
                    </button>
                )}
            </div>

            {rows.length === 0 ? (
                <div className="mt-6 rounded-lg border border-dashed py-10 text-center">
                    <p className="text-sm text-muted-foreground">{_t("dashboard.invoices.noResults")}</p>
                </div>
            ) : (
                <>
                    <div className="mt-4 hidden md:block">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{_t("dashboard.invoices.columns.number")}</TableHead>
                                    <TableHead>{_t("dashboard.invoices.columns.client")}</TableHead>
                                    <TableHead>{_t("dashboard.invoices.columns.date")}</TableHead>
                                    <TableHead>{_t("dashboard.invoices.columns.due")}</TableHead>
                                    <TableHead className="text-end">{_t("dashboard.invoices.columns.amount")}</TableHead>
                                    <TableHead className="text-end">{_t("invoices.columns.balance")}</TableHead>
                                    <TableHead>{_t("dashboard.invoices.columns.status")}</TableHead>
                                    <TableHead className="text-end">{_t("dashboard.invoices.columns.actions")}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {rows.map((inv) => (
                                    <TableRow key={inv.details.invoiceNumber} data-testid="invoice-row">
                                        <TableCell className="whitespace-nowrap font-medium">
                                            {inv.details.invoiceNumber}
                                            {recurringMark(inv)}
                                        </TableCell>
                                        <TableCell>
                                            <div className="max-w-[12rem] truncate">{inv.receiver.name}</div>
                                            <div className="max-w-[12rem] truncate text-xs text-muted-foreground">{inv.receiver.email}</div>
                                        </TableCell>
                                        <TableCell className="whitespace-nowrap">{date(inv.details.invoiceDate)}</TableCell>
                                        <TableCell className="whitespace-nowrap">{date(inv.details.dueDate)}</TableCell>
                                        <TableCell className="whitespace-nowrap text-end font-medium tabular-nums">
                                            {formatMoney(invoiceTotal(inv), inv.details.currency, locale)}
                                        </TableCell>
                                        <TableCell className="whitespace-nowrap text-end tabular-nums text-muted-foreground">
                                            {formatMoney(balanceDue(inv), inv.details.currency, locale)}
                                        </TableCell>
                                        <TableCell>{statusSelect(inv)}</TableCell>
                                        <TableCell>{actions(inv)}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>

                    <ul className="mt-4 space-y-3 md:hidden">
                        {rows.map((inv) => (
                            <li key={inv.details.invoiceNumber} data-testid="invoice-row" className="rounded-lg border p-3">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="font-medium">
                                            {inv.details.invoiceNumber}
                                            {recurringMark(inv)}
                                        </p>
                                        <p className="truncate text-sm text-muted-foreground">{inv.receiver.name}</p>
                                    </div>
                                    <div className="text-end">
                                        <p className="whitespace-nowrap font-semibold tabular-nums">
                                            {formatMoney(invoiceTotal(inv), inv.details.currency, locale)}
                                        </p>
                                        <p className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                                            {_t("invoices.columns.balance")}: {formatMoney(balanceDue(inv), inv.details.currency, locale)}
                                        </p>
                                    </div>
                                </div>
                                <p className="mt-1 text-xs text-muted-foreground">
                                    {date(inv.details.invoiceDate)} → {date(inv.details.dueDate)}
                                </p>
                                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                                    {statusSelect(inv)}
                                    {actions(inv)}
                                </div>
                            </li>
                        ))}
                    </ul>
                </>
            )}

            <PaymentsDialog number={paymentsFor} onClose={() => setPaymentsFor(null)} />
            <HistoryDialog number={historyFor} onClose={() => setHistoryFor(null)} />

            <AlertDialog open={pendingDelete !== null} onOpenChange={(o) => !o && setPendingDelete(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{_t("dashboard.confirmDelete.title", { number: pendingDelete ?? "" })}</AlertDialogTitle>
                        <AlertDialogDescription>{_t("dashboard.confirmDelete.body")}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>{_t("dashboard.confirmDelete.cancel")}</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={onConfirmDelete}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                            {_t("dashboard.confirmDelete.confirm")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </section>
    );
};

export default InvoicesPanel;
