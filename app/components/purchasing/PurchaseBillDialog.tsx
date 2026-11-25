"use client";

import { useEffect, useMemo, useState } from "react";
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/use-toast";
import BaseButton from "@/app/components/reusables/BaseButton";
import Field from "@/app/components/reusables/Field";
import NativeSelect from "@/app/components/reusables/NativeSelect";

import { useTranslationContext } from "@/contexts/TranslationContext";
import { toDay } from "@/lib/expenses";
import { accepted, receivedByLine, type GoodsReceipt } from "@/lib/goodsReceipts";
import { GST_RATES } from "@/lib/gst";
import { formatDay } from "@/lib/dates";
import { formatMoney } from "@/lib/invoiceRecords";
import type { Product } from "@/lib/products";
import {
    billTotals,
    billedByLine,
    dueDateFor,
    hasBillErrors,
    linesFromOrder,
    linesFromReceipt,
    matchBill,
    validatePurchaseBill,
    type BillErrors,
    type BillLine,
    type MatchIssue,
    type PurchaseBill,
} from "@/lib/purchaseBills";
import { changePurchaseBillStatus, savePurchaseBill } from "@/lib/purchaseBillStore";
import { round2, round3, snapshotOf, type PurchaseOrder } from "@/lib/purchaseOrders";
import { newId } from "@/lib/repository";
import type { BusinessProfile } from "@/lib/settings";
import { businessState, type Supplier } from "@/lib/suppliers";

import { Plus, Trash2 } from "lucide-react";

type FormLine = Omit<BillLine, "quantity" | "unitPrice" | "taxRate"> & { quantity: string; unitPrice: string; taxRate: string };
type Mode = "order" | "receipt" | "direct";

const parse = (s: string) => {
    const n = parseFloat(String(s).replace(/,/g, ""));
    return Number.isFinite(n) ? n : 0;
};

const toBillLine = (l: FormLine): BillLine => ({
    id: l.id,
    ...(l.productId ? { productId: l.productId } : {}),
    ...(l.poLineId ? { poLineId: l.poLineId } : {}),
    name: l.name.trim(),
    description: l.description.trim(),
    hsn: l.hsn.replace(/\D/g, ""),
    unit: l.unit.trim() || "pcs",
    quantity: round3(parse(l.quantity)),
    unitPrice: round2(parse(l.unitPrice)),
    taxRate: parse(l.taxRate),
});
const toFormLine = (l: BillLine): FormLine => ({ ...l, quantity: String(l.quantity), unitPrice: String(l.unitPrice), taxRate: String(l.taxRate) });
const blankLine = (): FormLine => ({ id: newId("line"), name: "", description: "", hsn: "", unit: "pcs", quantity: "1", unitPrice: "", taxRate: "18" });

