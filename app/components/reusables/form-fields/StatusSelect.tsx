"use client";

import { useFormContext } from "react-hook-form";

import {
    FormControl,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from "@/components/ui/form";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";

import { useTranslationContext } from "@/contexts/TranslationContext";
import { INVOICE_STATUSES } from "@/lib/schemas";

import { fieldControl, fieldLabel, fieldRow } from "./fieldStyles";

/**
 * Lifecycle status of the invoice. "Overdue" is deliberately not an option: it
 * is derived from the due date, so storing it would only let it go stale.
 */
const StatusSelect = ({ label }: { label: string }) => {
    const { control } = useFormContext();
    const { _t } = useTranslationContext();

    return (
        <FormField
            control={control}
            name="details.status"
            render={({ field }) => (
                <FormItem>
                    <div className={fieldRow}>
                        <FormLabel className={fieldLabel}>{label}:</FormLabel>
                        <div className={fieldControl}>
                            <Select value={field.value ?? "pending"} onValueChange={field.onChange}>
                                <FormControl>
                                    <SelectTrigger className="w-full">
                                        <SelectValue />
                                    </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                    {INVOICE_STATUSES.map((s) => (
                                        <SelectItem key={s} value={s}>
                                            {_t(`dashboard.status.${s}`)}
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
    );
};

export default StatusSelect;
