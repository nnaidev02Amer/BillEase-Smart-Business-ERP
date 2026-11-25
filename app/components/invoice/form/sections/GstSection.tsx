"use client";

import { useEffect } from "react";
import { useFormContext, useWatch } from "react-hook-form";

import { Switch } from "@/components/ui/switch";

import FormSelect from "@/app/components/reusables/form-fields/FormSelect";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { GST_STATE_OPTIONS, stateOfGstin, supplyTypeOf } from "@/lib/gst";
import type { InvoiceType } from "@/types";

/**
 * Per-invoice GST switch and settings.
 *
 * The supplier's GSTIN (Bill From) decides the supplier state; the place of
 * supply decides whether the sale is intra-state (CGST + SGST) or inter-state
 * (IGST). Line-level HSN/SAC and rate live on each item.
 */
const GstSection = () => {
    const { control, setValue, getValues } = useFormContext<InvoiceType>();
    const { _t } = useTranslationContext();

    const enabled = useWatch({ control, name: "details.gst.enabled" }) === true;
    const placeOfSupply = useWatch({ control, name: "details.gst.placeOfSupply" });
    const reverseCharge = useWatch({ control, name: "details.gst.reverseCharge" }) === true;
    const sellerGstin = useWatch({ control, name: "sender.gstin" });
    const buyerGstin = useWatch({ control, name: "receiver.gstin" });

    // Suggest a place of supply once GST is on: the buyer's state if their
    // GSTIN is known, otherwise the supplier's own. Only fills an empty field.
    useEffect(() => {
        if (!enabled || placeOfSupply) return;
        const guess = stateOfGstin(buyerGstin) ?? stateOfGstin(sellerGstin);
        if (guess) setValue("details.gst.placeOfSupply", guess, { shouldDirty: true });
    }, [enabled, placeOfSupply, buyerGstin, sellerGstin, setValue]);

    const supply = enabled ? supplyTypeOf(sellerGstin, placeOfSupply) : null;

    return (
        <div className="rounded-lg border border-border p-3">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-sm font-medium">{_t("gst.heading")}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{_t("gst.enableHelp")}</p>
                </div>
                <Switch
                    checked={enabled}
                    onCheckedChange={(on) => {
                        setValue("details.gst.enabled", on, { shouldDirty: true, shouldValidate: false });
                        if (!getValues("details.gst.pricing")) setValue("details.gst.pricing", "exclusive");
                    }}
                    aria-label={_t("gst.enable")}
                />
            </div>

            {enabled && (
                <div className="mt-4 flex flex-col gap-3">
                    <FormSelect
                        name="details.gst.pricing"
                        label={_t("gst.pricing")}
                        options={[
                            { value: "exclusive", label: _t("gst.exclusive") },
                            { value: "inclusive", label: _t("gst.inclusive") },
                        ]}
                    />
                    <FormSelect
                        name="details.gst.placeOfSupply"
                        label={_t("gst.placeOfSupply")}
                        placeholder={_t("gst.placeOfSupplyPlaceholder")}
                        options={GST_STATE_OPTIONS.map((s) => ({ value: s.code, label: s.label }))}
                    />
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-sm">{_t("gst.reverseCharge")}</span>
                        <Switch
                            checked={reverseCharge}
                            onCheckedChange={(on) =>
                                setValue("details.gst.reverseCharge", on, { shouldDirty: true })
                            }
                            aria-label={_t("gst.reverseCharge")}
                        />
                    </div>
                    <p className="text-xs text-muted-foreground" data-testid="gst-supply-note">
                        {supply === "intra"
                            ? _t("gst.intra")
                            : supply === "inter"
                              ? _t("gst.inter")
                              : _t("gst.needSeller")}
                    </p>
                </div>
            )}
        </div>
    );
};

export default GstSection;
