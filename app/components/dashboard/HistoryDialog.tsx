"use client";

import { useState } from "react";
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/use-toast";
import BaseButton from "@/app/components/reusables/BaseButton";
import { useInvoiceContext } from "@/contexts/InvoiceContext";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { formatMoney, parseDate } from "@/lib/invoiceRecords";

/** Every earlier saved version of an invoice, newest first, each restorable. */
const HistoryDialog = ({ number, onClose }: { number: string | null; onClose: () => void }) => {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const { savedInvoices, restoreInvoiceRevision } = useInvoiceContext();
    const [pending, setPending] = useState<string | null>(null);

    const invoice = number ? savedInvoices.find((i) => i.details.invoiceNumber === number) : undefined;
    const revisions = [...(invoice?.details.revisions ?? [])].reverse();

    return (
        <>
            <Dialog open={number !== null && !!invoice} onOpenChange={(o) => !o && onClose()}>
                <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>{_t("invoices.history.title", { number: number ?? "" })}</DialogTitle>
                        <DialogDescription>{_t("invoices.history.subtitle")}</DialogDescription>
                    </DialogHeader>
                    {revisions.length === 0 ? (
                        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                            {_t("invoices.history.none")}
                        </p>
                    ) : (
                        <ol className="space-y-2">
                            {revisions.map((r, i) => (
                                <li key={r.id} className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
                                    <div>
                                        <p className="font-medium">
                                            {_t("invoices.history.version", { n: revisions.length - i })}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {parseDate(r.savedAt)?.toLocaleString(locale)} ·{" "}
                                            {formatMoney(r.total, invoice?.details.currency ?? "USD", locale)}
                                        </p>
                                    </div>
                                    <BaseButton size="sm" variant="outline" onClick={() => setPending(r.id)}>
                                        {_t("invoices.history.restore")}
                                    </BaseButton>
                                </li>
                            ))}
                        </ol>
                    )}
                </DialogContent>
            </Dialog>

            <AlertDialog open={pending !== null} onOpenChange={(o) => !o && setPending(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{_t("invoices.history.confirmTitle")}</AlertDialogTitle>
                        <AlertDialogDescription>{_t("invoices.history.confirmBody")}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>{_t("guards.cancel")}</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={() => {
                                if (number && pending && restoreInvoiceRevision(number, pending)) {
                                    toast({ title: _t("invoices.toast.restored"), description: number });
                                }
                                setPending(null);
                            }}
                        >
                            {_t("invoices.history.restore")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
};

export default HistoryDialog;
