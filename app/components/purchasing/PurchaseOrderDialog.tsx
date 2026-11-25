"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale } from "next-intl";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/use-toast";
import BaseButton from "@/app/components/reusables/BaseButton";
import Field from "@/app/components/reusables/Field";
import NativeSelect from "@/app/components/reusables/NativeSelect";

import { useTranslationContext } from "@/contexts/TranslationContext";
import { GST_RATES } from "@/lib/gst";
import { formatMoney } from "@/lib/invoiceRecords";
import { toDay } from "@/lib/expenses";
import { lowStockProducts, round3 as qty3, type Product, type StockMovement } from "@/lib/products";
import { changePurchaseOrderStatus, savePurchaseOrder, type SavePoInput } from "@/lib/purchaseOrderStore";
import {
    hasErrors,
    poTotals,
    round2,
    snapshotOf,
    termsText,
    validatePurchaseOrder,
    type PoDraft,
    type PoErrors,
    type PoLine,
    type PurchaseOrder,
} from "@/lib/purchaseOrders";
import { newId } from "@/lib/repository";
import type { BusinessProfile } from "@/lib/settings";
import { businessState, type Supplier } from "@/lib/suppliers";

import { Package, PackagePlus, Plus, Trash2 } from "lucide-react";

/** A line as typed: numbers stay strings so "1." and "" are legal while typing. */
type FormLine = Omit<PoLine, "quantity" | "unitPrice" | "taxRate"> & { quantity: string; unitPrice: string; taxRate: string };

type FormState = {
    number: string;
    supplierId: string;
    date: string;
    expectedDate: string;
    currency: string;
    gstEnabled: boolean;
    lines: FormLine[];
    discountType: "amount" | "percentage";
    discountValue: string;
    freight: string;
    paymentTerms: string;
    notes: string;
    terms: string;
};

const parse = (s: string) => {
    const n = parseFloat(String(s).replace(/,/g, ""));
    return Number.isFinite(n) ? n : 0;
};

const toPoLine = (l: FormLine): PoLine => ({
    id: l.id,
    ...(l.productId ? { productId: l.productId } : {}),
    name: l.name.trim(),
    description: l.description.trim(),
    hsn: l.hsn.replace(/\D/g, ""),
    unit: l.unit.trim() || "pcs",
    quantity: qty3(parse(l.quantity)),
    unitPrice: round2(parse(l.unitPrice)),
    taxRate: parse(l.taxRate),
});

const toFormLine = (l: PoLine): FormLine => ({ ...l, quantity: String(l.quantity), unitPrice: String(l.unitPrice), taxRate: String(l.taxRate) });

const blankLine = (): FormLine => ({ id: newId("line"), name: "", description: "", hsn: "", unit: "pcs", quantity: "1", unitPrice: "", taxRate: "18" });

const lineFromProduct = (p: Product, quantity = 1): FormLine => ({
    id: newId("line"),
    productId: p.id,
    name: p.name,
    description: "",
    hsn: p.hsn,
    unit: p.unit,
    quantity: String(quantity),
    // What you pay is the purchase price; the selling price is what you charge.
    unitPrice: String(p.purchasePrice || ""),
    taxRate: String(p.taxRate),
});

const initialState = (order: PurchaseOrder | null, supplier: Supplier | null, defaultCurrency: string): FormState =>
    order
        ? {
              number: order.number,
              supplierId: order.supplierId,
              date: order.date,
              expectedDate: order.expectedDate,
              currency: order.currency,
              gstEnabled: order.gstEnabled,
              lines: order.lines.map(toFormLine),
              discountType: order.discount.type,
              discountValue: order.discount.value ? String(order.discount.value) : "",
              freight: order.freight ? String(order.freight) : "",
              paymentTerms: order.paymentTerms,
              notes: order.notes,
              terms: order.terms,
          }
        : {
              number: "",
              supplierId: supplier?.id ?? "",
              date: toDay(new Date()),
              expectedDate: "",
              currency: supplier?.currency ?? defaultCurrency,
              gstEnabled: true,
              lines: [blankLine()],
              discountType: "amount",
              discountValue: "",
              freight: "",
              paymentTerms: supplier ? termsText(supplier.paymentTermsDays) : "",
              notes: "",
              terms: "",
          };

