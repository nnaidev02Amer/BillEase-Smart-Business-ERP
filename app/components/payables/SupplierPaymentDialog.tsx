"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale } from "next-intl";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/use-toast";
import BaseButton from "@/app/components/reusables/BaseButton";
import Field from "@/app/components/reusables/Field";
import NativeSelect from "@/app/components/reusables/NativeSelect";

import { useTranslationContext } from "@/contexts/TranslationContext";
import { toDay } from "@/lib/expenses";
import { formatDay } from "@/lib/dates";
import { formatMoney, PAYMENT_METHODS } from "@/lib/invoiceRecords";
import { owedOn } from "@/lib/payables";
import type { PurchaseBill } from "@/lib/purchaseBills";
import { allocateSupplierPayment, recordSupplierPayment } from "@/lib/supplierPaymentStore";
import {
    allocateOldestFirst,
    allocatedTo,
    hasPaymentErrors,
    roundTo,
    validateSupplierPayment,
    type PaymentErrors,
    type SupplierPayment,
} from "@/lib/supplierPayments";
import type { Supplier } from "@/lib/suppliers";

const parse = (s: string) => {
    const n = parseFloat(String(s).replace(/,/g, ""));
    return Number.isFinite(n) ? n : 0;
};

/**
 * Record a payment to a supplier and say which bills it settles, or (with
 * `payment`) put an existing payment's advance against bills. Whatever is not
 * allocated stays as an advance.
 */
