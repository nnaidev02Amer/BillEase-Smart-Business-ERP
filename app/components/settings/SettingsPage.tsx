"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/use-toast";
import BaseButton from "@/app/components/reusables/BaseButton";
import Field from "@/app/components/reusables/Field";
import NativeSelect from "@/app/components/reusables/NativeSelect";

import { useInvoiceContext } from "@/contexts/InvoiceContext";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { findDuplicates, type BackupAnalysis, type DuplicateStrategy } from "@/lib/backup";
import {

    requestPersistence,
    storageReport,
    type DataScope,
    type StorageReport,
} from "@/lib/dataManagement";
import { GST_STATE_OPTIONS, normaliseGstin, validateGstin } from "@/lib/gst";
import { formatInvoiceNumber, sanitizeSettings, suggestInvoiceNumber, type AppSettings } from "@/lib/settings";

import { AlertTriangle, DatabaseBackup, Download, HardDrive, ShieldCheck, Trash2, Upload } from "lucide-react";

const Card = ({ id, title, hint, children }: { id?: string; title: string; hint?: string; children: React.ReactNode }) => (
    <section id={id} className="scroll-mt-24 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold">{title}</h2>
        {hint && <p className="mt-1 text-sm text-muted-foreground">{hint}</p>}
        <div className="mt-4">{children}</div>
    </section>
);

const bytes = (n: number) =>
    n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;

/* ------------------------------------------------------------ preferences */

const PreferencesCard = () => {
    const { _t } = useTranslationContext();
    const { settings, savedInvoices, updateSettings } = useInvoiceContext();
    const [draft, setDraft] = useState<AppSettings>(settings);
    useEffect(() => setDraft(settings), [settings]);

    const n = draft.numbering;
    const setNum = (p: Partial<AppSettings["numbering"]>) => setDraft((d) => ({ ...d, numbering: { ...d.numbering, ...p } }));
    const clean = sanitizeSettings(draft);
    const preview =
        clean.numbering.mode === "custom" ? suggestInvoiceNumber(clean, savedInvoices) : suggestInvoiceNumber(clean, savedInvoices);
    const dirty = JSON.stringify(clean) !== JSON.stringify(settings);

    return (
        <Card title={_t("settings.numbering.title")} hint={_t("settings.numbering.hint")}>
            <form
                className="space-y-5"
                onSubmit={(e) => {
                    e.preventDefault();
                    void updateSettings(clean);
                }}
            >
                <fieldset className="space-y-2">
                    <legend className="sr-only">{_t("settings.numbering.mode")}</legend>
                    {(["auto", "custom"] as const).map((m) => (
                        <label key={m} className="flex items-start gap-3 rounded-lg border p-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                            <input
                                type="radio"
                                name="numbering-mode"
                                className="mt-1"
                                checked={n.mode === m}
                                onChange={() => setNum({ mode: m })}
                            />
                            <span>
                                <span className="block font-medium">{_t(`settings.numbering.${m}`)}</span>
                                <span className="block text-muted-foreground">{_t(`settings.numbering.${m}Hint`)}</span>
                            </span>
                        </label>
                    ))}
                </fieldset>

                {n.mode === "custom" && (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <div className="space-y-1.5">
                            <Label htmlFor="n-prefix">{_t("settings.numbering.prefix")}</Label>
                            <Input id="n-prefix" maxLength={12} value={n.prefix} onChange={(e) => setNum({ prefix: e.target.value })} />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="n-sep">{_t("settings.numbering.separator")}</Label>
                            <Input id="n-sep" maxLength={2} value={n.separator} onChange={(e) => setNum({ separator: e.target.value })} />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="n-pad">{_t("settings.numbering.padding")}</Label>
                            <Input id="n-pad" type="number" min={1} max={10} value={n.padding} onChange={(e) => setNum({ padding: Number(e.target.value) })} />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="n-start">{_t("settings.numbering.start")}</Label>
                            <Input id="n-start" type="number" min={0} value={n.start} onChange={(e) => setNum({ start: Number(e.target.value) })} />
                        </div>
                        <label className="col-span-2 flex items-center gap-2 text-sm sm:col-span-4">
                            <input type="checkbox" className="h-4 w-4" checked={n.includeYear} onChange={(e) => setNum({ includeYear: e.target.checked })} />
                            {_t("settings.numbering.includeYear")}
                        </label>
                    </div>
                )}

                <p className="text-sm" data-testid="numbering-preview">
                    {_t("settings.numbering.next")}: <span className="rounded bg-muted px-2 py-0.5 font-mono">{preview}</span>
                    {n.mode === "custom" && (
                        <span className="ms-2 text-xs text-muted-foreground">
                            ({_t("settings.numbering.example")} {formatInvoiceNumber(clean.numbering, clean.numbering.start)})
                        </span>
                    )}
                </p>

                <div className="grid grid-cols-2 gap-3 sm:max-w-md">
                    <div className="space-y-1.5">
                        <Label htmlFor="p-due">{_t("settings.prefs.dueDays")}</Label>
                        <Input id="p-due" type="number" min={0} max={365} value={draft.defaultDueDays} onChange={(e) => setDraft((d) => ({ ...d, defaultDueDays: Number(e.target.value) }))} />
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="p-lead">{_t("settings.prefs.leadDays")}</Label>
                        <Input id="p-lead" type="number" min={0} max={60} value={draft.reminderLeadDays} onChange={(e) => setDraft((d) => ({ ...d, reminderLeadDays: Number(e.target.value) }))} />
                    </div>
                </div>

                <BaseButton type="submit" disabled={!dirty}>
                    {_t("settings.save")}
                </BaseButton>
            </form>
        </Card>
    );
};

