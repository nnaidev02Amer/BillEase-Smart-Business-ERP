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

export type SelectOption = { value: string; label: string };

type FormSelectProps = {
    name: string;
    label?: string;
    options: SelectOption[];
    placeholder?: string;
    /** Converts the stored value to the string the select works in. */
    toValue?: (stored: unknown) => string;
    /** Converts the chosen string back to the stored value. */
    fromValue?: (chosen: string) => unknown;
    disabled?: boolean;
};

/**
 * A react-hook-form bound select, stacked label-over-control. Values are
 * strings in the UI; `toValue` / `fromValue` bridge to numbers or booleans
 * when the stored field is not a string.
 */
const FormSelect = ({
    name,
    label,
    options,
    placeholder,
    toValue = (v) => (v === undefined || v === null ? "" : String(v)),
    fromValue = (v) => v,
    disabled,
}: FormSelectProps) => {
    const { control } = useFormContext();

    return (
        <FormField
            control={control}
            name={name}
            render={({ field }) => (
                <FormItem className="w-full min-w-0">
                    {label && <FormLabel>{`${label}:`}</FormLabel>}
                    <Select
                        value={toValue(field.value)}
                        onValueChange={(v) => field.onChange(fromValue(v))}
                        disabled={disabled}
                    >
                        <FormControl>
                            <SelectTrigger className="w-full">
                                <SelectValue placeholder={placeholder} />
                            </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                            {options.map((o) => (
                                <SelectItem key={o.value} value={o.value}>
                                    {o.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <FormMessage />
                </FormItem>
            )}
        />
    );
};

export default FormSelect;
