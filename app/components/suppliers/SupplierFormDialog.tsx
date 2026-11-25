"use client";

import { useEffect, useMemo, useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/use-toast";
import BaseButton from "@/app/components/reusables/BaseButton";
import Field from "@/app/components/reusables/Field";
import NativeSelect from "@/app/components/reusables/NativeSelect";

import { useTranslationContext } from "@/contexts/TranslationContext";
import { GST_STATE_OPTIONS, normaliseGstin, validateGstin } from "@/lib/gst";
import { saveSupplier } from "@/lib/supplierStore";
import { EMPTY_SUPPLIER_DRAFT, validateSupplier, type Supplier, type SupplierDraft, type SupplierErrors } from "@/lib/suppliers";

const draftOf = (s: Supplier | null): SupplierDraft =>
    s
        ? {
              name: s.name,
              contactPerson: s.contactPerson,
              email: s.email,
              phone: s.phone,
              address: s.address,
              city: s.city,
              zipCode: s.zipCode,
              country: s.country,
              state: s.state,
              gstin: s.gstin,
              pan: s.pan,
              paymentTermsDays: s.paymentTermsDays,
              currency: s.currency,
              openingBalance: s.openingBalance,
              notes: s.notes,
          }
        : EMPTY_SUPPLIER_DRAFT;

/** Create or edit a supplier. `supplier` null means create. */
const SupplierFormDialog = ({
    open,
    supplier,
    existing,
    onClose,
}: {
    open: boolean;
    supplier: Supplier | null;
    existing: Supplier[];
    onClose: (saved?: Supplier) => void;
}) => {
    const { _t } = useTranslationContext();
    const [draft, setDraft] = useState<SupplierDraft>(EMPTY_SUPPLIER_DRAFT);
    const [errors, setErrors] = useState<SupplierErrors>({});
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (open) {
            setDraft(draftOf(supplier));
            setErrors({});
        }
    }, [open, supplier]);

    const set = <K extends keyof SupplierDraft>(key: K, value: SupplierDraft[K]) => {
        setDraft((d) => ({ ...d, [key]: value }));
        setErrors((e) => ({ ...e, [key]: undefined }));
    };

    const gst = useMemo(() => (normaliseGstin(draft.gstin) ? validateGstin(draft.gstin) : null), [draft.gstin]);
    const err = (k: keyof SupplierErrors) => (errors[k] ? _t(`suppliers.errors.${errors[k]}`) : undefined);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        const found = validateSupplier(draft, existing, supplier?.id);
        if (Object.keys(found).length > 0) {
            setErrors(found);
            return;
        }
        setBusy(true);
        const result = await saveSupplier(draft, supplier?.id);
        setBusy(false);
        if (result.ok) {
            toast({ title: _t("suppliers.toast.saved"), description: result.supplier.name });
            onClose(result.supplier);
        } else if ("errors" in result) setErrors(result.errors);
        else toast({ variant: "destructive", title: _t("limit" in result ? "suppliers.toast.limit" : "suppliers.toast.storage") });
    };

    return (
        <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-h-[92dvh] max-w-2xl overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{_t(supplier ? "suppliers.form.titleEdit" : "suppliers.form.titleNew")}</DialogTitle>
                    <DialogDescription className="sr-only">{_t("suppliers.subtitle")}</DialogDescription>
                </DialogHeader>

                <form onSubmit={submit} className="space-y-6" noValidate data-testid="supplier-form">
                    <fieldset className="grid gap-4 sm:grid-cols-2">
                        <legend className="mb-2 text-sm font-semibold">{_t("suppliers.form.sectionContact")}</legend>
                        <Field id="sup-name" label={_t("suppliers.form.name")} error={err("name")} className="sm:col-span-2">
                            <Input id="sup-name" data-testid="supplier-name" value={draft.name} maxLength={120} autoFocus aria-invalid={!!errors.name} onChange={(e) => set("name", e.target.value)} />
                        </Field>
                        <Field id="sup-contact" label={_t("suppliers.form.contactPerson")}>
                            <Input id="sup-contact" value={draft.contactPerson} maxLength={80} onChange={(e) => set("contactPerson", e.target.value)} />
                        </Field>
                        <Field id="sup-email" label={_t("suppliers.form.email")} error={err("email")}>
                            <Input id="sup-email" type="email" inputMode="email" value={draft.email} aria-invalid={!!errors.email} onChange={(e) => set("email", e.target.value)} />
                        </Field>
                        <Field id="sup-phone" label={_t("suppliers.form.phone")}>
                            <Input id="sup-phone" type="tel" inputMode="tel" value={draft.phone} maxLength={50} onChange={(e) => set("phone", e.target.value)} />
                        </Field>
                        <Field id="sup-address" label={_t("suppliers.form.address")}>
                            <Input id="sup-address" value={draft.address} maxLength={120} onChange={(e) => set("address", e.target.value)} />
                        </Field>
                        <Field id="sup-city" label={_t("suppliers.form.city")}>
                            <Input id="sup-city" value={draft.city} maxLength={50} onChange={(e) => set("city", e.target.value)} />
                        </Field>
                        <Field id="sup-zip" label={_t("suppliers.form.zipCode")}>
                            <Input id="sup-zip" value={draft.zipCode} maxLength={20} onChange={(e) => set("zipCode", e.target.value)} />
                        </Field>
                        <Field id="sup-country" label={_t("suppliers.form.country")}>
                            <Input id="sup-country" value={draft.country} maxLength={70} onChange={(e) => set("country", e.target.value)} />
                        </Field>
                    </fieldset>

                    <fieldset className="grid gap-4 sm:grid-cols-2">
                        <legend className="mb-2 text-sm font-semibold">{_t("suppliers.form.sectionTax")}</legend>
                        <Field
                            id="sup-gstin"
                            label={_t("suppliers.form.gstin")}
                            error={err("gstin")}
                            hint={gst?.valid ? _t("suppliers.form.gstinOk", { state: gst.stateName }) : _t("suppliers.form.gstinHint")}
                        >
                            <Input
                                id="sup-gstin"
                                data-testid="supplier-gstin"
                                value={draft.gstin}
                                maxLength={15}
                                autoCapitalize="characters"
                                className="font-mono uppercase"
                                aria-invalid={!!errors.gstin}
                                onChange={(e) => set("gstin", normaliseGstin(e.target.value))}
                            />
                        </Field>
                        <Field id="sup-state" label={_t("suppliers.form.state")} error={err("state")}>
                            <NativeSelect id="sup-state" data-testid="supplier-state" value={gst?.valid ? gst.stateCode : draft.state} disabled={!!gst?.valid} aria-invalid={!!errors.state} onChange={(e) => set("state", e.target.value)}>
                                <option value="">{gst?.valid ? _t("suppliers.form.stateAuto") : _t("suppliers.form.stateChoose")}</option>
                                {GST_STATE_OPTIONS.map((s) => (
                                    <option key={s.code} value={s.code}>
                                        {s.label}
                                    </option>
                                ))}
                            </NativeSelect>
                        </Field>
                        <Field id="sup-pan" label={_t("suppliers.form.pan")} error={err("pan")}>
                            <Input id="sup-pan" value={draft.pan} maxLength={10} className="font-mono uppercase" aria-invalid={!!errors.pan} onChange={(e) => set("pan", e.target.value.toUpperCase())} />
                        </Field>
                    </fieldset>

                    <fieldset className="grid gap-4 sm:grid-cols-3">
                        <legend className="mb-2 text-sm font-semibold">{_t("suppliers.form.sectionTerms")}</legend>
                        <Field id="sup-terms" label={_t("suppliers.form.terms")} error={err("paymentTermsDays")}>
                            <Input id="sup-terms" data-testid="supplier-terms" type="number" min={0} max={365} step={1} inputMode="numeric" value={draft.paymentTermsDays} aria-invalid={!!errors.paymentTermsDays} onChange={(e) => set("paymentTermsDays", e.target.value)} />
                        </Field>
                        <Field id="sup-currency" label={_t("suppliers.form.currency")} error={err("currency")}>
                            <Input id="sup-currency" value={draft.currency} maxLength={3} className="uppercase" aria-invalid={!!errors.currency} onChange={(e) => set("currency", e.target.value.toUpperCase())} />
                        </Field>
                        <Field id="sup-opening" label={_t("suppliers.form.opening")} error={err("openingBalance")} hint={_t("suppliers.form.openingHint")}>
                            <Input id="sup-opening" type="number" min={0} step="0.01" inputMode="decimal" value={draft.openingBalance} aria-invalid={!!errors.openingBalance} onChange={(e) => set("openingBalance", e.target.value)} />
                        </Field>
                        <Field id="sup-notes" label={_t("suppliers.form.notes")} className="sm:col-span-3">
                            <Textarea id="sup-notes" rows={3} maxLength={1000} value={draft.notes} onChange={(e) => set("notes", e.target.value)} />
                        </Field>
                    </fieldset>

                    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                        <BaseButton variant="outline" onClick={() => onClose()}>
                            {_t("suppliers.form.cancel")}
                        </BaseButton>
                        <BaseButton type="submit" loading={busy} data-testid="supplier-save">
                            {_t("suppliers.form.save")}
                        </BaseButton>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
};

export default SupplierFormDialog;
