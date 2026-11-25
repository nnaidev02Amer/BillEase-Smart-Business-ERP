"use client";

import { useLocale } from "next-intl";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/use-toast";
import BaseButton from "@/app/components/reusables/BaseButton";

import { useTranslationContext } from "@/contexts/TranslationContext";
import type { Expense } from "@/lib/expenses";
import { setExpenseBill } from "@/lib/expenseStore";
import { formatDay } from "@/lib/dates";
import { formatMoney } from "@/lib/invoiceRecords";
import { expenseCandidates, type PurchaseBill } from "@/lib/purchaseBills";

/**
 * Lets the user say "this manual expense is the same spend as this bill". While
 * the bill is posted it is what counts toward profit and loss and the expense
 * is left out, so the purchase is counted once. Nothing is linked unless the
 * user asks: only they know whether two records are the same purchase.
 */
const ExpenseLinkDialog = ({ open, bill, total, expenses, onClose }: { open: boolean; bill: PurchaseBill | null; total: number; expenses: Expense[]; onClose: () => void }) => {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const rows = bill ? expenseCandidates(bill, total, expenses) : [];

    const toggle = async (e: Expense) => {
        if (!bill) return;
        const linked = e.billId === bill.id;
        const r = await setExpenseBill(e.id, linked ? null : bill.id);
        toast(r.ok ? { title: _t(linked ? "purchaseBills.expenseLink.toastUnlinked" : "purchaseBills.expenseLink.toastLinked") } : { variant: "destructive", title: _t("purchaseBills.toast.storage") });
    };

    return (
        <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-w-lg" data-testid="expense-link-dialog">
                <DialogHeader>
                    <DialogTitle>{_t("purchaseBills.expenseLink.title")}</DialogTitle>
                    <DialogDescription>{_t("purchaseBills.expenseLink.body")}</DialogDescription>
                </DialogHeader>
                <ul className="space-y-2">
                    {rows.map((e) => {
                        const linked = !!bill && e.billId === bill.id;
                        return (
                            <li key={e.id} className="flex items-center justify-between gap-3 rounded-lg border p-3" data-testid="expense-candidate" data-linked={linked ? "true" : "false"}>
                                <p className="min-w-0 truncate text-sm">{_t("purchaseBills.expenseLink.expense", { title: e.title, date: formatDay(e.date, locale), amount: formatMoney(e.amount, e.currency, locale) })}</p>
                                <BaseButton variant={linked ? "outline" : "default"} size="sm" className="h-8 shrink-0" onClick={() => toggle(e)} data-testid="expense-link-toggle">
                                    {_t(linked ? "purchaseBills.expenseLink.unlink" : "purchaseBills.expenseLink.link")}
                                </BaseButton>
                            </li>
                        );
                    })}
                </ul>
            </DialogContent>
        </Dialog>
    );
};

export default ExpenseLinkDialog;
