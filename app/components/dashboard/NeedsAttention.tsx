"use client";

import { useMemo } from "react";
import { useLocale } from "next-intl";

import { toast } from "@/components/ui/use-toast";
import BaseButton from "@/app/components/reusables/BaseButton";
import { useInvoiceContext } from "@/contexts/InvoiceContext";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { formatMoney, reminderCandidates, reminderMailto } from "@/lib/invoiceRecords";

import { BellRing, CheckCircle2, Mail } from "lucide-react";

/**
 * Due-date reminders. With no server there is nothing to send e-mail in the
 * background, so reminders are surfaced here whenever the app is open, and
 * "Remind" opens a ready-written message in the user's own mail client.
 */
const NeedsAttention = () => {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const { savedInvoices, settings, markPaid } = useInvoiceContext();

    const reminders = useMemo(
        () => reminderCandidates(savedInvoices, new Date(), settings.reminderLeadDays),
        [savedInvoices, settings.reminderLeadDays]
    );

    const templates = {
        subject: _t("reminders.mailSubject"),
        body: _t("reminders.mailBody"),
    };

    return (
        <section aria-labelledby="attention-heading" className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
            <div className="flex items-center gap-2">
                <BellRing className="h-4 w-4 text-warning" aria-hidden />
                <h2 id="attention-heading" className="text-base font-semibold">
                    {_t("reminders.title")}
                </h2>
                {reminders.length > 0 && (
                    <span className="rounded-full bg-warning/20 px-2 py-0.5 text-xs font-medium">{reminders.length}</span>
                )}
            </div>

            {reminders.length === 0 ? (
                <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
                    {_t("reminders.none", { days: settings.reminderLeadDays })}
                </p>
            ) : (
                <ul className="mt-3 divide-y">
                    {reminders.slice(0, 8).map(({ invoice, kind, days, balance }) => (
                        <li
                            key={invoice.details.invoiceNumber}
                            className="flex flex-wrap items-center justify-between gap-3 py-3"
                        >
                            <div className="min-w-0">
                                <p className="truncate text-sm font-medium">
                                    {invoice.details.invoiceNumber} · {invoice.receiver.name}
                                </p>
                                <p className={`text-xs ${kind === "overdue" ? "text-destructive" : "text-muted-foreground"}`}>
                                    {kind === "overdue"
                                        ? _t("reminders.overdueBy", { days })
                                        : days === 0
                                          ? _t("reminders.dueToday")
                                          : _t("reminders.dueIn", { days })}{" "}
                                    · {formatMoney(balance, invoice.details.currency, locale)}
                                </p>
                            </div>
                            <div className="flex gap-2">
                                {invoice.receiver.email && (
                                    <a
                                        href={reminderMailto(invoice, templates, locale)}
                                        className="inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    >
                                        <Mail className="h-3.5 w-3.5" aria-hidden />
                                        {_t("reminders.remind")}
                                    </a>
                                )}
                                <BaseButton
                                    size="sm"
                                    variant="outline"
                                    className="h-8 text-xs"
                                    onClick={() => {
                                        const r = markPaid(invoice.details.invoiceNumber);
                                        toast(
                                            r.ok
                                                ? { title: _t("invoices.toast.paid"), description: invoice.details.invoiceNumber }
                                                : { variant: "destructive", title: _t(`invoices.errors.${r.reason}`), description: r.detail }
                                        );
                                    }}
                                >
                                    {_t("invoices.markPaid")}
                                </BaseButton>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
};

export default NeedsAttention;
