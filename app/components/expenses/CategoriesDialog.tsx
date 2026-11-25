"use client";

import { useMemo, useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/use-toast";
import BaseButton from "@/app/components/reusables/BaseButton";

import { useTranslationContext } from "@/contexts/TranslationContext";
import { DEFAULT_CATEGORY_IDS, MAX_CATEGORY_NAME, usageByCategory, type Expense, type ExpenseCategory } from "@/lib/expenses";
import { addCategory, deleteCategory, renameCategory } from "@/lib/expenseStore";

import { Check, Pencil, Trash2, X } from "lucide-react";

type Props = { open: boolean; onClose: () => void; expenses: Expense[]; categories: ExpenseCategory[] };

/**
 * Built-in categories are fixed; custom ones can be added, renamed and deleted.
 * A custom category that expenses still use cannot simply be deleted: you pick
 * where those expenses go first, so none is ever left without a category.
 */
const CategoriesDialog = ({ open, onClose, expenses, categories }: Props) => {
    const { _t } = useTranslationContext();
    const [name, setName] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
    const [removing, setRemoving] = useState<{ category: ExpenseCategory; count: number } | null>(null);
    const [target, setTarget] = useState("miscellaneous");

    const usage = useMemo(() => usageByCategory(expenses), [expenses]);
    const reserved = DEFAULT_CATEGORY_IDS.map((id) => _t(`expenses.categories.${id}`));

    const fail = (reason: string) => setError(_t(`expenses.categoryErrors.${reason}`));

    const add = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        const r = await addCategory(name, reserved);
        if (r.ok) {
            setName("");
            toast({ title: _t("expenses.categoryToast.added"), description: r.category.name });
        } else fail(r.reason);
    };

    const rename = async () => {
        if (!editing) return;
        setError(null);
        const r = await renameCategory(editing.id, editing.name, reserved);
        if (r.ok) setEditing(null);
        else fail(r.reason);
    };

    const startRemove = (category: ExpenseCategory) => {
        setError(null);
        setTarget("miscellaneous");
        setRemoving({ category, count: usage.get(category.id) ?? 0 });
    };

    const confirmRemove = async () => {
        if (!removing) return;
        const r = await deleteCategory(removing.category.id, removing.count > 0 ? target : undefined);
        if (r.ok) {
            toast({ title: _t("expenses.categoryToast.deleted"), description: r.reassigned ? _t("expenses.categoryToast.reassigned", { count: r.reassigned }) : removing.category.name });
            setRemoving(null);
        } else {
            setRemoving(null);
            fail(r.reason);
        }
    };

    const others = [
        ...DEFAULT_CATEGORY_IDS.map((id) => ({ id: id as string, name: _t(`expenses.categories.${id}`) })),
        ...categories.filter((c) => c.id !== removing?.category.id).map((c) => ({ id: c.id, name: c.name })),
    ];

    return (
        <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-h-[90dvh] max-w-xl overflow-y-auto" data-testid="categories-dialog">
                <DialogHeader>
                    <DialogTitle>{_t("expenses.categoriesTitle")}</DialogTitle>
                    <DialogDescription>{_t("expenses.categoriesHint")}</DialogDescription>
                </DialogHeader>

                <form onSubmit={add} className="flex gap-2" noValidate>
                    <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={MAX_CATEGORY_NAME} placeholder={_t("expenses.newCategory")} aria-label={_t("expenses.newCategory")} data-testid="new-category" />
                    <BaseButton type="submit" data-testid="add-category">{_t("expenses.addCategory")}</BaseButton>
                </form>
                {error && <p role="alert" className="text-sm text-destructive" data-testid="category-error">{error}</p>}

                {removing && (
                    <div role="alertdialog" aria-label={_t("expenses.deleteCategoryTitle", { name: removing.category.name })} className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3" data-testid="category-delete">
                        <p className="text-sm font-medium">{_t("expenses.deleteCategoryTitle", { name: removing.category.name })}</p>
                        {removing.count > 0 ? (
                            <>
                                <p className="text-sm text-muted-foreground">{_t("expenses.deleteCategoryInUse", { count: removing.count })}</p>
                                <Select value={target} onValueChange={setTarget}>
                                    <SelectTrigger aria-label={_t("expenses.moveTo")} data-testid="reassign-to"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        {others.map((c) => (
                                            <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </>
                        ) : (
                            <p className="text-sm text-muted-foreground">{_t("expenses.deleteCategoryUnused")}</p>
                        )}
                        <div className="flex justify-end gap-2">
                            <BaseButton variant="ghost" size="sm" onClick={() => setRemoving(null)}>{_t("guards.cancel")}</BaseButton>
                            <BaseButton size="sm" className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={confirmRemove} data-testid="confirm-delete-category">
                                {removing.count > 0 ? _t("expenses.moveAndDelete") : _t("expenses.deleteCategory")}
                            </BaseButton>
                        </div>
                    </div>
                )}

                <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{_t("expenses.customCategories")}</h3>
                    {categories.length === 0 ? (
                        <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">{_t("expenses.noCustomCategories")}</p>
                    ) : (
                        <ul className="divide-y rounded-lg border" data-testid="custom-categories">
                            {categories.map((c) => (
                                <li key={c.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm" data-testid="custom-category" data-id={c.id}>
                                    {editing?.id === c.id ? (
                                        <>
                                            <Input value={editing.name} onChange={(e) => setEditing({ id: c.id, name: e.target.value })} maxLength={MAX_CATEGORY_NAME} aria-label={_t("expenses.renameCategory")} className="h-8" autoFocus data-testid="rename-input" />
                                            <div className="flex shrink-0">
                                                <BaseButton variant="ghost" size="icon" className="h-8 w-8" aria-label={_t("expenses.saveName")} onClick={rename} data-testid="rename-save"><Check className="h-4 w-4" /></BaseButton>
                                                <BaseButton variant="ghost" size="icon" className="h-8 w-8" aria-label={_t("guards.cancel")} onClick={() => setEditing(null)}><X className="h-4 w-4" /></BaseButton>
                                            </div>
                                        </>
                                    ) : (
                                        <>
                                            <span className="min-w-0 truncate">
                                                <span className="font-medium">{c.name}</span>
                                                <span className="ms-2 text-xs text-muted-foreground">{_t("expenses.usedBy", { count: usage.get(c.id) ?? 0 })}</span>
                                            </span>
                                            <div className="flex shrink-0">
                                                <BaseButton variant="ghost" size="icon" className="h-8 w-8" aria-label={`${_t("expenses.renameCategory")}: ${c.name}`} onClick={() => { setError(null); setEditing({ id: c.id, name: c.name }); }} data-testid="rename-category"><Pencil className="h-4 w-4" /></BaseButton>
                                                <BaseButton variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" aria-label={`${_t("expenses.deleteCategory")}: ${c.name}`} onClick={() => startRemove(c)} data-testid="delete-category"><Trash2 className="h-4 w-4" /></BaseButton>
                                            </div>
                                        </>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{_t("expenses.builtInCategories")}</h3>
                    <ul className="flex flex-wrap gap-1.5" data-testid="builtin-categories">
                        {DEFAULT_CATEGORY_IDS.map((id) => (
                            <li key={id} className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                                {_t(`expenses.categories.${id}`)}
                                <span className="ms-1.5 tabular-nums">{usage.get(id) ?? 0}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            </DialogContent>
        </Dialog>
    );
};

export default CategoriesDialog;
