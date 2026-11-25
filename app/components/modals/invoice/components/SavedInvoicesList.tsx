"use client";

import React, { useState } from "react";

// ShadCn
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
import { Card, CardContent } from "@/components/ui/card";

// Components
import BaseButton from "@/app/components/reusables/BaseButton";
import StatusBadge from "@/app/components/dashboard/StatusBadge";

// Contexts
import { useInvoiceContext } from "@/contexts/InvoiceContext";

// Helpers
import { formatNumberWithCommas } from "@/lib/helpers";
import { displayStatus } from "@/lib/invoiceRecords";

type SavedInvoicesListProps = {
    setModalState: React.Dispatch<React.SetStateAction<boolean>>;
};

const SavedInvoicesList = ({ setModalState }: SavedInvoicesListProps) => {
    const { savedInvoices, savedLoaded, onFormSubmit, deleteInvoiceByNumber, loadInvoice } =
        useInvoiceContext();

    const [pendingDelete, setPendingDelete] = useState<string | null>(null);

    /**
     * Loads a saved invoice into the form. Dates, logo and signature are kept;
     * the previous implementation mutated the saved object and wiped the logo
     * and signature on every load.
     */
    const load = (index: number, generate = false) => {
        const invoice = savedInvoices[index];
        if (!invoice) return;
        loadInvoice(invoice, { navigate: false });
        setModalState(false);
        if (generate) {
            // The form has just been reset to this invoice; generating from
            // the same copy keeps the PDF in step with what the user sees.
            const copy = JSON.parse(JSON.stringify(invoice));
            copy.details.invoiceDate = new Date(copy.details.invoiceDate);
            copy.details.dueDate = new Date(copy.details.dueDate);
            onFormSubmit(copy);
        }
    };

    return (
        <>
            <div className="flex max-h-72 flex-col gap-5 overflow-y-auto" aria-busy={!savedLoaded}>
                {savedInvoices.map((invoice, idx) => (
                    <Card
                        key={invoice.details.invoiceNumber}
                        className="rounded-sm border p-2 transition-shadow hover:border-primary/60 hover:shadow-lg"
                    >
                        <CardContent className="flex justify-between gap-3">
                            <div className="min-w-0">
                                <p className="flex items-center gap-2 font-semibold">
                                    Invoice #{invoice.details.invoiceNumber}
                                    <StatusBadge status={displayStatus(invoice)} />
                                </p>
                                <small className="text-muted-foreground">
                                    Updated at: {invoice.details.updatedAt}
                                </small>

                                <div className="truncate">
                                    <p className="truncate">Sender: {invoice.sender.name}</p>
                                    <p className="truncate">Receiver: {invoice.receiver.name}</p>
                                    <p>
                                        Total:{" "}
                                        <span className="font-semibold">
                                            {formatNumberWithCommas(Number(invoice.details.totalAmount))}{" "}
                                            {invoice.details.currency}
                                        </span>
                                    </p>
                                </div>
                            </div>

                            <div className="flex shrink-0 flex-col gap-2">
                                <BaseButton
                                    tooltipLabel="Load invoice details into the form"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => load(idx)}
                                >
                                    Load
                                </BaseButton>

                                <BaseButton
                                    tooltipLabel="Load invoice and generate PDF"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => load(idx, true)}
                                >
                                    Load & Generate
                                </BaseButton>

                                <BaseButton
                                    variant="destructive"
                                    size="sm"
                                    onClick={() => setPendingDelete(invoice.details.invoiceNumber)}
                                >
                                    Delete
                                </BaseButton>
                            </div>
                        </CardContent>
                    </Card>
                ))}

                {savedLoaded && savedInvoices.length === 0 && (
                    <p className="text-sm text-muted-foreground">No saved invoices</p>
                )}
            </div>

            <AlertDialog open={pendingDelete !== null} onOpenChange={(o) => !o && setPendingDelete(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete invoice {pendingDelete}?</AlertDialogTitle>
                        <AlertDialogDescription>
                            This permanently removes it from this browser.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={() => {
                                if (pendingDelete !== null) deleteInvoiceByNumber(pendingDelete);
                                setPendingDelete(null);
                            }}
                        >
                            Delete invoice
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
};

export default SavedInvoicesList;
