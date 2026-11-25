"use client";

import BaseButton from "@/app/components/reusables/BaseButton";

import { useTranslationContext } from "@/contexts/TranslationContext";
import {
    canConvert,
    canDelete,
    canEdit,
    canTransition,
    displayStatus,
    numberOf,
    type Quotation,
} from "@/lib/quotations";

import { Check, FileDown, FilePlus2, Pencil, Printer, Send, Trash2, Undo2, X, ExternalLink } from "lucide-react";

import type { useQuotationActions } from "./useQuotationActions";

type Actions = ReturnType<typeof useQuotationActions>;

type Props = {
    quotation: Quotation;
    /** Number of the invoice made from this quotation, if any. */
    invoiceNumber?: string;
    actions: Actions;
    onEdit: (q: Quotation) => void;
    onDelete: (q: Quotation) => void;
    onConvert: (q: Quotation) => void;
    /** Rows are compact (icon buttons for the secondary actions); the sheet is spelled out. */
    variant: "row" | "sheet";
};

/**
 * What can be done to a quotation right now.
 *
 * Which buttons appear is decided by the same rules the store enforces
 * (canTransition, canEdit, …), so a button is shown only when it will work,
 * and the store still refuses if the state changed underneath it.
 */
const QuotationActions = ({ quotation: q, invoiceNumber, actions, onEdit, onDelete, onConvert, variant }: Props) => {
    const { _t } = useTranslationContext();
    const converted = invoiceNumber !== undefined;
    const status = displayStatus(q);
    const number = numberOf(q);

    const can = (to: Parameters<typeof canTransition>[1]) => canTransition(q, to, { converted }).ok;
    const editable = canEdit(q, converted).ok;
    const deletable = canDelete(q, converted).ok;
    const convertible = canConvert(q, converted).ok;

    const sheet = variant === "sheet";
    const size = sheet ? "default" : "sm";
    const rowCls = sheet ? "" : "h-8";

    // "Accept" is offered only while it can succeed; an expired quotation is
    // told to extend its date first (see the edit action) instead.
    const primary: React.ReactNode[] = [];

    // Offered even when the validity has passed: the store refuses with the reason
    // ("choose a later date"), which tells the user what to fix.
    if (q.status === "draft") {
        primary.push(
            <BaseButton key="send" size={size} className={rowCls} onClick={() => actions.setStatus(q, "sent")}>
                <Send className="h-3.5 w-3.5" />
                {_t("quotations.actions.send")}
            </BaseButton>
        );
    }
    if (q.status === "sent" && status === "sent") {
        primary.push(
            <BaseButton key="accept" size={size} className={rowCls} onClick={() => actions.setStatus(q, "accepted")}>
                <Check className="h-3.5 w-3.5" />
                {_t("quotations.actions.accept")}
            </BaseButton>,
            <BaseButton key="reject" size={size} variant="outline" className={rowCls} onClick={() => actions.setStatus(q, "rejected")}>
                <X className="h-3.5 w-3.5" />
                {_t("quotations.actions.reject")}
            </BaseButton>
        );
    }
    if (status === "expired") {
        primary.push(
            <BaseButton key="reject" size={size} variant="outline" className={rowCls} onClick={() => actions.setStatus(q, "rejected")}>
                <X className="h-3.5 w-3.5" />
                {_t("quotations.actions.reject")}
            </BaseButton>
        );
    }
    if (q.status === "accepted" && convertible) {
        primary.push(
            <BaseButton key="convert" size={size} className={rowCls} onClick={() => onConvert(q)} data-testid="convert">
                <FilePlus2 className="h-3.5 w-3.5" />
                {_t("quotations.actions.convert")}
            </BaseButton>
        );
    }
    if (converted && invoiceNumber) {
        primary.push(
            <BaseButton key="open" size={size} variant="outline" className={rowCls} onClick={() => actions.openInvoice(invoiceNumber)} data-testid="open-invoice">
                <ExternalLink className="h-3.5 w-3.5" />
                {_t("quotations.actions.openInvoice", { number: invoiceNumber })}
            </BaseButton>
        );
    }
    if (q.status === "rejected") {
        primary.push(
            <BaseButton key="reopen" size={size} variant="outline" className={rowCls} onClick={() => actions.setStatus(q, "sent")}>
                <Undo2 className="h-3.5 w-3.5" />
                {_t("quotations.actions.reopen")}
            </BaseButton>
        );
    }

    const secondary: React.ReactNode[] = [];
    // Sheet-only status moves that are not the main next step.
    if (sheet && q.status === "sent" && can("draft")) {
        secondary.push(
            <BaseButton key="draft" variant="ghost" onClick={() => actions.setStatus(q, "draft")}>
                <Undo2 className="h-3.5 w-3.5" />
                {_t("quotations.actions.toDraft")}
            </BaseButton>
        );
    }
    if (sheet && q.status === "accepted" && can("sent")) {
        secondary.push(
            <BaseButton key="withdraw" variant="ghost" onClick={() => actions.setStatus(q, "sent")}>
                <Undo2 className="h-3.5 w-3.5" />
                {_t("quotations.actions.withdraw")}
            </BaseButton>
        );
    }

    const icon = (key: string, label: string, onClick: () => void, Icon: typeof Pencil, danger = false) => (
        <BaseButton
            key={key}
            variant="ghost"
            size={sheet ? "default" : "icon"}
            className={sheet ? "" : `h-8 w-8 ${danger ? "text-muted-foreground hover:text-destructive" : ""}`}
            aria-label={`${label}: ${number}`}
            onClick={onClick}
            data-testid={`q-${key}`}
        >
            <Icon className="h-4 w-4" />
            {sheet && label}
        </BaseButton>
    );

    const tools: React.ReactNode[] = [
        icon("pdf", _t("quotations.actions.pdf"), () => void actions.download(q), FileDown),
        icon("print", _t("quotations.actions.print"), () => void actions.print(q), Printer),
    ];
    if (editable) tools.push(icon("edit", _t("quotations.actions.edit"), () => onEdit(q), Pencil));
    if (deletable) tools.push(icon("delete", _t("quotations.actions.delete"), () => onDelete(q), Trash2, true));

    return (
        <div className={sheet ? "flex flex-col gap-3" : "flex flex-wrap items-center justify-end gap-1"}>
            {primary.length > 0 && <div className="flex flex-wrap items-center gap-2">{primary}</div>}
            <div className="flex flex-wrap items-center gap-1">
                {secondary}
                {tools}
            </div>
        </div>
    );
};

export default QuotationActions;
