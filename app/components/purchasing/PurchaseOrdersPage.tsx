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
import PurchaseOrderDialog from "./PurchaseOrderDialog";

import { useInvoiceContext } from "@/contexts/InvoiceContext";
import { useInventoryData } from "@/contexts/useInventoryData";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { useGoodsReceipts, usePurchaseBills, usePurchaseOrders, useSuppliers } from "@/contexts/usePurchasing";
import { Link } from "@/i18n/navigation";
import { canReceiveAgainst, hasAnyReceipts, hasPostedReceipts, receivedByLine, receivedByOrder } from "@/lib/goodsReceipts";
import { billedByLine, linesFromOrder } from "@/lib/purchaseBills";
import { formatDay } from "@/lib/dates";
import { formatMoney } from "@/lib/invoiceRecords";
import { toDay } from "@/lib/expenses";
import { downloadBlob, openBlobInTab } from "@/lib/quotationPdf";
import { fetchPurchaseOrderPdf } from "@/lib/purchaseOrderPdf";
import { changePurchaseOrderStatus, deletePurchaseOrder, savePurchaseOrder } from "@/lib/purchaseOrderStore";
import {
    EMPTY_PO_QUERY,
    canDelete,
    canEdit,
    canTransition,
    displayStatus,
    poPdfIssues,
    poToDocument,
    poTotals,
    purchaseOrderFilename,
    purchaseOrdersCsv,
    queryPurchaseOrders,
    receiptProgress,
    summarisePurchaseOrders,
    type PoDisplayStatus,
    type PoQuery,
    type PoStatus,
    type PurchaseOrder,
} from "@/lib/purchaseOrders";
import { newId } from "@/lib/repository";
import { businessState } from "@/lib/suppliers";
import { cn } from "@/lib/utils";

import { AlertTriangle, PackageCheck, ClipboardList, Copy, Download, FileDown, Pencil, Plus, Printer, Search, Send, Trash2, Undo2, XCircle, CheckCircle2, RotateCcw } from "lucide-react";

const BADGE: Record<PoDisplayStatus, string> = {
    draft: "bg-muted text-muted-foreground",
    sent: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
    partiallyReceived: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    received: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    overdue: "bg-destructive/10 text-destructive",
    closed: "bg-slate-500/10 text-slate-700 dark:text-slate-300",
    cancelled: "bg-muted text-muted-foreground line-through",
};

const DISPLAY_STATUSES: PoDisplayStatus[] = ["draft", "sent", "partiallyReceived", "received", "overdue", "closed", "cancelled"];