const PurchaseOrderDialog = ({
    open,
    order,
    initialSupplierId,
    suppliers,
    orders,
    products,
    movements,
    business,
    prefix,
    onClose,
}: {
    open: boolean;
    /** null creates a new order. */
    order: PurchaseOrder | null;
    initialSupplierId?: string;
    suppliers: Supplier[];
    orders: PurchaseOrder[];
    products: Product[];
    movements: StockMovement[];
    business: BusinessProfile;
    prefix: string;
    onClose: (saved?: PurchaseOrder) => void;
}) => {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const [form, setForm] = useState<FormState>(() => initialState(null, null, "INR"));
    const [errors, setErrors] = useState<PoErrors>({ lineErrors: {} });
    const [busy, setBusy] = useState(false);

    const selectable = useMemo(
        () => suppliers.filter((s) => !s.inactive || s.id === order?.supplierId).sort((a, b) => a.name.localeCompare(b.name)),
        [suppliers, order]
    );
    const activeProducts = useMemo(() => products.filter((p) => !p.archived).sort((a, b) => a.name.localeCompare(b.name)), [products]);

    useEffect(() => {
        if (!open) return;
        const preset = suppliers.find((s) => s.id === initialSupplierId) ?? null;
        setForm(initialState(order, preset, "INR"));
        setErrors({ lineErrors: {} });
    }, [open, order, initialSupplierId, suppliers]);

    const supplier = suppliers.find((s) => s.id === form.supplierId) ?? null;
    // An edited order keeps the supplier details it was written with, unless the supplier was changed.
    const supplierForTax = order && order.supplierId === form.supplierId ? order.supplier : supplier ? snapshotOf(supplier) : null;

    const lines = useMemo(() => form.lines.map(toPoLine), [form.lines]);
    const discount = useMemo(() => ({ type: form.discountType, value: round2(parse(form.discountValue)) }), [form.discountType, form.discountValue]);
    const freight = round2(parse(form.freight));
    const buyerState = businessState(business);

    const totals = useMemo(
        () => poTotals({ lines, discount, freight, gstEnabled: form.gstEnabled, currency: form.currency, supplier: supplierForTax ?? { state: "", gstin: "" } }, buyerState),
        [lines, discount, freight, form.gstEnabled, form.currency, supplierForTax, buyerState]
    );
    const money = (n: number) => formatMoney(n, form.currency || "INR", locale);

    const patch = (p: Partial<FormState>) => setForm((f) => ({ ...f, ...p }));
    const patchLine = (id: string, p: Partial<FormLine>) => {
        setForm((f) => ({ ...f, lines: f.lines.map((l) => (l.id === id ? { ...l, ...p } : l)) }));
        setErrors((e) => ({ ...e, lines: undefined, lineErrors: { ...e.lineErrors, [id]: {} } }));
    };

    const chooseSupplier = (id: string) => {
        const s = suppliers.find((x) => x.id === id);
        // Currency and terms follow the supplier, but never clobber text the user already edited on an existing order.
        patch({ supplierId: id, ...(s && !order ? { currency: s.currency, paymentTerms: termsText(s.paymentTermsDays) } : {}) });
        setErrors((e) => ({ ...e, supplier: undefined }));
    };

    const addProduct = (id: string) => {
        const p = activeProducts.find((x) => x.id === id);
        if (!p) return;
        setForm((f) => ({ ...f, lines: [...f.lines.filter((l) => l.name.trim() || l.unitPrice), lineFromProduct(p)] }));
        setErrors((e) => ({ ...e, lines: undefined }));
    };

    const addLowStock = () => {
        const low = lowStockProducts(products, movements);
        if (low.length === 0) {
            toast({ title: _t("purchaseOrders.form.noLowStock") });
            return;
        }
        const onOrder = new Set(form.lines.map((l) => l.productId));
        const added = low.filter(({ product }) => !onOrder.has(product.id));
        // Restock to twice the minimum: enough to get clear of the alert, not a guess at demand.
        const next = added.map(({ product, stock }) => lineFromProduct(product, Math.max(1, qty3(product.minStock * 2 - stock))));
        setForm((f) => ({ ...f, lines: [...f.lines.filter((l) => l.name.trim() || l.unitPrice), ...next] }));
        setErrors((e) => ({ ...e, lines: undefined }));
        toast({ title: _t("purchaseOrders.form.lowStockAdded", { count: next.length }) });
    };

    const submit = async (andSend: boolean) => {
        const draft: PoDraft = { number: form.number, supplierId: form.supplierId, date: form.date, expectedDate: form.expectedDate, currency: form.currency, lines, discount, freight, gstEnabled: form.gstEnabled };
        const found = validatePurchaseOrder(draft, suppliers, orders, order?.id);
        if (hasErrors(found)) {
            setErrors(found);
            return;
        }
        setBusy(true);
        const input: SavePoInput = { ...draft, paymentTerms: form.paymentTerms, notes: form.notes, terms: form.terms, prefix };
        const result = await savePurchaseOrder(input, order?.id);
        if (!result.ok) {
            setBusy(false);
            if ("errors" in result) setErrors(result.errors);
            else toast({ variant: "destructive", title: _t(result.reason === "limit" ? "purchaseOrders.toast.limit" : result.reason === "notEditable" ? "purchaseOrders.toast.notAllowed" : "purchaseOrders.toast.storage") });
            return;
        }
        let saved = result.order;
        if (andSend && saved.status === "draft") {
            const sent = await changePurchaseOrderStatus(saved.id, "sent");
            if (sent.ok) saved = sent.order;
        }
        setBusy(false);
        toast({ title: _t("purchaseOrders.toast.saved", { number: saved.number }) });
        onClose(saved);
    };

    const rateOptions = (current: string) => {
        const set = new Set<number>(GST_RATES);
        const cur = parse(current);
        if (current !== "" && Number.isFinite(cur)) set.add(cur);
        return [...set].sort((a, b) => a - b);
    };
    const e = (k: "supplier" | "date" | "expectedDate" | "number" | "currency" | "discount" | "freight") => (errors[k] ? _t(`purchaseOrders.errors.${errors[k]}`) : undefined);
    const canSend = !order || order.status === "draft";

    return (
        <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-h-[94dvh] max-w-4xl overflow-y-auto" data-testid="po-dialog">
                <DialogHeader>
                    <DialogTitle>{order ? _t("purchaseOrders.form.titleEdit", { number: order.number }) : _t("purchaseOrders.form.titleNew")}</DialogTitle>
                    <DialogDescription className="sr-only">{_t("purchaseOrders.subtitle")}</DialogDescription>
                </DialogHeader>

                <form
                    className="space-y-6"
                    noValidate
                    onSubmit={(ev) => {
                        ev.preventDefault();
                        void submit(false);
                    }}
                >
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                        <Field id="po-supplier" label={_t("purchaseOrders.form.supplier")} error={e("supplier")} className="sm:col-span-2">
                            <NativeSelect id="po-supplier" data-testid="po-supplier" value={form.supplierId} aria-invalid={!!errors.supplier} onChange={(ev) => chooseSupplier(ev.target.value)}>
                                <option value="">{_t("purchaseOrders.form.selectSupplier")}</option>
                                {selectable.map((s) => (
                                    <option key={s.id} value={s.id}>
                                        {s.name}
                                    </option>
                                ))}
                            </NativeSelect>
                        </Field>
                        <Field id="po-date" label={_t("purchaseOrders.form.date")} error={e("date")}>
                            <Input id="po-date" data-testid="po-date" type="date" value={form.date} aria-invalid={!!errors.date} onChange={(ev) => patch({ date: ev.target.value })} />
                        </Field>
                        <Field id="po-expected" label={_t("purchaseOrders.form.expected")} error={e("expectedDate")}>
                            <Input id="po-expected" data-testid="po-expected" type="date" value={form.expectedDate} min={form.date} aria-invalid={!!errors.expectedDate} onChange={(ev) => patch({ expectedDate: ev.target.value })} />
                        </Field>
                        <Field id="po-number" label={_t("purchaseOrders.form.number")} error={e("number")} hint={order ? undefined : _t("purchaseOrders.form.numberHint")}>
                            <Input id="po-number" data-testid="po-number" value={form.number} maxLength={40} aria-invalid={!!errors.number} onChange={(ev) => patch({ number: ev.target.value })} />
                        </Field>
                        <Field id="po-currency" label={_t("purchaseOrders.form.currency")} error={e("currency")}>
                            <Input id="po-currency" value={form.currency} maxLength={3} className="uppercase" aria-invalid={!!errors.currency} onChange={(ev) => patch({ currency: ev.target.value.toUpperCase() })} />
                        </Field>
                        <div className="flex items-end gap-3 pb-2 sm:col-span-2">
                            <Switch id="po-gst" checked={form.gstEnabled} onCheckedChange={(v) => patch({ gstEnabled: v })} />
                            <label htmlFor="po-gst" className="text-sm font-medium">
                                {_t("purchaseOrders.form.gst")}
                            </label>
                        </div>
                    </div>

                    <section aria-labelledby="po-items-title" className="space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 id="po-items-title" className="text-sm font-semibold">
                                {_t("purchaseOrders.form.items")}
                            </h3>
                            <div className="flex flex-wrap items-center gap-2">
                                <NativeSelect className="h-9 w-48" aria-label={_t("purchaseOrders.form.addProduct")} data-testid="po-add-product" value="" onChange={(ev) => addProduct(ev.target.value)} disabled={activeProducts.length === 0}>
                                    <option value="">{_t("purchaseOrders.form.pickProduct")}</option>
                                    {activeProducts.map((p) => (
                                        <option key={p.id} value={p.id}>
                                            {p.name}
                                            {p.sku ? ` (${p.sku})` : ""}
                                        </option>
                                    ))}
                                </NativeSelect>
                                <BaseButton variant="outline" size="sm" className="h-9" onClick={addLowStock} data-testid="po-add-lowstock">
                                    <PackagePlus className="h-4 w-4" />
                                    {_t("purchaseOrders.form.addLowStock")}
                                </BaseButton>
                                <BaseButton variant="outline" size="sm" className="h-9" onClick={() => patch({ lines: [...form.lines, blankLine()] })} data-testid="po-add-line">
                                    <Plus className="h-4 w-4" />
                                    {_t("purchaseOrders.form.addLine")}
                                </BaseButton>
                            </div>
                        </div>
                        {errors.lines && (
                            <p role="alert" className="text-sm font-medium text-destructive">
                                {_t(`purchaseOrders.errors.${errors.lines}`)}
                            </p>
                        )}

                        <ul className="space-y-3">
                            {form.lines.map((l, i) => {
                                const le = errors.lineErrors[l.id] ?? {};
                                const msg = (k: keyof typeof le) => (le[k] ? _t(`purchaseOrders.errors.${le[k]}`) : undefined);
                                const amount = round2(qty3(parse(l.quantity)) * round2(parse(l.unitPrice)));
                                return (
                                    <li key={l.id} className="rounded-lg border bg-muted/20 p-3" data-testid="po-line">
                                        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                                            <Field id={`po-name-${i}`} label={_t("purchaseOrders.form.itemName")} error={msg("name")}>
                                                <div className="relative">
                                                    {l.productId && <Package className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />}
                                                    <Input id={`po-name-${i}`} data-testid="po-line-name" className={l.productId ? "ps-9" : ""} value={l.name} maxLength={120} aria-invalid={!!le.name} onChange={(ev) => patchLine(l.id, { name: ev.target.value })} />
                                                </div>
                                            </Field>
                                            <div className="flex items-end justify-end">
                                                <BaseButton variant="ghost" size="icon" className="h-10 w-10 text-destructive hover:text-destructive" aria-label={`${_t("purchaseOrders.form.remove")} ${i + 1}`} onClick={() => patch({ lines: form.lines.length > 1 ? form.lines.filter((x) => x.id !== l.id) : [blankLine()] })}>
                                                    <Trash2 className="h-4 w-4" />
                                                </BaseButton>
                                            </div>
                                        </div>
                                        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-6">
                                            <Field id={`po-hsn-${i}`} label={_t("purchaseOrders.form.hsn")} error={msg("hsn")}>
                                                <Input id={`po-hsn-${i}`} inputMode="numeric" maxLength={8} value={l.hsn} aria-invalid={!!le.hsn} onChange={(ev) => patchLine(l.id, { hsn: ev.target.value.replace(/\D/g, "") })} />
                                            </Field>
                                            <Field id={`po-qty-${i}`} label={`${_t("purchaseOrders.form.qty")} (${l.unit})`} error={msg("quantity")}>
                                                <Input id={`po-qty-${i}`} data-testid="po-line-qty" type="number" min={0} step="any" inputMode="decimal" value={l.quantity} aria-invalid={!!le.quantity} onChange={(ev) => patchLine(l.id, { quantity: ev.target.value })} />
                                            </Field>
                                            <Field id={`po-price-${i}`} label={_t("purchaseOrders.form.price")} error={msg("unitPrice")}>
                                                <Input id={`po-price-${i}`} data-testid="po-line-price" type="number" min={0} step="0.01" inputMode="decimal" value={l.unitPrice} aria-invalid={!!le.unitPrice} onChange={(ev) => patchLine(l.id, { unitPrice: ev.target.value })} />
                                            </Field>
                                            <Field id={`po-rate-${i}`} label={_t("purchaseOrders.form.rate")} error={msg("taxRate")}>
                                                <NativeSelect id={`po-rate-${i}`} data-testid="po-line-rate" value={l.taxRate} disabled={!form.gstEnabled} aria-invalid={!!le.taxRate} onChange={(ev) => patchLine(l.id, { taxRate: ev.target.value })}>
                                                    {rateOptions(l.taxRate).map((r) => (
                                                        <option key={r} value={String(r)}>
                                                            {r}%
                                                        </option>
                                                    ))}
                                                </NativeSelect>
                                            </Field>
                                            <Field id={`po-unit-${i}`} label={_t("purchaseOrders.form.unit")}>
                                                <Input id={`po-unit-${i}`} value={l.unit} maxLength={20} onChange={(ev) => patchLine(l.id, { unit: ev.target.value })} />
                                            </Field>
                                            <div className="space-y-1.5">
                                                <p className="text-sm font-medium leading-none">{_t("purchaseOrders.form.amount")}</p>
                                                <p className="flex h-10 items-center text-sm font-semibold tabular-nums" data-testid="po-line-amount">
                                                    {money(amount)}
                                                </p>
                                            </div>
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    </section>

                    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
                        <div className="space-y-4">
                            <div className="grid gap-4 sm:grid-cols-2">
                                <Field id="po-discount" label={_t("purchaseOrders.form.discount")} error={e("discount")}>
                                    <div className="flex gap-2">
                                        <Input id="po-discount" type="number" min={0} step="0.01" inputMode="decimal" value={form.discountValue} aria-invalid={!!errors.discount} onChange={(ev) => patch({ discountValue: ev.target.value })} />
                                        <NativeSelect className="w-24" aria-label={_t("purchaseOrders.form.discount")} value={form.discountType} onChange={(ev) => patch({ discountType: ev.target.value as FormState["discountType"] })}>
                                            <option value="amount">{_t("purchaseOrders.form.discountAmount")}</option>
                                            <option value="percentage">{_t("purchaseOrders.form.discountPercent")}</option>
                                        </NativeSelect>
                                    </div>
                                </Field>
                                <Field id="po-freight" label={_t("purchaseOrders.form.freight")} error={e("freight")}>
                                    <Input id="po-freight" type="number" min={0} step="0.01" inputMode="decimal" value={form.freight} aria-invalid={!!errors.freight} onChange={(ev) => patch({ freight: ev.target.value })} />
                                </Field>
                                <Field id="po-terms-pay" label={_t("purchaseOrders.form.paymentTerms")} className="sm:col-span-2">
                                    <Input id="po-terms-pay" value={form.paymentTerms} maxLength={200} onChange={(ev) => patch({ paymentTerms: ev.target.value })} />
                                </Field>
                            </div>
                            <Field id="po-notes" label={_t("purchaseOrders.form.notes")}>
                                <Textarea id="po-notes" rows={2} maxLength={2000} value={form.notes} onChange={(ev) => patch({ notes: ev.target.value })} />
                            </Field>
                            <Field id="po-terms" label={_t("purchaseOrders.form.terms")}>
                                <Textarea id="po-terms" rows={2} maxLength={2000} value={form.terms} onChange={(ev) => patch({ terms: ev.target.value })} />
                            </Field>
                        </div>

                        <aside className="h-fit space-y-2 rounded-xl border bg-card p-4 text-sm shadow-sm" aria-label={_t("purchaseOrders.form.totals.total")} data-testid="po-totals">
                            <Row label={_t("purchaseOrders.form.totals.subtotal")} value={money(totals.subTotal)} />
                            {totals.discountAmount > 0 && <Row label={_t("purchaseOrders.form.totals.discount")} value={`− ${money(totals.discountAmount)}`} />}
                            {form.gstEnabled && (
                                <>
                                    <Row label={_t("purchaseOrders.form.totals.taxable")} value={money(totals.taxableValue)} />
                                    {totals.supply === "intra" ? (
                                        <>
                                            <Row label={_t("purchaseOrders.form.totals.cgst")} value={money(totals.cgst)} testId="po-cgst" />
                                            <Row label={_t("purchaseOrders.form.totals.sgst")} value={money(totals.sgst)} testId="po-sgst" />
                                        </>
                                    ) : (
                                        <Row label={_t("purchaseOrders.form.totals.igst")} value={money(totals.igst)} testId="po-igst" />
                                    )}
                                </>
                            )}
                            {totals.shippingAmount > 0 && <Row label={_t("purchaseOrders.form.totals.freight")} value={money(totals.shippingAmount)} />}
                            <div className="flex items-baseline justify-between border-t pt-2 text-base font-semibold">
                                <span>{_t("purchaseOrders.form.totals.total")}</span>
                                <span className="tabular-nums" data-testid="po-total">
                                    {money(totals.total)}
                                </span>
                            </div>
                            {form.gstEnabled && supplier && (
                                <p className={`rounded-md px-2 py-1.5 text-xs ${totals.supplyKnown ? "bg-muted text-muted-foreground" : "bg-amber-500/15 text-amber-800 dark:text-amber-300"}`} data-testid="po-supply">
                                    {_t(totals.supplyKnown ? `purchaseOrders.form.supply.${totals.supply}` : "purchaseOrders.form.supply.unknown")}
                                </p>
                            )}
                        </aside>
                    </div>

                    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                        <BaseButton variant="outline" onClick={() => onClose()}>
                            {_t("purchaseOrders.form.cancel")}
                        </BaseButton>
                        <BaseButton type="submit" variant={canSend ? "outline" : "default"} loading={busy} data-testid="po-save">
                            {_t("purchaseOrders.form.save")}
                        </BaseButton>
                        {canSend && (
                            <BaseButton loading={busy} onClick={() => void submit(true)} data-testid="po-save-send">
                                {_t("purchaseOrders.form.saveAndSend")}
                            </BaseButton>
                        )}
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
};

const Row = ({ label, value, testId }: { label: string; value: string; testId?: string }) => (
    <div className="flex items-baseline justify-between gap-3">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums" data-testid={testId}>
            {value}
        </span>
    </div>
);

export default PurchaseOrderDialog;
