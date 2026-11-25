"use client";

import { useEffect, useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/use-toast";
import BaseButton from "@/app/components/reusables/BaseButton";

import { useTranslationContext } from "@/contexts/TranslationContext";
import { GST_RATES } from "@/lib/gst";
import { saveProduct } from "@/lib/inventory";
import { isTracked, stockOf, type Product, type ProductErrors, type ProductType, type StockMovement } from "@/lib/products";

type Form = {
    name: string;
    type: ProductType;
    sku: string;
    category: string;
    description: string;
    unit: string;
    sellingPrice: string;
    purchasePrice: string;
    taxRate: string;
    hsn: string;
    trackStock: boolean;
    openingStock: string;
    minStock: string;
};

const EMPTY: Form = {
    name: "",
    type: "product",
    sku: "",
    category: "",
    description: "",
    unit: "pcs",
    sellingPrice: "",
    purchasePrice: "",
    taxRate: "18",
    hsn: "",
    trackStock: true,
    openingStock: "",
    minStock: "",
};

const fromProduct = (p: Product): Form => ({
    name: p.name,
    type: p.type,
    sku: p.sku,
    category: p.category,
    description: p.description,
    unit: p.unit,
    sellingPrice: String(p.sellingPrice || ""),
    purchasePrice: String(p.purchasePrice || ""),
    taxRate: String(p.taxRate),
    hsn: p.hsn,
    trackStock: isTracked(p),
    openingStock: "",
    minStock: p.minStock ? String(p.minStock) : "",
});

type Props = {
    /** `null` = closed, `"new"` = create, otherwise edit that product. */
    target: Product | "new" | null;
    onClose: () => void;
    categories: string[];
    movements: StockMovement[];
};

const ProductFormDialog = ({ target, onClose, categories, movements }: Props) => {
    const { _t } = useTranslationContext();
    const [form, setForm] = useState<Form>(EMPTY);
    const [errors, setErrors] = useState<ProductErrors>({});
    const [saving, setSaving] = useState(false);

    const editing = target && target !== "new" ? target : null;

    useEffect(() => {
        if (target === null) return;
        setForm(target === "new" ? EMPTY : fromProduct(target));
        setErrors({});
    }, [target]);

    const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (saving) return;
        setSaving(true);
        try {
            const result = await saveProduct(form, editing?.id);
            if ("errors" in result) {
                setErrors(result.errors);
                return;
            }
            if ("storage" in result) {
                toast({ variant: "destructive", title: _t("products.toast.storage") });
                return;
            }
            toast({ title: _t("products.toast.saved"), description: result.product.name });
            onClose();
        } finally {
            setSaving(false);
        }
    };

    const err = (key: keyof ProductErrors) =>
        errors[key] ? (
            <p className="text-xs text-destructive" role="alert">
                {_t(`products.errors.${errors[key]}`)}
            </p>
        ) : null;

    const isService = form.type === "service";

    return (
        <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{editing ? _t("products.edit") : _t("products.add")}</DialogTitle>
                    <DialogDescription>{editing ? editing.name : _t("products.subtitle")}</DialogDescription>
                </DialogHeader>

                <form onSubmit={submit} className="grid grid-cols-1 gap-4 sm:grid-cols-2" noValidate>
                    <div className="space-y-1.5 sm:col-span-2">
                        <Label htmlFor="pf-name">{_t("products.form.name")}</Label>
                        <Input id="pf-name" name="name" value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={120} autoFocus aria-invalid={!!errors.name} />
                        {err("name")}
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="pf-type">{_t("products.form.type")}</Label>
                        <Select
                            value={form.type}
                            onValueChange={(v) => {
                                const type = v as ProductType;
                                setForm((f) => ({ ...f, type, trackStock: type === "product" ? f.trackStock : false, unit: f.unit === "pcs" && type === "service" ? "hr" : f.unit === "hr" && type === "product" ? "pcs" : f.unit }));
                            }}
                            // A product that has stock history keeps its type: turning it
                            // into a service would orphan the ledger.
                            disabled={!!editing && stockOf(editing.id, movements) !== 0}
                        >
                            <SelectTrigger id="pf-type"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="product">{_t("products.types.product")}</SelectItem>
                                <SelectItem value="service">{_t("products.types.service")}</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="pf-sku">{_t("products.form.sku")}</Label>
                        <Input id="pf-sku" name="sku" value={form.sku} onChange={(e) => set("sku", e.target.value.toUpperCase())} maxLength={40} aria-invalid={!!errors.sku} />
                        {err("sku") ?? <p className="text-xs text-muted-foreground">{_t("products.form.skuHint")}</p>}
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="pf-category">{_t("products.form.category")}</Label>
                        <Input id="pf-category" name="category" list="pf-categories" value={form.category} onChange={(e) => set("category", e.target.value)} maxLength={60} />
                        <datalist id="pf-categories">
                            {categories.map((c) => (
                                <option key={c} value={c} />
                            ))}
                        </datalist>
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="pf-unit">{_t("products.form.unit")}</Label>
                        <Input id="pf-unit" name="unit" value={form.unit} onChange={(e) => set("unit", e.target.value)} maxLength={20} />
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="pf-sell">{_t("products.form.sellingPrice")}</Label>
                        <Input id="pf-sell" name="sellingPrice" inputMode="decimal" value={form.sellingPrice} onChange={(e) => set("sellingPrice", e.target.value)} aria-invalid={!!errors.sellingPrice} />
                        {err("sellingPrice")}
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="pf-buy">{_t("products.form.purchasePrice")}</Label>
                        <Input id="pf-buy" name="purchasePrice" inputMode="decimal" value={form.purchasePrice} onChange={(e) => set("purchasePrice", e.target.value)} aria-invalid={!!errors.purchasePrice} />
                        {err("purchasePrice")}
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="pf-rate">{_t("products.form.taxRate")}</Label>
                        <Input id="pf-rate" name="taxRate" inputMode="decimal" list="pf-rates" value={form.taxRate} onChange={(e) => set("taxRate", e.target.value)} aria-invalid={!!errors.taxRate} />
                        <datalist id="pf-rates">
                            {GST_RATES.map((r) => (
                                <option key={r} value={String(r)} />
                            ))}
                        </datalist>
                        {err("taxRate")}
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="pf-hsn">{_t("products.form.hsn")}</Label>
                        <Input id="pf-hsn" name="hsn" inputMode="numeric" value={form.hsn} onChange={(e) => set("hsn", e.target.value.replace(/\D/g, "").slice(0, 8))} aria-invalid={!!errors.hsn} />
                        {err("hsn")}
                    </div>

                    <div className="space-y-1.5 sm:col-span-2">
                        <Label htmlFor="pf-desc">{_t("products.form.description")}</Label>
                        <Textarea id="pf-desc" name="description" value={form.description} onChange={(e) => set("description", e.target.value)} maxLength={500} rows={2} />
                    </div>

                    {!isService && (
                        <fieldset className="space-y-3 rounded-lg border p-3 sm:col-span-2">
                            <div className="flex items-center justify-between gap-3">
                                <Label htmlFor="pf-track">{_t("products.form.trackStock")}</Label>
                                <Switch id="pf-track" checked={form.trackStock} onCheckedChange={(v) => set("trackStock", v)} />
                            </div>

                            {form.trackStock && (
                                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                    {!editing && (
                                        <div className="space-y-1.5">
                                            <Label htmlFor="pf-open">{_t("products.form.openingStock")}</Label>
                                            <Input id="pf-open" name="openingStock" inputMode="decimal" value={form.openingStock} onChange={(e) => set("openingStock", e.target.value)} aria-invalid={!!errors.openingStock} />
                                            {err("openingStock") ?? <p className="text-xs text-muted-foreground">{_t("products.form.openingHint")}</p>}
                                        </div>
                                    )}
                                    <div className="space-y-1.5">
                                        <Label htmlFor="pf-min">{_t("products.form.minStock")}</Label>
                                        <Input id="pf-min" name="minStock" inputMode="decimal" value={form.minStock} onChange={(e) => set("minStock", e.target.value)} aria-invalid={!!errors.minStock} />
                                        {err("minStock") ?? <p className="text-xs text-muted-foreground">{_t("products.form.minHint")}</p>}
                                    </div>
                                    {editing && <p className="text-xs text-muted-foreground sm:col-span-2">{_t("products.form.stockNote")}</p>}
                                </div>
                            )}
                        </fieldset>
                    )}

                    <div className="flex justify-end gap-2 sm:col-span-2">
                        <BaseButton type="button" variant="ghost" onClick={onClose}>
                            {_t("products.form.cancel")}
                        </BaseButton>
                        <BaseButton type="submit" disabled={saving}>
                            {_t("products.form.save")}
                        </BaseButton>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
};

export default ProductFormDialog;
