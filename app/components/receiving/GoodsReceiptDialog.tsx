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
import {
    accepted,
    canReceiveAgainst,
    hasGrnErrors,
    linesFromOrder,
    overReceipts,
    priceChanges,
    receivedByLine,
    remainingByLine,
    validateGoodsReceipt,
    type GoodsReceipt,
    type GrnErrors,
    type GrnLine,
    type OverReceipt,
    type PriceUpdate,
} from "@/lib/goodsReceipts";
import { postGoodsReceipt } from "@/lib/goodsReceiptStore";
import { formatMoney } from "@/lib/invoiceRecords";
import { isTracked, round3, type Product } from "@/lib/products";
import { receiptProgress, round2, type PurchaseOrder } from "@/lib/purchaseOrders";
import { newId } from "@/lib/repository";
import type { Supplier } from "@/lib/suppliers";

import { PackagePlus, Plus, Trash2 } from "lucide-react";

type FormLine = Omit<GrnLine, "received" | "rejected" | "unitPrice"> & {
    received: string;
    rejected: string;
    unitPrice: string;
    /** Only for lines that came from an order, to show what was asked for and what is left. */
    ordered?: number;
    remaining?: number;
};

const parse = (s: string) => {
    const n = parseFloat(String(s).replace(/,/g, ""));
    return Number.isFinite(n) ? n : 0;
};

const toGrnLine = (l: FormLine): GrnLine => ({
    id: l.id,
    ...(l.poLineId ? { poLineId: l.poLineId } : {}),
    ...(l.productId ? { productId: l.productId } : {}),
    name: l.name.trim(),
    unit: l.unit.trim() || "pcs",
    received: round3(parse(l.received)),
    rejected: round3(parse(l.rejected)),
    unitPrice: round2(parse(l.unitPrice)),
});

/** Order lines as form lines: received starts at what is still to come, which is what usually arrives. */
const fromOrder = (po: PurchaseOrder, received: Map<string, number>): FormLine[] => {
    const remaining = remainingByLine(po, received);
    return linesFromOrder(po, received, () => newId("line")).map((l) => {
        const pl = po.lines.find((x) => x.id === l.poLineId)!;
        return { ...l, received: String(l.received), rejected: "", unitPrice: String(l.unitPrice), ordered: pl.quantity, remaining: remaining.get(pl.id) };
    });
};