/* ---------------------------------------------------------------- restore */

const SCOPES: Exclude<DataScope, "all">[] = ["invoices", "clients", "senders", "templates", "settings", "draft", "products", "stock", "quotations", "expenses", "expenseCategories", "suppliers", "purchaseOrders", "goodsReceipts", "purchaseBills", "supplierPayments"];

const RestoreDialog = ({
    analysis,
    onClose,
}: {
    analysis: Extract<BackupAnalysis, { ok: true }> | null;
    onClose: () => void;
}) => {
    const { _t } = useTranslationContext();
    const { savedInvoices, restoreBackup } = useInvoiceContext();
    const [strategy, setStrategy] = useState<DuplicateStrategy>("skip");
    const [restoreSettings, setRestoreSettings] = useState(true);
    const [ackChecksum, setAckChecksum] = useState(false);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        setStrategy("skip");
        setAckChecksum(false);
        setRestoreSettings(true);
    }, [analysis]);

    const dups = useMemo(() => (analysis ? findDuplicates(savedInvoices, analysis.data.invoices) : []), [analysis, savedInvoices]);
    if (!analysis) return <Dialog open={false} onOpenChange={onClose} />;

    const d = analysis.data;
    const blocked = analysis.checksum === "mismatch" && !ackChecksum;
    const identical = dups.filter((x) => x.identical).length;
    const nothing =
        d.invoices.length + d.clients.length + d.senders.length + d.templates.length + d.products.length + d.stockMovements.length + d.quotations.length + d.expenses.length + d.expenseCategories.length + d.suppliers.length + d.purchaseOrders.length + d.goodsReceipts.length + d.purchaseBills.length + d.supplierPayments.length === 0 &&
        !d.settings;

    return (
        <Dialog open onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-h-[90dvh] max-w-xl overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{_t("settings.restore.title")}</DialogTitle>
                    <DialogDescription>
                        {_t("settings.restore.subtitle", { version: analysis.version })}
                        {analysis.exportedAt ? ` · ${new Date(analysis.exportedAt).toLocaleString()}` : ""}
                    </DialogDescription>
                </DialogHeader>

                <div
                    role="status"
                    className={`flex items-start gap-2 rounded-lg p-3 text-sm ${
                        analysis.checksum === "valid"
                            ? "bg-success/10 text-success"
                            : analysis.checksum === "mismatch"
                              ? "bg-destructive/10 text-destructive"
                              : "bg-muted text-muted-foreground"
                    }`}
                >
                    {analysis.checksum === "valid" ? <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
                    <span>{_t(`settings.restore.checksum.${analysis.checksum}`)}</span>
                </div>

                <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3 lg:grid-cols-4" data-testid="restore-counts">
                    {(
                        [
                            ["invoices", d.invoices.length],
                            ["clients", d.clients.length],
                            ["senders", d.senders.length],
                            ["templates", d.templates.length],
                            ["products", d.products.length],
                            ["quotations", d.quotations.length],
                            ["expenses", d.expenses.length],
                            ["suppliers", d.suppliers.length],
                            ["purchaseOrders", d.purchaseOrders.length],
                            ["goodsReceipts", d.goodsReceipts.length],
                            ["purchaseBills", d.purchaseBills.length],
                            ["supplierPayments", d.supplierPayments.length],
                        ] as const
                    ).map(([k, v]) => (
                        <div key={k} className="rounded-lg border p-2">
                            <dt className="text-xs text-muted-foreground">{_t(`settings.data.scope.${k}`)}</dt>
                            <dd className="text-lg font-semibold tabular-nums">{v}</dd>
                        </div>
                    ))}
                </dl>

                {analysis.issues.length > 0 && (
                    <div className="rounded-lg border border-destructive/40 p-3 text-sm">
                        <p className="font-medium text-destructive">{_t("settings.restore.invalid", { count: analysis.issues.length })}</p>
                        <ul className="mt-1 max-h-28 list-disc space-y-0.5 overflow-y-auto ps-5 text-xs text-muted-foreground">
                            {analysis.issues.slice(0, 20).map((i, k) => (
                                <li key={k}>
                                    {_t(`settings.data.scope.${i.kind === "client" ? "clients" : i.kind === "sender" ? "senders" : i.kind === "template" ? "templates" : i.kind === "product" ? "products" : i.kind === "stock" ? "stock" : i.kind === "quotation" ? "quotations" : i.kind === "expense" ? "expenses" : i.kind === "category" ? "expenseCategories" : i.kind === "supplier" ? "suppliers" : i.kind === "purchaseOrder" ? "purchaseOrders" : i.kind === "goodsReceipt" ? "goodsReceipts" : i.kind === "purchaseBill" ? "purchaseBills" : i.kind === "supplierPayment" ? "supplierPayments" : "invoices"}`)} #{i.index}: {i.message}
                                </li>
                            ))}
                        </ul>
                        <p className="mt-1 text-xs text-muted-foreground">{_t("settings.restore.invalidHint")}</p>
                    </div>
                )}

                {dups.length > 0 && (
                    <fieldset className="space-y-2 rounded-lg border p-3 text-sm">
                        <legend className="px-1 font-medium">
                            {_t("settings.restore.duplicates", { count: dups.length })}
                        </legend>
                        <p className="text-xs text-muted-foreground">
                            {_t("settings.restore.duplicatesHint", { identical })}{" "}
                            <span className="font-mono">{dups.slice(0, 5).map((x) => x.number).join(", ")}{dups.length > 5 ? "…" : ""}</span>
                        </p>
                        {(["skip", "overwrite", "keepBoth"] as const).map((s) => (
                            <label key={s} className="flex items-start gap-2">
                                <input type="radio" name="dup-strategy" className="mt-1" checked={strategy === s} onChange={() => setStrategy(s)} />
                                <span>
                                    <span className="block font-medium">{_t(`settings.restore.strategy.${s}`)}</span>
                                    <span className="block text-xs text-muted-foreground">{_t(`settings.restore.strategy.${s}Hint`)}</span>
                                </span>
                            </label>
                        ))}
                    </fieldset>
                )}

                {d.settings && (
                    <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" className="h-4 w-4" checked={restoreSettings} onChange={(e) => setRestoreSettings(e.target.checked)} />
                        {_t("settings.restore.includeSettings")}
                    </label>
                )}

                {analysis.checksum === "mismatch" && (
                    <label className="flex items-start gap-2 text-sm text-destructive">
                        <input type="checkbox" className="mt-1 h-4 w-4" checked={ackChecksum} onChange={(e) => setAckChecksum(e.target.checked)} />
                        {_t("settings.restore.ackChecksum")}
                    </label>
                )}

                <div className="flex justify-end gap-2">
                    <BaseButton variant="ghost" onClick={onClose}>
                        {_t("guards.cancel")}
                    </BaseButton>
                    <BaseButton
                        loading={busy}
                        disabled={blocked || nothing}
                        onClick={async () => {
                            setBusy(true);
                            const s = await restoreBackup(analysis, { strategy, restoreSettings });
                            setBusy(false);
                            toast({
                                variant: s.allWritten ? "default" : "destructive",
                                title: s.allWritten ? _t("settings.restore.done") : _t("toasts.storageFailedTitle"),
                                description:
                                    _t("settings.restore.doneBody", {
                                        added: s.invoices.added,
                                        skipped: s.invoices.skipped,
                                        overwritten: s.invoices.overwritten,
                                        renumbered: s.invoices.renumbered,
                                    }) + (s.products.added ? ` ${_t("settings.restore.productsBody", { count: s.products.added })}` : "") +
                                    (s.quotations.added ? ` ${_t("settings.restore.quotationsBody", { count: s.quotations.added })}` : "") +
                                    (s.expenses.added ? ` ${_t("settings.restore.expensesBody", { count: s.expenses.added })}` : "") +
                                    (s.expenses.refiled ? ` ${_t("settings.restore.refiledBody", { count: s.expenses.refiled })}` : "") +
                                    (s.suppliers.added ? ` ${_t("settings.restore.suppliersBody", { count: s.suppliers.added })}` : "") +
                                    (s.purchaseOrders.added ? ` ${_t("settings.restore.purchaseOrdersBody", { count: s.purchaseOrders.added })}` : "") +
                                    (s.goodsReceipts.added ? ` ${_t("settings.restore.goodsReceiptsBody", { count: s.goodsReceipts.added })}` : "") +
                                    (s.purchaseBills.added ? ` ${_t("settings.restore.purchaseBillsBody", { count: s.purchaseBills.added })}` : "") +
                                    (s.supplierPayments.added ? ` ${_t("settings.restore.supplierPaymentsBody", { count: s.supplierPayments.added })}` : ""),
                            });
                            onClose();
                        }}
                    >
                        {_t("settings.restore.confirm")}
                    </BaseButton>
                </div>
            </DialogContent>
        </Dialog>
    );
};

