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
import SupplierPaymentDialog from "@/app/components/payables/SupplierPaymentDialog";
import ExpenseLinkDialog from "./ExpenseLinkDialog";
import PurchaseBillDialog from "./PurchaseBillDialog";

import { useInvoiceContext } from "@/contexts/InvoiceContext";
import { useExpenses } from "@/contexts/useExpenses";
import { useInventoryData } from "@/contexts/useInventoryData";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { useGoodsReceipts, usePurchaseBills, usePurchaseOrders, useSupplierPayments, useSuppliers } from "@/contexts/usePurchasing";
import { Link } from "@/i18n/navigation";
import { formatDay } from "@/lib/dates";
import { formatMoney } from "@/lib/invoiceRecords";
import { billDisplayStatus, billTotal, daysOverdue, hasPayments, owedOn, paidOn, type BillDisplayStatus } from "@/lib/payables";
import {
    EMPTY_BILL_QUERY,
    billAmounts,
    canDelete,
    canEdit,
    canTransition,
    expenseCandidates,
    purchaseBillsCsv,
    queryPurchaseBills,
    type MatchIssue,
    type PurchaseBill,
} from "@/lib/purchaseBills";
import { changePurchaseBillStatus, deletePurchaseBill } from "@/lib/purchaseBillStore";
import { downloadBlob } from "@/lib/quotationPdf";
import { businessState } from "@/lib/suppliers";
import { cn } from "@/lib/utils";

import { AlertTriangle, CheckCircle2, Link2, Pencil, Plus, ScrollText, Search, Send, Trash2, Undo2, Wallet, XCircle, Download, RotateCcw } from "lucide-react";

const BADGE: Record<BillDisplayStatus, string> = {
    draft: "bg-muted text-muted-foreground",
    unpaid: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
    partial: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    paid: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    overdue: "bg-destructive/10 text-destructive",
    cancelled: "bg-muted text-muted-foreground line-through",
};
const FILTERS: BillDisplayStatus[] = ["draft", "unpaid", "partial", "overdue", "paid", "cancelled"];

