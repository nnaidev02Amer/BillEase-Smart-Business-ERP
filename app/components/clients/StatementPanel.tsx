"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale } from "next-intl";

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/use-toast";
import BaseButton from "@/app/components/reusables/BaseButton";

import { useTranslationContext } from "@/contexts/TranslationContext";
import { type CustomerRecord } from "@/lib/crm";
import { formatMoney, isoDay } from "@/lib/invoiceRecords";
import { buildStatement, ledgerCurrencies, pickBusiness, rangeFor, statementToCsv, type RangePreset } from "@/lib/statement";
import { downloadBlob, fetchStatementPdf, openBlobInTab, statementFilename, statementPayload } from "@/lib/statementPdf";
import type { SavedParty } from "@/lib/partyStore";
import type { Quotation } from "@/lib/quotations";
import type { InvoiceType } from "@/types";

import { Download, FileSpreadsheet, Printer } from "lucide-react";

import { StatCard } from "./CrmWidgets";

const PRESETS: RangePreset[] = ["all", "thisMonth", "last3", "thisFy", "thisYear"];

const parseDay = (v: string): Date | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    const [y, m, d] = v.split("-").map(Number);
    return new Date(y, m - 1, d);
};

type Props = {
    record: CustomerRecord;
    invoices: InvoiceType[];
    quotations: Quotation[];
    senders: SavedParty[];
};

/**
 * A customer's account statement: pick a period, see exactly what was invoiced
 * and paid, what is still owed and how overdue it is, and export it. The table,
 * the CSV and the PDF all come from one `buildStatement`, so they cannot differ.
 */