const GoodsReceiptDialog = ({
    open,
    presetOrderId,
    suppliers,
    orders,
    receipts,
    products,
    prefix,
    onClose,
}: {
    open: boolean;
    presetOrderId?: string;
    suppliers: Supplier[];
    orders: PurchaseOrder[];
    receipts: GoodsReceipt[];
    products: Product[];
    prefix: string;
    onClose: (saved?: GoodsReceipt) => void;
}) => {
    const { _t } = useTranslationContext();
    const locale = useLocale();

    const [mode, setMode] = useState<"order" | "direct">("order");
    const [poId, setPoId] = useState("");
    const [supplierId, setSupplierId] = useState("");
    const [date, setDate] = useState(toDay(new Date()));
    const [reference, setReference] = useState("");
    const [note, setNote] = useState("");
    const [number, setNumber] = useState("");
    const [lines, setLines] = useState<FormLine[]>([]);
    const [updatePrices, setUpdatePrices] = useState(false);
    const [errors, setErrors] = useState<GrnErrors>({ lineErrors: {} });
    const [busy, setBusy] = useState(false);
    const [stage, setStage] = useState<null | { kind: "over" | "price"; over: OverReceipt[]; changes: PriceUpdate[]; flags: { over: boolean; price: boolean } }>(null);

    const received = useMemo(() => new Map(orders.map((o) => [o.id, receivedByLine(receipts, o.id)])), [orders, receipts]);
    // Orders that can still take goods: sent, and not yet fully received.
    const openOrders = useMemo(
        () => orders.filter((o) => canReceiveAgainst(o) && receiptProgress(o, received.get(o.id)).fraction < 1).sort((a, b) => b.date.localeCompare(a.date)),
        [orders, received]
    );
    const po = orders.find((o) => o.id === poId) ?? null;
    const products_ = useMemo(() => products.filter((p) => !p.archived).sort((a, b) => a.name.localeCompare(b.name)), [products]);
    const trackedIds = useMemo(() => new Set(products.filter(isTracked).map((p) => p.id)), [products]);
    const activeSuppliers = suppliers.filter((s) => !s.inactive);

    // Reset whenever the dialog opens; a preset order selects "against an order" and fills the lines.
    useEffect(() => {
        if (!open) return;
        const preset = orders.find((o) => o.id === presetOrderId && canReceiveAgainst(o)) ?? null;
        setMode(preset || openOrders.length > 0 ? "order" : "direct");
        setPoId(preset?.id ?? "");
        setSupplierId(preset?.supplierId ?? "");
        setLines(preset ? fromOrder(preset, received.get(preset.id) ?? new Map()) : []);
        setDate(toDay(new Date()));
        setReference("");
        setNote("");
        setNumber("");
        setUpdatePrices(false);
        setErrors({ lineErrors: {} });
        setStage(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, presetOrderId]);

    const chooseMode = (m: "order" | "direct") => {
        setMode(m);
        setPoId("");
        setLines([]);
        setSupplierId("");
        setErrors({ lineErrors: {} });
    };

    const chooseOrder = (id: string) => {
        const o = orders.find((x) => x.id === id);
        setPoId(id);
        setSupplierId(o?.supplierId ?? "");
        setLines(o ? fromOrder(o, received.get(o.id) ?? new Map()) : []);
        setErrors({ lineErrors: {} });
    };

    const patchLine = (id: string, p: Partial<FormLine>) => {
        setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...p } : l)));
        setErrors((e) => ({ ...e, lines: undefined, lineErrors: { ...e.lineErrors, [id]: {} } }));
    };

    const addProduct = (id: string) => {
        const p = products_.find((x) => x.id === id);
        if (!p) return;
        setLines((ls) => [...ls, { id: newId("line"), productId: p.id, name: p.name, unit: p.unit, received: "1", rejected: "", unitPrice: String(p.purchasePrice || "") }]);
        setErrors((e) => ({ ...e, lines: undefined }));
    };

    const grnLines = useMemo(() => lines.map(toGrnLine), [lines]);
    const changes = useMemo(() => priceChanges(products, grnLines), [products, grnLines]);
    const currency = po?.currency ?? suppliers.find((s) => s.id === supplierId)?.currency ?? "INR";
    const totalIn = round3(grnLines.reduce((s, l) => s + accepted(l), 0));

    const post = async (flags: { over: boolean; price: boolean }) => {
        setBusy(true);
        const result = await postGoodsReceipt(
            { number, supplierId, poId: po?.id, date, reference, note, currency, lines: grnLines, prefix },
            { allowOver: flags.over, updatePrices: updatePrices && changes.length > 0 && flags.price }
        );
        setBusy(false);
        if (result.ok) {
            toast({ title: _t("goodsReceipts.toast.posted", { number: result.receipt.number }), description: _t("goodsReceipts.toast.stockIn", { count: result.stockMovements }) });
            onClose(result.receipt);
        } else if ("errors" in result) setErrors(result.errors);
        else if ("overReceipt" in result) setStage({ kind: "over", over: result.overReceipt, changes, flags });
        else toast({ variant: "destructive", title: _t(result.reason === "limit" ? "goodsReceipts.toast.limit" : "goodsReceipts.toast.storage") });
    };

    /** Checks, then asks for whatever needs confirming (over-receipt, then price change), then posts. */
    const attempt = async (flags: { over: boolean; price: boolean }) => {
        const draft = { number, supplierId, poId: po?.id, date, reference, note, currency, lines: grnLines };
        const found = validateGoodsReceipt(draft, { suppliers, orders, receipts });
        if (hasGrnErrors(found)) {
            setErrors(found);
            return;
        }
        const over = po ? overReceipts(po, grnLines, received.get(po.id) ?? new Map()) : [];
        if (over.length > 0 && !flags.over) return setStage({ kind: "over", over, changes, flags });
        if (updatePrices && changes.length > 0 && !flags.price) return setStage({ kind: "price", over, changes, flags });
        await post(flags);
    };

    const confirmStage = async () => {
        const s = stage;
        setStage(null);
        if (!s) return;
        await attempt(s.kind === "over" ? { ...s.flags, over: true } : { ...s.flags, price: true });
    };

    const numFmt = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 3 });
    const e = (k: "supplier" | "order" | "date" | "number") => (errors[k] ? _t(`goodsReceipts.errors.${errors[k]}`) : undefined);
    const orderFullyReceived = mode === "order" && po && lines.length === 0;

    return (
        <>
            <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
                <DialogContent className="max-h-[94dvh] max-w-3xl overflow-y-auto" data-testid="grn-dialog">
                    <DialogHeader>
                        <DialogTitle>{_t("goodsReceipts.form.title")}</DialogTitle>
                        <DialogDescription className="sr-only">{_t("goodsReceipts.subtitle")}</DialogDescription>
                    </DialogHeader>

                    <form
                        className="space-y-5"
                        noValidate
                        onSubmit={(ev) => {
                            ev.preventDefault();
                            void attempt({ over: false, price: false });
                        }}
                    >
                        <fieldset className="flex flex-wrap gap-4">
                            <legend className="sr-only">{_t("goodsReceipts.form.mode")}</legend>
                            {(["order", "direct"] as const).map((m) => (
                                <label key={m} className="flex cursor-pointer items-center gap-2 text-sm">
                                    <input type="radio" name="grn-mode" className="h-4 w-4" checked={mode === m} data-testid={`grn-mode-${m}`} onChange={() => chooseMode(m)} />
                                    {_t(m === "order" ? "goodsReceipts.form.fromOrder" : "goodsReceipts.form.direct")}
                                </label>
                            ))}
                        </fieldset>

                        <div className="grid gap-4 sm:grid-cols-2">
                            {mode === "order" ? (
                                <Field id="grn-order" label={_t("goodsReceipts.form.order")} error={e("order")} className="sm:col-span-2">
                                    {openOrders.length === 0 && !po ? (
                                        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground" data-testid="grn-no-orders">
                                            {_t("goodsReceipts.form.noOpenOrders")}
                                        </p>
                                    ) : (
                                        <NativeSelect id="grn-order" data-testid="grn-order" value={poId} aria-invalid={!!errors.order} onChange={(ev) => chooseOrder(ev.target.value)}>
                                            <option value="">{_t("goodsReceipts.form.selectOrder")}</option>
                                            {[...openOrders, ...(po && !openOrders.some((o) => o.id === po.id) ? [po] : [])].map((o) => (
                                                <option key={o.id} value={o.id}>
                                                    {o.number} · {o.supplier.name}
                                                </option>
                                            ))}
                                        </NativeSelect>
                                    )}
                                </Field>
                            ) : (
                                <Field id="grn-supplier" label={_t("goodsReceipts.form.supplier")} error={e("supplier")} className="sm:col-span-2">
                                    <NativeSelect id="grn-supplier" data-testid="grn-supplier" value={supplierId} aria-invalid={!!errors.supplier} onChange={(ev) => setSupplierId(ev.target.value)}>
                                        <option value="">{_t("goodsReceipts.form.selectSupplier")}</option>
                                        {activeSuppliers.map((s) => (
                                            <option key={s.id} value={s.id}>
                                                {s.name}
                                            </option>
                                        ))}
                                    </NativeSelect>
                                </Field>
                            )}
                            <Field id="grn-date" label={_t("goodsReceipts.form.date")} error={e("date")}>
                                <Input id="grn-date" data-testid="grn-date" type="date" value={date} aria-invalid={!!errors.date} onChange={(ev) => setDate(ev.target.value)} />
                            </Field>
                            <Field id="grn-ref" label={_t("goodsReceipts.form.reference")}>
                                <Input id="grn-ref" data-testid="grn-reference" value={reference} maxLength={80} onChange={(ev) => setReference(ev.target.value)} />
                            </Field>
                            <Field id="grn-number" label={_t("goodsReceipts.form.number")} error={e("number")} hint={_t("goodsReceipts.form.numberHint")}>
                                <Input id="grn-number" data-testid="grn-number" value={number} maxLength={40} aria-invalid={!!errors.number} onChange={(ev) => setNumber(ev.target.value)} />
                            </Field>
                        </div>

                        <section aria-labelledby="grn-items-title" className="space-y-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <h3 id="grn-items-title" className="text-sm font-semibold">
                                    {_t("goodsReceipts.form.items")}
                                </h3>
                                {mode === "direct" && (
                                    <div className="flex flex-wrap items-center gap-2">
                                        <NativeSelect className="h-9 w-48" aria-label={_t("goodsReceipts.form.addProduct")} data-testid="grn-add-product" value="" onChange={(ev) => addProduct(ev.target.value)} disabled={products_.length === 0}>
                                            <option value="">{_t("goodsReceipts.form.pickProduct")}</option>
                                            {products_.map((p) => (
                                                <option key={p.id} value={p.id}>
                                                    {p.name}
                                                    {p.sku ? ` (${p.sku})` : ""}
                                                </option>
                                            ))}
                                        </NativeSelect>
                                        <BaseButton variant="outline" size="sm" className="h-9" data-testid="grn-add-line" onClick={() => setLines((ls) => [...ls, { id: newId("line"), name: "", unit: "pcs", received: "1", rejected: "", unitPrice: "" }])}>
                                            <Plus className="h-4 w-4" />
                                            {_t("goodsReceipts.form.addLine")}
                                        </BaseButton>
                                    </div>
                                )}
                            </div>
                            {errors.lines && (
                                <p role="alert" className="text-sm font-medium text-destructive">
                                    {_t(`goodsReceipts.errors.${errors.lines}`)}
                                </p>
                            )}
                            {orderFullyReceived && <p className="text-sm text-muted-foreground">{_t("goodsReceipts.form.orderDone")}</p>}

                            <ul className="space-y-3">
                                {lines.map((l, i) => {
                                    const le = errors.lineErrors[l.id] ?? {};
                                    const msg = (k: keyof typeof le) => (le[k] ? _t(`goodsReceipts.errors.${le[k]}`) : undefined);
                                    const gl = toGrnLine(l);
                                    const into = accepted(gl);
                                    const over = l.remaining !== undefined && into > l.remaining;
                                    const tracked = l.productId ? trackedIds.has(l.productId) : false;
                                    return (
                                        <li key={l.id} className="rounded-lg border bg-muted/20 p-3" data-testid="grn-line">
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0 flex-1">
                                                    {l.poLineId ? (
                                                        <p className="truncate font-medium" data-testid="grn-line-name">
                                                            {l.name}
                                                        </p>
                                                    ) : (
                                                        <Field id={`grn-name-${i}`} label={_t("goodsReceipts.form.itemName")} error={msg("name")}>
                                                            <Input id={`grn-name-${i}`} data-testid="grn-line-name" value={l.name} maxLength={120} aria-invalid={!!le.name} onChange={(ev) => patchLine(l.id, { name: ev.target.value })} />
                                                        </Field>
                                                    )}
                                                    {l.ordered !== undefined && (
                                                        <p className="mt-0.5 text-xs text-muted-foreground">
                                                            {_t("goodsReceipts.form.ordered")} {numFmt(l.ordered)} · {_t("goodsReceipts.form.remaining")} {numFmt(l.remaining ?? 0)} {l.unit}
                                                        </p>
                                                    )}
                                                    {!tracked && <p className="mt-0.5 text-xs text-muted-foreground">{_t("goodsReceipts.form.untracked")}</p>}
                                                </div>
                                                {mode === "direct" && (
                                                    <BaseButton variant="ghost" size="icon" className="h-9 w-9 text-destructive hover:text-destructive" aria-label={`${_t("goodsReceipts.form.remove")} ${i + 1}`} onClick={() => setLines((ls) => ls.filter((x) => x.id !== l.id))}>
                                                        <Trash2 className="h-4 w-4" />
                                                    </BaseButton>
                                                )}
                                            </div>
                                            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                                                <Field id={`grn-rec-${i}`} label={`${_t("goodsReceipts.form.received")} (${l.unit})`} error={msg("received")}>
                                                    <Input id={`grn-rec-${i}`} data-testid="grn-line-received" type="number" min={0} step="any" inputMode="decimal" value={l.received} aria-invalid={!!le.received} onChange={(ev) => patchLine(l.id, { received: ev.target.value })} />
                                                </Field>
                                                <Field id={`grn-rej-${i}`} label={_t("goodsReceipts.form.rejected")} error={msg("rejected")}>
                                                    <Input id={`grn-rej-${i}`} data-testid="grn-line-rejected" type="number" min={0} step="any" inputMode="decimal" value={l.rejected} aria-invalid={!!le.rejected} onChange={(ev) => patchLine(l.id, { rejected: ev.target.value })} />
                                                </Field>
                                                <Field id={`grn-price-${i}`} label={_t("goodsReceipts.form.unitPrice")} error={msg("unitPrice")}>
                                                    <Input id={`grn-price-${i}`} data-testid="grn-line-price" type="number" min={0} step="0.01" inputMode="decimal" value={l.unitPrice} aria-invalid={!!le.unitPrice} onChange={(ev) => patchLine(l.id, { unitPrice: ev.target.value })} />
                                                </Field>
                                                <div className="space-y-1.5">
                                                    <p className="text-sm font-medium leading-none">{_t("goodsReceipts.form.accepted")}</p>
                                                    <p className={`flex h-10 items-center text-sm font-semibold tabular-nums ${over ? "text-amber-600 dark:text-amber-400" : ""}`} data-testid="grn-line-accepted" data-over={over ? "true" : "false"}>
                                                        {numFmt(into)}
                                                    </p>
                                                </div>
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        </section>

                        <Field id="grn-note" label={_t("goodsReceipts.form.note")}>
                            <Textarea id="grn-note" rows={2} maxLength={1000} value={note} onChange={(ev) => setNote(ev.target.value)} />
                        </Field>

                        <div className="rounded-lg border p-3">
                            <div className="flex items-start gap-3">
                                <Switch id="grn-prices" data-testid="grn-update-prices" checked={updatePrices} onCheckedChange={setUpdatePrices} />
                                <div className="text-sm">
                                    <label htmlFor="grn-prices" className="font-medium">
                                        {_t("goodsReceipts.form.priceUpdate")}
                                    </label>
                                    <p className="text-xs text-muted-foreground">{_t("goodsReceipts.form.priceUpdateHint")}</p>
                                </div>
                            </div>
                            {updatePrices && (
                                <div className="mt-2 text-xs" data-testid="grn-price-preview">
                                    {changes.length === 0 ? (
                                        <p className="text-muted-foreground">{_t("goodsReceipts.form.priceUpdateNone")}</p>
                                    ) : (
                                        <ul className="space-y-0.5">
                                            {changes.map((c) => (
                                                <li key={c.productId}>{_t("goodsReceipts.confirm.priceLine", { name: c.name, from: formatMoney(c.from, currency, locale), to: formatMoney(c.to, currency, locale) })}</li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            )}
                        </div>

                        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
                            <p className="text-sm text-muted-foreground" data-testid="grn-total-in">
                                {_t("goodsReceipts.card.accepted", { count: numFmt(totalIn) })}
                            </p>
                            <div className="flex flex-col-reverse gap-2 sm:flex-row">
                                <BaseButton variant="outline" onClick={() => onClose()}>
                                    {_t("goodsReceipts.form.cancel")}
                                </BaseButton>
                                <BaseButton type="submit" loading={busy} disabled={orderFullyReceived === true} data-testid="grn-save">
                                    <PackagePlus className="h-4 w-4" />
                                    {_t("goodsReceipts.form.save")}
                                </BaseButton>
                            </div>
                        </div>
                    </form>
                </DialogContent>
            </Dialog>

            <AlertDialog open={stage !== null} onOpenChange={(o) => !o && setStage(null)}>
                <AlertDialogContent data-testid="grn-confirm">
                    <AlertDialogHeader>
                        <AlertDialogTitle>{_t(stage?.kind === "over" ? "goodsReceipts.confirm.overTitle" : "goodsReceipts.confirm.priceTitle")}</AlertDialogTitle>
                        <AlertDialogDescription asChild>
                            <div>
                                <p>{_t(stage?.kind === "over" ? "goodsReceipts.confirm.overBody" : "goodsReceipts.confirm.priceBody")}</p>
                                <ul className="mt-2 list-disc space-y-1 ps-5 text-foreground">
                                    {stage?.kind === "over"
                                        ? stage.over.map((o) => (
                                              <li key={o.poLineId}>
                                                  {_t("goodsReceipts.confirm.overLine", { name: o.name, ordered: numFmt(o.ordered), already: numFmt(o.alreadyReceived), now: numFmt(o.nowAccepted), over: numFmt(o.over) })}
                                              </li>
                                          ))
                                        : stage?.changes.map((c) => (
                                              <li key={c.productId}>{_t("goodsReceipts.confirm.priceLine", { name: c.name, from: formatMoney(c.from, currency, locale), to: formatMoney(c.to, currency, locale) })}</li>
                                          ))}
                                </ul>
                            </div>
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>{_t("goodsReceipts.confirm.back")}</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void confirmStage()} data-testid="grn-confirm-yes">
                            {_t(stage?.kind === "over" ? "goodsReceipts.confirm.overConfirm" : "goodsReceipts.confirm.priceConfirm")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
};

export default GoodsReceiptDialog;
