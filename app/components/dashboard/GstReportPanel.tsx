"use client";

import { useMemo, useState } from "react";
import { useLocale } from "next-intl";

import { toast } from "@/components/ui/use-toast";
import BaseButton from "@/app/components/reusables/BaseButton";

import { useTranslationContext } from "@/contexts/TranslationContext";
import { buildGstReport, gstReportCsv } from "@/lib/gstReport";
import { formatMoney } from "@/lib/invoiceRecords";
import type { InvoiceType } from "@/types";

import { Download } from "lucide-react";

const toDate = (value: string): Date | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [y, m, d] = value.split("-").map(Number);
    return new Date(y, m - 1, d);
};

/**
 * GST sales summary for the chosen currency and date range. Every number comes
 * from buildGstReport over the saved invoices; nothing here is typed in.
 */
const GstReportPanel = ({ invoices, currency }: { invoices: InvoiceType[]; currency: string }) => {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const [from, setFrom] = useState("");
    const [to, setTo] = useState("");

    const money = (v: number) => formatMoney(v, currency, locale);
    const report = useMemo(
        () => buildGstReport(invoices, { currency, from: toDate(from), to: toDate(to) }),
        [invoices, currency, from, to]
    );

    const hasGstInvoices = invoices.some((i) => i.details.gst?.enabled);
    const t = report.totals;

    const download = () => {
        const { filename, csv } = gstReportCsv(report);
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast({ title: _t("analytics.exported"), description: filename });
    };

    const th = "px-3 py-2 text-end font-medium";
    const td = "px-3 py-2 text-end tabular-nums";

    return (
        <section className="rounded-xl border bg-card p-4 shadow-sm sm:p-6" data-testid="gst-report">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                    <h2 className="text-base font-semibold">{_t("gstReport.title")}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{_t("gstReport.hint", { currency })}</p>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        {_t("gstReport.from")}
                        <input
                            type="date"
                            value={from}
                            max={to || undefined}
                            onChange={(e) => setFrom(e.target.value)}
                            className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        {_t("gstReport.to")}
                        <input
                            type="date"
                            value={to}
                            min={from || undefined}
                            onChange={(e) => setTo(e.target.value)}
                            className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
                        />
                    </label>
                    <BaseButton variant="outline" size="sm" onClick={download} disabled={report.rows.length === 0}>
                        <Download className="h-4 w-4" />
                        CSV
                    </BaseButton>
                </div>
            </div>

            {!hasGstInvoices ? (
                <p className="mt-4 text-sm text-muted-foreground">{_t("gstReport.noGstInvoices")}</p>
            ) : report.rows.length === 0 ? (
                <p className="mt-4 text-sm text-muted-foreground">{_t("gstReport.empty")}</p>
            ) : (
                <>
                    <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
                        {[
                            [_t("gst.taxableValue"), t.taxable],
                            [_t("gst.cgst"), t.cgst],
                            [_t("gst.sgst"), t.sgst],
                            [_t("gst.igst"), t.igst],
                            [_t("gst.totalTax"), t.totalTax],
                        ].map(([label, value]) => (
                            <div key={label as string} className="rounded-lg bg-muted/40 p-3">
                                <dt className="text-xs text-muted-foreground">{label}</dt>
                                <dd className="mt-1 truncate text-lg font-semibold tabular-nums" data-testid="gst-total">
                                    {money(value as number)}
                                </dd>
                            </div>
                        ))}
                    </dl>

                    <p className="mt-3 text-xs text-muted-foreground">
                        {_t("gstReport.split", {
                            b2b: report.b2b.count,
                            b2c: report.b2c.count,
                        })}
                    </p>

                    <div className="mt-4 overflow-x-auto rounded-lg border">
                        <table className="w-full min-w-[32rem] text-sm">
                            <caption className="sr-only">{_t("gstReport.bySlab")}</caption>
                            <thead className="bg-muted/50 text-xs text-muted-foreground">
                                <tr>
                                    <th className="px-3 py-2 text-start font-medium">{_t("gstReport.bySlab")}</th>
                                    <th className={th}>{_t("gst.taxableValue")}</th>
                                    <th className={th}>{_t("gst.cgst")}</th>
                                    <th className={th}>{_t("gst.sgst")}</th>
                                    <th className={th}>{_t("gst.igst")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {report.bySlab.map((s) => (
                                    <tr key={s.rate} className="border-t">
                                        <td className="px-3 py-2">{s.rate}%</td>
                                        <td className={td}>{money(s.taxable)}</td>
                                        <td className={td}>{money(s.cgst)}</td>
                                        <td className={td}>{money(s.sgst)}</td>
                                        <td className={td}>{money(s.igst)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <div className="mt-4 overflow-x-auto rounded-lg border">
                        <table className="w-full min-w-[40rem] text-sm">
                            <caption className="sr-only">{_t("gstReport.invoices")}</caption>
                            <thead className="bg-muted/50 text-xs text-muted-foreground">
                                <tr>
                                    <th className="px-3 py-2 text-start font-medium">{_t("gstReport.invoice")}</th>
                                    <th className="px-3 py-2 text-start font-medium">{_t("gstReport.customer")}</th>
                                    <th className={th}>{_t("gst.taxableValue")}</th>
                                    <th className={th}>{_t("gst.totalTax")}</th>
                                    <th className={th}>{_t("gstReport.total")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {report.rows.map((x) => (
                                    <tr key={x.invoiceNumber + x.date} className="border-t">
                                        <td className="px-3 py-2">
                                            <span className="font-medium">{x.invoiceNumber}</span>
                                            <span className="ms-2 text-xs text-muted-foreground">
                                                {x.supply === "intra" ? "CGST+SGST" : "IGST"}
                                            </span>
                                        </td>
                                        <td className="px-3 py-2">
                                            {x.customer}
                                            {x.customerGstin && (
                                                <span className="ms-2 text-xs text-muted-foreground">{x.customerGstin}</span>
                                            )}
                                        </td>
                                        <td className={td}>{money(x.taxable)}</td>
                                        <td className={td}>{money(x.totalTax)}</td>
                                        <td className={td}>{money(x.total)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}

            {report.skipped.length > 0 && (
                <p className="mt-3 text-xs text-destructive" role="status">
                    {_t("gstReport.skipped", { numbers: report.skipped.join(", ") })}
                </p>
            )}
            <p className="mt-3 text-xs text-muted-foreground">{_t("gstReport.disclaimer")}</p>
        </section>
    );
};

export default GstReportPanel;
