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
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/use-toast";
import BaseButton from "@/app/components/reusables/BaseButton";
import NativeSelect from "@/app/components/reusables/NativeSelect";
import GoodsReceiptDialog from "./GoodsReceiptDialog";

import { useInventoryData } from "@/contexts/useInventoryData";
import { useInvoiceContext } from "@/contexts/InvoiceContext";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { useGoodsReceipts, usePurchaseOrders, useSuppliers } from "@/contexts/usePurchasing";
import { Link } from "@/i18n/navigation";
import {
    EMPTY_GRN_QUERY,
    accepted,
    goodsReceiptFilename,
    goodsReceiptsCsv,
    queryGoodsReceipts,
    totalsOf,
    type GoodsReceipt,
    type GrnQuery,
} from "@/lib/goodsReceipts";
import { voidGoodsReceipt } from "@/lib/goodsReceiptStore";
import { formatDay } from "@/lib/dates";
import { formatMoney } from "@/lib/invoiceRecords";
import { downloadBlob } from "@/lib/quotationPdf";
import { cn } from "@/lib/utils";

import { Download, PackageCheck, Plus, Search, Ban } from "lucide-react";

const BADGE = {
    posted: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    void: "bg-muted text-muted-foreground line-through",
} as const;

const Metric = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="mt-2 break-words text-xl font-semibold tabular-nums sm:text-2xl">{value}</p>
    </div>
);

