/**
 * Storage and operations for expenses and custom expense categories.
 *
 * Same shape as the product and quotation stores: the encrypted browser store,
 * validated on every read, plain async functions (so it could later be swapped
 * for a database), and one queue so two quick actions cannot lose each other's
 * update.
 */

import { readSecure, writeSecure } from "@/lib/secureStore";
import {
    DEFAULT_CATEGORY_IDS,
    FALLBACK_CATEGORY,
    MAX_CATEGORY_NAME,
    MAX_CUSTOM_CATEGORIES,
    categoryNameTaken,
    decimalsOf,
    isDefaultCategory,
    normaliseCurrency,
    sanitizeCategory,
    sanitizeExpense,
    validateExpense,
    withKnownCategories,
    type Expense,
    type ExpenseCategory,
    type ExpenseDraft,
    type ExpenseErrors,
    type ExpenseMethod,
    type ExpenseTax,
} from "@/lib/expenses";
import { roundMoney } from "@/lib/calculations";
import { normaliseGstin } from "@/lib/gst";
import { stripControlChars } from "@/lib/schemas";

export const EXPENSES_KEY = "invoify:expenses";
export const EXPENSE_CATEGORIES_KEY = "invoify:expenseCategories";
export const EXPENSES_EVENT = "invoify:expenses-changed";

const MAX_EXPENSES = 20_000;

let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
}
const announce = () => {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(EXPENSES_EVENT));
};

/* ------------------------------------------------------------------ reads */

export async function readCategories(): Promise<ExpenseCategory[]> {
    const raw = await readSecure<unknown>(EXPENSE_CATEGORIES_KEY);
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: ExpenseCategory[] = [];
    for (const c of raw.map(sanitizeCategory)) {
        if (c && !seen.has(c.id)) {
            seen.add(c.id);
            out.push(c);
        }
    }
    return out;
}

