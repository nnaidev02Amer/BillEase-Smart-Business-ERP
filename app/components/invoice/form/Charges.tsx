"use client";

// RHF
import { useFormContext, useWatch } from "react-hook-form";

// ShadCn
import { Switch } from "@/components/ui/switch";

// Components
import BaseButton from "@/app/components/reusables/BaseButton";
import ChargeInput from "@/app/components/reusables/form-fields/ChargeInput";

// Contexts
import { useChargesContext } from "@/contexts/ChargesContext";
import { useTranslationContext } from "@/contexts/TranslationContext";

// Helpers
import { formatNumberWithCommas } from "@/lib/helpers";

// Icons
import { Plus, X } from "lucide-react";

// Types
import { InvoiceType } from "@/types";

const Charges = () => {
    const {
        control,
        formState: { errors },
    } = useFormContext<InvoiceType>();

    const gst = useWatch({ control, name: "details.gst" });
    const gstOn = gst?.enabled === true;

    const { _t } = useTranslationContext();

    const {
        discountSwitch,
        setDiscountSwitch,
        taxSwitch,
        setTaxSwitch,
        shippingSwitch,
        setShippingSwitch,
        discountType,
        setDiscountType,
        taxType,
        setTaxType,
        shippingType,
        setShippingType,
        totalInWordsSwitch,
        setTotalInWordsSwitch,
        currency,
        subTotal,
        totalAmount,
    } = useChargesContext();

    const switchAmountType = (type: string, setType: (type: string) => void) => {
        if (type == "amount") {
            setType("percentage");
        } else {
            setType("amount");
        }
    };

    /*
     * Progressive disclosure.
     *
     * Discount, tax and shipping used to be three always-visible switches
     * sitting above the totals, so every invoice paid the visual cost of three
     * options most invoices never use. They are now "+ Add …" actions that
     * reveal the input, and each revealed row can be removed again.
     */
    const optional = [
        {
            key: "discount",
            label: _t("form.steps.summary.discount"),
            on: discountSwitch,
            setOn: setDiscountSwitch,
            name: "details.discountDetails.amount",
            type: discountType,
            setType: setDiscountType,
        },
        {
            key: "tax",
            label: _t("form.steps.summary.tax"),
            on: taxSwitch,
            setOn: setTaxSwitch,
            name: "details.taxDetails.amount",
            type: taxType,
            setType: setTaxType,
        },
        {
            key: "shipping",
            label: _t("form.steps.summary.shipping"),
            on: shippingSwitch,
            setOn: setShippingSwitch,
            name: "details.shippingDetails.cost",
            type: shippingType,
            setType: setShippingType,
        },
    ] as const;

    // With GST on, per-line GST replaces the single flat tax charge.
    const available = gstOn ? optional.filter((o) => o.key !== "tax") : optional;
    const hidden = available.filter((o) => !o.on);

    return (
        <div className="flex w-full min-w-0 flex-col gap-3">
            <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                    {_t("form.steps.summary.subTotal")}
                </span>
                <span className="tabular-nums">
                    {formatNumberWithCommas(subTotal)} {currency}
                </span>
            </div>

            {available
                .filter((o) => o.on)
                .map((o) => (
                    <div key={o.key} className="flex items-center gap-1">
                        <div className="min-w-0 flex-1">
                            <ChargeInput
                                label={o.label}
                                name={o.name}
                                switchAmountType={switchAmountType}
                                type={o.type}
                                setType={o.setType}
                                currency={currency}
                            />
                        </div>
                        <BaseButton
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                            aria-label={`${_t("form.steps.summary.remove")} ${o.label}`}
                            onClick={() => o.setOn(false)}
                        >
                            <X className="h-3.5 w-3.5" />
                        </BaseButton>
                    </div>
                ))}

            {hidden.length > 0 && (
                <div className="flex flex-wrap gap-x-4 gap-y-2 py-1">
                    {hidden.map((o) => (
                        <button
                            key={o.key}
                            type="button"
                            onClick={() => o.setOn(true)}
                            className="inline-flex items-center gap-1 text-sm font-medium text-primary transition-opacity hover:opacity-80"
                        >
                            <Plus className="h-3.5 w-3.5" />
                            {o.label}
                        </button>
                    ))}
                </div>
            )}

            {gstOn && (
                <div className="flex flex-col gap-1 rounded-md bg-muted/40 p-3 text-sm" data-testid="gst-breakdown">
                    {(
                        [
                            [_t("gst.taxableValue"), gst?.taxableValue, true],
                            [_t("gst.cgst"), gst?.cgst, Number(gst?.cgst) > 0],
                            [_t("gst.sgst"), gst?.sgst, Number(gst?.sgst) > 0],
                            [_t("gst.igst"), gst?.igst, Number(gst?.igst) > 0],
                        ] as [string, number | undefined, boolean][]
                    )
                        .filter(([, , show]) => show)
                        .map(([label, v]) => (
                            <div key={label} className="flex justify-between">
                                <span className="text-muted-foreground">{label}</span>
                                <span className="tabular-nums">
                                    {formatNumberWithCommas(Number(v ?? 0))} {currency}
                                </span>
                            </div>
                        ))}
                    <div className="flex justify-between font-medium">
                        <span>{_t("gst.totalTax")}</span>
                        <span className="tabular-nums">
                            {formatNumberWithCommas(Number(gst?.totalTax ?? 0))} {currency}
                        </span>
                    </div>
                </div>
            )}

            <div className="flex items-baseline justify-between border-t border-border pt-3">
                <span className="font-medium">
                    {_t("form.steps.summary.totalAmount")}
                </span>
                <div className="text-end">
                    <p className="text-lg font-semibold tabular-nums">
                        {formatNumberWithCommas(totalAmount)} {currency}
                    </p>
                    {errors.details?.totalAmount?.message && (
                        <small className="text-sm font-medium text-destructive">
                            {errors.details.totalAmount.message}
                        </small>
                    )}
                </div>
            </div>

            <div className="flex items-center justify-between gap-3 pt-1">
                <span className="text-sm text-muted-foreground">
                    {_t("form.steps.summary.includeTotalInWords")}
                </span>
                <Switch
                    checked={totalInWordsSwitch}
                    onCheckedChange={setTotalInWordsSwitch}
                    aria-label={_t("form.steps.summary.includeTotalInWords")}
                />
            </div>
        </div>
    );
};

export default Charges;
