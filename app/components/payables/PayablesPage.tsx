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
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/use-toast";
import BaseButton from "@/app/components/reusables/BaseButton";
import NativeSelect from "@/app/components/reusables/NativeSelect";
import SupplierLedgerDialog from "./SupplierLedgerDialog";
import SupplierPaymentDialog from "./SupplierPaymentDialog";

import { useInvoiceContext } from "@/contexts/InvoiceContext";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { usePurchaseBills, useSupplierPayments, useSuppliers } from "@/contexts/usePurchasing";
import { Link } from "@/i18n/navigation";
import { formatDay } from "@/lib/dates";
import { formatMoney } from "@/lib/invoiceRecords";
import { AGEING_BUCKETS, ageing, daysOverdue, owedOn, payablesSummary, supplierBalances, billDisplayStatus } from "@/lib/payables";
import { downloadBlob } from "@/lib/quotationPdf";
import { voidSupplierPayment } from "@/lib/supplierPaymentStore";
import { EMPTY_PAYMENT_QUERY, querySupplierPayments, supplierPaymentsCsv, unallocated, type PaymentQuery, type SupplierPayment } from "@/lib/supplierPayments";
import type { Supplier } from "@/lib/suppliers";
import { cn } from "@/lib/utils";

import { Ban, CalendarClock, Download, Landmark, Plus, Search, Wallet } from "lucide-react";

const BAR: Record<string, string> = { current: "bg-emerald-500", d1_30: "bg-amber-400", d31_60: "bg-orange-500", d61_90: "bg-red-500", d90plus: "bg-red-700" };

const Metric = ({ label, value, tone, testId }: { label: string; value: React.ReactNode; tone?: string; testId?: string }) => (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className={cn("mt-2 break-words text-xl font-semibold tabular-nums sm:text-2xl", tone)} data-testid={testId}>
            {value}
        </p>
    </div>
);

