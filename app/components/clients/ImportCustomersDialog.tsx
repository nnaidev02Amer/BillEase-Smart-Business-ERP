"use client";

import { useMemo, useRef, useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/use-toast";
import BaseButton from "@/app/components/reusables/BaseButton";

import { useTranslationContext } from "@/contexts/TranslationContext";
import { CUSTOMER_EXPORT_HEADER, MAX_IMPORT_BYTES, planImport, type ImportStrategy } from "@/lib/customerImport";
import { replaceParties, type SavedParty } from "@/lib/partyStore";
import { downloadBlob } from "@/lib/quotationPdf";
import { toCsv } from "@/lib/invoiceRecords";

import { FileUp, Upload } from "lucide-react";

const OUTCOME_STYLE: Record<string, string> = {
    new: "bg-success/15 text-success",
    update: "bg-primary/10 text-primary",
    skip: "bg-muted text-muted-foreground",
    duplicateInFile: "bg-muted text-muted-foreground",
    invalid: "bg-destructive/15 text-destructive",
};

/**
 * Import customers from a CSV. Reading and validating never writes anything:
 * the preview shows exactly which rows are new, which match someone already
 * there, and which are invalid and why. Only the final button writes.
 */
const ImportCustomersDialog = ({ open, existing, onClose }: { open: boolean; existing: SavedParty[]; onClose: () => void }) => {
    const { _t } = useTranslationContext();
    const fileRef = useRef<HTMLInputElement>(null);
    const [text, setText] = useState<string | null>(null);
    const [fileName, setFileName] = useState("");
    const [tooBig, setTooBig] = useState(false);
    const [strategy, setStrategy] = useState<ImportStrategy>("skip");
    const [busy, setBusy] = useState(false);

    const plan = useMemo(() => (text === null ? null : planImport(text, existing, strategy)), [text, existing, strategy]);

    const reset = () => {
        setText(null);
        setFileName("");
        setTooBig(false);
        setStrategy("skip");
    };
    const close = () => {
        reset();
        onClose();
    };

    const onFile = async (file: File | undefined) => {
        if (!file) return;
        setFileName(file.name);
        if (file.size > MAX_IMPORT_BYTES) {
            setTooBig(true);
            setText(null);
            return;
        }
        setTooBig(false);
        setText(await file.text());
    };

    const template = () => {
        const sample = ["Acme Traders", "accounts@acme.test", "+91 98765 43210", "Acme Traders Pvt Ltd", "Asha Rao", "", "12 MG Road", "400001", "Mumbai", "India", "", "", "", "", "Wholesale", "vip; north", "Active", "", "", "", "", ""];
        downloadBlob(new Blob([toCsv(CUSTOMER_EXPORT_HEADER, [sample])], { type: "text/csv;charset=utf-8" }), "customers-template.csv");
    };

    const apply = async () => {
        if (!plan || !plan.ok || busy) return;
        setBusy(true);
        try {
            await replaceParties("receiver", plan.result);
            toast({ title: _t("crm.import.done"), description: _t("crm.import.doneBody", { added: plan.counts.new, updated: plan.counts.update, skipped: plan.counts.skip + plan.counts.duplicateInFile, invalid: plan.counts.invalid }) });
            close();
        } finally {
            setBusy(false);
        }
    };

    const importable = plan?.ok ? plan.counts.new + plan.counts.update : 0;

    return (
        <Dialog open={open} onOpenChange={(o) => !o && close()}>
            <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto" data-testid="import-dialog">
                <DialogHeader>
                    <DialogTitle>{_t("crm.import.title")}</DialogTitle>
                    <DialogDescription>{_t("crm.import.hint")}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-wrap items-center gap-2">
                    <input ref={fileRef} type="file" accept=".csv,text/csv" className="sr-only" data-testid="import-file" aria-label={_t("crm.import.choose")} onChange={(e) => void onFile(e.target.files?.[0])} />
                    <BaseButton variant="outline" onClick={() => fileRef.current?.click()}>
                        <FileUp className="h-4 w-4" />
                        {_t("crm.import.choose")}
                    </BaseButton>
                    <BaseButton variant="ghost" onClick={template} data-testid="import-template">
                        {_t("crm.import.template")}
                    </BaseButton>
                    {fileName && <span className="text-sm text-muted-foreground">{fileName}</span>}
                </div>

                {tooBig && <p role="alert" className="text-sm text-destructive">{_t("crm.import.errors.tooLarge")}</p>}
                {plan && !plan.ok && <p role="alert" className="text-sm text-destructive" data-testid="import-error">{_t(`crm.import.errors.${plan.error}`)}</p>}

                {plan?.ok && (
                    <div className="space-y-4">
                        <div className="flex flex-wrap items-end gap-3">
                            <dl className="grid flex-1 grid-cols-2 gap-2 text-sm sm:grid-cols-5" data-testid="import-counts">
                                {(
                                    [
                                        ["new", plan.counts.new],
                                        ["update", plan.counts.update],
                                        ["skip", plan.counts.skip + plan.counts.duplicateInFile],
                                        ["invalid", plan.counts.invalid],
                                        ["similar", plan.counts.similar],
                                    ] as const
                                ).map(([k, v]) => (
                                    <div key={k} className="rounded-lg border p-2">
                                        <dt className="text-xs text-muted-foreground">{_t(`crm.import.counts.${k}`)}</dt>
                                        <dd className="text-lg font-semibold tabular-nums" data-testid={`import-count-${k}`}>{v}</dd>
                                    </div>
                                ))}
                            </dl>
                            <div className="space-y-1">
                                <Label htmlFor="import-strategy" className="text-xs text-muted-foreground">{_t("crm.import.existing")}</Label>
                                <Select value={strategy} onValueChange={(v) => setStrategy(v as ImportStrategy)}>
                                    <SelectTrigger id="import-strategy" className="w-56"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="skip">{_t("crm.import.strategy.skip")}</SelectItem>
                                        <SelectItem value="update">{_t("crm.import.strategy.update")}</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>

                        <div className="max-h-72 overflow-auto rounded-lg border">
                            <table className="w-full min-w-[28rem] text-sm" data-testid="import-rows">
                                <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
                                    <tr>
                                        <th className="px-3 py-2 text-start font-medium">{_t("crm.import.cols.line")}</th>
                                        <th className="px-3 py-2 text-start font-medium">{_t("crm.import.cols.name")}</th>
                                        <th className="px-3 py-2 text-start font-medium">{_t("crm.import.cols.result")}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {plan.rows.slice(0, 200).map((r) => (
                                        <tr key={r.line} className="border-t" data-testid="import-row" data-outcome={r.outcome}>
                                            <td className="px-3 py-1.5 tabular-nums text-muted-foreground">{r.line}</td>
                                            <td className="px-3 py-1.5">{r.name || "—"}</td>
                                            <td className="px-3 py-1.5">
                                                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${OUTCOME_STYLE[r.outcome]}`}>{_t(`crm.import.outcome.${r.outcome}`)}</span>
                                                {r.issue && <span className="ms-2 text-xs text-destructive">{_t(`crm.import.issue.${r.issue}`)}</span>}
                                                {r.similar.length > 0 && r.outcome !== "invalid" && (
                                                    <span className="ms-2 text-xs text-amber-600 dark:text-amber-400">{_t("crm.import.similarTo", { name: r.similar[0].name })}</span>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {plan.rows.length > 200 && <p className="text-xs text-muted-foreground">{_t("crm.import.firstRows", { count: 200 })}</p>}
                    </div>
                )}

                <div className="flex justify-end gap-2">
                    <BaseButton variant="ghost" onClick={close}>{_t("guards.cancel")}</BaseButton>
                    <BaseButton onClick={apply} loading={busy} disabled={importable === 0} data-testid="import-apply">
                        <Upload className="h-4 w-4" />
                        {_t("crm.import.apply", { count: importable })}
                    </BaseButton>
                </div>
            </DialogContent>
        </Dialog>
    );
};

export default ImportCustomersDialog;
