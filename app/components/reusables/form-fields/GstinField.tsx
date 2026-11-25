"use client";

import { useFormContext, useWatch } from "react-hook-form";

import FormInput from "./FormInput";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { normaliseGstin, validateGstin } from "@/lib/gst";

/**
 * GSTIN input with live local validation.
 *
 * Upper-cases as you type and says whether the number is well-formed (state
 * code, PAN pattern, check character). It does not and cannot say whether the
 * number is registered — that needs the GST portal.
 */
const GstinField = ({ name, label }: { name: "sender.gstin" | "receiver.gstin"; label: string }) => {
    const { control } = useFormContext();
    const { _t } = useTranslationContext();
    const value = useWatch({ name, control }) as string | undefined;

    const trimmed = normaliseGstin(value);
    const check = trimmed ? validateGstin(trimmed) : null;

    return (
        <div className="flex flex-col gap-1">
            <FormInput
                name={name}
                label={label}
                placeholder={_t("gst.gstinPlaceholder")}
                maxLength={15}
                autoCapitalize="characters"
                spellCheck={false}
                onInput={(e) => {
                    const t = e.target as HTMLInputElement;
                    t.value = t.value.toUpperCase().replace(/[^0-9A-Z]/g, "");
                }}
            />
            {check && (
                <p
                    className={`text-xs ${check.valid ? "text-muted-foreground" : "text-destructive"}`}
                    role={check.valid ? undefined : "status"}
                >
                    {check.valid
                        ? _t("gst.gstinValid", { state: check.stateName })
                        : trimmed.length < 15
                          ? null
                          : _t("gst.gstinInvalid")}
                </p>
            )}
        </div>
    );
};

export default GstinField;
