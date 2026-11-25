"use client";

import { useEffect, useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/use-toast";
import BaseButton from "@/app/components/reusables/BaseButton";

import { useTranslationContext } from "@/contexts/TranslationContext";
import { EXPENSE_METHODS, toDay, type Expense, type ExpenseErrors, type ExpenseMethod } from "@/lib/expenses";
import { saveExpense } from "@/lib/expenseStore";
import currencies from "@/public/assets/data/currencies.json";

type Form = {
    title: string;
    category: string;
    amount: string;
    currency: string;
    date: string;
    method: ExpenseMethod;
    vendor: string;
    reference: string;
    notes: string;
    taxAmount: string;
    taxRate: string;
    taxRecoverable: boolean;
    vendorGstin: string;
};

const blank = (currency: string): Form => ({
    title: "",
    category: "miscellaneous",
    amount: "",
    currency,
    date: toDay(new Date()),
    method: "bank",
    vendor: "",
    reference: "",
    notes: "",
    taxAmount: "",
    taxRate: "",
    taxRecoverable: false,
    vendorGstin: "",
});

const fromExpense = (e: Expense): Form => ({
    title: e.title,
    category: e.category,
    amount: String(e.amount),
    currency: e.currency,
    date: e.date,
    method: e.method,
    vendor: e.vendor,
    reference: e.reference,
    notes: e.notes,
    taxAmount: e.tax ? String(e.tax.amount) : "",
    taxRate: e.tax?.rate !== undefined ? String(e.tax.rate) : "",
    taxRecoverable: e.tax?.recoverable === true,
    vendorGstin: e.tax?.gstin ?? "",
});

type Props = {
    /** `null` = closed, `"new"` = create, otherwise edit that expense. */
    target: Expense | "new" | null;
    onClose: () => void;
    categories: { id: string; name: string }[];
    /** The currency a new expense starts in (the one you use most). */
    defaultCurrency: string;
};

/** Create or edit an expense. Everything is validated again by the store. */
const ExpenseDialog = ({ target, onClose, categories, defaultCurrency }: Props) => {
    const { _t } = useTranslationContext();
    const [form, setForm] = useState<Form>(blank(defaultCurrency));
    const [errors, setErrors] = useState<ExpenseErrors>({});
    const [busy, setBusy] = useState(false);

    const editing = target && target !== "new" ? target : null;

    useEffect(() => {
        if (target === null) return;
        setForm(target === "new" ? blank(defaultCurrency) : fromExpense(target));
        setErrors({});
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [target]);

    const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        try {
            const result = await saveExpense({ ...form, amount: form.amount.trim(), taxAmount: form.taxAmount.trim(), taxRate: form.taxRate.trim() }, editing?.id);
            if (result.ok) {
                toast({ title: _t("expenses.toast.saved"), description: result.expense.title });
                onClose();
            } else if ("errors" in result) {
                setErrors(result.errors);
            } else {
                toast({ variant: "destructive", title: _t(`expenses.errors.${result.reason}`) });
            }
        } finally {
            setBusy(false);
        }
    };

    const err = (key: keyof ExpenseErrors) =>
        errors[key] ? (
            <p className="text-xs text-destructive" role="alert">
                {_t(`expenses.errors.${errors[key]}`)}
            </p>
        ) : null;

    return (
        <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto" data-testid="expense-dialog">
                <DialogHeader>
                    <DialogTitle>{editing ? _t("expenses.edit") : _t("expenses.add")}</DialogTitle>
                    <DialogDescription>{_t("expenses.formHint")}</DialogDescription>
                </DialogHeader>

                <form onSubmit={submit} noValidate className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5 sm:col-span-2">
                        <Label htmlFor="ex-title">{_t("expenses.form.title")}</Label>
                        <Input id="ex-title" name="title" value={form.title} onChange={(e) => set("title", e.target.value)} maxLength={120} autoFocus aria-invalid={!!errors.title} />
                        {err("title")}
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="ex-category">{_t("expenses.form.category")}</Label>
                        <Select value={form.category} onValueChange={(v) => set("category", v)}>
                            <SelectTrigger id="ex-category"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                {categories.map((c) => (
                                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        {err("category")}
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="ex-date">{_t("expenses.form.date")}</Label>
                        <Input id="ex-date" name="date" type="date" value={form.date} onChange={(e) => set("date", e.target.value)} aria-invalid={!!errors.date} />
                        {err("date")}
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="ex-amount">{_t("expenses.form.amount")}</Label>
                        <Input id="ex-amount" name="amount" inputMode="decimal" value={form.amount} onChange={(e) => set("amount", e.target.value)} aria-invalid={!!errors.amount} />
                        {err("amount") ?? <p className="text-xs text-muted-foreground">{_t("expenses.form.amountHint")}</p>}
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="ex-currency">{_t("expenses.form.currency")}</Label>
                        <Input id="ex-currency" name="currency" list="ex-currencies" value={form.currency} onChange={(e) => set("currency", e.target.value.toUpperCase().slice(0, 3))} maxLength={3} aria-invalid={!!errors.currency} autoCapitalize="characters" />
                        <datalist id="ex-currencies">
                            {Object.keys(currencies).map((c) => (
                                <option key={c} value={c} />
                            ))}
                        </datalist>
                        {err("currency")}
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="ex-method">{_t("expenses.form.method")}</Label>
                        <Select value={form.method} onValueChange={(v) => set("method", v as ExpenseMethod)}>
                            <SelectTrigger id="ex-method"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                {EXPENSE_METHODS.map((m) => (
                                    <SelectItem key={m} value={m}>{_t(`invoices.methods.${m}`)}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="ex-vendor">{_t("expenses.form.vendor")}</Label>
                        <Input id="ex-vendor" name="vendor" value={form.vendor} onChange={(e) => set("vendor", e.target.value)} maxLength={100} />
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="ex-ref">{_t("expenses.form.reference")}</Label>
                        <Input id="ex-ref" name="reference" value={form.reference} onChange={(e) => set("reference", e.target.value)} maxLength={60} />
                    </div>

                    <fieldset className="space-y-3 rounded-lg border p-3 sm:col-span-2">
                        <legend className="px-1 text-sm font-semibold">
                            {_t("expenses.form.taxTitle")} <span className="font-normal text-muted-foreground">({_t("expenses.form.optional")})</span>
                        </legend>
                        <div className="grid gap-3 sm:grid-cols-3">
                            <div className="space-y-1.5">
                                <Label htmlFor="ex-tax">{_t("expenses.form.taxAmount")}</Label>
                                <Input id="ex-tax" name="taxAmount" inputMode="decimal" value={form.taxAmount} onChange={(e) => set("taxAmount", e.target.value)} aria-invalid={!!errors.taxAmount} />
                                {err("taxAmount")}
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="ex-rate">{_t("expenses.form.taxRate")}</Label>
                                <Input id="ex-rate" name="taxRate" inputMode="decimal" value={form.taxRate} onChange={(e) => set("taxRate", e.target.value)} aria-invalid={!!errors.taxRate} />
                                {err("taxRate")}
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="ex-gstin">{_t("expenses.form.vendorGstin")}</Label>
                                <Input id="ex-gstin" name="vendorGstin" value={form.vendorGstin} onChange={(e) => set("vendorGstin", e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, ""))} maxLength={15} spellCheck={false} aria-invalid={!!errors.vendorGstin} />
                                {err("vendorGstin")}
                            </div>
                        </div>
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <Label htmlFor="ex-recoverable">{_t("expenses.form.recoverable")}</Label>
                                <p className="text-xs text-muted-foreground">{_t("expenses.form.recoverableHint")}</p>
                            </div>
                            <Switch id="ex-recoverable" checked={form.taxRecoverable} onCheckedChange={(v) => set("taxRecoverable", v)} />
                        </div>
                    </fieldset>

                    <div className="space-y-1.5 sm:col-span-2">
                        <Label htmlFor="ex-notes">{_t("expenses.form.notes")}</Label>
                        <Textarea id="ex-notes" name="notes" rows={3} maxLength={1000} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
                    </div>

                    <div className="flex justify-end gap-2 sm:col-span-2">
                        <BaseButton variant="ghost" onClick={onClose}>{_t("guards.cancel")}</BaseButton>
                        <BaseButton type="submit" loading={busy} data-testid="save-expense">{_t("expenses.form.save")}</BaseButton>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
};

export default ExpenseDialog;
