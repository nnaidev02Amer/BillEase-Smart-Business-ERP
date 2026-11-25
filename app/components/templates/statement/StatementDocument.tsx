import React from "react";

import type { StatementPayload } from "@/lib/statement";

import type { StatementLabels } from "./statementLabels";

/**
 * A customer's account statement, laid out for A4.
 *
 * A plain function of its props: no hooks and no context, because it is
 * rendered through renderToStaticMarkup in the PDF route. It deliberately
 * shares the look of the invoice templates (same embedded typeface, accent
 * colour, hairline rules) so a statement and the invoices it lists read as one
 * set of documents.
 */
type Props = { payload: StatementPayload; labels: StatementLabels; locale: string };

const ACCENT = "#4F46E5";

const money = (value: number, currency: string, locale: string) => {
    try {
        // ISO code rather than a symbol: the PDF embeds a fixed set of fonts, and
        // "USD" is unambiguous where "$" is not (see the invoice templates).
        return new Intl.NumberFormat(locale, { style: "currency", currency, currencyDisplay: "code" }).format(value);
    } catch {
        return `${value.toFixed(2)} ${currency}`;
    }
};

const day = (ymd: string, locale: string) => {
    if (!ymd) return "";
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
};

const PartyLines = ({ party, labels }: { party: StatementPayload["customer"]; labels: StatementLabels }) => (
    <address className="mt-1 text-xs not-italic leading-relaxed text-gray-600">
        {party.address && (
            <>
                {party.address}
                <br />
            </>
        )}
        {[party.zipCode, party.city].filter(Boolean).join(", ")}
        {(party.zipCode || party.city) && <br />}
        {party.country}
        {party.country && <br />}
        {party.email && (
            <>
                {party.email}
                <br />
            </>
        )}
        {party.phone && (
            <>
                {party.phone}
                <br />
            </>
        )}
        {party.gstin && (
            <span>
                {labels.gstin}: <span className="tabular-nums">{party.gstin}</span>
            </span>
        )}
    </address>
);