export async function readExpenses(): Promise<Expense[]> {
    const raw = await readSecure<unknown>(EXPENSES_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.map(sanitizeExpense).filter((e): e is Expense => e !== null);
}

export async function loadExpenseData() {
    const [expenses, categories] = await Promise.all([readExpenses(), readCategories()]);
    return { expenses, categories };
}

const writeExpenses = (list: Expense[]) => writeSecure(EXPENSES_KEY, list.slice(0, MAX_EXPENSES));
const writeCategories = (list: ExpenseCategory[]) => writeSecure(EXPENSE_CATEGORIES_KEY, list.slice(0, MAX_CUSTOM_CATEGORIES));

export const allCategoryIds = (custom: ExpenseCategory[]) => [...DEFAULT_CATEGORY_IDS, ...custom.map((c) => c.id)];

/* --------------------------------------------------------------- expenses */

export type ExpenseInput = ExpenseDraft & {
    method: ExpenseMethod;
    taxRecoverable?: boolean;
};

export type SaveExpenseResult =
    | { ok: true; expense: Expense }
    | { ok: false; errors: ExpenseErrors }
    | { ok: false; reason: "notFound" | "storage" | "limit" };

/** Creates an expense, or updates `id`. Validated against the categories that actually exist. */
export function saveExpense(input: ExpenseInput, id?: string, now: Date = new Date()): Promise<SaveExpenseResult> {
    return enqueue(async () => {
        const { expenses, categories } = await loadExpenseData();
        const errors = validateExpense(input, allCategoryIds(categories), now);
        if (Object.keys(errors).length > 0) return { ok: false as const, errors };

        const existing = id ? expenses.find((e) => e.id === id) : undefined;
        if (id && !existing) return { ok: false as const, reason: "notFound" as const };
        if (!existing && expenses.length >= MAX_EXPENSES) return { ok: false as const, reason: "limit" as const };

        const currency = normaliseCurrency(input.currency);
        const dec = decimalsOf(currency);
        const taxAmount = input.taxAmount === undefined || input.taxAmount === "" ? 0 : roundMoney(Number(input.taxAmount), dec);
        const gstin = normaliseGstin(input.vendorGstin);
        const rate = input.taxRate === undefined || input.taxRate === "" ? undefined : Number(input.taxRate);
        const tax: ExpenseTax | undefined =
            taxAmount > 0
                ? { amount: taxAmount, recoverable: input.taxRecoverable === true, ...(rate !== undefined ? { rate } : {}), ...(gstin ? { gstin } : {}) }
                : undefined;

        const at = now.toISOString();
        const candidate = sanitizeExpense({
            id: existing?.id ?? crypto.randomUUID(),
            title: input.title,
            category: input.category,
            amount: input.amount,
            currency,
            date: input.date,
            method: input.method,
            vendor: input.vendor,
            reference: input.reference,
            notes: input.notes,
            tax,
            // Editing an expense must not undo the link to its purchase bill.
            billId: existing?.billId,
            createdAt: existing?.createdAt ?? at,
            updatedAt: at,
        });
        if (!candidate) return { ok: false as const, errors: { title: "title" } };

        const next = existing ? expenses.map((e) => (e.id === candidate.id ? candidate : e)) : [...expenses, candidate];
        if (!(await writeExpenses(next))) return { ok: false as const, reason: "storage" as const };
        announce();
        return { ok: true as const, expense: candidate };
    });
}

/** Links an expense to the purchase bill it is the same spend as (or unlinks it with null). */
export function setExpenseBill(id: string, billId: string | null): Promise<{ ok: true } | { ok: false; reason: "notFound" | "storage" }> {
    return enqueue(async () => {
        const expenses = await readExpenses();
        if (!expenses.some((e) => e.id === id)) return { ok: false as const, reason: "notFound" as const };
        const stamp = new Date().toISOString();
        const next = expenses.map((e) => {
            if (e.id !== id) return e;
            const { billId: _old, ...rest } = e;
            void _old;
            return billId ? { ...rest, billId, updatedAt: stamp } : { ...rest, updatedAt: stamp };
        });
        if (!(await writeExpenses(next))) return { ok: false as const, reason: "storage" as const };
        announce();
        return { ok: true as const };
    });
}

export function deleteExpense(id: string): Promise<{ ok: true } | { ok: false; reason: "notFound" | "storage" }> {
    return enqueue(async () => {
        const expenses = await readExpenses();
        if (!expenses.some((e) => e.id === id)) return { ok: false as const, reason: "notFound" as const };
        if (!(await writeExpenses(expenses.filter((e) => e.id !== id)))) return { ok: false as const, reason: "storage" as const };
        announce();
        return { ok: true as const };
    });
}

/* ------------------------------------------------------------- categories */

export type CategoryResult = { ok: true; category: ExpenseCategory } | { ok: false; reason: "name" | "taken" | "limit" | "notFound" | "storage" };

const cleanName = (n: string) => stripControlChars(n).trim().replace(/\s+/g, " ").slice(0, MAX_CATEGORY_NAME);

/** `reserved` are the built-in categories' names in the current language, so a custom one cannot copy them. */
export function addCategory(name: string, reserved: string[]): Promise<CategoryResult> {
    return enqueue(async () => {
        const cleaned = cleanName(name);
        if (cleaned.length < 2) return { ok: false as const, reason: "name" as const };
        const custom = await readCategories();
        if (custom.length >= MAX_CUSTOM_CATEGORIES) return { ok: false as const, reason: "limit" as const };
        if (categoryNameTaken(cleaned, custom, reserved)) return { ok: false as const, reason: "taken" as const };
        const category = { id: `x-${crypto.randomUUID().slice(0, 8)}`, name: cleaned };
        if (!(await writeCategories([...custom, category]))) return { ok: false as const, reason: "storage" as const };
        announce();
        return { ok: true as const, category };
    });
}

export function renameCategory(id: string, name: string, reserved: string[]): Promise<CategoryResult> {
    return enqueue(async () => {
        const cleaned = cleanName(name);
        if (cleaned.length < 2) return { ok: false as const, reason: "name" as const };
        const custom = await readCategories();
        const existing = custom.find((c) => c.id === id);
        if (!existing) return { ok: false as const, reason: "notFound" as const };
        if (categoryNameTaken(cleaned, custom, reserved, id)) return { ok: false as const, reason: "taken" as const };
        const category = { id, name: cleaned };
        if (!(await writeCategories(custom.map((c) => (c.id === id ? category : c))))) return { ok: false as const, reason: "storage" as const };
        announce();
        return { ok: true as const, category };
    });
}

export type DeleteCategoryResult =
    | { ok: true; reassigned: number }
    | { ok: false; reason: "builtIn" | "notFound" | "inUse" | "badTarget" | "storage"; count?: number };

/**
 * Deletes a custom category. If expenses still use it, it is refused unless
 * `reassignTo` names another category (built-in or custom), in which case those
 * expenses move there first. Built-in categories cannot be deleted.
 *
 * The expenses are rewritten before the category is removed, so a failure part
 * way leaves no expense pointing at a category that is gone.
 */
export function deleteCategory(id: string, reassignTo?: string): Promise<DeleteCategoryResult> {
    return enqueue(async () => {
        if (isDefaultCategory(id)) return { ok: false as const, reason: "builtIn" as const };
        const { expenses, categories } = await loadExpenseData();
        if (!categories.some((c) => c.id === id)) return { ok: false as const, reason: "notFound" as const };

        const using = expenses.filter((e) => e.category === id);
        if (using.length > 0) {
            if (!reassignTo) return { ok: false as const, reason: "inUse" as const, count: using.length };
            const valid = reassignTo !== id && allCategoryIds(categories).includes(reassignTo);
            if (!valid) return { ok: false as const, reason: "badTarget" as const };
            const moved = expenses.map((e) => (e.category === id ? { ...e, category: reassignTo, updatedAt: new Date().toISOString() } : e));
            if (!(await writeExpenses(moved))) return { ok: false as const, reason: "storage" as const };
        }
        if (!(await writeCategories(categories.filter((c) => c.id !== id)))) return { ok: false as const, reason: "storage" as const };
        announce();
        return { ok: true as const, reassigned: using.length };
    });
}

/* ----------------------------------------------------------------- backup */

/** Replaces both stores (backup restore). */
export function replaceExpenseData(expenses: Expense[], categories: ExpenseCategory[]) {
    return enqueue(async () => {
        const ok = (await writeCategories(categories)) && (await writeExpenses(expenses));
        announce();
        return ok;
    });
}

/**
 * Merges imported expenses and categories.
 *
 *   - A category matches an existing one by id, then by name (case-insensitively);
 *     an expense that used the imported id is pointed at the one already held, so
 *     importing never creates a second "Fuel".
 *   - An expense already held (same id) is skipped, never overwritten.
 *   - An expense whose category exists nowhere is filed under miscellaneous
 *     rather than left pointing at nothing.
 */
export function mergeExpenseData(
    existing: { expenses: Expense[]; categories: ExpenseCategory[] },
    incoming: { expenses: Expense[]; categories: ExpenseCategory[] }
) {
    const categories = [...existing.categories];
    const remap = new Map<string, string>();
    let addedCategories = 0;
    for (const c of incoming.categories) {
        const byId = categories.find((x) => x.id === c.id);
        const byName = categories.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
        if (byId) remap.set(c.id, byId.id);
        else if (byName) remap.set(c.id, byName.id);
        else if (categories.length < MAX_CUSTOM_CATEGORIES) {
            categories.push(c);
            remap.set(c.id, c.id);
            addedCategories++;
        }
    }

    const known = new Set([...DEFAULT_CATEGORY_IDS, ...categories.map((c) => c.id)] as string[]);
    const ids = new Set(existing.expenses.map((e) => e.id));
    const expenses = [...existing.expenses];
    let added = 0;
    let skipped = 0;
    let refiled = 0;
    for (const e of incoming.expenses) {
        if (ids.has(e.id)) {
            skipped++;
            continue;
        }
        const category = remap.get(e.category) ?? e.category;
        const filed = known.has(category) ? category : FALLBACK_CATEGORY;
        if (filed !== category) refiled++;
        expenses.push({ ...e, category: filed });
        ids.add(e.id);
        added++;
    }
    return { expenses: withKnownCategories(expenses, known), categories, added, skipped, refiled, addedCategories };
}
