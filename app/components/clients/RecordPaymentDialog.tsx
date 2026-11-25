"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale } from "next-intl";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/use-toast";
import BaseButton from "@/app/components/reusables/BaseButton";

import { useInvoiceContext } from "@/contexts/InvoiceContext";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { allocatePayment, openInvoicesOf, type CustomerRecord } from "@/lib/crm";
import { PAYMENT_METHODS, canRecordPayment, clientKey, formatMoney, isoDay, parseDate } from "@/lib/invoiceRecords";

/**
 * Record a payment from a customer without opening each invoice.
 *
 * The payment is split across their open invoices (oldest due date first), or
 * aimed at one. Nothing is written until *every* part has been checked against
 * the same rules as a payment recorded on the invoice itself (not on a draft,
 * not in the future, not before the invoice was issued, not more than is
 * owed), so a payment is either applied whole or not at all.
 */
const RecordPaymentDialog = ({ record, onClose }: { record: CustomerRecord | null; onClose: () => void }) => {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const { savedInvoices, recordPayment } = useInvoiceContext();

    const [currency, setCurrency] = useState("");
    const [amount, setAmount] = useState("");
    const [date, setDate] = useState(isoDay(new Date()));
    const [method, setMethod] = useState<string>("bank");
    const [note, setNote] = useState("");
    const [target, setTarget] = useState<string>("oldest");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const mine = useMemo(() => (record ? savedInvoices.filter((i) => clientKey(i.receiver) === record.key) : []), [record, savedInvoices]);
    const allOpen = useMemo(() => openInvoicesOf(mine), [mine]);
    // The customer's main currency first, then the rest alphabetically.
    const currencies = useMemo(() => {
        const all = [...new Set(allOpen.map((o) => o.currency))].sort();
        return record && all.includes(record.primaryCurrency) ? [record.primaryCurrency, ...all.filter((c) => c !== record.primaryCurrency)] : all;
    }, [allOpen, record]);
    const open = useMemo(() => allOpen.filter((o) => o.currency === currency), [allOpen, currency]);
    const owed = open.reduce((s, o) => s + o.balance, 0);

    // Start from what is owed, in the currency most is owed in.
    useEffect(() => {
        if (!record) return;
        const first = currencies[0] ?? "";
        setCurrency(first);
        const total = allOpen.filter((o) => o.currency === first).reduce((s, o) => s + o.balance, 0);
        setAmount(total ? String(Math.round(total * 100) / 100) : "");
        setDate(isoDay(new Date()));
        setMethod("bank");
        setNote("");
        setTarget("oldest");
        setError(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [record?.key]);

    const money = (v: number) => formatMoney(v, currency || "USD", locale);
    const value = Number(amount);
    const plan = useMemo(
        () => (open.length ? allocatePayment(open, value, target === "oldest" ? { mode: "oldest" } : { mode: "invoice", number: target }) : null),
        [open, value, target]
    );

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!record || busy) return;
        if (!plan || !plan.ok) {
            setError(
                !plan || plan.reason === "nothingOwed"
                    ? _t("crm.payment.errors.nothingOwed")
                    : plan.reason === "exceeds"
                      ? _t("crm.payment.errors.exceeds", { owed: money(plan.owed ?? 0) })
                      : plan.reason === "notFound"
                        ? _t("crm.payment.errors.notFound")
                        : _t("crm.payment.errors.amount")
            );
            return;
        }

        // Check every part first: all or nothing.
        const dated = parseDate(date);
        if (!dated) {
            setError(_t("invoices.errors.dateInvalid"));
            return;
        }
        for (const a of plan.allocations) {
            const inv = mine.find((i) => i.details.invoiceNumber === a.number);
            if (!inv) continue;
            const check = canRecordPayment(inv, { amount: a.amount, date, method, note });
            if (!check.ok) {
                setError(`${a.number}: ${_t(`invoices.errors.${check.reason}`)}`);
                return;
            }
        }

        setBusy(true);
        try {
            for (const a of plan.allocations) {
                recordPayment(a.number, { amount: a.amount, date, method, note });
            }
            toast({
                title: _t("crm.payment.recorded"),
                description: _t("crm.payment.recordedBody", { amount: money(value), count: plan.allocations.length }),
            });
            onClose();
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog open={record !== null} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto" data-testid="record-payment">
                <DialogHeader>
                    <DialogTitle>{_t("crm.payment.title", { name: record?.name ?? "" })}</DialogTitle>
                    <DialogDescription>{_t("crm.payment.hint")}</DialogDescription>
                </DialogHeader>

                {allOpen.length === 0 ? (
                    <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground" data-testid="nothing-owed">
                        {_t("crm.payment.errors.nothingOwed")}
                    </p>
                ) : (
                    <form className="space-y-4" noValidate onSubmit={submit}>
                        {currencies.length > 1 && (
                            <div className="space-y-1.5">
                                <Label htmlFor="pay-currency">{_t("crm.payment.currency")}</Label>
                                <Select
                                    value={currency}
                                    onValueChange={(v) => {
                                        setCurrency(v);
                                        setTarget("oldest");
                                        const total = allOpen.filter((o) => o.currency === v).reduce((s, o) => s + o.balance, 0);
                                        setAmount(String(Math.round(total * 100) / 100));
                                        setError(null);
                                    }}
                                >
                                    <SelectTrigger id="pay-currency"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        {currencies.map((c) => (
                                            <SelectItem key={c} value={c}>{c}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        )}

                        <p className="rounded-lg bg-muted/50 p-3 text-sm" data-testid="pay-owed">
                            {_t("crm.payment.owed", { amount: money(owed), count: open.length })}
                        </p>

                        <div className="grid gap-3 sm:grid-cols-2">
                            <div className="space-y-1.5">
                                <Label htmlFor="pay-amount">{_t("crm.payment.amount")}</Label>
                                <Input id="pay-amount" name="amount" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setError(null); }} autoFocus aria-invalid={!!error} />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="pay-date">{_t("crm.payment.date")}</Label>
                                <Input id="pay-date" name="date" type="date" max={isoDay(new Date())} value={date} onChange={(e) => { setDate(e.target.value); setError(null); }} />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="pay-method">{_t("crm.payment.method")}</Label>
                                <Select value={method} onValueChange={setMethod}>
                                    <SelectTrigger id="pay-method"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        {PAYMENT_METHODS.map((m) => (
                                            <SelectItem key={m} value={m}>{_t(`invoices.methods.${m}`)}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="pay-apply">{_t("crm.payment.apply")}</Label>
                                <Select value={target} onValueChange={(v) => { setTarget(v); setError(null); }}>
                                    <SelectTrigger id="pay-apply"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="oldest">{_t("crm.payment.oldest")}</SelectItem>
                                        {open.map((o) => (
                                            <SelectItem key={o.number} value={o.number}>{o.number} · {money(o.balance)}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>

                        <div className="space-y-1.5">
                            <Label htmlFor="pay-note">{_t("crm.payment.note")}</Label>
                            <Input id="pay-note" name="note" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
                        </div>

                        {plan?.ok && (
                            <div data-testid="allocation-preview">
                                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{_t("crm.payment.allocation")}</p>
                                <ul className="divide-y rounded-lg border text-sm">
                                    {plan.allocations.map((a) => {
                                        const o = open.find((x) => x.number === a.number)!;
                                        return (
                                            <li key={a.number} className="flex items-center justify-between gap-3 px-3 py-2" data-testid="allocation">
                                                <span className="font-medium">{a.number}</span>
                                                <span className="tabular-nums">
                                                    {money(a.amount)}
                                                    <span className="ms-2 text-xs text-muted-foreground">
                                                        {a.amount >= o.balance ? _t("crm.payment.settles") : _t("crm.payment.leaves", { amount: money(Math.round((o.balance - a.amount) * 100) / 100) })}
                                                    </span>
                                                </span>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>
                        )}

                        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

                        <div className="flex justify-end gap-2">
                            <BaseButton variant="ghost" onClick={onClose}>{_t("guards.cancel")}</BaseButton>
                            <BaseButton type="submit" loading={busy} data-testid="submit-payment">{_t("crm.payment.record")}</BaseButton>
                        </div>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
};

export default RecordPaymentDialog;