const GoodsReceiptsPage = () => {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const { settings, savedLoaded } = useInvoiceContext();
    const { suppliers, loaded: suppliersLoaded } = useSuppliers();
    const { orders, loaded: ordersLoaded } = usePurchaseOrders();
    const { receipts, loaded } = useGoodsReceipts();
    const { products, loaded: inventoryLoaded } = useInventoryData();

    const [query, setQuery] = useState<GrnQuery>(EMPTY_GRN_QUERY);
    const [form, setForm] = useState(false);
    const [presetOrder, setPresetOrder] = useState<string | undefined>();
    const [voiding, setVoiding] = useState<GoodsReceipt | null>(null);
    const [reason, setReason] = useState("");
    const [voidBusy, setVoidBusy] = useState(false);

    // `?po=<id>` (Receive goods, on the order) opens a receipt for that order; `?order=<id>` filters to its receipts.
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const po = params.get("po");
        const order = params.get("order");
        if (po) {
            setPresetOrder(po);
            setForm(true);
        }
        if (order) setQuery((q) => ({ ...q, poId: order }));
        if (po || order) window.history.replaceState(null, "", window.location.pathname);
    }, []);

    const rows = useMemo(() => queryGoodsReceipts(receipts, query), [receipts, query]);
    const orderNumber = useMemo(() => new Map(orders.map((o) => [o.id, o.number])), [orders]);
    const set = (patch: Partial<GrnQuery>) => setQuery((q) => ({ ...q, ...patch }));
    const numFmt = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 3 });

    const metrics = useMemo(() => {
        const posted = receipts.filter((g) => g.status === "posted");
        return {
            posted: posted.length,
            voided: receipts.length - posted.length,
            accepted: posted.reduce((s, g) => s + totalsOf(g).accepted, 0),
            rejected: posted.reduce((s, g) => s + totalsOf(g).rejected, 0),
        };
    }, [receipts]);

    const confirmVoid = async () => {
        const g = voiding;
        if (!g) return;
        setVoidBusy(true);
        const result = await voidGoodsReceipt(g.id, reason);
        setVoidBusy(false);
        if (result.ok) {
            setVoiding(null);
            setReason("");
            toast({ title: _t("goodsReceipts.toast.voided", { number: g.number }) });
            return;
        }
        if (result.reason === "insufficientStock") {
            setVoiding(null);
            toast({
                variant: "destructive",
                title: _t("goodsReceipts.toast.cannotVoid"),
                description: result.shortages.map((s) => _t("goodsReceipts.toast.cannotVoidDetail", { name: s.name, available: numFmt(s.available), needed: numFmt(s.needed) })).join(" · "),
            });
            return;
        }
        setVoiding(null);
        toast({ variant: "destructive", title: _t(result.reason === "alreadyVoid" ? "goodsReceipts.toast.alreadyVoid" : result.reason === "notFound" ? "goodsReceipts.toast.notFound" : "goodsReceipts.toast.storage") });
    };

    const exportCsv = () => downloadBlob(new Blob(["﻿", goodsReceiptsCsv(rows)], { type: "text/csv;charset=utf-8" }), rows.length === 1 ? goodsReceiptFilename(rows[0].number) : "goods-receipts.csv");

    if (!loaded || !suppliersLoaded || !ordersLoaded || !inventoryLoaded || !savedLoaded) return <Skeleton className="h-96 rounded-xl" aria-busy="true" />;

    const activeSuppliers = suppliers.filter((s) => !s.inactive);
    const orderOptions = [...new Map(receipts.filter((g) => g.poId).map((g) => [g.poId!, g.poNumber ?? orderNumber.get(g.poId!) ?? g.poId!])).entries()];

    return (
        <div className="space-y-6" data-testid="goods-receipts-page">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{_t("goodsReceipts.title")}</h1>
                    <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{_t("goodsReceipts.subtitle")}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <BaseButton variant="outline" onClick={exportCsv} disabled={rows.length === 0}>
                        <Download className="h-4 w-4" />
                        {_t("goodsReceipts.export")}
                    </BaseButton>
                    <BaseButton
                        onClick={() => {
                            setPresetOrder(undefined);
                            setForm(true);
                        }}
                        disabled={activeSuppliers.length === 0}
                        data-testid="grn-new"
                    >
                        <Plus className="h-4 w-4" />
                        {_t("goodsReceipts.new")}
                    </BaseButton>
                </div>
            </div>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Metric label={_t("goodsReceipts.metrics.posted")} value={metrics.posted} />
                <Metric label={_t("goodsReceipts.metrics.accepted")} value={numFmt(metrics.accepted)} />
                <Metric label={_t("goodsReceipts.metrics.rejected")} value={numFmt(metrics.rejected)} />
                <Metric label={_t("goodsReceipts.metrics.voided")} value={metrics.voided} />
            </div>

            {receipts.length === 0 ? (
                <div className="flex flex-col items-center rounded-xl border border-dashed bg-card px-6 py-14 text-center" data-testid="grn-empty">
                    <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                        <PackageCheck className="h-6 w-6" />
                    </span>
                    <h2 className="text-lg font-semibold">{_t("goodsReceipts.empty.title")}</h2>
                    <p className="mt-1 max-w-md text-sm text-muted-foreground">{_t(activeSuppliers.length === 0 ? "goodsReceipts.empty.needSupplier" : "goodsReceipts.empty.body")}</p>
                    {activeSuppliers.length === 0 ? (
                        <Link prefetch={false} href="/suppliers" className={cn(buttonVariants(), "mt-5")}>
                            {_t("goodsReceipts.empty.addSupplier")}
                        </Link>
                    ) : (
                        <BaseButton className="mt-5" onClick={() => setForm(true)}>
                            <Plus className="h-4 w-4" />
                            {_t("goodsReceipts.empty.cta")}
                        </BaseButton>
                    )}
                </div>
            ) : (
                <>
                    <div className="flex flex-col gap-2 sm:flex-row">
                        <div className="relative flex-1">
                            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                            <Input type="search" className="ps-9" placeholder={_t("goodsReceipts.search")} aria-label={_t("goodsReceipts.search")} data-testid="grn-search" value={query.q} onChange={(e) => set({ q: e.target.value })} />
                        </div>
                        <NativeSelect className="sm:w-44" aria-label={_t("goodsReceipts.filters.all")} data-testid="grn-status-filter" value={query.status} onChange={(e) => set({ status: e.target.value as GrnQuery["status"] })}>
                            <option value="all">{_t("goodsReceipts.filters.all")}</option>
                            <option value="posted">{_t("goodsReceipts.status.posted")}</option>
                            <option value="void">{_t("goodsReceipts.status.void")}</option>
                        </NativeSelect>
                        {orderOptions.length > 0 && (
                            <NativeSelect className="sm:w-44" aria-label={_t("goodsReceipts.filters.allOrders")} data-testid="grn-order-filter" value={query.poId} onChange={(e) => set({ poId: e.target.value })}>
                                <option value="">{_t("goodsReceipts.filters.allOrders")}</option>
                                {orderOptions.map(([id, number]) => (
                                    <option key={id} value={id}>
                                        {number}
                                    </option>
                                ))}
                            </NativeSelect>
                        )}
                    </div>

                    {rows.length === 0 ? (
                        <p className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground" data-testid="grn-nomatch">
                            {_t("goodsReceipts.noMatch")}
                        </p>
                    ) : (
                        <ul className="space-y-3" data-testid="grn-list">
                            {rows.map((g) => {
                                const t = totalsOf(g);
                                return (
                                    <li key={g.id} data-testid="grn-card" data-number={g.number} data-status={g.status} className="rounded-xl border bg-card p-4 shadow-sm transition-shadow hover:shadow-md">
                                        <div className="flex flex-wrap items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <h2 className="font-mono text-base font-semibold">{g.number}</h2>
                                                    <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium", BADGE[g.status])} data-testid="grn-status">
                                                        {_t(`goodsReceipts.status.${g.status}`)}
                                                    </span>
                                                </div>
                                                <p className="mt-1 truncate text-sm">{g.supplierName}</p>
                                                <p className="mt-0.5 text-xs text-muted-foreground">
                                                    {formatDay(g.date, locale)} · {g.poId ? _t("goodsReceipts.card.order", { number: orderNumber.get(g.poId) ?? g.poNumber ?? "—" }) : _t("goodsReceipts.card.direct")}
                                                    {g.reference ? ` · ${_t("goodsReceipts.card.reference", { ref: g.reference })}` : ""} · {_t("goodsReceipts.card.items", { count: g.lines.length })}
                                                </p>
                                            </div>
                                            <dl className="flex gap-4 text-end text-sm tabular-nums">
                                                <div>
                                                    <dt className="text-xs text-muted-foreground">{_t("goodsReceipts.form.received")}</dt>
                                                    <dd data-testid="grn-received">{numFmt(t.received)}</dd>
                                                </div>
                                                <div>
                                                    <dt className="text-xs text-muted-foreground">{_t("goodsReceipts.form.rejected")}</dt>
                                                    <dd data-testid="grn-rejected">{numFmt(t.rejected)}</dd>
                                                </div>
                                                <div>
                                                    <dt className="text-xs text-muted-foreground">{_t("goodsReceipts.form.accepted")}</dt>
                                                    <dd className="font-semibold" data-testid="grn-accepted">
                                                        {numFmt(t.accepted)}
                                                    </dd>
                                                </div>
                                            </dl>
                                        </div>

                                        <ul className="mt-3 divide-y rounded-lg border text-sm">
                                            {g.lines.map((l) => (
                                                <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
                                                    <span className="min-w-0 truncate">{l.name}</span>
                                                    <span className="tabular-nums text-muted-foreground">
                                                        {numFmt(accepted(l))} / {numFmt(l.received)} {l.unit}
                                                        {l.rejected > 0 ? ` · ${_t("goodsReceipts.card.rejected", { count: numFmt(l.rejected) })}` : ""}
                                                        {l.unitPrice > 0 ? ` · ${formatMoney(l.unitPrice, g.currency, locale)}` : ""}
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>

                                        {(g.priceUpdates.length > 0 || g.status === "void" || g.note) && (
                                            <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                                                {g.priceUpdates.length > 0 && <p data-testid="grn-price-updates">{_t("goodsReceipts.card.prices", { count: g.priceUpdates.length })}</p>}
                                                {g.status === "void" && (
                                                    <p>
                                                        {_t("goodsReceipts.card.voidedOn", { date: formatDay((g.voidedAt ?? "").slice(0, 10), locale) })}
                                                        {g.voidReason ? ` · ${_t("goodsReceipts.card.reason", { reason: g.voidReason })}` : ""}
                                                    </p>
                                                )}
                                                {g.note && <p>{g.note}</p>}
                                            </div>
                                        )}

                                        {g.status === "posted" && (
                                            <div className="mt-3 flex justify-end border-t pt-3">
                                                <BaseButton variant="ghost" size="sm" className="h-8 gap-1.5 text-destructive hover:text-destructive" onClick={() => setVoiding(g)} data-testid="grn-void">
                                                    <Ban className="h-3.5 w-3.5" />
                                                    {_t("goodsReceipts.actions.void")}
                                                </BaseButton>
                                            </div>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </>
            )}

            <GoodsReceiptDialog
                open={form}
                presetOrderId={presetOrder}
                suppliers={suppliers}
                orders={orders}
                receipts={receipts}
                products={products}
                prefix={settings.purchase.grnPrefix}
                onClose={() => {
                    setForm(false);
                    setPresetOrder(undefined);
                }}
            />

            <AlertDialog
                open={voiding !== null}
                onOpenChange={(o) => {
                    if (!o && !voidBusy) {
                        setVoiding(null);
                        setReason("");
                    }
                }}
            >
                <AlertDialogContent data-testid="grn-void-dialog">
                    <AlertDialogHeader>
                        <AlertDialogTitle>{voiding && _t("goodsReceipts.confirm.voidTitle", { number: voiding.number })}</AlertDialogTitle>
                        <AlertDialogDescription>{voiding && _t("goodsReceipts.confirm.voidBody", { units: numFmt(totalsOf(voiding).accepted) })}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <div className="space-y-1.5">
                        <label htmlFor="grn-void-reason" className="text-sm font-medium">
                            {_t("goodsReceipts.confirm.voidReason")}
                        </label>
                        <Textarea id="grn-void-reason" data-testid="grn-void-reason" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
                    </div>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={voidBusy}>{_t("goodsReceipts.confirm.keep")}</AlertDialogCancel>
                        <AlertDialogAction
                            disabled={voidBusy}
                            onClick={(e) => {
                                e.preventDefault();
                                void confirmVoid();
                            }}
                            data-testid="grn-void-confirm"
                        >
                            {_t("goodsReceipts.confirm.voidConfirm")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
};

export default GoodsReceiptsPage;