/* ------------------------------------------------------------------- data */

const DataCard = () => {
    const { _t } = useTranslationContext();
    const { exportBackup, inspectBackup, clearStoredData, savedInvoices, templates } = useInvoiceContext();
    const fileRef = useRef<HTMLInputElement>(null);
    const [report, setReport] = useState<StorageReport | null>(null);
    const [analysis, setAnalysis] = useState<Extract<BackupAnalysis, { ok: true }> | null>(null);
    const [clearScope, setClearScope] = useState<DataScope | null>(null);
    const [confirmText, setConfirmText] = useState("");
    const [persisted, setPersisted] = useState<boolean | null>(null);

    const refresh = useCallback(async () => {
        const r = await storageReport();
        setReport(r);
        setPersisted(r.persisted);
    }, []);
    // Refresh when the amount of stored data changes, not on every render.
    useEffect(() => {
        void refresh();
    }, [refresh, savedInvoices.length, templates.length]);

    const onFile = async (file: File | undefined) => {
        if (!file) return;
        const result = await inspectBackup(file);
        if (fileRef.current) fileRef.current.value = "";
        if (!result.ok) {
            toast({ variant: "destructive", title: _t("settings.restore.failed"), description: _t(`settings.restore.errors.${result.error}`) });
            return;
        }
        setAnalysis(result);
    };

    const quotaPct = report?.usage != null && report.quota ? (report.usage / report.quota) * 100 : null;

    return (
        <Card id="backup" title={_t("settings.data.title")} hint={_t("settings.data.hint")}>
            <div className="space-y-6">
                <div>
                    <h3 className="flex items-center gap-2 text-sm font-semibold">
                        <HardDrive className="h-4 w-4" aria-hidden />
                        {_t("settings.data.usage")}
                    </h3>
                    {!report ? (
                        <Skeleton className="mt-3 h-24" />
                    ) : (
                        <>
                            <table className="mt-3 w-full text-sm">
                                <tbody>
                                    {report.items.map((i) => (
                                        <tr key={i.scope} className="border-b last:border-0">
                                            <th scope="row" className="py-1.5 text-start font-normal text-muted-foreground">
                                                {_t(`settings.data.scope.${i.scope}`)}
                                            </th>
                                            <td className="py-1.5 text-end tabular-nums">{i.scope === "settings" || i.scope === "draft" ? (i.count ? "✓" : "—") : i.count}</td>
                                            <td className="w-24 py-1.5 text-end tabular-nums">{bytes(i.bytes)}</td>
                                        </tr>
                                    ))}
                                    <tr>
                                        <th scope="row" className="py-1.5 text-start">{_t("settings.data.total")}</th>
                                        <td />
                                        <td className="py-1.5 text-end font-semibold tabular-nums" data-testid="storage-total">{bytes(report.totalBytes)}</td>
                                    </tr>
                                </tbody>
                            </table>
                            {quotaPct !== null && report.quota != null && report.usage != null && (
                                <div className="mt-3">
                                    <div className="h-2 overflow-hidden rounded-full bg-muted" role="img" aria-label={_t("settings.data.quota", { used: bytes(report.usage), total: bytes(report.quota) })}>
                                        <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(1, Math.min(100, quotaPct))}%` }} />
                                    </div>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        {_t("settings.data.quota", { used: bytes(report.usage), total: bytes(report.quota) })}
                                    </p>
                                </div>
                            )}
                            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                                <span>{persisted ? _t("settings.data.persistent") : _t("settings.data.notPersistent")}</span>
                                {persisted === false && (
                                    <button
                                        type="button"
                                        className="font-medium text-primary underline-offset-4 hover:underline"
                                        onClick={async () => {
                                            setPersisted(await requestPersistence());
                                        }}
                                    >
                                        {_t("settings.data.requestPersist")}
                                    </button>
                                )}
                            </div>
                            <p className="mt-2 text-xs text-muted-foreground">{_t("settings.data.localOnly")}</p>
                        </>
                    )}
                </div>

                <div>
                    <h3 className="flex items-center gap-2 text-sm font-semibold">
                        <DatabaseBackup className="h-4 w-4" aria-hidden />
                        {_t("settings.data.backup")}
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">{_t("settings.data.backupHint")}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                        <input
                            ref={fileRef}
                            type="file"
                            accept="application/json,.json"
                            className="sr-only"
                            tabIndex={-1}
                            data-testid="backup-file"
                            onChange={(e) => void onFile(e.target.files?.[0])}
                        />
                        <BaseButton onClick={() => void exportBackup()}>
                            <Download className="h-4 w-4" />
                            {_t("dashboard.backup.export")}
                        </BaseButton>
                        <BaseButton variant="outline" onClick={() => fileRef.current?.click()}>
                            <Upload className="h-4 w-4" />
                            {_t("dashboard.backup.import")}
                        </BaseButton>
                    </div>
                </div>

                <div className="rounded-lg border border-destructive/30 p-4">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-destructive">
                        <Trash2 className="h-4 w-4" aria-hidden />
                        {_t("settings.data.dangerTitle")}
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">{_t("settings.data.dangerHint")}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                        {(["invoices", "clients", "templates", "draft", "all"] as const).map((s) => (
                            <BaseButton
                                key={s}
                                variant="outline"
                                size="sm"
                                className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                                onClick={() => {
                                    setConfirmText("");
                                    setClearScope(s);
                                }}
                            >
                                {_t(`settings.data.clear.${s}`)}
                            </BaseButton>
                        ))}
                    </div>
                </div>
            </div>

            <RestoreDialog
                analysis={analysis}
                onClose={() => {
                    setAnalysis(null);
                    void refresh();
                }}
            />

            <Dialog open={clearScope !== null} onOpenChange={(o) => !o && setClearScope(null)}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>{_t("settings.data.clearTitle")}</DialogTitle>
                        <DialogDescription>
                            {clearScope && _t(`settings.data.clearBody.${clearScope}`)} {_t("settings.data.clearBackupFirst")}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-1.5">
                        <Label htmlFor="clear-confirm">{_t("settings.data.typeToConfirm", { word: "DELETE" })}</Label>
                        <Input id="clear-confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
                    </div>
                    <div className="flex flex-wrap justify-end gap-2">
                        <BaseButton variant="outline" onClick={() => void exportBackup()}>
                            {_t("dashboard.backup.export")}
                        </BaseButton>
                        <BaseButton variant="ghost" onClick={() => setClearScope(null)}>
                            {_t("guards.cancel")}
                        </BaseButton>
                        <BaseButton
                            variant="destructive"
                            disabled={confirmText !== "DELETE"}
                            onClick={async () => {
                                if (!clearScope) return;
                                await clearStoredData(clearScope);
                                setClearScope(null);
                                void refresh();
                                toast({ title: _t("settings.data.cleared") });
                            }}
                        >
                            {_t("settings.data.clearConfirm")}
                        </BaseButton>
                    </div>
                </DialogContent>
            </Dialog>
        </Card>
    );
};

const BusinessProfileCard = () => {
    const { _t } = useTranslationContext();
    const { settings, updateSettings } = useInvoiceContext();
    const [business, setBusiness] = useState(settings.business);
    const [purchase, setPurchase] = useState(settings.purchase);
    useEffect(() => {
        setBusiness(settings.business);
        setPurchase(settings.purchase);
    }, [settings]);

    const clean = sanitizeSettings({ ...settings, business, purchase });
    const dirty = JSON.stringify([clean.business, clean.purchase]) !== JSON.stringify([settings.business, settings.purchase]);
    const gst = normaliseGstin(business.gstin) ? validateGstin(business.gstin) : null;
    // Typed, but not a real GSTIN yet: say so without blocking someone who is mid-entry until they save.
    const gstinBad = gst !== null && !gst.valid && business.gstin.length >= 15;
    const stateMismatch = gst?.valid === true && business.state !== "" && business.state !== gst.stateCode;
    const set = (p: Partial<typeof business>) => setBusiness((b) => ({ ...b, ...p }));

    return (
        <Card id="business" title={_t("settings.business.title")} hint={_t("settings.business.hint")}>
            <form
                className="space-y-5"
                noValidate
                data-testid="business-form"
                onSubmit={(e) => {
                    e.preventDefault();
                    if ((gst !== null && !gst.valid) || stateMismatch) return;
                    void updateSettings(clean);
                }}
            >
                <div className="grid gap-4 sm:grid-cols-2">
                    <Field id="b-name" label={_t("settings.business.name")} className="sm:col-span-2">
                        <Input id="b-name" data-testid="business-name" value={business.name} maxLength={50} onChange={(e) => set({ name: e.target.value })} />
                    </Field>
                    <Field id="b-gstin" label={_t("settings.business.gstin")} error={gstinBad ? _t("settings.business.gstinBad") : undefined} hint={gst?.valid ? _t("settings.business.gstinOk", { state: gst.stateName }) : undefined}>
                        <Input id="b-gstin" data-testid="business-gstin" className="font-mono uppercase" value={business.gstin} maxLength={15} aria-invalid={gstinBad} onChange={(e) => set({ gstin: normaliseGstin(e.target.value) })} />
                    </Field>
                    <Field id="b-state" label={_t("settings.business.state")} error={stateMismatch ? _t("settings.business.stateMismatch") : undefined}>
                        <NativeSelect id="b-state" data-testid="business-state" value={gst?.valid ? gst.stateCode : business.state} disabled={gst?.valid === true} aria-invalid={stateMismatch} onChange={(e) => set({ state: e.target.value })}>
                            <option value="">{gst?.valid ? _t("settings.business.stateAuto") : "—"}</option>
                            {GST_STATE_OPTIONS.map((s) => (
                                <option key={s.code} value={s.code}>
                                    {s.label}
                                </option>
                            ))}
                        </NativeSelect>
                    </Field>
                    <Field id="b-address" label={_t("settings.business.address")}>
                        <Input id="b-address" value={business.address} maxLength={70} onChange={(e) => set({ address: e.target.value })} />
                    </Field>
                    <Field id="b-city" label={_t("settings.business.city")}>
                        <Input id="b-city" value={business.city} maxLength={50} onChange={(e) => set({ city: e.target.value })} />
                    </Field>
                    <Field id="b-zip" label={_t("settings.business.zipCode")}>
                        <Input id="b-zip" value={business.zipCode} maxLength={20} onChange={(e) => set({ zipCode: e.target.value })} />
                    </Field>
                    <Field id="b-country" label={_t("settings.business.country")}>
                        <Input id="b-country" value={business.country} maxLength={70} onChange={(e) => set({ country: e.target.value })} />
                    </Field>
                    <Field id="b-email" label={_t("settings.business.email")}>
                        <Input id="b-email" type="email" inputMode="email" value={business.email} onChange={(e) => set({ email: e.target.value })} />
                    </Field>
                    <Field id="b-phone" label={_t("settings.business.phone")}>
                        <Input id="b-phone" type="tel" inputMode="tel" value={business.phone} maxLength={50} onChange={(e) => set({ phone: e.target.value })} />
                    </Field>
                </div>

                <fieldset className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <legend className="mb-2 text-sm font-semibold">{_t("settings.business.prefixes")}</legend>
                    <Field id="b-po" label={_t("settings.business.poPrefix")}>
                        <Input id="b-po" data-testid="business-po-prefix" className="font-mono" value={purchase.poPrefix} maxLength={12} onChange={(e) => setPurchase((p) => ({ ...p, poPrefix: e.target.value }))} />
                    </Field>
                    <Field id="b-grn" label={_t("settings.business.grnPrefix")}>
                        <Input id="b-grn" className="font-mono" value={purchase.grnPrefix} maxLength={12} onChange={(e) => setPurchase((p) => ({ ...p, grnPrefix: e.target.value }))} />
                    </Field>
                    <Field id="b-bill" label={_t("settings.business.billPrefix")}>
                        <Input id="b-bill" className="font-mono" value={purchase.billPrefix} maxLength={12} onChange={(e) => setPurchase((p) => ({ ...p, billPrefix: e.target.value }))} />
                    </Field>
                    <Field id="b-pay" label={_t("settings.business.paymentPrefix")}>
                        <Input id="b-pay" data-testid="business-pay-prefix" className="font-mono" value={purchase.paymentPrefix} maxLength={12} onChange={(e) => setPurchase((p) => ({ ...p, paymentPrefix: e.target.value }))} />
                    </Field>
                </fieldset>

                <BaseButton type="submit" disabled={!dirty || (gst !== null && !gst.valid) || stateMismatch} data-testid="business-save">
                    {_t("settings.business.save")}
                </BaseButton>
            </form>
        </Card>
    );
};

const SettingsPage = () => {
    const { _t } = useTranslationContext();
    const { savedLoaded } = useInvoiceContext();
    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{_t("settings.title")}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{_t("settings.subtitle")}</p>
            </div>
            {savedLoaded ? <PreferencesCard /> : <Skeleton className="h-64 rounded-xl" />}
            {savedLoaded ? <BusinessProfileCard /> : <Skeleton className="h-64 rounded-xl" />}
            <DataCard />
        </div>
    );
};

export default SettingsPage;
