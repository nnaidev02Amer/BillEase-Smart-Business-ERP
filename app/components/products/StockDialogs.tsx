"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale } from "next-intl";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/use-toast";
import BaseButton from "@/app/components/reusables/BaseButton";

import { useTranslationContext } from "@/contexts/TranslationContext";
import { adjustStock } from "@/lib/inventory";
import { historyOf, round3, stockOf, type Product, type StockMovement } from "@/lib/products";

type Reason = "purchase" | "add" | "remove";

/** Manual stock changes. Never lets stock go below zero. */
export const StockAdjustDialog = ({
    product,
    movements,
    onClose,
}: {
    product: Product | null;
    movements: StockMovement[];
    onClose: () => void;
}) => {
    const { _t } = useTranslationContext();
    const [reason, setReason] = useState<Reason>("purchase");
    const [qty, setQty] = useState("");
    const [note, setNote] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (product) {
            setReason("purchase");
            setQty("");
            setNote("");
            setError(null);
        }
    }, [product]);

    const current = product ? stockOf(product.id, movements) : 0;
    const amount = round3(Number(qty));
    const valid = Number.isFinite(amount) && amount > 0;
    const signed = reason === "remove" ? -amount : amount;

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!product || busy) return;
        if (!valid) {
            setError(_t("products.adjust.errors.zero"));
            return;
        }
        setBusy(true);
        try {
            const result = await adjustStock(product.id, signed, reason === "purchase" ? "purchase" : "adjustment", note);
            if (result.ok) {
                toast({ title: _t("products.toast.adjusted"), description: `${product.name}: ${result.stock} ${product.unit}` });
                onClose();
            } else if (result.reason === "negative") {
                setError(_t("products.adjust.errors.negative", { count: result.stock ?? current }));
            } else {
                setError(_t(`products.adjust.errors.${result.reason}`));
            }
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog open={product !== null} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{_t("products.adjust.title")}</DialogTitle>
                    <DialogDescription>
                        {product?.name} · {_t("products.adjust.current")}: {current} {product?.unit}
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={submit} className="space-y-4" noValidate>
                    <div className="space-y-1.5">
                        <Label htmlFor="adj-reason">{_t("products.adjust.kind")}</Label>
                        <Select value={reason} onValueChange={(v) => setReason(v as Reason)}>
                            <SelectTrigger id="adj-reason"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="purchase">{_t("products.adjust.purchase")}</SelectItem>
                                <SelectItem value="add">{_t("products.adjust.add")}</SelectItem>
                                <SelectItem value="remove">{_t("products.adjust.remove")}</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="adj-qty">{_t("products.adjust.quantity")}</Label>
                        <Input id="adj-qty" name="quantity" inputMode="decimal" value={qty} onChange={(e) => { setQty(e.target.value); setError(null); }} autoFocus aria-invalid={!!error} />
                        {valid && <p className="text-xs text-muted-foreground">{_t("products.adjust.result", { count: round3(current + signed) })}</p>}
                        {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="adj-note">{_t("products.adjust.note")}</Label>
                        <Input id="adj-note" name="note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder={_t("products.adjust.notePlaceholder")} />
                    </div>
                    <div className="flex justify-end gap-2">
                        <BaseButton type="button" variant="ghost" onClick={onClose}>{_t("products.form.cancel")}</BaseButton>
                        <BaseButton type="submit" disabled={busy}>{_t("products.adjust.apply")}</BaseButton>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
};

/** Every movement for one product, newest first, with the running balance. */
export const StockHistoryDialog = ({
    product,
    movements,
    onClose,
}: {
    product: Product | null;
    movements: StockMovement[];
    onClose: () => void;
}) => {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const rows = useMemo(() => (product ? historyOf(product.id, movements).reverse() : []), [product, movements]);

    return (
        <Dialog open={product !== null} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{_t("products.history.title")}</DialogTitle>
                    <DialogDescription>{product?.name}</DialogDescription>
                </DialogHeader>
                {rows.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">{_t("products.history.empty")}</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[28rem] text-sm" data-testid="stock-history">
                            <thead className="text-xs text-muted-foreground">
                                <tr>
                                    <th className="py-2 text-start font-medium">{_t("products.history.date")}</th>
                                    <th className="py-2 text-start font-medium">{_t("products.history.movement")}</th>
                                    <th className="py-2 text-end font-medium">{_t("products.history.change")}</th>
                                    <th className="py-2 text-end font-medium">{_t("products.history.balance")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((r) => (
                                    <tr key={r.id} className="border-t">
                                        <td className="py-2 pe-3 whitespace-nowrap text-muted-foreground">
                                            {new Date(r.date).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" })}
                                        </td>
                                        <td className="py-2 pe-3">
                                            {_t(`products.history.kinds.${r.kind}`)}
                                            {r.invoiceNumber && <span className="ms-2 text-xs text-muted-foreground">{_t("products.history.invoice", { number: r.invoiceNumber })}</span>}
                                            {r.note && <span className="ms-2 text-xs text-muted-foreground">{r.note}</span>}
                                        </td>
                                        <td className={`py-2 text-end tabular-nums ${r.qty < 0 ? "text-destructive" : "text-emerald-600 dark:text-emerald-400"}`}>
                                            {r.qty > 0 ? "+" : ""}
                                            {r.qty}
                                        </td>
                                        <td className="py-2 text-end tabular-nums">{r.balance}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
};