const Metric = ({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) => (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className={cn("mt-2 break-words text-xl font-semibold tabular-nums sm:text-2xl", tone)}>{value}</p>
    </div>
);

const PurchaseOrdersPage = () => {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const { settings, savedLoaded } = useInvoiceContext();
    const { suppliers, loaded: suppliersLoaded } = useSuppliers();
    const { orders, loaded } = usePurchaseOrders();
    const { receipts, loaded: receiptsLoaded } = useGoodsReceipts();
    const { bills, loaded: billsLoaded } = usePurchaseBills();
    const { products, movements, loaded: inventoryLoaded } = useInventoryData();

    const business = settings.business;
    const buyerState = businessState(business);

    const [query, setQuery] = useState<PoQuery>(EMPTY_PO_QUERY);
    const [form, setForm] = useState<PurchaseOrder | "new" | null>(null);
    const [presetSupplier, setPresetSupplier] = useState<string | undefined>();
    const [confirm, setConfirm] = useState<{ kind: "cancel" | "delete"; order: PurchaseOrder } | null>(null);
    const [pdfBusy, setPdfBusy] = useState<string | null>(null);

    // `?supplier=<id>` (from the Suppliers page) opens a new order for that supplier.
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const id = params.get("supplier");
        if (id) {
            setPresetSupplier(id);
            setForm("new");
            window.history.replaceState(null, "", window.location.pathname);
        }
    }, []);

    // Every order's received quantities in one map. Order line ids are unique, so merging is safe.
    const received = useMemo(() => {
        const all = new Map<string, number>();
        for (const m of receivedByOrder(receipts).values()) for (const [lineId, qty] of m) all.set(lineId, qty);
        return all;
    }, [receipts]);
    const rows = useMemo(() => queryPurchaseOrders(orders, query, received), [orders, query, received]);
    const summary = useMemo(() => summarisePurchaseOrders(orders, buyerState, received), [orders, buyerState, received]);
    const set = (patch: Partial<PoQuery>) => setQuery((q) => ({ ...q, ...patch }));
    const money = (n: number, currency: string) => formatMoney(n, currency, locale);
    const statusLabel = (s: PoDisplayStatus) => _t(`purchaseOrders.status.${s}`);

    const openValue = Object.entries(summary.openValue)
        .map(([cur, amt]) => money(amt, cur))
        .join(" · ");

    const move = async (po: PurchaseOrder, to: PoStatus) => {
        const r = await changePurchaseOrderStatus(po.id, to);
        toast(
            r.ok
                ? { title: _t("purchaseOrders.toast.status", { number: po.number, status: statusLabel(to).toLowerCase() }) }
                : { variant: "destructive", title: _t(r.reason === "storage" ? "purchaseOrders.toast.storage" : "purchaseOrders.toast.notAllowed") }
        );
    };

    const buildPdf = async (po: PurchaseOrder): Promise<Blob | null> => {
        const issues = poPdfIssues(po, business);
        if (issues.length > 0) {
            const parties = [...new Set(issues.map((i) => (i.startsWith("sender") ? "sender" : i.startsWith("receiver") ? "receiver" : i === "gst" ? "gst" : "other")))];
            toast({ variant: "destructive", title: _t("purchaseOrders.toast.pdfIncomplete", { parties: parties.map((p) => _t(`purchaseOrders.pdfParty.${p}`)).join(", ") }) });
            return null;
        }
        setPdfBusy(po.id);
        try {
            return await fetchPurchaseOrderPdf(poToDocument(po, business, locale), locale);
        } catch {
            toast({ variant: "destructive", title: _t("purchaseOrders.toast.pdfFailed") });
            return null;
        } finally {
            setPdfBusy(null);
        }
    };

    const download = async (po: PurchaseOrder) => {
        const blob = await buildPdf(po);
        if (blob) downloadBlob(blob, purchaseOrderFilename(po.number));
    };

    const print = async (po: PurchaseOrder) => {
        const blob = await buildPdf(po);
        if (blob && !openBlobInTab(blob)) toast({ title: _t("purchaseOrders.toast.popup") });
    };

    const duplicate = async (po: PurchaseOrder) => {
        const r = await savePurchaseOrder({
            number: "",
            supplierId: po.supplierId,
            date: toDay(new Date()),
            expectedDate: "",
            currency: po.currency,
            lines: po.lines.map((l) => ({ ...l, id: newId("line") })),
            discount: po.discount,
            freight: po.freight,
            gstEnabled: po.gstEnabled,
            paymentTerms: po.paymentTerms,
            notes: po.notes,
            terms: po.terms,
            prefix: settings.purchase.poPrefix,
        });
        toast(r.ok ? { title: _t("purchaseOrders.toast.duplicated"), description: r.order.number } : { variant: "destructive", title: _t("purchaseOrders.toast.notAllowed") });
    };

    const runConfirmed = async () => {
        const c = confirm;
        setConfirm(null);
        if (!c) return;
        if (c.kind === "cancel") return void (await move(c.order, "cancelled"));
        const r = await deletePurchaseOrder(c.order.id);
        toast(r.ok ? { title: _t("purchaseOrders.toast.deleted"), description: c.order.number } : { variant: "destructive", title: _t(r.reason === "storage" ? "purchaseOrders.toast.storage" : "purchaseOrders.toast.notAllowed") });
    };

    const exportCsv = () => downloadBlob(new Blob(["﻿", purchaseOrdersCsv(rows, buyerState)], { type: "text/csv;charset=utf-8" }), "purchase-orders.csv");

    if (!loaded || !receiptsLoaded || !billsLoaded || !suppliersLoaded || !inventoryLoaded || !savedLoaded) return <Skeleton className="h-96 rounded-xl" aria-busy="true" />;

    const activeSuppliers = suppliers.filter((s) => !s.inactive);
    const small = "h-8 gap-1.5";

    return (
        <div className="space-y-6" data-testid="purchase-orders-page">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{_t("purchaseOrders.title")}</h1>
                    <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{_t("purchaseOrders.subtitle")}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <BaseButton variant="outline" onClick={exportCsv} disabled={rows.length === 0}>
                        <Download className="h-4 w-4" />
                        {_t("purchaseOrders.export")}
                    </BaseButton>
                    <BaseButton onClick={() => { setPresetSupplier(undefined); setForm("new"); }} disabled={activeSuppliers.length === 0} data-testid="po-new">
                        <Plus className="h-4 w-4" />
                        {_t("purchaseOrders.new")}
                    </BaseButton>
                </div>
            </div>

            {!buyerState && (
                <div role="note" className="flex flex-col gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 sm:flex-row sm:items-center" data-testid="po-business-banner">
                    <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
                    <div className="flex-1 text-sm">
                        <p className="font-semibold">{_t("purchaseOrders.needBusiness.title")}</p>
                        <p className="text-muted-foreground">{_t("purchaseOrders.needBusiness.body")}</p>
                    </div>
                    <Link prefetch={false} href="/settings#business" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")}>
                        {_t("purchaseOrders.needBusiness.action")}
                    </Link>
                </div>
            )}

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Metric label={_t("purchaseOrders.metrics.open")} value={summary.open} />
                <Metric label={_t("purchaseOrders.metrics.openValue")} value={openValue || "—"} />
                <Metric label={_t("purchaseOrders.metrics.overdue")} value={summary.overdue} tone={summary.overdue > 0 ? "text-destructive" : undefined} />
                <Metric label={_t("purchaseOrders.metrics.drafts")} value={summary.draft} />
            </div>

            {orders.length === 0 ? (
                <div className="flex flex-col items-center rounded-xl border border-dashed bg-card px-6 py-14 text-center" data-testid="po-empty">
                    <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                        <ClipboardList className="h-6 w-6" />
                    </span>
                    <h2 className="text-lg font-semibold">{_t("purchaseOrders.empty.title")}</h2>
                    <p className="mt-1 max-w-md text-sm text-muted-foreground">{_t(activeSuppliers.length === 0 ? "purchaseOrders.empty.needSupplier" : "purchaseOrders.empty.body")}</p>
                    {activeSuppliers.length === 0 ? (
                        <Link prefetch={false} href="/suppliers" className={cn(buttonVariants(), "mt-5")}>
                            {_t("purchaseOrders.empty.addSupplier")}
                        </Link>
                    ) : (
                        <BaseButton className="mt-5" onClick={() => setForm("new")}>
                            <Plus className="h-4 w-4" />
                            {_t("purchaseOrders.empty.cta")}
                        </BaseButton>
                    )}
                </div>
            ) : (
                <>
                    <div className="flex flex-col gap-2 sm:flex-row">
                        <div className="relative flex-1">
                            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                            <Input type="search" className="ps-9" placeholder={_t("purchaseOrders.search")} aria-label={_t("purchaseOrders.search")} data-testid="po-search" value={query.q} onChange={(e) => set({ q: e.target.value })} />
                        </div>
                        <NativeSelect className="sm:w-48" aria-label={_t("purchaseOrders.filters.all")} data-testid="po-status-filter" value={query.status} onChange={(e) => set({ status: e.target.value as PoQuery["status"] })}>
                            <option value="all">{_t("purchaseOrders.filters.all")}</option>
                            {DISPLAY_STATUSES.map((s) => (
                                <option key={s} value={s}>
                                    {statusLabel(s)}
                                </option>
                            ))}
                        </NativeSelect>
                        <NativeSelect className="sm:w-48" aria-label={_t("purchaseOrders.filters.allSuppliers")} value={query.supplierId} onChange={(e) => set({ supplierId: e.target.value })}>
                            <option value="">{_t("purchaseOrders.filters.allSuppliers")}</option>
                            {[...new Map(orders.map((o) => [o.supplierId, o.supplier.name])).entries()].map(([id, name]) => (
                                <option key={id} value={id}>
                                    {name}
                                </option>
                            ))}
                        </NativeSelect>
                    </div>

                    {rows.length === 0 ? (
                        <p className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground" data-testid="po-nomatch">
                            {_t("purchaseOrders.noMatch")}
                        </p>
                    ) : (
                        <ul className="space-y-3" data-testid="po-list">
                            {rows.map((po) => {
                                const status = displayStatus(po, received);
                                const total = poTotals(po, buyerState).total;
                                const progress = receiptProgress(po, received);
                                // Goods received or a bill posted settle the order: it can no longer be cancelled or reverted.
                                const billed = bills.some((b) => b.poId === po.id && b.status === "posted");
                                const hasPosted = hasPostedReceipts(receipts, po.id) || billed;
                                const anyBill = bills.some((b) => b.poId === po.id);
                                const billable = linesFromOrder(po, receivedByLine(receipts, po.id), billedByLine(bills, po.id), () => "x").length > 0;
                                const receiptCount = receipts.filter((g) => g.poId === po.id).length;
                                const busy = pdfBusy === po.id;
                                return (
                                    <li key={po.id} data-testid="po-card" data-number={po.number} data-status={status} className="rounded-xl border bg-card p-4 shadow-sm transition-shadow hover:shadow-md">
                                        <div className="flex flex-wrap items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <h2 className="font-mono text-base font-semibold">{po.number}</h2>
                                                    <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium", BADGE[status])} data-testid="po-status">
                                                        {statusLabel(status)}
                                                    </span>
                                                </div>
                                                <p className="mt-1 truncate text-sm">{po.supplier.name}</p>
                                                <p className="mt-0.5 text-xs text-muted-foreground">
                                                    {formatDay(po.date, locale)} · {po.expectedDate ? _t("purchaseOrders.card.expected", { date: formatDay(po.expectedDate, locale) }) : _t("purchaseOrders.card.noExpected")} · {_t("purchaseOrders.card.items", { count: po.lines.length })}
                                                </p>
                                            </div>
                                            <p className="text-lg font-semibold tabular-nums" data-testid="po-card-total">
                                                {money(total, po.currency)}
                                            </p>
                                        </div>

                                        {(po.status === "sent" || po.status === "closed") && progress.received > 0 && (
                                            <div className="mt-3" data-testid="po-progress">
                                                <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                                                    <span>{_t("purchaseOrders.card.progress", { received: progress.received.toLocaleString(locale, { maximumFractionDigits: 3 }), ordered: progress.ordered.toLocaleString(locale, { maximumFractionDigits: 3 }) })}</span>
                                                    <span>{Math.round(progress.fraction * 100)}%</span>
                                                </div>
                                                <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.fraction * 100)}>
                                                    <div className={cn("h-full rounded-full", progress.fraction >= 1 ? "bg-emerald-500" : "bg-sky-500")} style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
                                                </div>
                                            </div>
                                        )}

                                        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t pt-3">
                                            {canEdit(po) && (
                                                <BaseButton variant="outline" size="sm" className={small} onClick={() => setForm(po)} data-testid="po-edit">
                                                    <Pencil className="h-3.5 w-3.5" />
                                                    {_t("purchaseOrders.actions.edit")}
                                                </BaseButton>
                                            )}
                                            {po.status === "draft" && (
                                                <BaseButton size="sm" className={small} onClick={() => move(po, "sent")} data-testid="po-mark-sent">
                                                    <Send className="h-3.5 w-3.5" />
                                                    {_t("purchaseOrders.actions.markSent")}
                                                </BaseButton>
                                            )}
                                            {canReceiveAgainst(po) && progress.fraction < 1 && (
                                                <Link prefetch={false} href={`/goods-receipts?po=${encodeURIComponent(po.id)}`} className={cn(buttonVariants({ size: "sm" }), small)} data-testid="po-receive">
                                                    <PackageCheck className="h-3.5 w-3.5" />
                                                    {_t("purchaseOrders.actions.receive")}
                                                </Link>
                                            )}
                                            {billable && (po.status === "sent" || po.status === "closed") && (
                                                <Link prefetch={false} href={`/purchase-bills?po=${encodeURIComponent(po.id)}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }), small)} data-testid="po-bill">
                                                    {_t("purchaseOrders.actions.bill")}
                                                </Link>
                                            )}
                                            {receiptCount > 0 && (
                                                <Link prefetch={false} href={`/goods-receipts?order=${encodeURIComponent(po.id)}`} className={cn(buttonVariants({ variant: "ghost", size: "sm" }), small)} data-testid="po-receipts-link">
                                                    {_t("purchaseOrders.card.receiptCount", { count: receiptCount })}
                                                </Link>
                                            )}
                                            <BaseButton variant="outline" size="sm" className={small} loading={busy} loadingText={_t("purchaseOrders.actions.pdf")} onClick={() => download(po)} data-testid="po-pdf">
                                                <FileDown className="h-3.5 w-3.5" />
                                                {_t("purchaseOrders.actions.pdf")}
                                            </BaseButton>
                                            <BaseButton variant="ghost" size="icon" className="h-8 w-8" aria-label={`${_t("purchaseOrders.actions.print")}: ${po.number}`} onClick={() => print(po)}>
                                                <Printer className="h-4 w-4" />
                                            </BaseButton>
                                            <BaseButton variant="ghost" size="icon" className="h-8 w-8" aria-label={`${_t("purchaseOrders.actions.duplicate")}: ${po.number}`} onClick={() => duplicate(po)}>
                                                <Copy className="h-4 w-4" />
                                            </BaseButton>
                                            {canTransition(po.status, "closed") && (
                                                <BaseButton variant="ghost" size="sm" className={small} onClick={() => move(po, "closed")}>
                                                    <CheckCircle2 className="h-3.5 w-3.5" />
                                                    {_t("purchaseOrders.actions.close")}
                                                </BaseButton>
                                            )}
                                            {po.status === "closed" && (
                                                <BaseButton variant="ghost" size="sm" className={small} onClick={() => move(po, "sent")}>
                                                    <RotateCcw className="h-3.5 w-3.5" />
                                                    {_t("purchaseOrders.actions.reopen")}
                                                </BaseButton>
                                            )}
                                            {po.status === "sent" && !hasPosted && (
                                                <BaseButton variant="ghost" size="sm" className={small} onClick={() => move(po, "draft")}>
                                                    <Undo2 className="h-3.5 w-3.5" />
                                                    {_t("purchaseOrders.actions.backToDraft")}
                                                </BaseButton>
                                            )}
                                            {po.status === "cancelled" && (
                                                <BaseButton variant="ghost" size="sm" className={small} onClick={() => move(po, "draft")} data-testid="po-restore">
                                                    <RotateCcw className="h-3.5 w-3.5" />
                                                    {_t("purchaseOrders.actions.restore")}
                                                </BaseButton>
                                            )}
                                            {canTransition(po.status, "cancelled", { hasReceipts: hasPosted }) && (
                                                <BaseButton variant="ghost" size="sm" className={cn(small, "text-destructive hover:text-destructive")} onClick={() => setConfirm({ kind: "cancel", order: po })} data-testid="po-cancel">
                                                    <XCircle className="h-3.5 w-3.5" />
                                                    {_t("purchaseOrders.actions.cancel")}
                                                </BaseButton>
                                            )}
                                            {canDelete(po, { hasReceipts: hasAnyReceipts(receipts, po.id) || anyBill }) && (
                                                <BaseButton variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" aria-label={`${_t("purchaseOrders.actions.delete")}: ${po.number}`} onClick={() => setConfirm({ kind: "delete", order: po })} data-testid="po-delete">
                                                    <Trash2 className="h-4 w-4" />
                                                </BaseButton>
                                            )}
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </>
            )}

            <PurchaseOrderDialog
                open={form !== null}
                order={form === "new" ? null : form}
                initialSupplierId={presetSupplier}
                suppliers={suppliers}
                orders={orders}
                products={products}
                movements={movements}
                business={business}
                prefix={settings.purchase.poPrefix}
                onClose={() => {
                    setForm(null);
                    setPresetSupplier(undefined);
                }}
            />

            <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{_t(confirm?.kind === "delete" ? "purchaseOrders.confirm.deleteTitle" : "purchaseOrders.confirm.cancelTitle")}</AlertDialogTitle>
                        <AlertDialogDescription>{confirm && _t(confirm.kind === "delete" ? "purchaseOrders.confirm.deleteBody" : "purchaseOrders.confirm.cancelBody", { number: confirm.order.number })}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>{_t("purchaseOrders.confirm.keep")}</AlertDialogCancel>
                        <AlertDialogAction onClick={runConfirmed} data-testid="po-confirm">
                            {_t(confirm?.kind === "delete" ? "purchaseOrders.confirm.confirmDelete" : "purchaseOrders.confirm.confirmCancel")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
};

export default PurchaseOrdersPage;
