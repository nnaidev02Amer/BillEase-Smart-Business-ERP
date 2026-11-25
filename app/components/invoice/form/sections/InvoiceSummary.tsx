"use client";

// Components
import Charges from "@/app/components/invoice/form/Charges";
import FormTextarea from "@/app/components/reusables/form-fields/FormTextarea";
import PaymentTermPresets from "@/app/components/invoice/form/PaymentTermPresets";
import SignatureModal from "@/app/components/modals/signature/SignatureModal";
import Subheading from "@/app/components/reusables/Subheading";

// Contexts
import { useTranslationContext } from "@/contexts/TranslationContext";
import { SignatureContextProvider } from "@/contexts/SignatureContext";

const InvoiceSummary = () => {
    const { _t } = useTranslationContext();

    return (
        <section>
            <Subheading>{_t("form.steps.summary.heading")}:</Subheading>
            <div className="mt-5 grid grid-cols-1 gap-x-8 gap-y-8">
                <div className="flex min-w-0 flex-col gap-3">
                    <SignatureContextProvider>
                        {/* Signature dialog */}
                        <SignatureModal />
                    </SignatureContextProvider>

                    {/* Additional notes & Payment terms */}
                    <FormTextarea
                        name="details.additionalNotes"
                        label={_t("form.steps.summary.additionalNotes")}
                        placeholder="Your additional notes"
                    />
                    <FormTextarea
                        name="details.terms"
                        label={_t("designer.terms")}
                        placeholder={_t("designer.termsPlaceholder")}
                        maxLength={2000}
                    />
                    <div className="flex flex-col gap-2">
                        <FormTextarea
                            name="details.paymentTerms"
                            label={_t("form.steps.summary.paymentTerms")}
                            placeholder="Ex: Net 30"
                        />
                        {/*
                         * Presets fill the field above rather than replacing
                         * it — the terms stay free text, they are just no
                         * longer something you have to type from memory in
                         * whatever language you happen to be working in.
                         */}
                        <PaymentTermPresets />
                    </div>
                </div>

                {/* Final charges */}
                <Charges />
            </div>
        </section>
    );
};

export default InvoiceSummary;
