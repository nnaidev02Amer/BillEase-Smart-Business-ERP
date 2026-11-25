"use client";

import { useMemo, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/use-toast";
import BaseButton from "@/app/components/reusables/BaseButton";
import { BarChart } from "@/app/components/dashboard/Charts";
import { Panel, StatCard } from "@/app/components/clients/CrmWidgets";

import CategoriesDialog from "./CategoriesDialog";
import ExpenseDialog from "./ExpenseDialog";
import { CategoryBars, PeriodPicker, usePeriod } from "./ExpenseWidgets";

import { useInvoiceContext } from "@/contexts/InvoiceContext";
import { useExpenses } from "@/contexts/useExpenses";
import { usePurchaseBills } from "@/contexts/usePurchasing";
import { useTranslationContext } from "@/contexts/TranslationContext";
import {
    EMPTY_EXPENSE_QUERY,
    EXPENSE_METHODS,
    currenciesOfExpenses,
    expensesToCsv,
    fromDay,
    queryExpenses,
    summariseExpenses,
    type Expense,
    type ExpenseQuery,
    type ExpenseSortKey,
} from "@/lib/expenses";
import { deleteExpense } from "@/lib/expenseStore";
import { formatMoney } from "@/lib/invoiceRecords";
import { downloadBlob } from "@/lib/quotationPdf";

import { Download, Pencil, Plus, Receipt, Search, Settings2, Trash2 } from "lucide-react";

const SORTS: ExpenseSortKey[] = ["date", "amount", "title", "category", "vendor"];

const ExpensesPage = () => {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const { savedInvoices } = useInvoiceContext();
    const { expenses, categories, loaded, nameOf, categoryOptions } = useExpenses();
    // An expense linked to a posted supplier bill is counted through the bill, and says so.
    const { bills: purchaseBills } = usePurchaseBills();
    const linkedBill = useMemo(() => new Map(purchaseBills.filter((b) => b.status === "posted").map((b) => [b.id, b.number])), [purchaseBills]);

    const period = usePeriod("all", "list");
    const [query, setQuery] = useState<ExpenseQuery>(EMPTY_EXPENSE_QUERY);
    const [form, setForm] = useState<Expense | "new" | null>(null);
    const [managing, setManaging] = useState(false);
    const [deleting, setDeleting] = useState<Expense | null>(null);
    const [summaryCurrency, setSummaryCurrency] = useState<string | null>(null);

    const effective: ExpenseQuery = { ...query, from: period.range.from, to: period.range.to };
    const rows = useMemo(() => queryExpenses(expenses, effective, nameOf), [expenses, effective.search, effective.category, effective.method, effective.currency, effective.from, effective.to, effective.sort, effective.dir, nameOf]); // eslint-disable-line react-hooks/exhaustive-deps

    // Money is never added across currencies: the summary is for one.
    const rowCurrencies = useMemo(() => currenciesOfExpenses(rows), [rows]);
    const counts = useMemo(() => {
        const m = new Map<string, number>();
        for (const e of rows) m.set(e.currency, (m.get(e.currency) ?? 0) + 1);
        return m;
    }, [rows]);
    const currency =
        summaryCurrency && rowCurrencies.includes(summaryCurrency)
            ? summaryCurrency
            : [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "USD";
    const summary = useMemo(() => summariseExpenses(rows, { currency }), [rows, currency]);

    // A new expense starts in the currency you use most: your latest expense's, else your latest invoice's.
    const defaultCurrency = useMemo(() => {
        const latest = [...expenses].sort((a, b) => b.date.localeCompare(a.date))[0]?.currency;
        return latest ?? savedInvoices.at(-1)?.details.currency ?? "USD";
    }, [expenses, savedInvoices]);

    const set = (patch: Partial<ExpenseQuery>) => setQuery((q) => ({ ...q, ...patch }));
    const filtered = query.search !== "" || query.category !== "" || query.method !== "" || query.currency !== "" || period.choice !== "all";
    const clear = () => {
        setQuery(EMPTY_EXPENSE_QUERY);
        period.setChoice("all");
    };

    const money = (v: number, c = currency) => formatMoney(v, c, locale);
    const day = (ymd: string) => fromDay(ymd).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
    const monthLabel = (ym: string) => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5)) - 1, 1).toLocaleDateString(locale, { month: "short", year: "2-digit" });

    const exportCsv = () => {
        const name = `expenses-${new Date().toISOString().slice(0, 10)}.csv`;
        downloadBlob(new Blob([expensesToCsv(rows, nameOf)], { type: "text/csv;charset=utf-8" }), name);
        toast({ title: _t("expenses.exported"), description: _t("expenses.exportedBody", { count: rows.length }) });
    };

    const remove = async () => {
        const e = deleting;
        setDeleting(null);
        if (!e) return;
        const r = await deleteExpense(e.id);
        toast(r.ok ? { title: _t("expenses.toast.deleted"), description: e.title } : { variant: "destructive", title: _t(`expenses.errors.${r.reason}`) });
    };

    if (!loaded) return <Skeleton className="h-96 rounded-xl" aria-busy="true" />;

    const Actions = ({ e }: { e: Expense }) => (
        <div className="flex items-center justify-end gap-1">
            <BaseButton variant="ghost" size="icon" className="h-8 w-8" aria-label={`${_t("expenses.actions.edit")}: ${e.title}`} onClick={() => setForm(e)} data-testid="edit-expense">
                <Pencil className="h-4 w-4" />
            </BaseButton>
            <BaseButton variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" aria-label={`${_t("expenses.actions.delete")}: ${e.title}`} onClick={() => setDeleting(e)} data-testid="delete-expense">
                <Trash2 className="h-4 w-4" />
            </BaseButton>
        </div>
    );

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{_t("expenses.title")}</h1>
                    <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{_t("expenses.subtitle")}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <BaseButton variant="outline" onClick={() => setManaging(true)} data-testid="manage-categories">
                        <Settings2 className="h-4 w-4" />
                        {_t("expenses.categoriesButton")}
                    </BaseButton>
                    {expenses.length > 0 && (
                        <BaseButton variant="outline" onClick={exportCsv} data-testid="export-expenses">
                            <Download className="h-4 w-4" />
                            {_t("expenses.export")}
                        </BaseButton>
                    )}
                    <BaseButton onClick={() => setForm("new")} data-testid="add-expense">
                        <Plus className="h-4 w-4" />
                        {_t("expenses.add")}
                    </BaseButton>
                </div>
            </div>

            {expenses.length === 0 ? (
                <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center">
                    <div className="rounded-full bg-primary/10 p-4 text-primary">
                        <Receipt className="h-8 w-8" aria-hidden />
                    </div>
                    <h2 className="text-lg font-semibold">{_t("expenses.empty.title")}</h2>
                    <p className="max-w-md text-sm text-muted-foreground">{_t("expenses.empty.body")}</p>
                    <BaseButton onClick={() => setForm("new")}>
                        <Plus className="h-4 w-4" />
                        {_t("expenses.empty.cta")}
                    </BaseButton>
                </div>
            ) : (
                <>
                    <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-end">
                        <div className="relative lg:w-72">
                            <Search aria-hidden className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input type="search" data-shortcut-search className="ps-9" value={query.search} onChange={(e) => set({ search: e.target.value })} placeholder={_t("expenses.search")} aria-label={_t("expenses.search")} />
                        </div>
                        <Select value={query.category || "__all"} onValueChange={(v) => set({ category: v === "__all" ? "" : v })}>
                            <SelectTrigger className="lg:w-48" aria-label={_t("expenses.filters.category")}><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="__all">{_t("expenses.filters.allCategories")}</SelectItem>
                                {categoryOptions.map((c) => (
                                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Select value={query.method || "__all"} onValueChange={(v) => set({ method: v === "__all" ? "" : v })}>
                            <SelectTrigger className="lg:w-44" aria-label={_t("expenses.filters.method")}><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="__all">{_t("expenses.filters.allMethods")}</SelectItem>
                                {EXPENSE_METHODS.map((m) => (
                                    <SelectItem key={m} value={m}>{_t(`invoices.methods.${m}`)}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        {currenciesOfExpenses(expenses).length > 1 && (
                            <Select value={query.currency || "__all"} onValueChange={(v) => set({ currency: v === "__all" ? "" : v })}>
                                <SelectTrigger className="lg:w-36" aria-label={_t("expenses.filters.currency")}><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="__all">{_t("expenses.filters.allCurrencies")}</SelectItem>
                                    {currenciesOfExpenses(expenses).map((c) => (
                                        <SelectItem key={c} value={c}>{c}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        )}
                        <PeriodPicker period={period} />
                        <Select value={query.sort} onValueChange={(v) => set({ sort: v as ExpenseSortKey })}>
                            <SelectTrigger className="lg:w-44" aria-label={_t("expenses.sortBy")}><SelectValue /></SelectTrigger>
                            <SelectContent>
                                {SORTS.map((s) => (
                                    <SelectItem key={s} value={s}>{_t("expenses.sortBy")}: {_t(`expenses.sort.${s}`)}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <BaseButton variant="outline" className="w-10 px-0" onClick={() => set({ dir: query.dir === "asc" ? "desc" : "asc" })} aria-label={query.dir === "asc" ? _t("expenses.ascending") : _t("expenses.descending")} data-testid="sort-dir">
                            {query.dir === "asc" ? "↑" : "↓"}
                        </BaseButton>
                        {filtered && (
                            <BaseButton variant="ghost" size="sm" onClick={clear} data-testid="clear-filters">{_t("expenses.filters.clear")}</BaseButton>
                        )}
                    </div>
                    {period.invalid && <p role="alert" className="text-sm text-destructive">{_t("expenses.period.badRange")}</p>}

                    {rowCurrencies.length > 1 && (
                        <div className="flex items-center gap-2 text-sm">
                            <span className="text-muted-foreground">{_t("expenses.summaryIn")}</span>
                            <Select value={currency} onValueChange={setSummaryCurrency}>
                                <SelectTrigger className="h-8 w-28" aria-label={_t("expenses.summaryIn")}><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {rowCurrencies.map((c) => (
                                        <SelectItem key={c} value={c}>{c}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <span className="text-xs text-muted-foreground">{_t("expenses.neverMixed")}</span>
                        </div>
                    )}

                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5" data-testid="expense-summary">
                        <StatCard testId="es-total" label={_t("expenses.summary.total")} value={money(summary.total)} />
                        <StatCard testId="es-count" label={_t("expenses.summary.count")} value={summary.count} />
                        <StatCard testId="es-average" label={_t("expenses.summary.average")} value={money(summary.average)} />
                        <StatCard testId="es-tax" label={_t("expenses.summary.tax")} value={money(summary.tax)} sub={summary.recoverableTax > 0 ? _t("expenses.summary.recoverable", { amount: money(summary.recoverableTax) }) : undefined} />
                        <StatCard testId="es-largest" label={_t("expenses.summary.largest")} value={summary.largest ? money(summary.largest.amount) : "—"} sub={summary.largest?.title} />
                    </div>

                    <div className="grid gap-6 xl:grid-cols-2">
                        <Panel title={_t("expenses.byCategory")} testId="by-category">
                            <CategoryBars rows={summary.byCategory} nameOf={nameOf} currency={currency} />
                        </Panel>
                        <Panel title={_t("expenses.byMonth")} testId="by-month">
                            {summary.byMonth.length === 0 ? (
                                <p className="py-6 text-center text-sm text-muted-foreground">{_t("expenses.noneInPeriod")}</p>
                            ) : (
                                <BarChart
                                    ariaLabel={_t("expenses.byMonth")}
                                    series={[{ name: _t("expenses.summary.total"), color: "hsl(var(--primary))" }]}
                                    format={(v) => money(v)}
                                    data={summary.byMonth.map((m) => ({ label: monthLabel(m.ym), values: [m.total], title: `${monthLabel(m.ym)}: ${money(m.total)}` }))}
                                />
                            )}
                        </Panel>
                    </div>

                    <p className="text-xs text-muted-foreground" data-testid="expense-count">{_t("expenses.showing", { shown: rows.length, total: expenses.length })}</p>

                    {rows.length === 0 ? (
                        <p className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">{_t("expenses.empty.filtered")}</p>
                    ) : (
                        <>
                            <div className="hidden overflow-x-auto rounded-xl border bg-card shadow-sm md:block">
                                <table className="w-full text-sm" data-testid="expense-table">
                                    <thead className="bg-muted/50 text-xs text-muted-foreground">
                                        <tr>
                                            <th className="px-4 py-3 text-start font-medium">{_t("expenses.columns.date")}</th>
                                            <th className="px-4 py-3 text-start font-medium">{_t("expenses.columns.title")}</th>
                                            <th className="px-4 py-3 text-start font-medium">{_t("expenses.columns.category")}</th>
                                            <th className="px-4 py-3 text-start font-medium">{_t("expenses.columns.method")}</th>
                                            <th className="px-4 py-3 text-end font-medium">{_t("expenses.columns.amount")}</th>
                                            <th className="px-4 py-3 text-end font-medium">{_t("expenses.columns.actions")}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {rows.map((e) => (
                                            <tr key={e.id} className="border-t" data-testid="expense-row" data-title={e.title}>
                                                <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{day(e.date)}</td>
                                                <td className="px-4 py-3">
                                                    <p className="font-medium">{e.title}</p>
                                                    <p className="text-xs text-muted-foreground">{[e.vendor, e.reference].filter(Boolean).join(" · ")}</p>
                                                    {e.billId && linkedBill.has(e.billId) && (
                                                        <p className="text-xs font-medium text-sky-700 dark:text-sky-400" data-testid="expense-linked">
                                                            {_t("expenses.linkedToBill", { number: linkedBill.get(e.billId) ?? "" })}
                                                        </p>
                                                    )}
                                                </td>
                                                <td className="px-4 py-3">{nameOf(e.category)}</td>
                                                <td className="px-4 py-3 text-muted-foreground">{_t(`invoices.methods.${e.method}`)}</td>
                                                <td className="px-4 py-3 text-end tabular-nums">
                                                    {money(e.amount, e.currency)}
                                                    {e.tax && <p className="text-xs text-muted-foreground">{_t("expenses.taxIncluded", { amount: money(e.tax.amount, e.currency) })}</p>}
                                                </td>
                                                <td className="px-4 py-3"><Actions e={e} /></td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            <ul className="grid grid-cols-1 gap-3 md:hidden" data-testid="expense-cards">
                                {rows.map((e) => (
                                    <li key={e.id} className="rounded-xl border bg-card p-4 shadow-sm" data-testid="expense-row" data-title={e.title}>
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0">
                                                <p className="truncate font-medium">{e.title}</p>
                                                <p className="truncate text-xs text-muted-foreground">{nameOf(e.category)} · {day(e.date)}</p>
                                            </div>
                                            <p className="shrink-0 font-semibold tabular-nums">{money(e.amount, e.currency)}</p>
                                        </div>
                                        {(e.vendor || e.reference) && <p className="mt-1 truncate text-xs text-muted-foreground">{[e.vendor, e.reference].filter(Boolean).join(" · ")}</p>}
                                        {e.billId && linkedBill.has(e.billId) && (
                                            <p className="mt-1 text-xs font-medium text-sky-700 dark:text-sky-400" data-testid="expense-linked">
                                                {_t("expenses.linkedToBill", { number: linkedBill.get(e.billId) ?? "" })}
                                            </p>
                                        )}
                                        <div className="mt-2"><Actions e={e} /></div>
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                </>
            )}

            <ExpenseDialog target={form} onClose={() => setForm(null)} categories={categoryOptions} defaultCurrency={defaultCurrency} />
            <CategoriesDialog open={managing} onClose={() => setManaging(false)} expenses={expenses} categories={categories} />

            <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{_t("expenses.confirmDeleteTitle", { title: deleting?.title ?? "" })}</AlertDialogTitle>
                        <AlertDialogDescription>{_t("expenses.confirmDeleteBody")}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>{_t("guards.cancel")}</AlertDialogCancel>
                        <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={remove} data-testid="confirm-delete-expense">
                            {_t("expenses.actions.delete")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
};

export default ExpensesPage;
