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
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/use-toast";
import BaseButton from "@/app/components/reusables/BaseButton";
import NativeSelect from "@/app/components/reusables/NativeSelect";
import SupplierFormDialog from "./SupplierFormDialog";

import { cn } from "@/lib/utils";
import { useSuppliers, usePurchaseOrders } from "@/contexts/usePurchasing";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { Link } from "@/i18n/navigation";
import { GST_STATES } from "@/lib/gst";
import { formatMoney } from "@/lib/invoiceRecords";
import { readParties } from "@/lib/partyStore";
import { downloadBlob } from "@/lib/quotationPdf";
import { deleteSupplier, setSupplierInactive } from "@/lib/supplierStore";
import { EMPTY_SUPPLIER_QUERY, matchingCustomer, querySuppliers, suppliersCsv, type Supplier, type SupplierQuery } from "@/lib/suppliers";

import { ClipboardList, Download, Pencil, Plus, Power, Search, Trash2, Truck } from "lucide-react";

const Metric = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="mt-2 break-words text-xl font-semibold tabular-nums sm:text-2xl">{value}</p>
    </div>
);

const SuppliersPage = () => {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const { suppliers, loaded } = useSuppliers();
    const { orders, loaded: ordersLoaded } = usePurchaseOrders();

    const [query, setQuery] = useState<SupplierQuery>(EMPTY_SUPPLIER_QUERY);
    const [form, setForm] = useState<Supplier | "new" | null>(null);
    const [deleting, setDeleting] = useState<Supplier | null>(null);
    const [customers, setCustomers] = useState<Awaited<ReturnType<typeof readParties>>>([]);

    // The address book, only to flag a supplier that is also a customer.
    useEffect(() => {
        void readParties("receiver").then(setCustomers);
    }, []);

    const rows = useMemo(() => querySuppliers(suppliers, query), [suppliers, query]);
    const orderCount = useMemo(() => {
        const m = new Map<string, number>();
        for (const o of orders) m.set(o.supplierId, (m.get(o.supplierId) ?? 0) + 1);
        return m;
    }, [orders]);

    const metrics = useMemo(() => {
        const active = suppliers.filter((s) => !s.inactive);
        const opening: Record<string, number> = {};
        for (const s of active) if (s.openingBalance > 0) opening[s.currency] = (opening[s.currency] ?? 0) + s.openingBalance;
        return {
            active: active.length,
            withGstin: active.filter((s) => s.gstin).length,
            open: orders.filter((o) => o.status === "sent").length,
            opening,
        };
    }, [suppliers, orders]);

    const states = useMemo(() => [...new Set(suppliers.map((s) => s.state).filter(Boolean))].sort(), [suppliers]);
    const set = (patch: Partial<SupplierQuery>) => setQuery((q) => ({ ...q, ...patch }));
    const filtered = JSON.stringify(query) !== JSON.stringify(EMPTY_SUPPLIER_QUERY);

    const toggleInactive = async (s: Supplier) => {
        const ok = await setSupplierInactive(s.id, !s.inactive);
        toast(ok ? { title: _t(s.inactive ? "suppliers.toast.activated" : "suppliers.toast.deactivated"), description: s.name } : { variant: "destructive", title: _t("suppliers.toast.storage") });
    };

    const confirmDelete = async () => {
        const s = deleting;
        setDeleting(null);
        if (!s) return;
        const result = await deleteSupplier(s.id);
        toast(
            result.ok
                ? { title: _t("suppliers.toast.deleted"), description: s.name }
                : result.reason === "inUse"
                  ? { variant: "destructive", title: _t("suppliers.delete.title"), description: _t("suppliers.delete.inUse", { name: s.name }) }
                  : { variant: "destructive", title: _t("suppliers.toast.storage") }
        );
    };

    const exportCsv = () => downloadBlob(new Blob(["﻿", suppliersCsv(rows)], { type: "text/csv;charset=utf-8" }), "suppliers.csv");

    if (!loaded || !ordersLoaded) return <Skeleton className="h-96 rounded-xl" aria-busy="true" />;

    const openingText = Object.entries(metrics.opening)
        .map(([cur, amt]) => formatMoney(amt, cur, locale))
        .join(" · ");

    return (
        <div className="space-y-6" data-testid="suppliers-page">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{_t("suppliers.title")}</h1>
                    <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{_t("suppliers.subtitle")}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <BaseButton variant="outline" onClick={exportCsv} disabled={rows.length === 0} data-testid="suppliers-export">
                        <Download className="h-4 w-4" />
                        {_t("suppliers.export")}
                    </BaseButton>
                    <BaseButton onClick={() => setForm("new")} data-testid="supplier-new">
                        <Plus className="h-4 w-4" />
                        {_t("suppliers.new")}
                    </BaseButton>
                </div>
            </div>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Metric label={_t("suppliers.metrics.active")} value={metrics.active} />
                <Metric label={_t("suppliers.metrics.withGstin")} value={metrics.withGstin} />
                <Metric label={_t("suppliers.metrics.openOrders")} value={metrics.open} />
                <Metric label={_t("suppliers.metrics.opening")} value={openingText || "—"} />
            </div>

            {suppliers.length === 0 ? (
                <div className="flex flex-col items-center rounded-xl border border-dashed bg-card px-6 py-14 text-center" data-testid="suppliers-empty">
                    <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                        <Truck className="h-6 w-6" />
                    </span>
                    <h2 className="text-lg font-semibold">{_t("suppliers.empty.title")}</h2>
                    <p className="mt-1 max-w-md text-sm text-muted-foreground">{_t("suppliers.empty.body")}</p>
                    <BaseButton className="mt-5" onClick={() => setForm("new")}>
                        <Plus className="h-4 w-4" />
                        {_t("suppliers.empty.cta")}
                    </BaseButton>
                </div>
            ) : (
                <>
                    <div className="flex flex-col gap-2 sm:flex-row">
                        <div className="relative flex-1">
                            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                            <Input
                                type="search"
                                className="ps-9"
                                placeholder={_t("suppliers.search")}
                                aria-label={_t("suppliers.search")}
                                data-testid="suppliers-search"
                                value={query.q}
                                onChange={(e) => set({ q: e.target.value })}
                            />
                        </div>
                        <NativeSelect className="sm:w-40" aria-label={_t("suppliers.filters.active")} data-testid="suppliers-status" value={query.status} onChange={(e) => set({ status: e.target.value as SupplierQuery["status"] })}>
                            <option value="active">{_t("suppliers.filters.active")}</option>
                            <option value="inactive">{_t("suppliers.filters.inactive")}</option>
                            <option value="all">{_t("suppliers.filters.all")}</option>
                        </NativeSelect>
                        {states.length > 0 && (
                            <NativeSelect className="sm:w-48" aria-label={_t("suppliers.filters.state")} value={query.state} onChange={(e) => set({ state: e.target.value })}>
                                <option value="">{_t("suppliers.filters.anyState")}</option>
                                {states.map((code) => (
                                    <option key={code} value={code}>
                                        {code} – {GST_STATES[code] ?? code}
                                    </option>
                                ))}
                            </NativeSelect>
                        )}
                    </div>

                    {rows.length === 0 ? (
                        <p className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground" data-testid="suppliers-nomatch">
                            {_t("suppliers.noMatch")}
                            {filtered && (
                                <BaseButton variant="link" onClick={() => setQuery(EMPTY_SUPPLIER_QUERY)}>
                                    ×
                                </BaseButton>
                            )}
                        </p>
                    ) : (
                        <ul className="grid gap-3 lg:grid-cols-2" data-testid="supplier-list">
                            {rows.map((s) => {
                                const isCustomer = matchingCustomer(s, customers) !== null;
                                const count = orderCount.get(s.id) ?? 0;
                                return (
                                    <li key={s.id} data-testid="supplier-card" data-name={s.name} className={`rounded-xl border bg-card p-4 shadow-sm transition-shadow hover:shadow-md ${s.inactive ? "opacity-70" : ""}`}>
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <h2 className="truncate font-semibold">{s.name}</h2>
                                                <p className="truncate text-sm text-muted-foreground">{[s.contactPerson, s.city].filter(Boolean).join(" · ") || s.email || "—"}</p>
                                            </div>
                                            <div className="flex shrink-0 flex-wrap justify-end gap-1">
                                                {s.inactive && <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{_t("suppliers.card.inactive")}</span>}
                                                {isCustomer && (
                                                    <span title={_t("suppliers.card.alsoCustomerHint")} data-testid="also-customer" className="rounded-full bg-sky-500/10 px-2 py-0.5 text-xs font-medium text-sky-700 dark:text-sky-400">
                                                        {_t("suppliers.card.alsoCustomer")}
                                                    </span>
                                                )}
                                            </div>
                                        </div>

                                        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                                            <dt className="text-muted-foreground">{_t("suppliers.card.gstin")}</dt>
                                            <dd className="truncate text-end font-mono text-xs leading-5">{s.gstin || _t("suppliers.card.noGstin")}</dd>
                                            <dt className="text-muted-foreground">{_t("suppliers.form.terms")}</dt>
                                            <dd className="text-end">{s.paymentTermsDays > 0 ? _t("suppliers.card.terms", { days: s.paymentTermsDays }) : _t("suppliers.card.termsNow")}</dd>
                                            {s.openingBalance > 0 && (
                                                <>
                                                    <dt className="text-muted-foreground">{_t("suppliers.card.opening")}</dt>
                                                    <dd className="text-end tabular-nums">{formatMoney(s.openingBalance, s.currency, locale)}</dd>
                                                </>
                                            )}
                                        </dl>

                                        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                                            <span className="text-xs text-muted-foreground">{_t("suppliers.card.orders", { count })}</span>
                                            <div className="flex flex-wrap items-center gap-1">
                                                {!s.inactive && (
                                                    <Link prefetch={false}
                                                        href={`/purchase-orders?supplier=${encodeURIComponent(s.id)}`}
                                                        className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-8 gap-2")}
                                                    >
                                                        <ClipboardList className="h-3.5 w-3.5" />
                                                        {_t("suppliers.actions.newOrder")}
                                                    </Link>
                                                )}
                                                <BaseButton variant="ghost" size="icon" className="h-8 w-8" aria-label={`${_t("suppliers.actions.edit")}: ${s.name}`} onClick={() => setForm(s)}>
                                                    <Pencil className="h-4 w-4" />
                                                </BaseButton>
                                                <BaseButton variant="ghost" size="icon" className="h-8 w-8" aria-label={`${_t(s.inactive ? "suppliers.actions.activate" : "suppliers.actions.deactivate")}: ${s.name}`} onClick={() => toggleInactive(s)}>
                                                    <Power className="h-4 w-4" />
                                                </BaseButton>
                                                <BaseButton variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" aria-label={`${_t("suppliers.actions.delete")}: ${s.name}`} onClick={() => setDeleting(s)}>
                                                    <Trash2 className="h-4 w-4" />
                                                </BaseButton>
                                            </div>
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </>
            )}

            <SupplierFormDialog open={form !== null} supplier={form === "new" ? null : form} existing={suppliers} onClose={() => setForm(null)} />

            <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{_t("suppliers.delete.title")}</AlertDialogTitle>
                        <AlertDialogDescription>{deleting && _t("suppliers.delete.body", { name: deleting.name })}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>{_t("suppliers.form.cancel")}</AlertDialogCancel>
                        <AlertDialogAction onClick={confirmDelete} data-testid="supplier-delete-confirm">
                            {_t("suppliers.actions.delete")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
};

export default SuppliersPage;