const SupplierPaymentDialog = ({
    open,
    payment,
    presetSupplierId,
    presetBillId,
    suppliers,
    bills,
    payments,
    prefix,
    onClose,
}: {
    open: boolean;
    /** Set to allocate an existing payment instead of recording a new one. */
    payment?: SupplierPayment | null;
    presetSupplierId?: string;
    presetBillId?: string;
    suppliers: Supplier[];
    bills: PurchaseBill[];
    payments: SupplierPayment[];
    prefix: string;
    onClose: (saved?: SupplierPayment) => void;
}) => {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const allocating = !!payment;

    const [supplierId, setSupplierId] = useState("");
    const [date, setDate] = useState(toDay(new Date()));
    const [amount, setAmount] = useState("");
    const [currency, setCurrency] = useState("INR");
    const [method, setMethod] = useState<string>("bank");
    const [reference, setReference] = useState("");
    const [note, setNote] = useState("");
    const [number, setNumber] = useState("");
    const [alloc, setAlloc] = useState<Record<string, string>>({});
    const [errors, setErrors] = useState<PaymentErrors>({ allocationErrors: {} });
    const [busy, setBusy] = useState(false);

    // What a bill owes, leaving out this payment's own allocations while it is being changed.
    const owedExcludingThis = (b: PurchaseBill) => Math.max(0, roundTo(owedOn(b, payments) + (payment ? allocatedTo([payment], b.id) : 0), b.currency));

    useEffect(() => {
        if (!open) return;
        setErrors({ allocationErrors: {} });
        setNumber("");
        if (payment) {
            setSupplierId(payment.supplierId);
            setDate(payment.date);
            setAmount(String(payment.amount));
            setCurrency(payment.currency);
            setMethod(payment.method);
            setReference(payment.reference);
            setNote(payment.note);
            setAlloc(Object.fromEntries(payment.allocations.map((a) => [a.billId, String(a.amount)])));
            return;
        }
        const preset = bills.find((b) => b.id === presetBillId && b.status === "posted");
        const sid = preset?.supplierId ?? presetSupplierId ?? "";
        const sup = suppliers.find((s) => s.id === sid);
        setSupplierId(sid);
        setDate(toDay(new Date()));
        setCurrency(preset?.currency ?? sup?.currency ?? "INR");
        setMethod("bank");
        setReference("");
        setNote("");
        if (preset) {
            const owed = owedOn(preset, payments);
            setAmount(owed > 0 ? String(owed) : "");
            setAlloc(owed > 0 ? { [preset.id]: String(owed) } : {});
        } else {
            setAmount("");
            setAlloc({});
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, payment?.id, presetSupplierId, presetBillId]);

    const open_ = useMemo(
        () =>
            bills
                .filter((b) => b.status === "posted" && b.supplierId === supplierId && b.currency === currency && owedExcludingThis(b) > 0)
                .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.number.localeCompare(b.number)),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [bills, payments, supplierId, currency, payment?.id]
    );

    const total = roundTo(parse(amount), currency);
    const allocations = open_.map((b) => ({ billId: b.id, amount: roundTo(parse(alloc[b.id] ?? ""), b.currency) })).filter((a) => a.amount > 0);
    const allocated = roundTo(allocations.reduce((s, a) => s + a.amount, 0), currency);
    const advance = roundTo(Math.max(0, total - allocated), currency);
    const money = (n: number, cur = currency) => formatMoney(n, cur, locale);

    const chooseSupplier = (id: string) => {
        const s = suppliers.find((x) => x.id === id);
        setSupplierId(id);
        setAlloc({});
        if (s) setCurrency(s.currency);
        setErrors((e) => ({ ...e, supplier: undefined }));
    };

    const auto = () => {
        const { allocations: a } = allocateOldestFirst(total, open_.map((b) => ({ id: b.id, dueDate: b.dueDate, outstanding: owedExcludingThis(b) })), currency);
        setAlloc(Object.fromEntries(a.map((x) => [x.billId, String(x.amount)])));
    };

    const submit = async () => {
        const draft = { number, supplierId, date, currency, amount: total, method, allocations };
        const outstandingOf = (id: string) => {
            const b = bills.find((x) => x.id === id);
            return b ? owedExcludingThis(b) : 0;
        };
        const found = validateSupplierPayment(draft, { suppliers, bills, payments, outstandingOf }, payment?.id);
        if (hasPaymentErrors(found)) {
            setErrors(found);
            return;
        }
        setBusy(true);
        const result = payment ? await allocateSupplierPayment(payment.id, allocations) : await recordSupplierPayment({ ...draft, reference, note, prefix });
        setBusy(false);
        if (result.ok) {
            toast({ title: payment ? _t("payables.toast.allocated") : _t("payables.toast.recorded", { number: result.payment.number }) });
            onClose(result.payment);
        } else if ("errors" in result) setErrors(result.errors);
        else toast({ variant: "destructive", title: _t(result.reason === "limit" ? "payables.toast.limit" : result.reason === "notAllowed" ? "payables.toast.notAllowed" : "payables.toast.storage") });
    };

    const e = (k: "supplier" | "date" | "amount" | "currency" | "method" | "number") => (errors[k] ? _t(`payables.errors.${errors[k]}`) : undefined);
    const sup = suppliers.find((s) => s.id === supplierId);
    const selectable = suppliers.filter((s) => !s.inactive || s.id === supplierId).sort((a, b) => a.name.localeCompare(b.name));

    return (
        <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-h-[94dvh] max-w-2xl overflow-y-auto" data-testid="pay-dialog">
                <DialogHeader>
                    <DialogTitle>{payment ? _t("payables.form.titleAllocate", { number: payment.number }) : _t("payables.form.title")}</DialogTitle>
                    <DialogDescription className="sr-only">{_t("payables.subtitle")}</DialogDescription>
                </DialogHeader>

                <form
                    className="space-y-5"
                    noValidate
                    onSubmit={(ev) => {
                        ev.preventDefault();
                        void submit();
                    }}
                >
                    <div className="grid gap-4 sm:grid-cols-2">
                        <Field id="pay-supplier" label={_t("payables.form.supplier")} error={e("supplier")} className="sm:col-span-2">
                            <NativeSelect id="pay-supplier" data-testid="pay-supplier" value={supplierId} disabled={allocating} aria-invalid={!!errors.supplier} onChange={(ev) => chooseSupplier(ev.target.value)}>
                                <option value="">{_t("payables.form.selectSupplier")}</option>
                                {selectable.map((s) => (
                                    <option key={s.id} value={s.id}>
                                        {s.name}
                                    </option>
                                ))}
                            </NativeSelect>
                        </Field>
                        <Field id="pay-amount" label={_t("payables.form.amount")} error={e("amount")}>
                            <Input id="pay-amount" data-testid="pay-amount" type="number" min={0} step="0.01" inputMode="decimal" value={amount} disabled={allocating} aria-invalid={!!errors.amount} onChange={(ev) => setAmount(ev.target.value)} />
                        </Field>
                        <Field id="pay-currency" label={_t("payables.form.currency")} error={e("currency")}>
                            <Input id="pay-currency" value={currency} maxLength={3} className="uppercase" disabled={allocating} aria-invalid={!!errors.currency} onChange={(ev) => { setCurrency(ev.target.value.toUpperCase()); setAlloc({}); }} />
                        </Field>
                        <Field id="pay-date" label={_t("payables.form.date")} error={e("date")}>
                            <Input id="pay-date" data-testid="pay-date" type="date" value={date} disabled={allocating} aria-invalid={!!errors.date} onChange={(ev) => setDate(ev.target.value)} />
                        </Field>
                        <Field id="pay-method" label={_t("payables.form.method")} error={e("method")}>
                            <NativeSelect id="pay-method" data-testid="pay-method" value={method} disabled={allocating} onChange={(ev) => setMethod(ev.target.value)}>
                                {PAYMENT_METHODS.map((m) => (
                                    <option key={m} value={m}>
                                        {_t(`payables.methods.${m}`)}
                                    </option>
                                ))}
                            </NativeSelect>
                        </Field>
                        {!allocating && (
                            <>
                                <Field id="pay-ref" label={_t("payables.form.reference")}>
                                    <Input id="pay-ref" data-testid="pay-reference" value={reference} maxLength={80} onChange={(ev) => setReference(ev.target.value)} />
                                </Field>
                                <Field id="pay-number" label={_t("payables.form.number")} error={e("number")} hint={_t("payables.form.numberHint")}>
                                    <Input id="pay-number" value={number} maxLength={40} aria-invalid={!!errors.number} onChange={(ev) => setNumber(ev.target.value)} />
                                </Field>
                            </>
                        )}
                    </div>

                    <section aria-labelledby="pay-settle" className="space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 id="pay-settle" className="text-sm font-semibold">
                                {_t("payables.form.settle")}
                            </h3>
                            {open_.length > 0 && (
                                <div className="flex gap-2">
                                    <BaseButton variant="outline" size="sm" className="h-8" onClick={auto} disabled={!(total > 0)} data-testid="pay-auto">
                                        {_t("payables.form.auto")}
                                    </BaseButton>
                                    <BaseButton variant="ghost" size="sm" className="h-8" onClick={() => setAlloc({})}>
                                        {_t("payables.form.clear")}
                                    </BaseButton>
                                </div>
                            )}
                        </div>
                        {errors.allocations && (
                            <p role="alert" className="text-sm font-medium text-destructive">
                                {_t(`payables.errors.${errors.allocations}`)}
                            </p>
                        )}

                        {!supplierId ? null : open_.length === 0 ? (
                            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground" data-testid="pay-no-bills">
                                {_t("payables.form.noOpenBills", { currency })}
                            </p>
                        ) : (
                            <ul className="space-y-2">
                                {open_.map((b) => {
                                    const err = errors.allocationErrors[b.id];
                                    return (
                                        <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3" data-testid="pay-bill" data-bill={b.number}>
                                            <div className="min-w-0">
                                                <p className="truncate text-sm font-medium">
                                                    {b.number} · {b.supplierBillNo}
                                                </p>
                                                <p className="text-xs text-muted-foreground">
                                                    {_t("payables.form.due", { date: formatDay(b.dueDate, locale) })} · {_t("payables.form.owes", { amount: money(owedExcludingThis(b), b.currency) })}
                                                </p>
                                                {err && (
                                                    <p role="alert" className="text-xs font-medium text-destructive">
                                                        {_t(`payables.errors.${err}`)}
                                                    </p>
                                                )}
                                            </div>
                                            <Input
                                                aria-label={`${b.number}`}
                                                data-testid="pay-alloc"
                                                className="h-9 w-36 text-end tabular-nums"
                                                type="number"
                                                min={0}
                                                step="0.01"
                                                inputMode="decimal"
                                                value={alloc[b.id] ?? ""}
                                                aria-invalid={!!err}
                                                onChange={(ev) => setAlloc((a) => ({ ...a, [b.id]: ev.target.value }))}
                                            />
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </section>

                    {!allocating && (
                        <Field id="pay-note" label={_t("payables.form.note")}>
                            <Textarea id="pay-note" rows={2} maxLength={1000} value={note} onChange={(ev) => setNote(ev.target.value)} />
                        </Field>
                    )}

                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-sm text-muted-foreground" data-testid="pay-summary">
                            {_t("payables.form.settles", { amount: money(allocated) })}
                            {advance > 0 && sup ? ` · ${_t("payables.form.advance", { amount: money(advance) })}` : ""}
                        </p>
                        <div className="flex flex-col-reverse gap-2 sm:flex-row">
                            <BaseButton variant="outline" onClick={() => onClose()}>
                                {_t("payables.form.cancel")}
                            </BaseButton>
                            <BaseButton type="submit" loading={busy} data-testid="pay-save">
                                {_t(allocating ? "payables.form.saveAllocate" : "payables.form.save")}
                            </BaseButton>
                        </div>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
};

export default SupplierPaymentDialog;