const PurchaseBillDialog = ({
    open,
    bill,
    presetOrderId,
    suppliers,
    orders,
    receipts,
    bills,
    products,
    business,
    prefix,
    onClose,
}: {
    open: boolean;
    /** null creates a new bill. */
    bill: PurchaseBill | null;
    presetOrderId?: string;
    suppliers: Supplier[];
    orders: PurchaseOrder[];
    receipts: GoodsReceipt[];
    bills: PurchaseBill[];
    products: Product[];
    business: BusinessProfile;
    prefix: string;
    onClose: (saved?: PurchaseBill) => void;
}) => {
    const { _t } = useTranslationContext();
    const locale = useLocale();

    const [mode, setMode] = useState<Mode>("direct");
    const [poId, setPoId] = useState("");
    const [grnId, setGrnId] = useState("");
    const [supplierId, setSupplierId] = useState("");
    const [supplierBillNo, setSupplierBillNo] = useState("");
    const [billDate, setBillDate] = useState(toDay(new Date()));
    const [dueDate, setDueDate] = useState("");
    const [dueTouched, setDueTouched] = useState(false);
    const [currency, setCurrency] = useState("INR");
    const [number, setNumber] = useState("");
    const [gstEnabled, setGstEnabled] = useState(true);
    const [itcEligible, setItcEligible] = useState(true);
    const [lines, setLines] = useState<FormLine[]>([blankLine()]);
    const [discountType, setDiscountType] = useState<"amount" | "percentage">("amount");
    const [discountValue, setDiscountValue] = useState("");
    const [freight, setFreight] = useState("");
    const [notes, setNotes] = useState("");
    const [errors, setErrors] = useState<BillErrors>({ lineErrors: {} });
    const [busy, setBusy] = useState(false);
    const [confirmPost, setConfirmPost] = useState(false);

    const editing = !!bill;
    const activeProducts = useMemo(() => products.filter((p) => !p.archived).sort((a, b) => a.name.localeCompare(b.name)), [products]);

    const orderBy = useMemo(() => new Map(orders.map((o) => [o.id, o])), [orders]);
    const billableOrders = useMemo(
        () =>
            orders
                .filter((o) => (o.status === "sent" || o.status === "closed") && linesFromOrder(o, receivedByLine(receipts, o.id), billedByLine(bills, o.id, bill?.id), () => "x").length > 0)
                .sort((a, b) => b.date.localeCompare(a.date)),
        [orders, receipts, bills, bill?.id]
    );
    const postedReceipts = useMemo(() => receipts.filter((g) => g.status === "posted" && g.lines.some((l) => accepted(l) > 0)).sort((a, b) => b.date.localeCompare(a.date)), [receipts]);

    const termsOf = (id: string) => suppliers.find((s) => s.id === id)?.paymentTermsDays ?? 30;
    const rateFor = (productId?: string) => products.find((p) => p.id === productId)?.taxRate ?? 18;

    const fillFromOrder = (po: PurchaseOrder, date: string) => {
        setPoId(po.id);
        setSupplierId(po.supplierId);
        setCurrency(po.currency);
        setGstEnabled(po.gstEnabled);
        setLines(linesFromOrder(po, receivedByLine(receipts, po.id), billedByLine(bills, po.id, bill?.id), () => newId("line")).map(toFormLine));
        if (!dueTouched) setDueDate(dueDateFor(date, termsOf(po.supplierId)));
    };

    // Reset whenever the dialog opens.
    useEffect(() => {
        if (!open) return;
        setErrors({ lineErrors: {} });
        setConfirmPost(false);
        setBusy(false);
        setDueTouched(false);
        if (bill) {
            setMode(bill.poId ? "order" : "direct");
            setPoId(bill.poId ?? "");
            setGrnId(bill.grnIds[0] ?? "");
            setSupplierId(bill.supplierId);
            setSupplierBillNo(bill.supplierBillNo);
            setBillDate(bill.billDate);
            setDueDate(bill.dueDate);
            setDueTouched(true);
            setCurrency(bill.currency);
            setNumber(bill.number);
            setGstEnabled(bill.gstEnabled);
            setItcEligible(bill.itcEligible);
            setLines(bill.lines.map(toFormLine));
            setDiscountType(bill.discount.type);
            setDiscountValue(bill.discount.value ? String(bill.discount.value) : "");
            setFreight(bill.freight ? String(bill.freight) : "");
            setNotes(bill.notes);
            return;
        }
        const today = toDay(new Date());
        setBillDate(today);
        setSupplierBillNo("");
        setNumber("");
        setGrnId("");
        setItcEligible(true);
        setDiscountType("amount");
        setDiscountValue("");
        setFreight("");
        setNotes("");
        const preset = orders.find((o) => o.id === presetOrderId);
        if (preset) {
            setMode("order");
            fillFromOrder(preset, today);
        } else {
            setMode(billableOrders.length > 0 ? "order" : "direct");
            setPoId("");
            setSupplierId("");
            setCurrency("INR");
            setGstEnabled(true);
            setLines(billableOrders.length > 0 ? [] : [blankLine()]);
            setDueDate("");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, bill?.id, presetOrderId]);

    const chooseMode = (m: Mode) => {
        setMode(m);
        setPoId("");
        setGrnId("");
        setSupplierId("");
        setLines(m === "direct" ? [blankLine()] : []);
        setErrors({ lineErrors: {} });
    };

    const chooseOrder = (id: string) => {
        const po = orderBy.get(id);
        if (po) fillFromOrder(po, billDate);
        else {
            setPoId("");
            setLines([]);
        }
    };

    const chooseReceipt = (id: string) => {
        const g = receipts.find((x) => x.id === id);
        setGrnId(id);
        if (!g) return setLines([]);
        const po = g.poId ? orderBy.get(g.poId) : undefined;
        setPoId(po?.id ?? "");
        setSupplierId(g.supplierId);
        setCurrency(g.currency);
        setGstEnabled(po?.gstEnabled ?? true);
        setLines(linesFromReceipt(g, po, rateFor, () => newId("line")).map(toFormLine));
        if (!dueTouched) setDueDate(dueDateFor(billDate, termsOf(g.supplierId)));
    };

    const chooseSupplier = (id: string) => {
        const s = suppliers.find((x) => x.id === id);
        setSupplierId(id);
        if (s && !editing) {
            setCurrency(s.currency);
            if (!dueTouched) setDueDate(dueDateFor(billDate, s.paymentTermsDays));
        }
        setErrors((e) => ({ ...e, supplier: undefined }));
    };

    const changeBillDate = (d: string) => {
        setBillDate(d);
        if (!dueTouched && /^\d{4}-\d{2}-\d{2}$/.test(d)) setDueDate(dueDateFor(d, termsOf(supplierId)));
    };

    const patchLine = (id: string, p: Partial<FormLine>) => {
        setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...p } : l)));
        setErrors((e) => ({ ...e, lines: undefined, lineErrors: { ...e.lineErrors, [id]: {} } }));
    };

    const addProduct = (id: string) => {
        const p = activeProducts.find((x) => x.id === id);
        if (!p) return;
        setLines((ls) => [...ls.filter((l) => l.name.trim() || l.unitPrice), { id: newId("line"), productId: p.id, name: p.name, description: "", hsn: p.hsn, unit: p.unit, quantity: "1", unitPrice: String(p.purchasePrice || ""), taxRate: String(p.taxRate) }]);
        setErrors((e) => ({ ...e, lines: undefined }));
    };

    const supplier = suppliers.find((s) => s.id === supplierId) ?? null;
    // An edited bill keeps the supplier details it was written with, unless the supplier was changed.
    const supplierForTax = useMemo(
        () => (bill && bill.supplierId === supplierId ? bill.supplier : supplier ? snapshotOf(supplier) : snapshotOf({ state: "", gstin: "" } as Supplier)),
        [bill, supplierId, supplier]
    );
    const billLines = useMemo(() => lines.map(toBillLine), [lines]);
    const discount = useMemo(() => ({ type: discountType, value: round2(parse(discountValue)) }), [discountType, discountValue]);
    const freightNum = round2(parse(freight));
    const buyerState = businessState(business);
    const totals = useMemo(
        () => billTotals({ lines: billLines, discount, freight: freightNum, gstEnabled, currency, supplier: supplierForTax }, buyerState),
        [billLines, discount, freightNum, gstEnabled, currency, supplierForTax, buyerState]
    );
    const money = (n: number) => formatMoney(n, currency || "INR", locale);
    const numFmt = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 3 });

    const po = poId ? orderBy.get(poId) : undefined;
    const issues: MatchIssue[] = useMemo(
        () => (po ? matchBill({ lines: billLines, poId: po.id }, po, receivedByLine(receipts, po.id), billedByLine(bills, po.id, bill?.id)) : []),
        [po, billLines, receipts, bills, bill?.id]
    );

    const rateOptions = (current: string) => {
        const set = new Set<number>(GST_RATES);
        if (current !== "" && Number.isFinite(parse(current))) set.add(parse(current));
        return [...set].sort((a, b) => a - b);
    };

    const attempt = async (post: boolean, confirmed: boolean) => {
        const draft = { number, supplierId, supplierBillNo, billDate, dueDate, currency, lines: billLines, discount, freight: freightNum, gstEnabled };
        const found = validatePurchaseBill(draft, suppliers, bills, bill?.id);
        if (hasBillErrors(found)) {
            setErrors(found);
            return;
        }
        if (post && issues.length > 0 && !confirmed) {
            setConfirmPost(true);
            return;
        }
        setBusy(true);
        const saved = await savePurchaseBill({ ...draft, poId: po?.id, grnIds: grnId ? [grnId] : [], itcEligible, notes, prefix }, bill?.id);
        if (!saved.ok) {
            setBusy(false);
            if ("errors" in saved) setErrors(saved.errors);
            else toast({ variant: "destructive", title: _t(saved.reason === "limit" ? "purchaseBills.toast.limit" : saved.reason === "notEditable" ? "purchaseBills.toast.notAllowed" : "purchaseBills.toast.storage") });
            return;
        }
        let result = saved.bill;
        if (post) {
            const posted = await changePurchaseBillStatus(saved.bill.id, "posted", { allowMismatch: confirmed || issues.length === 0 });
            if (posted.ok) result = posted.bill;
            else {
                // Saved as a draft; say why it did not post.
                setBusy(false);
                toast({ variant: "destructive", title: _t("purchaseBills.toast.notAllowed") });
                onClose(saved.bill);
                return;
            }
        }
        setBusy(false);
        toast({ title: _t(post ? "purchaseBills.toast.posted" : "purchaseBills.toast.saved", { number: result.number }) });
        onClose(result);
    };

    const e = (k: "supplier" | "supplierBillNo" | "billDate" | "dueDate" | "number" | "currency" | "discount" | "freight") => (errors[k] ? _t(`purchaseBills.errors.${errors[k]}`) : undefined);
    const issueText = (i: MatchIssue) =>
        _t(`purchaseBills.match.kinds.${i.kind}`, { name: i.name, billed: numFmt(i.billed ?? 0), received: numFmt(i.received ?? 0), ordered: numFmt(i.ordered ?? 0), billPrice: money(i.billPrice ?? 0), orderPrice: money(i.orderPrice ?? 0) });
    const selectable = suppliers.filter((s) => !s.inactive || s.id === bill?.supplierId).sort((a, b) => a.name.localeCompare(b.name));
    const locked = mode !== "direct" && !!poId;

    return (
        <>
            <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
                <DialogContent className="max-h-[94dvh] max-w-4xl overflow-y-auto" data-testid="bill-dialog">
                    <DialogHeader>
                        <DialogTitle>{bill ? _t("purchaseBills.form.titleEdit", { number: bill.number }) : _t("purchaseBills.form.titleNew")}</DialogTitle>
                        <DialogDescription className="sr-only">{_t("purchaseBills.subtitle")}</DialogDescription>
                    </DialogHeader>

                    <form
                        className="space-y-6"
                        noValidate
                        onSubmit={(ev) => {
                            ev.preventDefault();
                            void attempt(false, false);
                        }}
                    >
                        {!editing && (
                            <fieldset className="flex flex-wrap gap-4">
                                <legend className="sr-only">{_t("purchaseBills.form.mode")}</legend>
                                {(["order", "receipt", "direct"] as const).map((m) => (
                                    <label key={m} className="flex cursor-pointer items-center gap-2 text-sm">
                                        <input type="radio" name="bill-mode" className="h-4 w-4" checked={mode === m} data-testid={`bill-mode-${m}`} onChange={() => chooseMode(m)} />
                                        {_t(m === "order" ? "purchaseBills.form.fromOrder" : m === "receipt" ? "purchaseBills.form.fromReceipt" : "purchaseBills.form.direct")}
                                    </label>
                                ))}
                            </fieldset>
                        )}

                        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                            {!editing && mode === "order" && (
                                <Field id="bill-order" label={_t("purchaseBills.form.order")} className="sm:col-span-2 lg:col-span-4">
                                    {billableOrders.length === 0 && !po ? (
                                        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground" data-testid="bill-no-orders">
                                            {_t("purchaseBills.form.noBillableOrders")}
                                        </p>
                                    ) : (
                                        <NativeSelect id="bill-order" data-testid="bill-order" value={poId} onChange={(ev) => chooseOrder(ev.target.value)}>
                                            <option value="">{_t("purchaseBills.form.selectOrder")}</option>
                                            {[...billableOrders, ...(po && !billableOrders.some((o) => o.id === po.id) ? [po] : [])].map((o) => (
                                                <option key={o.id} value={o.id}>
                                                    {o.number} · {o.supplier.name}
                                                </option>
                                            ))}
                                        </NativeSelect>
                                    )}
                                </Field>
                            )}
                            {!editing && mode === "receipt" && (
                                <Field id="bill-receipt" label={_t("purchaseBills.form.receipt")} className="sm:col-span-2 lg:col-span-4">
                                    {postedReceipts.length === 0 ? (
                                        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground" data-testid="bill-no-receipts">
                                            {_t("purchaseBills.form.noReceipts")}
                                        </p>
                                    ) : (
                                        <NativeSelect id="bill-receipt" data-testid="bill-receipt" value={grnId} onChange={(ev) => chooseReceipt(ev.target.value)}>
                                            <option value="">{_t("purchaseBills.form.selectReceipt")}</option>
                                            {postedReceipts.map((g) => (
                                                <option key={g.id} value={g.id}>
                                                    {g.number} · {g.supplierName} · {formatDay(g.date, locale)}
                                                </option>
                                            ))}
                                        </NativeSelect>
                                    )}
                                </Field>
                            )}

                            <Field id="bill-supplier" label={_t("purchaseBills.form.supplier")} error={e("supplier")} className="sm:col-span-2">
                                <NativeSelect id="bill-supplier" data-testid="bill-supplier" value={supplierId} disabled={locked || editing} aria-invalid={!!errors.supplier} onChange={(ev) => chooseSupplier(ev.target.value)}>
                                    <option value="">{_t("purchaseBills.form.selectSupplier")}</option>
                                    {selectable.map((s) => (
                                        <option key={s.id} value={s.id}>
                                            {s.name}
                                        </option>
                                    ))}
                                </NativeSelect>
                            </Field>
                            <Field id="bill-no" label={_t("purchaseBills.form.supplierBillNo")} error={e("supplierBillNo")} className="sm:col-span-2">
                                <Input id="bill-no" data-testid="bill-supplier-no" value={supplierBillNo} maxLength={60} aria-invalid={!!errors.supplierBillNo} onChange={(ev) => setSupplierBillNo(ev.target.value)} />
                            </Field>
                            <Field id="bill-date" label={_t("purchaseBills.form.billDate")} error={e("billDate")}>
                                <Input id="bill-date" data-testid="bill-date" type="date" value={billDate} aria-invalid={!!errors.billDate} onChange={(ev) => changeBillDate(ev.target.value)} />
                            </Field>
                            <Field id="bill-due" label={_t("purchaseBills.form.dueDate")} error={e("dueDate")}>
                                <Input id="bill-due" data-testid="bill-due" type="date" value={dueDate} min={billDate} aria-invalid={!!errors.dueDate} onChange={(ev) => { setDueDate(ev.target.value); setDueTouched(true); }} />
                            </Field>
                            <Field id="bill-currency" label={_t("purchaseBills.form.currency")} error={e("currency")}>
                                <Input id="bill-currency" value={currency} maxLength={3} className="uppercase" disabled={locked} aria-invalid={!!errors.currency} onChange={(ev) => setCurrency(ev.target.value.toUpperCase())} />
                            </Field>
                            <Field id="bill-number" label={_t("purchaseBills.form.number")} error={e("number")} hint={editing ? undefined : _t("purchaseBills.form.numberHint")}>
                                <Input id="bill-number" data-testid="bill-number" value={number} maxLength={40} aria-invalid={!!errors.number} onChange={(ev) => setNumber(ev.target.value)} />
                            </Field>
                            <div className="flex items-end gap-3 pb-2 sm:col-span-2">
                                <Switch id="bill-gst" checked={gstEnabled} disabled={locked} onCheckedChange={setGstEnabled} />
                                <label htmlFor="bill-gst" className="text-sm font-medium">
                                    {_t("purchaseBills.form.gst")}
                                </label>
                            </div>
                        </div>

                        <section aria-labelledby="bill-items-title" className="space-y-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <h3 id="bill-items-title" className="text-sm font-semibold">
                                    {_t("purchaseBills.form.items")}
                                </h3>
                                {(mode === "direct" || editing) && (
                                    <div className="flex flex-wrap items-center gap-2">
                                        <NativeSelect className="h-9 w-48" aria-label={_t("purchaseBills.form.addProduct")} data-testid="bill-add-product" value="" onChange={(ev) => addProduct(ev.target.value)} disabled={activeProducts.length === 0}>
                                            <option value="">{_t("purchaseBills.form.pickProduct")}</option>
                                            {activeProducts.map((p) => (
                                                <option key={p.id} value={p.id}>
                                                    {p.name}
                                                    {p.sku ? ` (${p.sku})` : ""}
                                                </option>
                                            ))}
                                        </NativeSelect>
                                        <BaseButton variant="outline" size="sm" className="h-9" data-testid="bill-add-line" onClick={() => setLines((ls) => [...ls, blankLine()])}>
                                            <Plus className="h-4 w-4" />
                                            {_t("purchaseBills.form.addLine")}
                                        </BaseButton>
                                    </div>
                                )}
                            </div>
                            {errors.lines && (
                                <p role="alert" className="text-sm font-medium text-destructive">
                                    {_t(`purchaseBills.errors.${errors.lines}`)}
                                </p>
                            )}

                            <ul className="space-y-3">
                                {lines.map((l, i) => {
                                    const le = errors.lineErrors[l.id] ?? {};
                                    const msg = (k: keyof typeof le) => (le[k] ? _t(`purchaseBills.errors.${le[k]}`) : undefined);
                                    const amount = round2(round3(parse(l.quantity)) * round2(parse(l.unitPrice)));
                                    return (
                                        <li key={l.id} className="rounded-lg border bg-muted/20 p-3" data-testid="bill-line">
                                            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                                                <Field id={`bill-name-${i}`} label={_t("purchaseBills.form.itemName")} error={msg("name")}>
                                                    <Input id={`bill-name-${i}`} data-testid="bill-line-name" value={l.name} maxLength={120} aria-invalid={!!le.name} onChange={(ev) => patchLine(l.id, { name: ev.target.value })} />
                                                </Field>
                                                <div className="flex items-end justify-end">
                                                    <BaseButton variant="ghost" size="icon" className="h-10 w-10 text-destructive hover:text-destructive" aria-label={`${_t("purchaseBills.form.remove")} ${i + 1}`} onClick={() => setLines((ls) => ls.filter((x) => x.id !== l.id))}>
                                                        <Trash2 className="h-4 w-4" />
                                                    </BaseButton>
                                                </div>
                                            </div>
                                            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-6">
                                                <Field id={`bill-hsn-${i}`} label={_t("purchaseBills.form.hsn")} error={msg("hsn")}>
                                                    <Input id={`bill-hsn-${i}`} inputMode="numeric" maxLength={8} value={l.hsn} aria-invalid={!!le.hsn} onChange={(ev) => patchLine(l.id, { hsn: ev.target.value.replace(/\D/g, "") })} />
                                                </Field>
                                                <Field id={`bill-qty-${i}`} label={`${_t("purchaseBills.form.qty")} (${l.unit})`} error={msg("quantity")}>
                                                    <Input id={`bill-qty-${i}`} data-testid="bill-line-qty" type="number" min={0} step="any" inputMode="decimal" value={l.quantity} aria-invalid={!!le.quantity} onChange={(ev) => patchLine(l.id, { quantity: ev.target.value })} />
                                                </Field>
                                                <Field id={`bill-price-${i}`} label={_t("purchaseBills.form.price")} error={msg("unitPrice")}>
                                                    <Input id={`bill-price-${i}`} data-testid="bill-line-price" type="number" min={0} step="0.01" inputMode="decimal" value={l.unitPrice} aria-invalid={!!le.unitPrice} onChange={(ev) => patchLine(l.id, { unitPrice: ev.target.value })} />
                                                </Field>
                                                <Field id={`bill-rate-${i}`} label={_t("purchaseBills.form.rate")} error={msg("taxRate")}>
                                                    <NativeSelect id={`bill-rate-${i}`} data-testid="bill-line-rate" value={l.taxRate} disabled={!gstEnabled} aria-invalid={!!le.taxRate} onChange={(ev) => patchLine(l.id, { taxRate: ev.target.value })}>
                                                        {rateOptions(l.taxRate).map((r) => (
                                                            <option key={r} value={String(r)}>
                                                                {r}%
                                                            </option>
                                                        ))}
                                                    </NativeSelect>
                                                </Field>
                                                <Field id={`bill-unit-${i}`} label={_t("purchaseBills.form.unit")}>
                                                    <Input id={`bill-unit-${i}`} value={l.unit} maxLength={20} onChange={(ev) => patchLine(l.id, { unit: ev.target.value })} />
                                                </Field>
                                                <div className="space-y-1.5">
                                                    <p className="text-sm font-medium leading-none">{_t("purchaseBills.form.amount")}</p>
                                                    <p className="flex h-10 items-center text-sm font-semibold tabular-nums" data-testid="bill-line-amount">
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
                                    <Field id="bill-discount" label={_t("purchaseBills.form.discount")} error={e("discount")}>
                                        <div className="flex gap-2">
                                            <Input id="bill-discount" type="number" min={0} step="0.01" inputMode="decimal" value={discountValue} aria-invalid={!!errors.discount} onChange={(ev) => setDiscountValue(ev.target.value)} />
                                            <NativeSelect className="w-24" aria-label={_t("purchaseBills.form.discount")} value={discountType} onChange={(ev) => setDiscountType(ev.target.value as "amount" | "percentage")}>
                                                <option value="amount">{_t("purchaseBills.form.discountAmount")}</option>
                                                <option value="percentage">{_t("purchaseBills.form.discountPercent")}</option>
                                            </NativeSelect>
                                        </div>
                                    </Field>
                                    <Field id="bill-freight" label={_t("purchaseBills.form.freight")} error={e("freight")}>
                                        <Input id="bill-freight" data-testid="bill-freight" type="number" min={0} step="0.01" inputMode="decimal" value={freight} aria-invalid={!!errors.freight} onChange={(ev) => setFreight(ev.target.value)} />
                                    </Field>
                                </div>
                                <div className="flex items-start gap-3 rounded-lg border p-3">
                                    <Switch id="bill-itc" data-testid="bill-itc" checked={itcEligible} disabled={!gstEnabled} onCheckedChange={setItcEligible} />
                                    <div className="text-sm">
                                        <label htmlFor="bill-itc" className="font-medium">
                                            {_t("purchaseBills.form.itc")}
                                        </label>
                                        <p className="text-xs text-muted-foreground">{_t("purchaseBills.form.itcHint")}</p>
                                    </div>
                                </div>
                                <Field id="bill-notes" label={_t("purchaseBills.form.notes")}>
                                    <Textarea id="bill-notes" rows={2} maxLength={2000} value={notes} onChange={(ev) => setNotes(ev.target.value)} />
                                </Field>
                            </div>

                            <aside className="h-fit space-y-2 rounded-xl border bg-card p-4 text-sm shadow-sm" data-testid="bill-totals">
                                <Row label={_t("purchaseBills.form.totals.subtotal")} value={money(totals.subTotal)} />
                                {totals.discountAmount > 0 && <Row label={_t("purchaseBills.form.totals.discount")} value={`− ${money(totals.discountAmount)}`} />}
                                {gstEnabled && (
                                    <>
                                        <Row label={_t("purchaseBills.form.totals.taxable")} value={money(totals.taxableValue)} />
                                        {totals.supply === "intra" ? (
                                            <>
                                                <Row label={_t("purchaseBills.form.totals.cgst")} value={money(totals.cgst)} testId="bill-cgst" />
                                                <Row label={_t("purchaseBills.form.totals.sgst")} value={money(totals.sgst)} testId="bill-sgst" />
                                            </>
                                        ) : (
                                            <Row label={_t("purchaseBills.form.totals.igst")} value={money(totals.igst)} testId="bill-igst" />
                                        )}
                                    </>
                                )}
                                {totals.shippingAmount > 0 && <Row label={_t("purchaseBills.form.totals.freight")} value={money(totals.shippingAmount)} />}
                                <div className="flex items-baseline justify-between border-t pt-2 text-base font-semibold">
                                    <span>{_t("purchaseBills.form.totals.total")}</span>
                                    <span className="tabular-nums" data-testid="bill-total">
                                        {money(totals.total)}
                                    </span>
                                </div>
                                {gstEnabled && supplier && (
                                    <p className={`rounded-md px-2 py-1.5 text-xs ${totals.supplyKnown ? "bg-muted text-muted-foreground" : "bg-amber-500/15 text-amber-800 dark:text-amber-300"}`} data-testid="bill-supply">
                                        {_t(totals.supplyKnown ? `purchaseBills.form.supply.${totals.supply}` : "purchaseBills.form.supply.unknown")}
                                    </p>
                                )}
                            </aside>
                        </div>

                        <section aria-labelledby="bill-match-title" className="rounded-xl border p-4" data-testid="bill-match">
                            <h3 id="bill-match-title" className="text-sm font-semibold">
                                {_t("purchaseBills.match.title")}
                            </h3>
                            {!po ? (
                                <p className="mt-1 text-sm text-muted-foreground">{_t("purchaseBills.match.direct")}</p>
                            ) : issues.length === 0 ? (
                                <p className="mt-1 text-sm text-emerald-700 dark:text-emerald-400" data-testid="bill-match-ok">
                                    {_t("purchaseBills.match.ok")}
                                </p>
                            ) : (
                                <ul className="mt-2 list-disc space-y-1 ps-5 text-sm text-amber-800 dark:text-amber-300" data-testid="bill-match-issues">
                                    {issues.map((i, idx) => (
                                        <li key={`${i.kind}-${i.lineId}-${idx}`} data-kind={i.kind}>
                                            {issueText(i)}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </section>

                        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                            <BaseButton variant="outline" onClick={() => onClose()}>
                                {_t("purchaseBills.form.cancel")}
                            </BaseButton>
                            <BaseButton type="submit" variant="outline" loading={busy} data-testid="bill-save">
                                {_t("purchaseBills.form.save")}
                            </BaseButton>
                            <BaseButton loading={busy} onClick={() => void attempt(true, false)} data-testid="bill-save-post">
                                {_t("purchaseBills.form.saveAndPost")}
                            </BaseButton>
                        </div>
                    </form>
                </DialogContent>
            </Dialog>

            <AlertDialog open={confirmPost} onOpenChange={(o) => !o && setConfirmPost(false)}>
                <AlertDialogContent data-testid="bill-confirm">
                    <AlertDialogHeader>
                        <AlertDialogTitle>{_t("purchaseBills.match.confirmTitle")}</AlertDialogTitle>
                        <AlertDialogDescription asChild>
                            <div>
                                <p>{_t("purchaseBills.match.confirmBody")}</p>
                                <ul className="mt-2 list-disc space-y-1 ps-5 text-foreground">
                                    {issues.map((i, idx) => (
                                        <li key={`${i.kind}-${i.lineId}-${idx}`}>{issueText(i)}</li>
                                    ))}
                                </ul>
                            </div>
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>{_t("purchaseBills.match.back")}</AlertDialogCancel>
                        <AlertDialogAction
                            data-testid="bill-confirm-yes"
                            onClick={() => {
                                setConfirmPost(false);
                                void attempt(true, true);
                            }}
                        >
                            {_t("purchaseBills.match.confirm")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
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

export default PurchaseBillDialog;
