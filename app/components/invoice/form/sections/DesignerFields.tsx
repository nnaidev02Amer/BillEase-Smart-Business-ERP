"use client";

import { useFormContext } from "react-hook-form";

import { FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import FormInput from "@/app/components/reusables/form-fields/FormInput";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { PAPER_SIZES, type InvoicePaper } from "@/app/components/templates/invoice-pdf/invoiceTheme";

import { fieldControl, fieldLabel, fieldRow } from "@/app/components/reusables/form-fields/fieldStyles";

const FREQUENCIES = ["none", "weekly", "monthly", "quarterly", "yearly"] as const;

/**
 * Page and brand options that sit beside the template gallery: paper size, a
 * custom header and footer, and the recurring schedule. Colour, typeface,
 * density and logo already have their own controls; these are the rest of what
 * makes an invoice "yours".
 */
const DesignerFields = () => {
    const { control, watch } = useFormContext();
    const { _t } = useTranslationContext();
    const frequency = watch("details.recurring.frequency") ?? "none";

    return (
        <div className="flex min-w-0 flex-col gap-3 border-t border-border pt-5">
            <p className="text-sm font-semibold">{_t("designer.page")}</p>

            <FormField
                control={control}
                name="details.theme.paper"
                render={({ field }) => (
                    <FormItem>
                        <div className={fieldRow}>
                            <FormLabel className={fieldLabel}>{_t("designer.paper")}:</FormLabel>
                            <div className={fieldControl}>
                                <Select value={field.value ?? "a4"} onValueChange={field.onChange}>
                                    <FormControl>
                                        <SelectTrigger className="w-full">
                                            <SelectValue />
                                        </SelectTrigger>
                                    </FormControl>
                                    <SelectContent>
                                        {(Object.keys(PAPER_SIZES) as InvoicePaper[]).map((p) => (
                                            <SelectItem key={p} value={p}>
                                                {PAPER_SIZES[p].label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <FormMessage />
                            </div>
                        </div>
                    </FormItem>
                )}
            />

            <FormInput
                name="details.theme.headerText"
                label={_t("designer.header")}
                placeholder={_t("designer.headerPlaceholder")}
                maxLength={200}
            />
            <FormInput
                name="details.theme.footerText"
                label={_t("designer.footer")}
                placeholder={_t("designer.footerPlaceholder")}
                maxLength={300}
            />

            <p className="mt-2 text-sm font-semibold">{_t("designer.recurring")}</p>
            <FormField
                control={control}
                name="details.recurring.frequency"
                render={({ field }) => (
                    <FormItem>
                        <div className={fieldRow}>
                            <FormLabel className={fieldLabel}>{_t("designer.repeat")}:</FormLabel>
                            <div className={fieldControl}>
                                <Select value={field.value ?? "none"} onValueChange={field.onChange}>
                                    <FormControl>
                                        <SelectTrigger className="w-full">
                                            <SelectValue />
                                        </SelectTrigger>
                                    </FormControl>
                                    <SelectContent>
                                        {FREQUENCIES.map((f) => (
                                            <SelectItem key={f} value={f}>
                                                {_t(`designer.frequency.${f}`)}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <FormMessage />
                            </div>
                        </div>
                    </FormItem>
                )}
            />
            {frequency !== "none" && (
                <>
                    <FormInput
                        name="details.recurring.endDate"
                        label={_t("designer.endDate")}
                        type="date"
                        placeholder="yyyy-mm-dd"
                    />
                    <p className="text-xs text-muted-foreground">{_t("designer.recurringHint")}</p>
                </>
            )}
        </div>
    );
};

export default DesignerFields;