const PayablesPage = () => {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const { settings, savedLoaded } = useInvoiceContext();
    const { suppliers, loaded: sLoaded } = useSuppliers();
    const { bills, loaded: bLoaded } = usePurchaseBills();
    const { payments, loaded: pLoaded } = useSupplierPayments();

    const now = useMemo(() => new Date(), []);
    const [picked, setPicked] = useState("");
    const [pay, setPay] = useState<{ open: boolean; supplierId?: string; billId?: string; payment?: SupplierPayment | null }>({ open: false });
    const [ledgerFor, setLedgerFor] = useState<Supplier | null>(null);
    const [voiding, setVoiding] = useState<SupplierPayment | null>(null);
    const [reason, setReason] = useState("");
    const [voidBusy, setVoidBusy] = useState(false);
    const [query, setQuery] = useState<PaymentQuery>(EMPTY_PAYMENT_QUERY);

    const currencies = useMemo(() => {
        const set = new Set<string>();
        for (const b of bills) if (b.status === "posted") set.add(b.currency);
        for (const p of payments) if (p.status === "posted") set.add(p.currency);
        for (const s of suppliers) if (s.openingBalance > 0) set.add(s.currency);
        return [...set].sort();
    }, [bills, payments, suppliers]);

    const summaries = useMemo(() => payablesSummary(suppliers, bills, payments, { now }), [suppliers, bills, payments, now]);
    const currency = picked && currencies.includes(picked) ? picked : summaries[0]?.currency ?? currencies[0] ?? "INR";
    const summary = summaries.find((s) => s.currency === currency);
    const age = useMemo(() => ageing(bills, payments, { currency, now }), [bills, payments, currency, now]);
    const balances = useMemo(() => supplierBalances(suppliers, bills, payments, { now }).filter((r) => r.currency === currency), [suppliers, bills, payments, currency, now]);
    const toPay = useMemo(
        () => bills.filter((b) => b.status === "posted" && b.currency === currency && owedOn(b, payments) > 0).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.number.localeCompare(b.number)),
        [bills, payments, currency]
    );
    const rows = useMemo(() => querySupplierPayments(payments, query), [payments, query]);

    const money = (n: number, cur = currency) => formatMoney(n, cur, locale);
    const maxBucket = Math.max(1, ...age.rows.map((r) => r.amount));
    const billNumber = useMemo(() => new Map(bills.map((b) => [b.id, b.number])), [bills]);

    const confirmVoid = async () => {
        const p = voiding;
        if (!p) return;
        setVoidBusy(true);
        const r = await voidSupplierPayment(p.id, reason);
        setVoidBusy(false);
        setVoiding(null);
        setReason("");
        toast(r.ok ? { title: _t("payables.toast.voided", { number: p.number }) } : { variant: "destructive", title: _t(r.reason === "alreadyVoid" ? "payables.toast.alreadyVoid" : r.reason === "notFound" ? "payables.toast.notFound" : "payables.toast.storage") });
    };

    const exportCsv = () => downloadBlob(new Blob(["﻿", supplierPaymentsCsv(rows)], { type: "text/csv;charset=utf-8" }), "supplier-payments.csv");

    if (![sLoaded, bLoaded, pLoaded, savedLoaded].every(Boolean)) return <Skeleton className="h-96 rounded-xl" aria-busy="true" />;

    const activeSuppliers = suppliers.filter((s) => !s.inactive);
    const nothing = bills.length === 0 && payments.length === 0 && !suppliers.some((s) => s.openingBalance > 0);

    return (
        <div className="space-y-6" data-testid="payables-page">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{_t("payables.title")}</h1>
                    <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{_t("payables.subtitle")}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {currencies.length > 1 && (
                        <NativeSelect className="h-10 w-28" aria-label={_t("payables.currency")} data-testid="payables-currency" value={currency} onChange={(e) => setPicked(e.target.value)}>
                            {currencies.map((c) => (
                                <option key={c} value={c}>
                                    {c}
                                </option>
                            ))}
                        </NativeSelect>
                    )}
                    <Link prefetch={false} href="/purchase-bills" className={buttonVariants({ variant: "outline" })}>
                        {_t("payables.bills.viewAll")}
                    </Link>
                    <BaseButton onClick={() => setPay({ open: true })} disabled={activeSuppliers.length === 0} data-testid="pay-new">
                        <Plus className="h-4 w-4" />
                        {_t("payables.payments.new")}
                    </BaseButton>
                </div>
            </div>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6" data-testid="payables-metrics">
                <Metric testId="m-owed" label={_t("payables.metrics.owed")} value={money(summary?.outstanding ?? 0)} />
                <Metric testId="m-overdue" label={_t("payables.metrics.overdue")} value={money(summary?.overdue ?? 0)} tone={(summary?.overdue ?? 0) > 0 ? "text-destructive" : undefined} />
                <Metric testId="m-soon" label={_t("payables.metrics.dueSoon")} value={money(summary?.dueSoon ?? 0)} />
                <Metric testId="m-advances" label={_t("payables.metrics.advances")} value={money(summary?.advances ?? 0)} />
                <Metric testId="m-opening" label={_t("payables.metrics.opening")} value={money(summary?.opening ?? 0)} />
                <Metric testId="m-net" label={_t("payables.metrics.net")} value={money(summary?.netPayable ?? 0)} />
            </div>

            {nothing ? (
                <div className="flex flex-col items-center rounded-xl border border-dashed bg-card px-6 py-14 text-center" data-testid="payables-empty">
                    <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                        <Landmark className="h-6 w-6" />
                    </span>
                    <h2 className="text-lg font-semibold">{_t("payables.ageing.empty")}</h2>
                    <Link prefetch={false} href="/purchase-bills" className={cn(buttonVariants(), "mt-5")}>
                        {_t("payables.bills.viewAll")}
                    </Link>
                </div>
            ) : (
                <>
                    <section aria-labelledby="ageing-title" className="rounded-xl border bg-card p-4 shadow-sm sm:p-6" data-testid="ageing">
                        <h2 id="ageing-title" className="text-base font-semibold">
                            {_t("payables.ageing.title")}
                        </h2>
                        <p className="text-sm text-muted-foreground">{_t("payables.ageing.hint")}</p>
                        <ul className="mt-4 space-y-3">
                            {AGEING_BUCKETS.map((k) => {
                                const r = age.rows.find((x) => x.bucket === k)!;
                                return (
                                    <li key={k} data-testid={`ageing-${k}`} data-amount={r.amount} data-count={r.count}>
                                        <div className="flex items-baseline justify-between gap-3 text-sm">
                                            <span>{_t(`payables.ageing.buckets.${k}`)}</span>
                                            <span className="tabular-nums">
                                                <span className="font-medium">{money(r.amount)}</span> <span className="text-xs text-muted-foreground">· {_t("payables.ageing.count", { count: r.count })}</span>
                                            </span>
                                        </div>
                                        <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted" role="presentation">
                                            <div className={cn("h-full rounded-full", BAR[k])} style={{ width: `${Math.round((r.amount / maxBucket) * 100)}%` }} />
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    </section>

                    <div className="grid gap-6 xl:grid-cols-2">
                        <section aria-labelledby="sup-title" className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
                            <h2 id="sup-title" className="text-base font-semibold">
                                {_t("payables.suppliers.title")}
                            </h2>
                            {balances.length === 0 ? (
                                <p className="mt-3 text-sm text-muted-foreground">{_t("payables.suppliers.empty")}</p>
                            ) : (
                                <ul className="mt-3 divide-y" data-testid="supplier-balances">
                                    {balances.map((r) => {
                                        const s = suppliers.find((x) => x.id === r.supplierId) ?? null;
                                        return (
                                            <li key={r.supplierId} className="py-3" data-testid="supplier-balance" data-supplier={r.supplierName}>
                                                <div className="flex flex-wrap items-start justify-between gap-3">
                                                    <div className="min-w-0">
                                                        <p className="truncate font-medium">{r.supplierName}</p>
                                                        {r.nextDue && <p className="text-xs text-muted-foreground">{_t("payables.suppliers.nextDue", { date: formatDay(r.nextDue, locale) })}</p>}
                                                    </div>
                                                    <p className="text-lg font-semibold tabular-nums" data-testid="supplier-net">
                                                        {money(r.netPayable)}
                                                    </p>
                                                </div>
                                                <dl className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1 text-xs sm:grid-cols-6">
                                                    {(
                                                        [
                                                            ["opening", r.opening],
                                                            ["billed", r.billed],
                                                            ["paid", r.paid],
                                                            ["advances", r.advances],
                                                            ["owed", r.outstanding],
                                                            ["overdue", r.overdue],
                                                        ] as const
                                                    ).map(([k, v]) => (
                                                        <div key={k}>
                                                            <dt className="text-muted-foreground">{_t(`payables.suppliers.${k}`)}</dt>
                                                            <dd className={cn("tabular-nums", k === "overdue" && v > 0 ? "font-medium text-destructive" : "")} data-testid={`sb-${k}`}>
                                                                {money(v)}
                                                            </dd>
                                                        </div>
                                                    ))}
                                                </dl>
                                                <div className="mt-2 flex gap-2">
                                                    <BaseButton size="sm" variant="outline" className="h-8" onClick={() => setPay({ open: true, supplierId: r.supplierId })} disabled={!s || s.inactive}>
                                                        <Wallet className="h-3.5 w-3.5" />
                                                        {_t("payables.suppliers.pay")}
                                                    </BaseButton>
                                                    <BaseButton size="sm" variant="ghost" className="h-8" onClick={() => setLedgerFor(s)} disabled={!s} data-testid="supplier-ledger">
                                                        {_t("payables.suppliers.ledger")}
                                                    </BaseButton>
                                                </div>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </section>

                        <section aria-labelledby="topay-title" className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
                            <h2 id="topay-title" className="flex items-center gap-2 text-base font-semibold">
                                <CalendarClock className="h-4 w-4 text-warning" aria-hidden="true" />
                                {_t("payables.bills.title")}
                            </h2>
                            {toPay.length === 0 ? (
                                <p className="mt-3 text-sm text-muted-foreground">{_t("payables.bills.empty")}</p>
                            ) : (
                                <ul className="mt-3 divide-y" data-testid="bills-to-pay">
                                    {toPay.map((b) => {
                                        const late = daysOverdue(b, now);
                                        return (
                                            <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 py-3" data-testid="topay-row" data-number={b.number} data-status={billDisplayStatus(b, payments, now)}>
                                                <div className="min-w-0">
                                                    <p className="truncate text-sm font-medium">
                                                        {b.number} · {b.supplier.name}
                                                    </p>
                                                    <p className={cn("text-xs", late > 0 ? "font-medium text-destructive" : "text-muted-foreground")}>
                                                        {_t("purchaseBills.card.due", { date: formatDay(b.dueDate, locale) })} · {late > 0 ? _t("purchaseBills.card.overdueBy", { days: late }) : late === 0 ? _t("purchaseBills.card.dueToday") : _t("purchaseBills.card.dueIn", { days: -late })}
                                                    </p>
                                                </div>
                                                <div className="flex items-center gap-3">
                                                    <span className="tabular-nums" data-testid="topay-owed">
                                                        {money(owedOn(b, payments), b.currency)}
                                                    </span>
                                                    <BaseButton size="sm" variant="outline" className="h-8" onClick={() => setPay({ open: true, billId: b.id, supplierId: b.supplierId })} data-testid="topay-pay">
                                                        {_t("payables.bills.pay")}
                                                    </BaseButton>
                                                </div>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </section>
                    </div>

                    <section aria-labelledby="pays-title" className="space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <h2 id="pays-title" className="text-base font-semibold">
                                {_t("payables.payments.title")}
                            </h2>
                            <BaseButton variant="outline" size="sm" onClick={exportCsv} disabled={rows.length === 0}>
                                <Download className="h-4 w-4" />
                                {_t("payables.payments.export")}
                            </BaseButton>
                        </div>
                        {payments.length > 0 && (
                            <div className="flex flex-col gap-2 sm:flex-row">
                                <div className="relative flex-1">
                                    <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                                    <Input type="search" className="ps-9" placeholder={_t("payables.payments.search")} aria-label={_t("payables.payments.search")} data-testid="pay-search" value={query.q} onChange={(e) => setQuery((q) => ({ ...q, q: e.target.value }))} />
                                </div>
                                <NativeSelect className="sm:w-44" aria-label={_t("payables.payments.filters.all")} data-testid="pay-status-filter" value={query.status} onChange={(e) => setQuery((q) => ({ ...q, status: e.target.value as PaymentQuery["status"] }))}>
                                    <option value="all">{_t("payables.payments.filters.all")}</option>
                                    <option value="posted">{_t("payables.payments.status.posted")}</option>
                                    <option value="void">{_t("payables.payments.status.void")}</option>
                                </NativeSelect>
                            </div>
                        )}
                        {payments.length === 0 ? (
                            <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">{_t("payables.payments.empty")}</p>
                        ) : rows.length === 0 ? (
                            <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground" data-testid="pay-nomatch">
                                {_t("payables.payments.noMatch")}
                            </p>
                        ) : (
                            <ul className="space-y-3" data-testid="pay-list">
                                {rows.map((p) => {
                                    const adv = unallocated(p);
                                    const allocated = p.allocations.reduce((s, a) => s + a.amount, 0);
                                    return (
                                        <li key={p.id} data-testid="pay-card" data-number={p.number} data-status={p.status} className="rounded-xl border bg-card p-4 shadow-sm">
                                            <div className="flex flex-wrap items-start justify-between gap-3">
                                                <div className="min-w-0">
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <h3 className="font-mono text-base font-semibold">{p.number}</h3>
                                                        <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium", p.status === "posted" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "bg-muted text-muted-foreground line-through")} data-testid="pay-status">
                                                            {_t(`payables.payments.status.${p.status}`)}
                                                        </span>
                                                    </div>
                                                    <p className="mt-1 truncate text-sm">{p.supplierName}</p>
                                                    <p className="mt-0.5 text-xs text-muted-foreground">
                                                        {formatDay(p.date, locale)} · {_t(`payables.methods.${p.method}`)}
                                                        {p.reference ? ` · ${_t("payables.payments.card.reference", { ref: p.reference })}` : ""}
                                                        {p.allocations.length > 0 ? ` · ${_t("payables.payments.card.to", { numbers: p.allocations.map((a) => billNumber.get(a.billId) ?? "?").join(", ") })}` : ""}
                                                    </p>
                                                </div>
                                                <div className="text-end">
                                                    <p className="text-lg font-semibold tabular-nums" data-testid="pay-amount-card">
                                                        {money(p.amount, p.currency)}
                                                    </p>
                                                    {p.status === "posted" && (
                                                        <p className="text-xs tabular-nums text-muted-foreground">
                                                            {allocated > 0 ? _t("payables.payments.card.allocated", { amount: money(allocated, p.currency) }) : ""}
                                                            {allocated > 0 && adv > 0 ? " · " : ""}
                                                            {adv > 0 ? <span data-testid="pay-advance">{_t("payables.payments.card.advance", { amount: money(adv, p.currency) })}</span> : null}
                                                        </p>
                                                    )}
                                                </div>
                                            </div>
                                            {p.status === "void" && (
                                                <p className="mt-2 text-xs text-muted-foreground">
                                                    {_t("payables.payments.card.voidedOn", { date: formatDay((p.voidedAt ?? "").slice(0, 10), locale) })}
                                                    {p.voidReason ? ` · ${_t("payables.payments.card.reason", { reason: p.voidReason })}` : ""}
                                                </p>
                                            )}
                                            {p.status === "posted" && (
                                                <div className="mt-3 flex flex-wrap justify-end gap-1.5 border-t pt-3">
                                                    {adv > 0 && (
                                                        <BaseButton variant="outline" size="sm" className="h-8" onClick={() => setPay({ open: true, payment: p })} data-testid="pay-allocate">
                                                            {_t("payables.payments.actions.allocate")}
                                                        </BaseButton>
                                                    )}
                                                    <BaseButton variant="ghost" size="sm" className="h-8 gap-1.5 text-destructive hover:text-destructive" onClick={() => setVoiding(p)} data-testid="pay-void">
                                                        <Ban className="h-3.5 w-3.5" />
                                                        {_t("payables.payments.actions.void")}
                                                    </BaseButton>
                                                </div>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </section>
                </>
            )}

            <SupplierPaymentDialog
                open={pay.open}
                payment={pay.payment}
                presetSupplierId={pay.supplierId}
                presetBillId={pay.billId}
                suppliers={suppliers}
                bills={bills}
                payments={payments}
                prefix={settings.purchase.paymentPrefix}
                onClose={() => setPay({ open: false })}
            />
            <SupplierLedgerDialog supplier={ledgerFor} currency={currency} bills={bills} payments={payments} onClose={() => setLedgerFor(null)} />

            <AlertDialog
                open={voiding !== null}
                onOpenChange={(o) => {
                    if (!o && !voidBusy) {
                        setVoiding(null);
                        setReason("");
                    }
                }}
            >
                <AlertDialogContent data-testid="pay-void-dialog">
                    <AlertDialogHeader>
                        <AlertDialogTitle>{voiding && _t("payables.void.title", { number: voiding.number })}</AlertDialogTitle>
                        <AlertDialogDescription>{_t("payables.void.body")}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <div className="space-y-1.5">
                        <label htmlFor="pay-void-reason" className="text-sm font-medium">
                            {_t("payables.void.reason")}
                        </label>
                        <Textarea id="pay-void-reason" data-testid="pay-void-reason" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
                    </div>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={voidBusy}>{_t("payables.void.keep")}</AlertDialogCancel>
                        <AlertDialogAction
                            disabled={voidBusy}
                            onClick={(e) => {
                                e.preventDefault();
                                void confirmVoid();
                            }}
                            data-testid="pay-void-confirm"
                        >
                            {_t("payables.void.confirm")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
};

export default PayablesPage;
