"use client";

// RHF
import { useFieldArray, useFormContext } from "react-hook-form";

// Components
import BaseButton from "@/app/components/reusables/BaseButton";
import PartyPicker from "@/app/components/invoice/form/PartyPicker";
import FormCustomInput from "@/app/components/reusables/form-fields/FormCustomInput";
import FormInput from "@/app/components/reusables/form-fields/FormInput";
import Subheading from "@/app/components/reusables/Subheading";

import GstinField from "@/app/components/reusables/form-fields/GstinField";

// Contexts
import { useTranslationContext } from "@/contexts/TranslationContext";

// Icons
import { Plus } from "lucide-react";

const BillToSection = () => {
    const { control } = useFormContext();

    const { _t } = useTranslationContext();

    const CUSTOM_INPUT_NAME = "receiver.customInputs";

    const { fields, append, remove } = useFieldArray({
        control: control,
        name: CUSTOM_INPUT_NAME,
    });

    const addNewCustomInput = () => {
        append({
            key: "",
            value: "",
        });
    };

    const removeCustomInput = (index: number) => {
        remove(index);
    };

    return (
        <section className="flex flex-col gap-3">
            <Subheading>{_t("form.steps.fromAndTo.billTo")}:</Subheading>

            {/* Save this client, or fill the fields from one saved before. */}
            <PartyPicker kind="receiver" />

            <FormInput
                name="receiver.name"
                label={_t("form.steps.fromAndTo.name")}
                placeholder="Receiver name"
            />
            <FormInput
                name="receiver.address"
                label={_t("form.steps.fromAndTo.address")}
                placeholder="Receiver address"
            />
            <FormInput
                name="receiver.zipCode"
                label={_t("form.steps.fromAndTo.zipCode")}
                placeholder="Receiver zip code"
            />
            <FormInput
                name="receiver.city"
                label={_t("form.steps.fromAndTo.city")}
                placeholder="Receiver city"
            />
            <FormInput
                name="receiver.country"
                label={_t("form.steps.fromAndTo.country")}
                placeholder="Receiver country"
            />
            <FormInput
                name="receiver.email"
                label={_t("form.steps.fromAndTo.email")}
                placeholder="Receiver email"
            />
            <FormInput
                name="receiver.phone"
                label={_t("form.steps.fromAndTo.phone")}
                placeholder="Receiver phone number"
                type="text"
                inputMode="tel"
                pattern="[0-9+\-\(\)\s]*"
                aria-describedby="phone-format"
                onInput={(e) => {
                    const target = e.target as HTMLInputElement;
                    target.value = target.value.replace(/[^\d\+\-\(\)\s]/g, "");
                }}
            />
            <GstinField name="receiver.gstin" label={_t("gst.gstin")} />
            {/* Optional: printed as "Ship to" only when something is filled in. */}
            <details className="rounded-md border border-border px-3 py-2 text-sm [&_summary]:cursor-pointer">
                <summary className="font-medium">{_t("designer.shippingAddress")}</summary>
                <div className="mt-3 flex flex-col gap-3">
                    <FormInput name="receiver.shippingAddress.address" label={_t("form.steps.fromAndTo.address")} placeholder="Shipping address" />
                    <FormInput name="receiver.shippingAddress.zipCode" label={_t("form.steps.fromAndTo.zipCode")} placeholder="Shipping zip code" />
                    <FormInput name="receiver.shippingAddress.city" label={_t("form.steps.fromAndTo.city")} placeholder="Shipping city" />
                    <FormInput name="receiver.shippingAddress.country" label={_t("form.steps.fromAndTo.country")} placeholder="Shipping country" />
                </div>
            </details>
            {/* //? key = field.id fixes a bug where wrong field gets deleted  */}
            {fields?.map((field, index) => (
                <FormCustomInput
                    key={field.id}
                    index={index}
                    location={CUSTOM_INPUT_NAME}
                    removeField={removeCustomInput}
                />
            ))}
            <BaseButton
                tooltipLabel="Add custom input to receiver"
                size="sm"
                variant="link"
                className="w-fit"
                onClick={addNewCustomInput}
            >
                <Plus />
                {_t("form.steps.fromAndTo.addCustomInput")}
            </BaseButton>
        </section>
    );
};

export default BillToSection;