const StatementPanel = ({ record, invoices, quotations, senders }: Props) => {
    const { _t } = useTranslationContext();
    const locale = useLocale();

    const currencies = useMemo(() => ledgerCurrencies(invoices, record.key), [invoices, record.key]);
    const [currency, setCurrency] = useState(currencies.includes(record.primaryCurrency) ? record.primaryCurrency : currencies[0] ?? record.primaryCurrency);
    const [preset, setPreset] = useState<RangePreset | "custom">("all");
    const [from, setFrom] = useState("");
    const [to, setTo] = useState(isoDay(new Date()));
    const [busy, setBusy] = useState<null | "pdf" | "print">(null);

    // If the customer's currencies change (a restore, a new invoice), stay on a valid one.
    useEffect(() => {
        if (currencies.length && !currencies.includes(currency)) setCurrency(currencies[0]);
    }, [currencies, currency]);

    const range = useMemo(() => {
        if (preset === "custom") return { from: parseDay(from), to: parseDay(to) ?? new Date() };
        return rangeFor(preset);
    }, [preset, from, to]);

    const statement = useMemo(
        () => buildStatement(invoices, record.key, { currency, from: range.from, to: range.to }),
        [invoices, record.key, currency, range]
    );

    const money = (v: number) => formatMoney(v, currency, locale);
    const day = (ymd: string) => {
        const d = parseDay(ymd);
        return d ? d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" }) : "";
    };

    const invalidRange = preset === "custom" && range.from && range.to && range.from > range.to;

    // Who the statement is from: your latest invoice to this customer, else any of your
    // documents, else a saved sender. Without any of these there is nobody to issue it.
    const business = useMemo(() => {
        const fromInvoices = pickBusiness(invoices, record.key, senders);
        if (fromInvoices) return fromInvoices;
        const q = [...quotations].reverse().find((x) => x.doc.sender?.name);
        return q ? { business: q.doc.sender, logo: q.doc.details.invoiceLogo ?? "" } : null;
    }, [invoices, quotations, record.key, senders]);

    const customerParty = useMemo(() => {
        const p = record.profile;
        return {
            name: record.name,
            address: p?.address ?? "",
            zipCode: p?.zipCode ?? "",
            city: p?.city ?? record.city,
            country: p?.country ?? "",
            email: record.email,
            phone: record.phone,
            ...(record.gstin ? { gstin: record.gstin } : {}),
        };
    }, [record]);

    const csv = () => {
        const { filename, csv: text } = statementToCsv(statement, record.name);
        downloadBlob(new Blob([text], { type: "text/csv;charset=utf-8" }), filename);
        toast({ title: _t("crm.statement.csvReady"), description: filename });
    };

    const pdf = async (mode: "pdf" | "print") => {
        if (!business) return;
        setBusy(mode);
        try {
            const payload = statementPayload({ statement, business: business.business, logo: business.logo, customer: customerParty });
            const blob = await fetchStatementPdf(payload, locale);
            if (mode === "pdf") {
                downloadBlob(blob, statementFilename(record.name, statement));
                toast({ title: _t("crm.statement.pdfReady") });
            } else openBlobInTab(blob);
        } catch (e) {
            console.error(e);
            toast({ variant: "destructive", title: _t("crm.statement.pdfFailed"), description: _t("crm.statement.pdfFailedBody") });
        } finally {
            setBusy(null);
        }
    };

    if (currencies.length === 0) {
        return (
            <p className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground" data-testid="statement-empty">
                {_t("crm.statement.none")}
            </p>
        );
    }

    const agingRows: [string, number][] = [
        [_t("crm.statement.aging.current"), statement.aging.current],
        [_t("crm.statement.aging.d1_30"), statement.aging.d1_30],
        [_t("crm.statement.aging.d31_60"), statement.aging.d31_60],
        [_t("crm.statement.aging.d61_90"), statement.aging.d61_90],
        [_t("crm.statement.aging.d90plus"), statement.aging.d90plus],
    ];

    return (
        <div className="space-y-5" data-testid="statement-panel">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div className="flex flex-wrap items-end gap-2">
                    <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">{_t("crm.statement.period")}</p>
                        <Select value={preset} onValueChange={(v) => setPreset(v as RangePreset | "custom")}>
                            <SelectTrigger className="w-52" aria-label={_t("crm.statement.period")}><SelectValue /></SelectTrigger>
                            <SelectContent>
                                {PRESETS.map((p) => (
                                    <SelectItem key={p} value={p}>{_t(`crm.statement.presets.${p}`)}</SelectItem>
                                ))}
                                <SelectItem value="custom">{_t("crm.statement.presets.custom")}</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    {preset === "custom" && (
                        <>
                            <label className="space-y-1 text-xs text-muted-foreground">
                                {_t("crm.statement.from")}
                                <Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="h-10 w-40 text-foreground" />
                            </label>
                            <label className="space-y-1 text-xs text-muted-foreground">
                                {_t("crm.statement.to")}
                                <Input type="date" value={to} min={from || undefined} max={isoDay(new Date())} onChange={(e) => setTo(e.target.value)} className="h-10 w-40 text-foreground" />
                            </label>
                        </>
                    )}
                    {currencies.length > 1 && (
                        <div className="space-y-1">
                            <p className="text-xs text-muted-foreground">{_t("crm.statement.currency")}</p>
                            <Select value={currency} onValueChange={setCurrency}>
                                <SelectTrigger className="w-28" aria-label={_t("crm.statement.currency")}><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {currencies.map((c) => (
                                        <SelectItem key={c} value={c}>{c}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    )}
                </div>
                <div className="flex flex-wrap gap-2">
                    <BaseButton variant="outline" onClick={() => pdf("print")} loading={busy === "print"} disabled={!business || busy !== null || !!invalidRange} data-testid="statement-print">
                        <Printer className="h-4 w-4" />
                        {_t("crm.statement.print")}
                    </BaseButton>
                    <BaseButton variant="outline" onClick={csv} disabled={!!invalidRange} data-testid="statement-csv">
                        <FileSpreadsheet className="h-4 w-4" />
                        CSV
                    </BaseButton>
                    <BaseButton onClick={() => pdf("pdf")} loading={busy === "pdf"} disabled={!business || busy !== null || !!invalidRange} data-testid="statement-pdf">
                        <Download className="h-4 w-4" />
                        PDF
                    </BaseButton>
                </div>
            </div>

            {invalidRange && <p role="alert" className="text-sm text-destructive">{_t("crm.statement.badRange")}</p>}

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="statement-summary">
                <StatCard testId="st-opening" label={_t("crm.statement.opening")} value={money(statement.opening)} />
                <StatCard testId="st-invoiced" label={_t("crm.statement.invoiced")} value={money(statement.totals.invoiced)} />
                <StatCard testId="st-paid" label={_t("crm.statement.paid")} value={money(statement.totals.paid)} />
                <StatCard testId="st-closing" label={_t("crm.statement.closing")} value={money(statement.closing)} tone={statement.closing > 0 ? "" : "text-success"} />
            </div>

            <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
                <table className="w-full min-w-[34rem] text-sm" data-testid="statement-table">
                    <caption className="sr-only">{_t("crm.statement.transactions")}</caption>
                    <thead className="bg-muted/50 text-xs text-muted-foreground">
                        <tr>
                            <th className="px-4 py-3 text-start font-medium">{_t("crm.statement.cols.date")}</th>
                            <th className="px-4 py-3 text-start font-medium">{_t("crm.statement.cols.type")}</th>
                            <th className="px-4 py-3 text-start font-medium">{_t("crm.statement.cols.reference")}</th>
                            <th className="px-4 py-3 text-end font-medium">{_t("crm.statement.cols.debit")}</th>
                            <th className="px-4 py-3 text-end font-medium">{_t("crm.statement.cols.credit")}</th>
                            <th className="px-4 py-3 text-end font-medium">{_t("crm.statement.cols.balance")}</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr className="border-t bg-muted/20" data-testid="statement-opening-row">
                            <td className="px-4 py-2 text-muted-foreground" colSpan={5}>{_t("crm.statement.opening")}</td>
                            <td className="px-4 py-2 text-end font-medium tabular-nums">{money(statement.opening)}</td>
                        </tr>
                        {statement.rows.length === 0 && (
                            <tr>
                                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground" data-testid="statement-no-rows">{_t("crm.statement.noRows")}</td>
                            </tr>
                        )}
                        {statement.rows.map((r, i) => (
                            <tr key={i} className="border-t" data-testid="statement-row" data-kind={r.kind}>
                                <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">{day(r.date)}</td>
                                <td className="px-4 py-2">{_t(r.kind === "invoice" ? "crm.statement.typeInvoice" : "crm.statement.typePayment")}</td>
                                <td className="px-4 py-2">
                                    <span className="font-medium">{r.ref}</span>
                                    {r.description && <span className="ms-2 text-xs text-muted-foreground">{r.description}</span>}
                                </td>
                                <td className="px-4 py-2 text-end tabular-nums">{r.debit ? money(r.debit) : ""}</td>
                                <td className="px-4 py-2 text-end tabular-nums text-success">{r.credit ? money(r.credit) : ""}</td>
                                <td className="px-4 py-2 text-end font-medium tabular-nums">{money(r.balance)}</td>
                            </tr>
                        ))}
                        <tr className="border-t-2">
                            <td className="px-4 py-3 font-semibold" colSpan={5}>{_t("crm.statement.closing")}</td>
                            <td className="px-4 py-3 text-end font-semibold tabular-nums" data-testid="statement-closing-row">{money(statement.closing)}</td>
                        </tr>
                    </tbody>
                </table>
            </div>

            {statement.openItems.length > 0 && (
                <div className="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
                    <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
                        <table className="w-full min-w-[28rem] text-sm" data-testid="statement-open-items">
                            <caption className="px-4 pt-3 text-start text-sm font-semibold">{_t("crm.statement.openItems")}</caption>
                            <thead className="text-xs text-muted-foreground">
                                <tr>
                                    <th className="px-4 py-2 text-start font-medium">{_t("crm.statement.cols.invoice")}</th>
                                    <th className="px-4 py-2 text-start font-medium">{_t("crm.statement.cols.due")}</th>
                                    <th className="px-4 py-2 text-end font-medium">{_t("crm.statement.cols.balance")}</th>
                                    <th className="px-4 py-2 text-end font-medium">{_t("crm.statement.cols.overdue")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {statement.openItems.map((o) => (
                                    <tr key={o.number} className="border-t" data-testid="open-item">
                                        <td className="px-4 py-2 font-medium">{o.number}</td>
                                        <td className="px-4 py-2 text-muted-foreground">{day(o.due)}</td>
                                        <td className="px-4 py-2 text-end tabular-nums">{money(o.balance)}</td>
                                        <td className={`px-4 py-2 text-end tabular-nums ${o.daysOverdue ? "text-destructive" : "text-muted-foreground"}`}>{o.daysOverdue || "–"}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="rounded-xl border bg-card p-4 shadow-sm" data-testid="statement-aging">
                        <h3 className="mb-3 text-sm font-semibold">{_t("crm.statement.agingTitle")}</h3>
                        <dl className="space-y-2 text-sm">
                            {agingRows.map(([label, v]) => (
                                <div key={label} className="flex justify-between gap-3">
                                    <dt className="text-muted-foreground">{label}</dt>
                                    <dd className="tabular-nums">{money(v)}</dd>
                                </div>
                            ))}
                        </dl>
                    </div>
                </div>
            )}

            {!business && <p className="text-xs text-muted-foreground">{_t("crm.statement.noBusiness")}</p>}
            <p className="text-xs text-muted-foreground">{_t("crm.statement.definitions")}</p>
        </div>
    );
};

export default StatementPanel;