const Metric = ({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) => (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className={cn("mt-2 break-words text-xl font-semibold tabular-nums sm:text-2xl", tone)}>{value}</p>
    </div>
);

const PurchaseBillsPage = () => {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const { settings, savedLoaded } = useInvoiceContext();
    const { suppliers, loaded: sLoaded } = useSuppliers();
    const { orders, loaded: oLoaded } = usePurchaseOrders();
    const { receipts, loaded: rLoaded } = useGoodsReceipts();
    const { bills, loaded: bLoaded } = usePurchaseBills();
    const { payments, loaded: pLoaded } = useSupplierPayments();
    const { products, loaded: iLoaded } = useInventoryData();
    const { expenses, loaded: eLoaded } = useExpenses();

    const business = settings.business;
    const buyerState = businessState(business);

    const [query, setQuery] = useState(EMPTY_BILL_QUERY);
    const [filter, setFilter] = useState<BillDisplayStatus | "all">("all");
    const [form, setForm] = useState<PurchaseBill | "new" | null>(null);
    const [presetOrder, setPresetOrder] = useState<string | undefined>();
    const [payFor, setPayFor] = useState<PurchaseBill | null>(null);
    const [linkFor, setLinkFor] = useState<PurchaseBill | null>(null);
    const [confirm, setConfirm] = useState<{ kind: "cancel" | "delete"; bill: PurchaseBill } | null>(null);
    const [mismatch, setMismatch] = useState<{ bill: PurchaseBill; issues: MatchIssue[] } | null>(null);

    // `?po=<id>` (Bill this order, from the order) opens a new bill for that order.
    useEffect(() => {
        const id = new URLSearchParams(window.location.search).get("po");
        if (id) {
            setPresetOrder(id);
            setForm("new");
            window.history.replaceState(null, "", window.location.pathname);
        }
    }, []);

    const now = useMemo(() => new Date(), []);
    const money = (n: number, cur: string) => formatMoney(n, cur, locale);
    const numFmt = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 3 });
    const statusOf = (b: PurchaseBill) => billDisplayStatus(b, payments, now);

    const rows = useMemo(
        () => queryPurchaseBills(bills, { ...query, status: "all" }).filter((b) => filter === "all" || billDisplayStatus(b, payments, now) === filter),
        [bills, query, filter, payments, now]
    );

    const metrics = useMemo(() => {
        let awaiting = 0;
        let overdue = 0;
        const owed: Record<string, number> = {};
        for (const b of bills) {
            const o = owedOn(b, payments);
            if (o <= 0) continue;
            awaiting++;
            owed[b.currency] = (owed[b.currency] ?? 0) + o;
            if (daysOverdue(b, now) > 0) overdue++;
        }
        return { awaiting, overdue, owed, drafts: bills.filter((b) => b.status === "draft").length };
    }, [bills, payments, now]);

    const issueText = (i: MatchIssue, cur: string) =>
        _t(`purchaseBills.match.kinds.${i.kind}`, { name: i.name, billed: numFmt(i.billed ?? 0), received: numFmt(i.received ?? 0), ordered: numFmt(i.ordered ?? 0), billPrice: money(i.billPrice ?? 0, cur), orderPrice: money(i.orderPrice ?? 0, cur) });

    const move = async (b: PurchaseBill, to: "draft" | "posted" | "cancelled", allowMismatch = false) => {
        const r = await changePurchaseBillStatus(b.id, to, { allowMismatch });
        if (r.ok) {
            toast({ title: to === "posted" ? _t("purchaseBills.toast.posted", { number: b.number }) : _t("purchaseBills.toast.status", { number: b.number, status: _t(`purchaseBills.status.${to}`).toLowerCase() }) });
        } else if ("issues" in r) setMismatch({ bill: b, issues: r.issues });
        else if ("errors" in r) toast({ variant: "destructive", title: _t("purchaseBills.toast.notAllowed") });
        else toast({ variant: "destructive", title: _t(r.reason === "storage" ? "purchaseBills.toast.storage" : hasPayments(b, payments) ? "purchaseBills.toast.hasPayments" : "purchaseBills.toast.notAllowed") });
    };

    const runConfirmed = async () => {
        const c = confirm;
        setConfirm(null);
        if (!c) return;
        if (c.kind === "cancel") return void (await move(c.bill, "cancelled"));
        const r = await deletePurchaseBill(c.bill.id);
        toast(r.ok ? { title: _t("purchaseBills.toast.deleted"), description: c.bill.number } : { variant: "destructive", title: _t(r.reason === "storage" ? "purchaseBills.toast.storage" : "purchaseBills.toast.notAllowed") });
    };

    const exportCsv = () => downloadBlob(new Blob(["﻿", purchaseBillsCsv(rows, buyerState)], { type: "text/csv;charset=utf-8" }), "purchase-bills.csv");

    if (![sLoaded, oLoaded, rLoaded, bLoaded, pLoaded, iLoaded, eLoaded, savedLoaded].every(Boolean)) return <Skeleton className="h-96 rounded-xl" aria-busy="true" />;

    const activeSuppliers = suppliers.filter((s) => !s.inactive);
    const small = "h-8 gap-1.5";
    const owedText = Object.entries(metrics.owed).map(([c, a]) => money(a, c)).join(" · ");

    return (
        <div className="space-y-6" data-testid="purchase-bills-page">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{_t("purchaseBills.title")}</h1>
                    <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{_t("purchaseBills.subtitle")}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <BaseButton variant="outline" onClick={exportCsv} disabled={rows.length === 0}>
                        <Download className="h-4 w-4" />
                        {_t("purchaseBills.export")}
                    </BaseButton>
                    <BaseButton onClick={() => { setPresetOrder(undefined); setForm("new"); }} disabled={activeSuppliers.length === 0} data-testid="bill-new">
                        <Plus className="h-4 w-4" />
                        {_t("purchaseBills.new")}
                    </BaseButton>
                </div>
            </div>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Metric label={_t("purchaseBills.metrics.awaiting")} value={metrics.awaiting} />
                <Metric label={_t("purchaseBills.metrics.owed")} value={owedText || "—"} />
                <Metric label={_t("purchaseBills.metrics.overdue")} value={metrics.overdue} tone={metrics.overdue > 0 ? "text-destructive" : undefined} />
                <Metric label={_t("purchaseBills.metrics.drafts")} value={metrics.drafts} />
            </div>

            {bills.length === 0 ? (
                <div className="flex flex-col items-center rounded-xl border border-dashed bg-card px-6 py-14 text-center" data-testid="bill-empty">
                    <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                        <ScrollText className="h-6 w-6" />
                    </span>
                    <h2 className="text-lg font-semibold">{_t("purchaseBills.empty.title")}</h2>
                    <p className="mt-1 max-w-md text-sm text-muted-foreground">{_t(activeSuppliers.length === 0 ? "purchaseBills.empty.needSupplier" : "purchaseBills.empty.body")}</p>
                    {activeSuppliers.length === 0 ? (
                        <Link prefetch={false} href="/suppliers" className={cn(buttonVariants(), "mt-5")}>
                            {_t("purchaseBills.empty.addSupplier")}
                        </Link>
                    ) : (
                        <BaseButton className="mt-5" onClick={() => setForm("new")}>
                            <Plus className="h-4 w-4" />
                            {_t("purchaseBills.empty.cta")}
                        </BaseButton>
                    )}
                </div>
            ) : (
                <>
                    <div className="flex flex-col gap-2 sm:flex-row">
                        <div className="relative flex-1">
                            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                            <Input type="search" className="ps-9" placeholder={_t("purchaseBills.search")} aria-label={_t("purchaseBills.search")} data-testid="bill-search" value={query.q} onChange={(e) => setQuery((q) => ({ ...q, q: e.target.value }))} />
                        </div>
                        <NativeSelect className="sm:w-44" aria-label={_t("purchaseBills.filters.all")} data-testid="bill-status-filter" value={filter} onChange={(e) => setFilter(e.target.value as BillDisplayStatus | "all")}>
                            <option value="all">{_t("purchaseBills.filters.all")}</option>
                            {FILTERS.map((s) => (
                                <option key={s} value={s}>
                                    {_t(`purchaseBills.status.${s}`)}
                                </option>
                            ))}
                        </NativeSelect>
                        <NativeSelect className="sm:w-48" aria-label={_t("purchaseBills.filters.allSuppliers")} value={query.supplierId} onChange={(e) => setQuery((q) => ({ ...q, supplierId: e.target.value }))}>
                            <option value="">{_t("purchaseBills.filters.allSuppliers")}</option>
                            {[...new Map(bills.map((b) => [b.supplierId, b.supplier.name])).entries()].map(([id, name]) => (
                                <option key={id} value={id}>
                                    {name}
                                </option>
                            ))}
                        </NativeSelect>
                    </div>

                    {rows.length === 0 ? (
                        <p className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground" data-testid="bill-nomatch">
                            {_t("purchaseBills.noMatch")}
                        </p>
                    ) : (
                        <ul className="space-y-3" data-testid="bill-list">
                            {rows.map((b) => {
                                const status = statusOf(b);
                                const a = billAmounts(b, buyerState);
                                const paid = paidOn(b, payments);
                                const owed = owedOn(b, payments);
                                const late = daysOverdue(b, now);
                                const paidAny = hasPayments(b, payments);
                                const candidates = b.status !== "cancelled" ? expenseCandidates(b, billTotal(b), expenses) : [];
                                return (
                                    <li key={b.id} data-testid="bill-card" data-number={b.number} data-status={status} className="rounded-xl border bg-card p-4 shadow-sm transition-shadow hover:shadow-md">
                                        <div className="flex flex-wrap items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <h2 className="font-mono text-base font-semibold">{b.number}</h2>
                                                    <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium", BADGE[status])} data-testid="bill-status">
                                                        {_t(`purchaseBills.status.${status}`)}
                                                    </span>
                                                </div>
                                                <p className="mt-1 truncate text-sm">
                                                    {b.supplier.name} · {_t("purchaseBills.card.supplierBillNo", { no: b.supplierBillNo })}
                                                </p>
                                                <p className="mt-0.5 text-xs text-muted-foreground">
                                                    {_t("purchaseBills.card.billed", { date: formatDay(b.billDate, locale) })} · {_t("purchaseBills.card.due", { date: formatDay(b.dueDate, locale) })}
                                                    {b.poNumber ? ` · ${_t("purchaseBills.card.order", { number: b.poNumber })}` : ""} · {_t("purchaseBills.card.items", { count: b.lines.length })}
                                                </p>
                                            </div>
                                            <div className="text-end">
                                                <p className="text-lg font-semibold tabular-nums" data-testid="bill-card-total">
                                                    {money(a.total, b.currency)}
                                                </p>
                                                {b.status === "posted" && (
                                                    <p className="text-xs tabular-nums text-muted-foreground" data-testid="bill-card-owed">
                                                        {paid > 0 ? `${_t("purchaseBills.card.paid", { amount: money(paid, b.currency) })} · ` : ""}
                                                        {_t("purchaseBills.card.owed", { amount: money(owed, b.currency) })}
                                                    </p>
                                                )}
                                            </div>
                                        </div>

                                        {b.status === "posted" && owed > 0 && (
                                            <p className={cn("mt-2 text-xs", late > 0 ? "font-medium text-destructive" : "text-muted-foreground")} data-testid="bill-due-note">
                                                {late > 0 ? _t("purchaseBills.card.overdueBy", { days: late }) : late === 0 ? _t("purchaseBills.card.dueToday") : _t("purchaseBills.card.dueIn", { days: -late })}
                                            </p>
                                        )}
                                        <p className="mt-1 text-xs text-muted-foreground">{b.gstEnabled && b.itcEligible && a.recoverableTax > 0 ? _t("purchaseBills.card.claimable", { amount: money(a.recoverableTax, b.currency) }) : b.gstEnabled && a.tax > 0 ? _t("purchaseBills.card.notClaimable") : ""}</p>

                                        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t pt-3">
                                            {canEdit(b) && (
                                                <BaseButton variant="outline" size="sm" className={small} onClick={() => setForm(b)} data-testid="bill-edit">
                                                    <Pencil className="h-3.5 w-3.5" />
                                                    {_t("purchaseBills.actions.edit")}
                                                </BaseButton>
                                            )}
                                            {b.status === "draft" && (
                                                <BaseButton size="sm" className={small} onClick={() => move(b, "posted")} data-testid="bill-post">
                                                    <Send className="h-3.5 w-3.5" />
                                                    {_t("purchaseBills.actions.post")}
                                                </BaseButton>
                                            )}
                                            {b.status === "posted" && owed > 0 && (
                                                <BaseButton size="sm" className={small} onClick={() => setPayFor(b)} data-testid="bill-pay">
                                                    <Wallet className="h-3.5 w-3.5" />
                                                    {_t("purchaseBills.actions.pay")}
                                                </BaseButton>
                                            )}
                                            {candidates.length > 0 && (
                                                <BaseButton variant="ghost" size="sm" className={small} onClick={() => setLinkFor(b)} data-testid="bill-link-expense">
                                                    {candidates.some((e) => e.billId === b.id) ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <Link2 className="h-3.5 w-3.5 text-amber-600" />}
                                                    {_t("purchaseBills.expenseLink.title")}
                                                </BaseButton>
                                            )}
                                            {b.status === "posted" && canTransition("posted", "draft", { hasPayments: paidAny }) && (
                                                <BaseButton variant="ghost" size="sm" className={small} onClick={() => move(b, "draft")} data-testid="bill-to-draft">
                                                    <Undo2 className="h-3.5 w-3.5" />
                                                    {_t("purchaseBills.actions.toDraft")}
                                                </BaseButton>
                                            )}
                                            {b.status === "cancelled" && (
                                                <BaseButton variant="ghost" size="sm" className={small} onClick={() => move(b, "draft")} data-testid="bill-restore">
                                                    <RotateCcw className="h-3.5 w-3.5" />
                                                    {_t("purchaseBills.actions.restore")}
                                                </BaseButton>
                                            )}
                                            {canTransition(b.status, "cancelled", { hasPayments: paidAny }) && (
                                                <BaseButton variant="ghost" size="sm" className={cn(small, "text-destructive hover:text-destructive")} onClick={() => setConfirm({ kind: "cancel", bill: b })} data-testid="bill-cancel">
                                                    <XCircle className="h-3.5 w-3.5" />
                                                    {_t("purchaseBills.actions.cancel")}
                                                </BaseButton>
                                            )}
                                            {canDelete(b, { hasPayments: paidAny }) && (
                                                <BaseButton variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" aria-label={`${_t("purchaseBills.actions.delete")}: ${b.number}`} onClick={() => setConfirm({ kind: "delete", bill: b })} data-testid="bill-delete">
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

            <PurchaseBillDialog
                open={form !== null}
                bill={form === "new" ? null : form}
                presetOrderId={presetOrder}
                suppliers={suppliers}
                orders={orders}
                receipts={receipts}
                bills={bills}
                products={products}
                business={business}
                prefix={settings.purchase.billPrefix}
                onClose={() => {
                    setForm(null);
                    setPresetOrder(undefined);
                }}
            />

            <SupplierPaymentDialog open={payFor !== null} presetBillId={payFor?.id} presetSupplierId={payFor?.supplierId} suppliers={suppliers} bills={bills} payments={payments} prefix={settings.purchase.paymentPrefix} onClose={() => setPayFor(null)} />

            <ExpenseLinkDialog open={linkFor !== null} bill={linkFor} total={linkFor ? billTotal(linkFor) : 0} expenses={expenses} onClose={() => setLinkFor(null)} />

            <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{_t(confirm?.kind === "delete" ? "purchaseBills.confirm.deleteTitle" : "purchaseBills.confirm.cancelTitle")}</AlertDialogTitle>
                        <AlertDialogDescription>{confirm && _t(confirm.kind === "delete" ? "purchaseBills.confirm.deleteBody" : "purchaseBills.confirm.cancelBody", { number: confirm.bill.number })}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>{_t("purchaseBills.confirm.keep")}</AlertDialogCancel>
                        <AlertDialogAction onClick={runConfirmed} data-testid="bill-confirm-action">
                            {_t(confirm?.kind === "delete" ? "purchaseBills.confirm.confirmDelete" : "purchaseBills.confirm.confirmCancel")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            <AlertDialog open={mismatch !== null} onOpenChange={(o) => !o && setMismatch(null)}>
                <AlertDialogContent data-testid="bill-post-confirm">
                    <AlertDialogHeader>
                        <AlertDialogTitle className="flex items-center gap-2">
                            <AlertTriangle className="h-5 w-5 text-amber-600" aria-hidden="true" />
                            {_t("purchaseBills.match.confirmTitle")}
                        </AlertDialogTitle>
                        <AlertDialogDescription asChild>
                            <div>
                                <p>{_t("purchaseBills.match.confirmBody")}</p>
                                <ul className="mt-2 list-disc space-y-1 ps-5 text-foreground">
                                    {mismatch?.issues.map((i, idx) => (
                                        <li key={`${i.kind}-${idx}`}>{issueText(i, mismatch.bill.currency)}</li>
                                    ))}
                                </ul>
                            </div>
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>{_t("purchaseBills.match.back")}</AlertDialogCancel>
                        <AlertDialogAction
                            data-testid="bill-post-confirm-yes"
                            onClick={() => {
                                const m = mismatch;
                                setMismatch(null);
                                if (m) void move(m.bill, "posted", true);
                            }}
                        >
                            {_t("purchaseBills.match.confirm")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
};

export default PurchaseBillsPage;
