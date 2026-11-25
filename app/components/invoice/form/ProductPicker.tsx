"use client";

import { useMemo, useState } from "react";
import { useFormContext, useWatch } from "react-hook-form";

import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import BaseButton from "@/app/components/reusables/BaseButton";

import { useInventoryData } from "@/contexts/useInventoryData";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { appliedConsumption, isTracked, round3, stockLevels, type Product } from "@/lib/products";

import { Link2Off, Package } from "lucide-react";

/**
 * Fills an invoice line from the catalogue and links it to the product, so
 * issuing the invoice can update stock. Lines left unlinked behave exactly as
 * they always did.
 *
 * It also answers "can I actually sell this much?" while you type, using the
 * ledger plus whatever this very invoice has already taken.
 */
const ProductPicker = ({ name, index }: { name: string; index: number }) => {
    const { control, setValue, getValues } = useFormContext();
    const { _t } = useTranslationContext();
    const { products, movements, loaded } = useInventoryData();
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");

    const productId = useWatch({ control, name: `${name}[${index}].productId` }) as string | undefined;
    const quantity = Number(useWatch({ control, name: `${name}[${index}].quantity` })) || 0;
    const invoiceNumber = useWatch({ control, name: "details.invoiceNumber" }) as string | undefined;

    const linked = products.find((p) => p.id === productId);

    const choices = useMemo(() => {
        const needle = search.trim().toLowerCase();
        return products
            .filter((p) => !p.archived)
            .filter((p) => !needle || [p.name, p.sku, p.category, p.hsn].join(" ").toLowerCase().includes(needle))
            .sort((a, b) => a.name.localeCompare(b.name))
            .slice(0, 50);
    }, [products, search]);

    const pick = (p: Product) => {
        const path = `${name}[${index}]`;
        const opts = { shouldDirty: true, shouldValidate: true };
        setValue(`${path}.productId`, p.id, opts);
        setValue(`${path}.name`, p.name, opts);
        setValue(`${path}.description`, p.description, opts);
        setValue(`${path}.unitPrice`, p.sellingPrice, opts);
        setValue(`${path}.unit`, p.unit, opts);
        // HSN and rate are only meaningful on a GST invoice, but carrying them
        // costs nothing and saves retyping if GST is switched on later.
        setValue(`${path}.hsn`, p.hsn, opts);
        setValue(`${path}.gstRate`, p.taxRate, opts);
        if (!Number(getValues(`${path}.quantity`))) setValue(`${path}.quantity`, 1, opts);
        setOpen(false);
        setSearch("");
    };

    const unlink = () => {
        setValue(`${name}[${index}].productId`, undefined, { shouldDirty: true });
        setValue(`${name}[${index}].unit`, undefined, { shouldDirty: true });
    };

    // Stock this line could draw on: what is on hand, plus what this invoice
    // already took (so an issued invoice is not blocked by its own deduction).
    const stock = useMemo(() => {
        if (!linked || !isTracked(linked)) return null;
        const onHand = stockLevels(movements).get(linked.id) ?? 0;
        const own = invoiceNumber ? appliedConsumption(movements).get(`${invoiceNumber}\u0000${linked.id}`) ?? 0 : 0;
        return round3(onHand + own);
    }, [linked, movements, invoiceNumber]);

    return (
        <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
                <Popover open={open} onOpenChange={setOpen}>
                    <PopoverTrigger asChild>
                        <BaseButton type="button" variant="outline" size="sm" className="h-8" data-testid="pick-product">
                            <Package className="h-3.5 w-3.5" />
                            {linked ? linked.name : _t("inventory.pick")}
                        </BaseButton>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-80 p-2">
                        <Input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder={_t("inventory.pickSearch")}
                            aria-label={_t("inventory.pickSearch")}
                            className="mb-2 h-9"
                        />
                        {!loaded ? null : products.filter((p) => !p.archived).length === 0 ? (
                            <p className="px-2 py-3 text-sm text-muted-foreground">{_t("inventory.pickEmpty")}</p>
                        ) : choices.length === 0 ? (
                            <p className="px-2 py-3 text-sm text-muted-foreground">{_t("inventory.pickNone")}</p>
                        ) : (
                            <ul className="max-h-64 overflow-y-auto" role="listbox">
                                {choices.map((p) => {
                                    const level = stockLevels(movements).get(p.id) ?? 0;
                                    return (
                                        <li key={p.id}>
                                            <button
                                                type="button"
                                                role="option"
                                                aria-selected={p.id === productId}
                                                onClick={() => pick(p)}
                                                className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-start text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                                            >
                                                <span className="min-w-0">
                                                    <span className="block truncate font-medium">{p.name}</span>
                                                    <span className="block truncate text-xs text-muted-foreground">
                                                        {[p.sku, p.sellingPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })].filter(Boolean).join(" · ")}
                                                    </span>
                                                </span>
                                                <span className="shrink-0 text-xs text-muted-foreground">
                                                    {isTracked(p) ? `${level} ${p.unit}` : _t("products.types.service")}
                                                </span>
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </PopoverContent>
                </Popover>

                {linked && (
                    <BaseButton type="button" variant="ghost" size="sm" className="h-8 text-muted-foreground" onClick={unlink} aria-label={_t("inventory.clear")}>
                        <Link2Off className="h-3.5 w-3.5" />
                        {_t("inventory.clear")}
                    </BaseButton>
                )}
            </div>

            {linked && stock === null && <p className="text-xs text-muted-foreground">{_t("inventory.service")}</p>}
            {linked && stock !== null && (
                <p
                    className={`text-xs ${quantity > stock ? "font-medium text-destructive" : "text-muted-foreground"}`}
                    role={quantity > stock ? "alert" : undefined}
                    data-testid="stock-hint"
                >
                    {quantity > stock
                        ? _t("inventory.notEnough", { count: stock, unit: linked.unit })
                        : quantity > 0
                          ? `${_t("inventory.inStock", { count: stock, unit: linked.unit })} · ${_t("inventory.willRemain", { count: round3(stock - quantity), unit: linked.unit })}`
                          : _t("inventory.inStock", { count: stock, unit: linked.unit })}
                </p>
            )}
        </div>
    );
};

export default ProductPicker;
