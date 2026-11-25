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
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/use-toast";
import BaseButton from "@/app/components/reusables/BaseButton";

import ProductFormDialog from "./ProductFormDialog";
import { StockAdjustDialog, StockHistoryDialog } from "./StockDialogs";

import { useInvoiceContext } from "@/contexts/InvoiceContext";
import { useInventoryData } from "@/contexts/useInventoryData";
import { useQuotations } from "@/contexts/useQuotations";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { deleteProduct, isProductInUse, setArchived } from "@/lib/inventory";
import {
    EMPTY_PRODUCT_QUERY,
    categoriesOf,
    isTracked,
    lowStockProducts,
    queryProducts,
    stockLevels,
    stockStatus,
    type Product,
    type ProductQuery,
    type StockStatus,
} from "@/lib/products";

import { Archive, ArchiveRestore, History, Package, Pencil, Plus, Search, SlidersHorizontal, Trash2 } from "lucide-react";

const BADGE: Record<StockStatus, string> = {
    ok: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    low: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    out: "bg-destructive/10 text-destructive",
    untracked: "bg-muted text-muted-foreground",
};

const Metric = ({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) => (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className={`mt-2 break-words text-xl font-semibold tabular-nums sm:text-2xl ${tone ?? ""}`}>{value}</p>
    </div>
);

const ProductsPage = () => {
    const { _t } = useTranslationContext();
    const locale = useLocale();
    const { savedInvoices, savedLoaded } = useInvoiceContext();
    const { products, movements, loaded } = useInventoryData();
    const { quotations } = useQuotations();
    // A product on a quotation is as "in use" as one on an invoice: deleting it
    // would leave the quotation, and the invoice it becomes, with a dead link.
    const documents = useMemo(() => [...savedInvoices, ...quotations.map((q) => q.doc)], [savedInvoices, quotations]);

    const [query, setQuery] = useState<ProductQuery>(EMPTY_PRODUCT_QUERY);
    const [form, setForm] = useState<Product | "new" | null>(null);
    const [adjusting, setAdjusting] = useState<Product | null>(null);
    const [history, setHistory] = useState<Product | null>(null);
    const [deleting, setDeleting] = useState<Product | null>(null);

    const levels = useMemo(() => stockLevels(movements), [movements]);
    const categories = useMemo(() => categoriesOf(products), [products]);
    const rows = useMemo(() => queryProducts(products, movements, query), [products, movements, query]);
    const low = useMemo(() => lowStockProducts(products, movements), [products, movements]);

    const metrics = useMemo(() => {
        const active = products.filter((p) => !p.archived);
        const tracked = active.filter(isTracked);
        return {
            items: active.length,
            low: tracked.filter((p) => stockStatus(p, levels.get(p.id) ?? 0) === "low").length,
            out: tracked.filter((p) => stockStatus(p, levels.get(p.id) ?? 0) === "out").length,
            // At cost, and only positive stock: negative stock is a problem to fix, not an asset.
            value: tracked.reduce((sum, p) => sum + Math.max(0, levels.get(p.id) ?? 0) * p.purchasePrice, 0),
        };
    }, [products, levels]);

    const num = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 3 });
    const price = (n: number) => n.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const set = (patch: Partial<ProductQuery>) => setQuery((q) => ({ ...q, ...patch }));
    const filtered = JSON.stringify(query) !== JSON.stringify(EMPTY_PRODUCT_QUERY);

    const toggleArchive = async (p: Product) => {
        const ok = await setArchived(p.id, !p.archived);
        toast(ok ? { title: _t(p.archived ? "products.toast.restored" : "products.toast.archived"), description: p.name } : { variant: "destructive", title: _t("products.toast.storage") });
    };

    const confirmDelete = async () => {
        const p = deleting;
        setDeleting(null);
        if (!p) return;
        const result = await deleteProduct(p.id, documents);
        toast(result.ok ? { title: _t("products.toast.deleted"), description: p.name } : { variant: "destructive", title: _t(result.reason === "inUse" ? "products.delete.title" : "products.toast.storage"), description: result.reason === "inUse" ? _t("products.delete.inUse", { name: p.name }) : undefined });
    };

    if (!loaded || !savedLoaded) return <Skeleton className="h-96 rounded-xl" aria-busy="true" />;

    const StockBadge = ({ p, stock }: { p: Product; stock: number }) => {
        const status = stockStatus(p, stock);
        return (
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${BADGE[status]}`} data-testid="stock-badge" data-status={status}>
                {status === "untracked" ? _t("products.stockStatus.untracked") : `${num(stock)} ${p.unit}`}
            </span>
        );
    };

    const Actions = ({ p }: { p: Product }) => (
        <div className="flex flex-wrap items-center gap-1">
            {isTracked(p) && (
                <BaseButton variant="outline" size="sm" className="h-8" onClick={() => setAdjusting(p)}>
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                    {_t("products.actions.adjust")}
                </BaseButton>
            )}
            {isTracked(p) && (
                <BaseButton variant="ghost" size="icon" className="h-8 w-8" aria-label={`${_t("products.actions.history")}: ${p.name}`} onClick={() => setHistory(p)}>
                    <History className="h-4 w-4" />
                </BaseButton>
            )}
            <BaseButton variant="ghost" size="icon" className="h-8 w-8" aria-label={`${_t("products.actions.edit")}: ${p.name}`} onClick={() => setForm(p)}>
                <Pencil className="h-4 w-4" />
            </BaseButton>
            <BaseButton variant="ghost" size="icon" className="h-8 w-8" aria-label={`${_t(p.archived ? "products.actions.restore" : "products.actions.archive")}: ${p.name}`} onClick={() => toggleArchive(p)}>
                {p.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
            </BaseButton>
            <BaseButton variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" aria-label={`${_t("products.actions.delete")}: ${p.name}`} onClick={() => setDeleting(p)}>
                <Trash2 className="h-4 w-4" />
            </BaseButton>
        </div>
    );

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{_t("products.title")}</h1>
                    <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{_t("products.subtitle")}</p>
                </div>
                <BaseButton onClick={() => setForm("new")} data-testid="add-product">
                    <Plus className="h-4 w-4" />
                    {_t("products.add")}
                </BaseButton>
            </div>

            {products.length === 0 ? (
                <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center">
                    <div className="rounded-full bg-primary/10 p-4 text-primary">
                        <Package className="h-8 w-8" aria-hidden />
                    </div>
                    <h2 className="text-lg font-semibold">{_t("products.empty.title")}</h2>
                    <p className="max-w-md text-sm text-muted-foreground">{_t("products.empty.body")}</p>
                    <BaseButton onClick={() => setForm("new")}>
                        <Plus className="h-4 w-4" />
                        {_t("products.empty.cta")}
                    </BaseButton>
                </div>
            ) : (
                <>
                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="product-metrics">
                        <Metric label={_t("products.metrics.items")} value={metrics.items} />
                        <Metric label={_t("products.metrics.low")} value={metrics.low} tone={metrics.low ? "text-amber-600 dark:text-amber-400" : ""} />
                        <Metric label={_t("products.metrics.out")} value={metrics.out} tone={metrics.out ? "text-destructive" : ""} />
                        <Metric label={_t("products.metrics.value")} value={price(metrics.value)} />
                    </div>

                    {low.length > 0 && (
                        <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm" data-testid="low-stock-banner">
                            <p className="font-medium">{_t("products.lowBanner", { count: low.length })}</p>
                            <p className="mt-0.5 text-muted-foreground">
                                {low.slice(0, 6).map(({ product, stock }) => `${product.name} (${num(stock)} ${product.unit})`).join(", ")}
                                {low.length > 6 ? "…" : ""}
                            </p>
                        </div>
                    )}

                    <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
                        <div className="relative lg:w-80">
                            <Search aria-hidden className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input type="search" data-shortcut-search className="ps-9" value={query.search} onChange={(e) => set({ search: e.target.value })} placeholder={_t("products.search")} aria-label={_t("products.search")} />
                        </div>
                        <Select value={query.type} onValueChange={(v) => set({ type: v as ProductQuery["type"] })}>
                            <SelectTrigger className="lg:w-40" aria-label={_t("products.type")}><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">{_t("products.type")}: {_t("products.all")}</SelectItem>
                                <SelectItem value="product">{_t("products.types.product")}</SelectItem>
                                <SelectItem value="service">{_t("products.types.service")}</SelectItem>
                            </SelectContent>
                        </Select>
                        <Select value={query.category || "__all"} onValueChange={(v) => set({ category: v === "__all" ? "" : v })}>
                            <SelectTrigger className="lg:w-48" aria-label={_t("products.category")}><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="__all">{_t("products.category")}: {_t("products.all")}</SelectItem>
                                {categories.map((c) => (
                                    <SelectItem key={c} value={c}>{c}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Select value={query.stock} onValueChange={(v) => set({ stock: v as ProductQuery["stock"] })}>
                            <SelectTrigger className="lg:w-44" aria-label={_t("products.stockFilter")}><SelectValue /></SelectTrigger>
                            <SelectContent>
                                {(["all", "ok", "low", "out"] as const).map((s) => (
                                    <SelectItem key={s} value={s}>{_t(`products.stockStatus.${s}`)}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <label className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Switch checked={query.showArchived} onCheckedChange={(v) => set({ showArchived: v })} aria-label={_t("products.showArchived")} />
                            {_t("products.showArchived")}
                        </label>
                    </div>

                    {rows.length === 0 ? (
                        <p className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
                            {filtered ? _t("products.empty.filtered") : _t("products.empty.title")}
                        </p>
                    ) : (
                        <>
                            {/* Wide screens: a table */}
                            <div className="hidden overflow-x-auto rounded-xl border bg-card shadow-sm md:block">
                                <table className="w-full text-sm" data-testid="product-table">
                                    <thead className="bg-muted/50 text-xs text-muted-foreground">
                                        <tr>
                                            <th className="px-4 py-3 text-start font-medium">{_t("products.columns.name")}</th>
                                            <th className="px-4 py-3 text-start font-medium">{_t("products.columns.category")}</th>
                                            <th className="px-4 py-3 text-end font-medium">{_t("products.columns.price")}</th>
                                            <th className="px-4 py-3 text-start font-medium">{_t("products.columns.stock")}</th>
                                            <th className="px-4 py-3 text-end font-medium">{_t("products.columns.actions")}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {rows.map(({ product: p, stock }) => (
                                            <tr key={p.id} className={`border-t ${p.archived ? "opacity-60" : ""}`} data-testid="product-row">
                                                <td className="px-4 py-3">
                                                    <p className="font-medium">
                                                        {p.name}
                                                        {p.archived && <span className="ms-2 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">{_t("products.archivedBadge")}</span>}
                                                    </p>
                                                    <p className="text-xs text-muted-foreground">{[p.sku, _t(`products.types.${p.type}`), p.hsn && `HSN ${p.hsn}`].filter(Boolean).join(" · ")}</p>
                                                </td>
                                                <td className="px-4 py-3 text-muted-foreground">{p.category || "—"}</td>
                                                <td className="px-4 py-3 text-end tabular-nums">{price(p.sellingPrice)}</td>
                                                <td className="px-4 py-3"><StockBadge p={p} stock={stock} /></td>
                                                <td className="px-4 py-3"><div className="flex justify-end"><Actions p={p} /></div></td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>

                            {/* Phones: cards */}
                            <ul className="grid grid-cols-1 gap-3 md:hidden" data-testid="product-cards">
                                {rows.map(({ product: p, stock }) => (
                                    <li key={p.id} className={`rounded-xl border bg-card p-4 shadow-sm ${p.archived ? "opacity-60" : ""}`} data-testid="product-row">
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0">
                                                <p className="truncate font-medium">{p.name}</p>
                                                <p className="truncate text-xs text-muted-foreground">{[p.sku, p.category].filter(Boolean).join(" · ") || _t(`products.types.${p.type}`)}</p>
                                            </div>
                                            <StockBadge p={p} stock={stock} />
                                        </div>
                                        <p className="mt-2 text-sm tabular-nums">{price(p.sellingPrice)}<span className="text-muted-foreground"> / {p.unit}</span></p>
                                        <div className="mt-3"><Actions p={p} /></div>
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                </>
            )}

            <ProductFormDialog target={form} onClose={() => setForm(null)} categories={categories} movements={movements} />
            <StockAdjustDialog product={adjusting} movements={movements} onClose={() => setAdjusting(null)} />
            <StockHistoryDialog product={history} movements={movements} onClose={() => setHistory(null)} />

            <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{_t("products.delete.title")}</AlertDialogTitle>
                        <AlertDialogDescription>
                            {deleting && (isProductInUse(deleting.id, documents) ? _t("products.delete.inUse", { name: deleting.name }) : _t("products.delete.body", { name: deleting.name }))}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>{_t("products.form.cancel")}</AlertDialogCancel>
                        {deleting && !isProductInUse(deleting.id, documents) && (
                            <AlertDialogAction onClick={confirmDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                                {_t("products.delete.confirm")}
                            </AlertDialogAction>
                        )}
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
};

export default ProductsPage;
