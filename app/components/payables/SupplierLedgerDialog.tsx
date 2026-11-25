"use client";

import { useMemo } from "react";
import { useLocale } from "next-intl";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { useTranslationContext } from "@/contexts/TranslationContext";
import { formatDay } from "@/lib/dates";
import { formatMoney } from "@/lib/invoiceRecords";
import { supplierLedger } from "@/lib/payables";
import type { PurchaseBill } from "@/lib/purchaseBills";
import type { SupplierPayment } from "@/lib/supplierPayments";
import type { Supplier } from "@/lib/suppliers";

/** A supplier's statement in one currency: opening balance, bills and payments in date order, with a running balance. */
const SupplierLedgerDialog = ({ supplier, currency, bills, payments, onClose }: { supplier: Supplier | null; currency: string; bills: PurchaseBill[]; payments: SupplierPayment[]; onClose: () => void }) => {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const rows = useMemo(() => (supplier ? supplierLedger(supplier, bills, payments, currency) : []), [supplier, bills, payments, currency]);
    const money = (n: number) => formatMoney(n, currency, locale);

    return (
        <Dialog open={supplier !== null} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-h-[92dvh] max-w-3xl overflow-y-auto" data-testid="ledger-dialog">
                <DialogHeader>
                    <DialogTitle>{supplier && _t("payables.ledger.title", { name: supplier.name })}</DialogTitle>
                    <DialogDescription>{_t("payables.ledger.currency", { currency })}</DialogDescription>
                </DialogHeader>
                {rows.length === 0 ? (
                    <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">{_t("payables.ledger.empty")}</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[34rem] text-sm">
                            <thead>
                                <tr className="border-b text-xs text-muted-foreground">
                                    <th scope="col" className="py-2 text-start font-medium">{_t("payables.ledger.date")}</th>
                                    <th scope="col" className="py-2 text-start font-medium">{_t("payables.ledger.ref")}</th>
                                    <th scope="col" className="py-2 text-end font-medium">{_t("payables.ledger.debit")}</th>
                                    <th scope="col" className="py-2 text-end font-medium">{_t("payables.ledger.credit")}</th>
                                    <th scope="col" className="py-2 text-end font-medium">{_t("payables.ledger.balance")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((r) => (
                                    <tr key={r.id} className="border-b last:border-0" data-testid="ledger-row" data-kind={r.kind}>
                                        <td className="py-2 tabular-nums">{r.date ? formatDay(r.date, locale) : "—"}</td>
                                        <td className="py-2">
                                            {r.kind === "opening" ? _t("payables.ledger.opening") : r.ref}
                                            {r.detail ? <span className="ms-2 text-xs text-muted-foreground">{r.detail}</span> : null}
                                        </td>
                                        <td className="py-2 text-end tabular-nums">{r.debit ? money(r.debit) : ""}</td>
                                        <td className="py-2 text-end tabular-nums">{r.credit ? money(r.credit) : ""}</td>
                                        <td className="py-2 text-end font-medium tabular-nums" data-testid="ledger-balance">
                                            {money(r.balance)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                            <tfoot>
                                <tr>
                                    <th scope="row" colSpan={4} className="py-2 text-start font-semibold">
                                        {_t("payables.ledger.closing")}
                                    </th>
                                    <td className="py-2 text-end font-semibold tabular-nums" data-testid="ledger-closing">
                                        {money(rows[rows.length - 1].balance)}
                                    </td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
};

export default SupplierLedgerDialog;
