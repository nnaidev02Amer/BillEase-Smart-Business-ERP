"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/use-toast";
import BaseButton from "@/app/components/reusables/BaseButton";
import StatusBadge from "./StatusBadge";

import { useInvoiceContext } from "@/contexts/InvoiceContext";
import { useTranslationContext } from "@/contexts/TranslationContext";
import {
    PAYMENT_METHODS,
    amountPaid,
    balanceDue,
    displayStatus,
    formatMoney,
    invoiceTotal,
    isoDay,
    parseDate,
    paymentsOf,
    storedStatus,
} from "@/lib/invoiceRecords";

import { Trash2 } from "lucide-react";

/**
 * Payment tracking for one invoice: what is owed, what has been paid, and a
 * form to record more. The invoice is looked up by number from the live saved
 * list, so the figures here update the moment a payment is recorded.
 */
const PaymentsDialog = ({ number, onClose }: { number: string | null; onClose: () => void }) => {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const { savedInvoices, recordPayment, removePayment, markPaid } = useInvoiceContext();

    const invoice = number ? savedInvoices.find((i) => i.details.invoiceNumber === number) : undefined;

    const [amount, setAmount] = useState("");
    const [date, setDate] = useState(isoDay(new Date()));
    const [method, setMethod] = useState<string>("bank");
    const [note, setNote] = useState("");
    const [error, setError] = useState<string | null>(null);

    // Reset the form whenever a different invoice is opened.
    useEffect(() => {
        if (invoice) {
            setAmount(String(balanceDue(invoice) || ""));
            setDate(isoDay(new Date()));
            setMethod("bank");
            setNote("");
            setError(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [number]);

    if (!invoice) return <Dialog open={false} onOpenChange={onClose} />;

    const currency = invoice.details.currency;
    const money = (v: number) => formatMoney(v, currency, locale);
    const status = storedStatus(invoice);
    const payments = [...paymentsOf(invoice)].sort(
        (a, b) => (parseDate(b.date)?.getTime() ?? 0) - (parseDate(a.date)?.getTime() ?? 0)
    );
    const balance = balanceDue(invoice);

    const submit = (e: React.FormEvent) => {
        e.preventDefault();
        const result = recordPayment(invoice.details.invoiceNumber, {
            amount: Number(amount),
            date,
            method,
            note: note.trim() || undefined,
        });
        if (!result.ok) {
            setError(_t(`invoices.errors.${result.reason}`));
            return;
        }
        setError(null);
        setNote("");
        toast({ title: _t("invoices.toast.paymentRecorded"), description: money(Number(amount)) });
        // Pre-fill what is left, or clear once settled.
        const left = Math.max(0, balance - Number(amount));
        setAmount(left > 0 ? String(Math.round(left * 100) / 100) : "");
    };

    return (
        <Dialog open={number !== null} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        {_t("invoices.payments.title", { number: invoice.details.invoiceNumber })}
                        <StatusBadge status={displayStatus(invoice)} />
                    </DialogTitle>
                    <DialogDescription>{invoice.receiver.name}</DialogDescription>
                </DialogHeader>

                <dl className="grid grid-cols-3 gap-3 rounded-lg bg-muted/50 p-3 text-sm">
                    <div>
                        <dt className="text-xs text-muted-foreground">{_t("invoices.payments.total")}</dt>
                        <dd className="font-semibold tabular-nums">{money(invoiceTotal(invoice))}</dd>
                    </div>
                    <div>
                        <dt className="text-xs text-muted-foreground">{_t("invoices.payments.paid")}</dt>
                        <dd className="font-semibold tabular-nums text-success">{money(amountPaid(invoice))}</dd>
                    </div>
                    <div>
                        <dt className="text-xs text-muted-foreground">{_t("invoices.payments.balance")}</dt>
                        <dd className="font-semibold tabular-nums">{money(balance)}</dd>
                    </div>
                </dl>

                {status !== "sent" ? (
                    <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground" role="status">
                        {_t(status === "draft" ? "invoices.errors.paymentOnDraft" : "invoices.errors.paymentOnCancelled")}
                    </p>
                ) : balance > 0 ? (
                    <form onSubmit={submit} className="space-y-3" noValidate>
                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                                <Label htmlFor="pay-amount">{_t("invoices.payments.amount")}</Label>
                                <Input
                                    id="pay-amount"
                                    type="number"
                                    inputMode="decimal"
                                    min="0.01"
                                    step="0.01"
                                    value={amount}
                                    onChange={(e) => setAmount(e.target.value)}
                                    aria-invalid={!!error}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="pay-date">{_t("invoices.payments.date")}</Label>
                                <Input
                                    id="pay-date"
                                    type="date"
                                    max={isoDay(new Date())}
                                    value={date}
                                    onChange={(e) => setDate(e.target.value)}
                                />
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                                <Label htmlFor="pay-method">{_t("invoices.payments.method")}</Label>
                                <Select value={method} onValueChange={setMethod}>
                                    <SelectTrigger id="pay-method">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {PAYMENT_METHODS.map((m) => (
                                            <SelectItem key={m} value={m}>
                                                {_t(`invoices.methods.${m}`)}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="pay-note">{_t("invoices.payments.note")}</Label>
                                <Input id="pay-note" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
                            </div>
                        </div>
                        {error && (
                            <p role="alert" className="text-sm text-destructive">
                                {error}
                            </p>
                        )}
                        <div className="flex flex-wrap justify-end gap-2">
                            <BaseButton
                                variant="outline"
                                onClick={() => {
                                    const r = markPaid(invoice.details.invoiceNumber);
                                    if (!r.ok) setError(_t(`invoices.errors.${r.reason}`));
                                    else toast({ title: _t("invoices.toast.paid"), description: invoice.details.invoiceNumber });
                                }}
                            >
                                {_t("invoices.markPaid")}
                            </BaseButton>
                            <BaseButton type="submit">{_t("invoices.payments.record")}</BaseButton>
                        </div>
                    </form>
                ) : (
                    <p className="text-sm text-success" role="status">
                        {_t("invoices.payments.settled")}
                    </p>
                )}

                <div>
                    <h3 className="mb-2 text-sm font-semibold">{_t("invoices.payments.history")}</h3>
                    {payments.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{_t("invoices.payments.none")}</p>
                    ) : (
                        <ul className="divide-y rounded-lg border">
                            {payments.map((p) => (
                                <li key={p.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                                    <div className="min-w-0">
                                        <p className="font-medium tabular-nums">{money(p.amount)}</p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {parseDate(p.date)?.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" })}
                                            {p.method ? ` · ${_t(`invoices.methods.${p.method}`)}` : ""}
                                            {p.note ? ` · ${p.note}` : ""}
                                        </p>
                                    </div>
                                    {status === "sent" && (
                                        <BaseButton
                                            size="icon"
                                            variant="ghost"
                                            className="text-destructive hover:text-destructive"
                                            aria-label={`${_t("invoices.payments.remove")} ${money(p.amount)}`}
                                            onClick={() => removePayment(invoice.details.invoiceNumber, p.id)}
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </BaseButton>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
};

export default PaymentsDialog;
