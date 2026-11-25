import React from "react";

import type { ReportPayload } from "@/lib/profit";

import type { ReportLabels } from "./reportLabels";

/**
 * The profit and loss report, laid out for A4.
 *
 * A plain function of its props (no hooks, no context) because it is rendered
 * through renderToStaticMarkup in the PDF route. It keeps the two bases visibly
 * apart, on purpose: the cash block says what money moved, the invoice block is
 * labelled an estimate, and receivables are a separate line that belongs to
 * neither.
 */
type Props = { payload: ReportPayload; labels: ReportLabels; locale: string };

const ACCENT = "#4F46E5";

const money = (value: number, currency: string, locale: string) => {
    try {
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

const month = (ym: string, locale: string) => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5)) - 1, 1).toLocaleDateString(locale, { month: "short", year: "numeric" });

const ProfitLossDocument = ({ payload, labels, locale }: Props) => {
    const { pnl: p, business, categories, months } = payload;
    const m = (v: number) => money(v, p.currency, locale);
    const period = p.from ? labels.periodRange.replace("{from}", day(p.from, locale)).replace("{to}", day(p.to, locale)) : labels.periodAll.replace("{to}", day(p.to, locale));

    const th = "border-b-2 border-gray-300 pb-2 text-xs font-semibold uppercase tracking-wider";
    const Line = ({ label, value, strong = false, indent = false, tone }: { label: string; value: number; strong?: boolean; indent?: boolean; tone?: "good" | "bad" }) => (
        <tr className="break-inside-avoid border-b border-gray-200">
            <td className={`py-1.5 pe-2 ${indent ? "ps-4 text-gray-500" : ""} ${strong ? "font-semibold text-gray-900" : "text-gray-700"}`}>{label}</td>
            <td className={`py-1.5 text-end tabular-nums ${strong ? "font-bold" : ""}`} style={tone ? { color: tone === "good" ? "#15803d" : "#b91c1c" } : undefined}>
                {m(value)}
            </td>
        </tr>
    );

    return (
        <div className="w-full bg-white p-12 text-gray-800" style={{ fontFamily: "Outfit, sans-serif" }} data-testid="report-document">
            <div className="flex items-start justify-between gap-6">
                <div>
                    <p className="text-base font-semibold text-gray-900">{business.name}</p>
                    {business.gstin && (
                        <p className="text-xs text-gray-500">
                            {labels.gstin}: <span className="tabular-nums">{business.gstin}</span>
                        </p>
                    )}
                </div>
                <div className="text-end">
                    <p className="text-2xl font-bold uppercase tracking-wide" style={{ color: ACCENT }}>
                        {labels.title}
                    </p>
                    <p className="mt-1 text-xs text-gray-500">{period}</p>
                    <p className="text-xs text-gray-500">{labels.generated.replace("{date}", day(payload.generatedAt, locale))}</p>
                    <p className="text-xs text-gray-500">
                        {labels.currency}: {p.currency}
                    </p>
                </div>
            </div>

            {/* Cash basis */}
            <p className="mt-8 text-xs font-semibold uppercase tracking-wider" style={{ color: ACCENT }}>
                {labels.cashBasis}
            </p>
            <p className="text-xs text-gray-500">{labels.cashBasisNote}</p>
            <table className="mt-2 w-full border-collapse text-sm" data-testid="report-cash">
                <tbody>
                    <Line label={labels.collected} value={p.collected} />
                    <Line label={labels.expensesPaid} value={p.expenses} />
                    {p.supplierPaid > 0 && <Line label={labels.paidSuppliers} value={p.supplierPaid} />}
                    <Line label={labels.netCashFlow} value={p.netCashFlow} strong tone={p.netCashFlow >= 0 ? "good" : "bad"} />
                </tbody>
            </table>

            {/* Invoice basis */}
            <p className="mt-8 text-xs font-semibold uppercase tracking-wider" style={{ color: ACCENT }}>
                {labels.invoiceBasis}
            </p>
            <p className="text-xs text-gray-500">{labels.invoiceBasisNote}</p>
            <table className="mt-2 w-full border-collapse text-sm" data-testid="report-invoice">
                <tbody>
                    <Line label={labels.invoiced} value={p.invoiced} />
                    <Line label={labels.lessTax} value={-p.invoicedTax} indent />
                    <Line label={labels.revenue} value={p.revenue} strong />
                    <Line label={labels.expensesTotal} value={p.expenses} />
                    <Line label={labels.lessRecoverable} value={-p.recoverableTax} indent />
                    <Line label={labels.cost} value={p.expensesNet} strong />
                    {p.purchaseCount > 0 && (
                        <>
                            <Line label={labels.purchases} value={p.purchases} />
                            <Line label={labels.lessClaimable} value={-p.purchasesRecoverableTax} indent />
                            <Line label={labels.purchaseCost} value={p.purchasesNet} strong />
                        </>
                    )}
                    <Line label={labels.estimatedProfit} value={p.estimatedProfit} strong tone={p.estimatedProfit >= 0 ? "good" : "bad"} />
                </tbody>
            </table>

            {/* Receivables */}
            <p className="mt-8 text-xs font-semibold uppercase tracking-wider" style={{ color: ACCENT }}>
                {labels.receivables}
            </p>
            <p className="text-xs text-gray-500">{labels.receivablesNote}</p>
            <table className="mt-2 w-full border-collapse text-sm" data-testid="report-receivables">
                <tbody>
                    <Line label={labels.outstanding} value={p.outstanding} />
                    <Line label={labels.overdue} value={p.overdue} indent />
                </tbody>
            </table>

            {/* Payables */}
            {p.payables > 0 && (
                <>
                    <p className="mt-8 text-xs font-semibold uppercase tracking-wider" style={{ color: ACCENT }}>
                        {labels.payables}
                    </p>
                    <p className="text-xs text-gray-500">{labels.payablesNote}</p>
                    <table className="mt-2 w-full border-collapse text-sm" data-testid="report-payables">
                        <tbody>
                            <Line label={labels.outstanding} value={p.payables} />
                            <Line label={labels.overdue} value={p.payablesOverdue} indent />
                        </tbody>
                    </table>
                </>
            )}

            {/* By category */}
            <div className="mt-8 break-inside-avoid">
                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: ACCENT }}>
                    {labels.byCategory}
                </p>
                <table className="mt-2 w-full border-collapse text-xs" data-testid="report-categories">
                    <thead>
                        <tr>
                            <th className={`${th} text-start`}>{labels.category}</th>
                            <th className={`${th} text-end`}>{labels.count}</th>
                            <th className={`${th} text-end`}>{labels.share}</th>
                            <th className={`${th} text-end`}>{labels.amount}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {categories.length === 0 && (
                            <tr>
                                <td colSpan={4} className="py-3 text-center text-gray-500">
                                    {labels.noExpenses}
                                </td>
                            </tr>
                        )}
                        {categories.map((c, i) => (
                            <tr key={i} className="break-inside-avoid border-b border-gray-200">
                                <td className="py-1.5 pe-2 text-gray-800">{c.name}</td>
                                <td className="py-1.5 text-end tabular-nums text-gray-600">{c.count}</td>
                                <td className="py-1.5 text-end tabular-nums text-gray-600">{Math.round(c.share * 100)}%</td>
                                <td className="py-1.5 text-end tabular-nums">{m(c.total)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* By month */}
            {months.length > 0 && (
                <div className="mt-8">
                    <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: ACCENT }}>
                        {labels.byMonth}
                    </p>
                    <table className="mt-2 w-full border-collapse text-xs" data-testid="report-months">
                        <thead>
                            <tr>
                                <th className={`${th} text-start`}>{labels.month}</th>
                                <th className={`${th} text-end`}>{labels.revenue}</th>
                                <th className={`${th} text-end`}>{labels.collected}</th>
                                <th className={`${th} text-end`}>{labels.expensesTotal}</th>
                                <th className={`${th} text-end`}>{labels.estimatedProfit}</th>
                                <th className={`${th} text-end`}>{labels.netCashFlow}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {months.map((row) => (
                                <tr key={row.ym} className="break-inside-avoid border-b border-gray-200">
                                    <td className="py-1.5 pe-2 text-gray-800">{month(row.ym, locale)}</td>
                                    <td className="py-1.5 text-end tabular-nums">{m(row.revenue)}</td>
                                    <td className="py-1.5 text-end tabular-nums">{m(row.collected)}</td>
                                    <td className="py-1.5 text-end tabular-nums">{m(row.expenses)}</td>
                                    <td className="py-1.5 text-end tabular-nums">{m(row.estimatedProfit)}</td>
                                    <td className="py-1.5 text-end tabular-nums">{m(row.netCashFlow)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <p className="mt-8 text-xs text-gray-500">{labels.note}</p>
        </div>
    );
};

export default ProfitLossDocument;