const StatementDocument = ({ payload, labels, locale }: Props) => {
    const { business, customer, statement: s } = payload;
    const m = (v: number) => money(v, s.currency, locale);
    const period = s.from
        ? labels.periodRange.replace("{from}", day(s.from, locale)).replace("{to}", day(s.to, locale))
        : labels.periodAll.replace("{to}", day(s.to, locale));

    const aging: [string, number][] = [
        [labels.current, s.aging.current],
        [labels.days1to30, s.aging.d1_30],
        [labels.days31to60, s.aging.d31_60],
        [labels.days61to90, s.aging.d61_90],
        [labels.days90plus, s.aging.d90plus],
    ];

    const th = "border-b-2 border-gray-300 pb-2 text-xs font-semibold uppercase tracking-wider";

    return (
        <div className="w-full bg-white p-12 text-gray-800" style={{ fontFamily: "Outfit, sans-serif" }} data-testid="statement-document">
            {/* Header */}
            <div className="flex items-start justify-between gap-6">
                <div>
                    {payload.logo && (
                        <img src={payload.logo} alt="" width={140} height={100} style={{ maxHeight: 56, width: "auto", objectFit: "contain" }} />
                    )}
                    <p className="mt-2 text-base font-semibold text-gray-900">{business.name}</p>
                    <PartyLines party={business} labels={labels} />
                </div>
                <div className="text-end">
                    <p className="text-2xl font-bold uppercase tracking-wide" style={{ color: ACCENT }}>
                        {labels.title}
                    </p>
                    <p className="mt-1 text-xs text-gray-500">{period}</p>
                    <p className="text-xs text-gray-500">{labels.generated.replace("{date}", day(payload.generatedAt, locale))}</p>
                    <p className="mt-1 text-xs text-gray-500">
                        {labels.currency}: {s.currency}
                    </p>
                </div>
            </div>

            <div className="mt-8">
                <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">{labels.statementFor}</p>
                <p className="mt-1 text-sm font-semibold text-gray-900">{customer.name}</p>
                <PartyLines party={customer} labels={labels} />
            </div>

            {/* Summary */}
            <div className="mt-8 grid grid-cols-4 gap-3" data-testid="statement-summary">
                {[
                    [labels.openingBalance, s.opening, false],
                    [labels.invoiced, s.totals.invoiced, false],
                    [labels.paymentsReceived, s.totals.paid, false],
                    [labels.closingBalance, s.closing, true],
                ].map(([label, value, strong]) => (
                    <div key={label as string} className="rounded border border-gray-200 p-3" style={strong ? { backgroundColor: ACCENT, borderColor: ACCENT, color: "#ffffff" } : undefined}>
                        <p className={`text-xs ${strong ? "" : "text-gray-500"}`} style={strong ? { opacity: 0.85 } : undefined}>
                            {label as string}
                        </p>
                        <p className="mt-1 text-sm font-bold tabular-nums">{m(value as number)}</p>
                    </div>
                ))}
            </div>

            {/* Transactions */}
            <p className="mt-8 text-xs font-semibold uppercase tracking-wider" style={{ color: ACCENT }}>
                {labels.transactions}
            </p>
            <table className="mt-2 w-full border-collapse text-xs">
                <thead>
                    <tr>
                        <th className={`${th} text-start`}>{labels.date}</th>
                        <th className={`${th} text-start`}>{labels.type}</th>
                        <th className={`${th} text-start`}>{labels.reference}</th>
                        <th className={`${th} text-end`}>{labels.debit}</th>
                        <th className={`${th} text-end`}>{labels.credit}</th>
                        <th className={`${th} text-end`}>{labels.balance}</th>
                    </tr>
                </thead>
                <tbody>
                    <tr className="border-b border-gray-200 bg-gray-50">
                        <td className="py-1.5 pe-2 text-gray-500" colSpan={5}>
                            {labels.openingBalance}
                        </td>
                        <td className="py-1.5 text-end font-medium tabular-nums">{m(s.opening)}</td>
                    </tr>
                    {s.rows.length === 0 && (
                        <tr>
                            <td colSpan={6} className="py-4 text-center text-gray-500">
                                {labels.noTransactions}
                            </td>
                        </tr>
                    )}
                    {s.rows.map((r, i) => (
                        <tr key={i} className="break-inside-avoid border-b border-gray-200">
                            <td className="whitespace-nowrap py-1.5 pe-2 tabular-nums text-gray-600">{day(r.date, locale)}</td>
                            <td className="py-1.5 pe-2 text-gray-600">{r.kind === "invoice" ? labels.typeInvoice : labels.typePayment}</td>
                            <td className="py-1.5 pe-2 font-medium text-gray-900">
                                {r.ref}
                                {r.description && <span className="ms-2 font-normal text-gray-500">{r.description}</span>}
                            </td>
                            <td className="py-1.5 text-end tabular-nums">{r.debit ? m(r.debit) : ""}</td>
                            <td className="py-1.5 text-end tabular-nums">{r.credit ? m(r.credit) : ""}</td>
                            <td className="py-1.5 text-end font-medium tabular-nums">{m(r.balance)}</td>
                        </tr>
                    ))}
                    <tr className="border-t-2" style={{ borderColor: ACCENT }}>
                        <td className="pt-2 text-sm font-semibold" colSpan={5}>
                            {labels.closingBalance}
                        </td>
                        <td className="pt-2 text-end text-sm font-bold tabular-nums">{m(s.closing)}</td>
                    </tr>
                </tbody>
            </table>
            {s.closing < 0 && <p className="mt-1 text-xs italic text-gray-500">{labels.creditNote}</p>}

            {/* Open invoices and ageing */}
            {s.openItems.length > 0 && (
                <div className="mt-8 break-inside-avoid" data-testid="statement-open-items">
                    <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: ACCENT }}>
                        {labels.openItems}
                    </p>
                    <table className="mt-2 w-full border-collapse text-xs">
                        <thead>
                            <tr>
                                <th className={`${th} text-start`}>{labels.invoice}</th>
                                <th className={`${th} text-start`}>{labels.invoiceDate}</th>
                                <th className={`${th} text-start`}>{labels.dueDate}</th>
                                <th className={`${th} text-end`}>{labels.total}</th>
                                <th className={`${th} text-end`}>{labels.paid}</th>
                                <th className={`${th} text-end`}>{labels.balance}</th>
                                <th className={`${th} text-end`}>{labels.daysOverdue}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {s.openItems.map((o) => (
                                <tr key={o.number} className="border-b border-gray-200">
                                    <td className="py-1.5 pe-2 font-medium text-gray-900">{o.number}</td>
                                    <td className="py-1.5 pe-2 tabular-nums text-gray-600">{day(o.date, locale)}</td>
                                    <td className="py-1.5 pe-2 tabular-nums text-gray-600">{day(o.due, locale)}</td>
                                    <td className="py-1.5 text-end tabular-nums">{m(o.total)}</td>
                                    <td className="py-1.5 text-end tabular-nums">{m(o.paid)}</td>
                                    <td className="py-1.5 text-end font-medium tabular-nums">{m(o.balance)}</td>
                                    <td className="py-1.5 text-end tabular-nums">{o.daysOverdue || "–"}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>

                    <p className="mt-6 text-xs font-semibold uppercase tracking-wider" style={{ color: ACCENT }}>
                        {labels.aging}
                    </p>
                    <div className="mt-2 grid grid-cols-5 gap-2">
                        {aging.map(([label, value]) => (
                            <div key={label} className="rounded border border-gray-200 p-2">
                                <p className="text-xs text-gray-500">{label}</p>
                                <p className="mt-0.5 text-xs font-semibold tabular-nums">{m(value)}</p>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            <p className="mt-8 text-xs text-gray-500">{labels.note}</p>
        </div>
    );
};

export default StatementDocument;
