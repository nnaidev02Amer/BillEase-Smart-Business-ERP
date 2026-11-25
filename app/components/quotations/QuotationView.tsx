"use client";

import { useLocale } from "next-intl";

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

import QuotationActions from "./QuotationActions";
import { ExpiryNote, QuotationStatusBadge } from "./QuotationStatusBadge";
import type { useQuotationActions } from "./useQuotationActions";

import { useTranslationContext } from "@/contexts/TranslationContext";
import { gstOfInvoice } from "@/lib/gst";
import { fetchCurrencyDetails } from "@/lib/helpers";
import { formatMoney, parseDate } from "@/lib/invoiceRecords";
import { displayStatus, numberOf, validUntilOf, type Quotation } from "@/lib/quotations";

type Props = {
    quotation: Quotation | null;
    invoiceNumber?: string;
    actions: ReturnType<typeof useQuotationActions>;
    onClose: () => void;
    onEdit: (q: Quotation) => void;
    onDelete: (q: Quotation) => void;
    onConvert: (q: Quotation) => void;
};

/**
 * Read-only detail of one quotation: who it is for, what is on it, the tax
 * breakdown, the activity so far, and whatever can be done next. Every figure
 * is from the stored document (GST is recomputed from the lines, as in reports).
 */
const QuotationView = ({ quotation: q, invoiceNumber, actions, onClose, onEdit, onDelete, onConvert }: Props) => {
    const { _t } = useTranslationContext();
    const locale = useLocale();

    const date = (value: unknown) => {
        const d = parseDate(value);
        return d ? d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" }) : "—";
    };

    return (
        <Sheet open={q !== null} onOpenChange={(o) => !o && onClose()}>
            <SheetContent side="right" className="w-full overflow-y-auto p-5 sm:max-w-xl sm:p-6" data-testid="quotation-view">
                {q && (() => {
                    const d = q.doc.details;
                    const money = (v: unknown) => formatMoney(Number(v) || 0, d.currency, locale);
                    const gst = d.gst?.enabled ? gstOfInvoice(q.doc, fetchCurrencyDetails(d.currency)?.decimals ?? 2) : null;
                    const status = displayStatus(q);

                    return (
                        <>
                            <SheetHeader className="text-start">
                                <SheetTitle className="flex flex-wrap items-center gap-2">
                                    {numberOf(q)}
                                    <QuotationStatusBadge status={status} />
                                </SheetTitle>
                                <SheetDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                    <span>{_t("quotations.view.validity", { date: date(validUntilOf(q)) })}</span>
                                    <ExpiryNote quotation={q} />
                                </SheetDescription>
                            </SheetHeader>

                            {invoiceNumber && (
                                <p className="mt-3 rounded-lg bg-success/10 px-3 py-2 text-sm text-success" data-testid="converted-note">
                                    {_t("quotations.converted", { number: invoiceNumber })}
                                </p>
                            )}

                            <div className="mt-4">
                                <QuotationActions
                                    variant="sheet"
                                    quotation={q}
                                    invoiceNumber={invoiceNumber}
                                    actions={actions}
                                    onEdit={onEdit}
                                    onDelete={onDelete}
                                    onConvert={onConvert}
                                />
                            </div>

                            <section className="mt-6 grid gap-4 text-sm sm:grid-cols-2">
                                <div>
                                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{_t("quotations.view.customer")}</h3>
                                    <p className="mt-1 font-medium">{q.doc.receiver.name}</p>
                                    <p className="text-muted-foreground">{q.doc.receiver.email}</p>
                                    {q.doc.receiver.gstin && (
                                        <p className="text-muted-foreground">
                                            {_t("quotations.view.gstin")}: <span className="tabular-nums">{q.doc.receiver.gstin}</span>
                                        </p>
                                    )}
                                </div>
                                <div>
                                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{_t("quotations.view.business")}</h3>
                                    <p className="mt-1 font-medium">{q.doc.sender.name}</p>
                                    {q.doc.sender.gstin && (
                                        <p className="text-muted-foreground">
                                            {_t("quotations.view.gstin")}: <span className="tabular-nums">{q.doc.sender.gstin}</span>
                                        </p>
                                    )}
                                </div>
                            </section>

                            <section className="mt-6">
                                <h3 className="mb-2 text-sm font-semibold">{_t("quotations.view.items")}</h3>
                                <div className="overflow-x-auto rounded-lg border">
                                    <table className="w-full min-w-[26rem] text-sm" data-testid="quotation-items">
                                        <thead className="bg-muted/50 text-xs text-muted-foreground">
                                            <tr>
                                                <th className="px-3 py-2 text-start font-medium">{_t("quotations.view.item")}</th>
                                                <th className="px-3 py-2 text-end font-medium">{_t("quotations.view.qty")}</th>
                                                <th className="px-3 py-2 text-end font-medium">{_t("quotations.view.rate")}</th>
                                                {gst && <th className="px-3 py-2 text-end font-medium">{_t("quotations.view.tax")}</th>}
                                                <th className="px-3 py-2 text-end font-medium">{_t("quotations.view.amount")}</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {d.items.map((item, i) => (
                                                <tr key={i} className="border-t">
                                                    <td className="px-3 py-2">
                                                        <span className="font-medium">{item.name}</span>
                                                        {item.hsn && <span className="ms-2 text-xs text-muted-foreground">HSN {item.hsn}</span>}
                                                    </td>
                                                    <td className="px-3 py-2 text-end tabular-nums">
                                                        {item.quantity}
                                                        {item.unit ? ` ${item.unit}` : ""}
                                                    </td>
                                                    <td className="px-3 py-2 text-end tabular-nums">{money(item.unitPrice)}</td>
                                                    {gst && <td className="px-3 py-2 text-end tabular-nums">{item.gstRate ?? 0}%</td>}
                                                    <td className="px-3 py-2 text-end tabular-nums">{money(item.total)}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>

                                <dl className="ms-auto mt-3 w-full max-w-xs space-y-1 text-sm" data-testid="quotation-totals">
                                    <div className="flex justify-between"><dt className="text-muted-foreground">{_t("quotations.view.subtotal")}</dt><dd className="tabular-nums">{money(d.subTotal)}</dd></div>
                                    {(gst ? gst.discountAmount : 0) > 0 && (
                                        <div className="flex justify-between"><dt className="text-muted-foreground">{_t("quotations.view.discount")}</dt><dd className="tabular-nums">− {money(gst!.discountAmount)}</dd></div>
                                    )}
                                    {!gst && d.discountDetails?.amount ? (
                                        <div className="flex justify-between"><dt className="text-muted-foreground">{_t("quotations.view.discount")}</dt><dd className="tabular-nums">{d.discountDetails.amountType === "percentage" ? `${d.discountDetails.amount}%` : `− ${money(d.discountDetails.amount)}`}</dd></div>
                                    ) : null}
                                    {gst && (
                                        <>
                                            <div className="flex justify-between"><dt className="text-muted-foreground">{_t("quotations.view.taxable")}</dt><dd className="tabular-nums">{money(gst.taxableValue)}</dd></div>
                                            {gst.supply === "intra" ? (
                                                <>
                                                    <div className="flex justify-between"><dt className="text-muted-foreground">{_t("gst.cgst")}</dt><dd className="tabular-nums" data-testid="view-cgst">{money(gst.cgst)}</dd></div>
                                                    <div className="flex justify-between"><dt className="text-muted-foreground">{_t("gst.sgst")}</dt><dd className="tabular-nums" data-testid="view-sgst">{money(gst.sgst)}</dd></div>
                                                </>
                                            ) : (
                                                <div className="flex justify-between"><dt className="text-muted-foreground">{_t("gst.igst")}</dt><dd className="tabular-nums" data-testid="view-igst">{money(gst.igst)}</dd></div>
                                            )}
                                        </>
                                    )}
                                    {!gst && d.taxDetails?.amount ? (
                                        <div className="flex justify-between"><dt className="text-muted-foreground">{_t("form.steps.summary.tax")}</dt><dd className="tabular-nums">{d.taxDetails.amountType === "percentage" ? `${d.taxDetails.amount}%` : money(d.taxDetails.amount)}</dd></div>
                                    ) : null}
                                    {d.shippingDetails?.cost ? (
                                        <div className="flex justify-between"><dt className="text-muted-foreground">{_t("quotations.view.shipping")}</dt><dd className="tabular-nums">{d.shippingDetails.costType === "percentage" ? `${d.shippingDetails.cost}%` : money(d.shippingDetails.cost)}</dd></div>
                                    ) : null}
                                    <div className="flex justify-between border-t pt-2 text-base font-semibold"><dt>{_t("quotations.view.total")}</dt><dd className="tabular-nums" data-testid="view-total">{money(d.totalAmount)}</dd></div>
                                </dl>
                            </section>

                            {(d.additionalNotes || d.terms || d.paymentTerms) && (
                                <section className="mt-6 space-y-3 text-sm">
                                    {d.paymentTerms && (
                                        <div><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{_t("quotations.view.paymentTerms")}</h3><p className="mt-1 whitespace-pre-line">{d.paymentTerms}</p></div>
                                    )}
                                    {d.additionalNotes && (
                                        <div><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{_t("quotations.view.notes")}</h3><p className="mt-1 whitespace-pre-line">{d.additionalNotes}</p></div>
                                    )}
                                    {d.terms && (
                                        <div><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{_t("quotations.view.terms")}</h3><p className="mt-1 whitespace-pre-line">{d.terms}</p></div>
                                    )}
                                </section>
                            )}

                            <section className="mt-6">
                                <h3 className="mb-2 text-sm font-semibold">{_t("quotations.view.timeline")}</h3>
                                <ol className="space-y-1.5 border-s ps-4 text-sm" data-testid="quotation-timeline">
                                    {[...q.events].reverse().map((e, i) => (
                                        <li key={i} className="relative">
                                            <span aria-hidden className="absolute -start-[1.3rem] top-1.5 h-2 w-2 rounded-full bg-border" />
                                            {_t(`quotations.view.events.${e.kind}`)}
                                            <span className="ms-2 text-xs text-muted-foreground">{date(e.at)}</span>
                                        </li>
                                    ))}
                                </ol>
                            </section>
                        </>
                    );
                })()}
            </SheetContent>
        </Sheet>
    );
};

export default QuotationView;
