"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useTranslationContext } from "@/contexts/TranslationContext";
import { DEFAULT_CATEGORY_IDS, categoryLabel, type Expense, type ExpenseCategory } from "@/lib/expenses";
import { EXPENSES_EVENT, loadExpenseData } from "@/lib/expenseStore";

/**
 * The expenses and the custom categories, kept fresh: reloads whenever anything
 * changes them (the expense form, the category manager, a backup restore).
 */
export function useExpenses() {
    const { _t } = useTranslationContext();
    const [data, setData] = useState<{ expenses: Expense[]; categories: ExpenseCategory[] }>({ expenses: [], categories: [] });
    const [loaded, setLoaded] = useState(false);

    const reload = useCallback(async () => {
        try {
            setData(await loadExpenseData());
        } finally {
            setLoaded(true);
        }
    }, []);

    useEffect(() => {
        void reload();
        window.addEventListener(EXPENSES_EVENT, reload);
        return () => window.removeEventListener(EXPENSES_EVENT, reload);
    }, [reload]);

    /** The name of a category in the current language (custom ones are shown as typed). */
    const nameOf = useCallback(
        (id: string) => categoryLabel(id, data.categories, (d) => _t(`expenses.categories.${d}`)),
        [data.categories, _t]
    );

    const categoryOptions = useMemo(
        () => [
            ...DEFAULT_CATEGORY_IDS.map((id) => ({ id: id as string, name: _t(`expenses.categories.${id}`), custom: false })),
            ...data.categories.map((c) => ({ id: c.id, name: c.name, custom: true })),
        ],
        [data.categories, _t]
    );

    return { ...data, loaded, reload, nameOf, categoryOptions };
}
