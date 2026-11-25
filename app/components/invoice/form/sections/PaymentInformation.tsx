"use client";

// Components
import FormInput from "@/app/components/reusables/form-fields/FormInput";
import FormTextarea from "@/app/components/reusables/form-fields/FormTextarea";
import Subheading from "@/app/components/reusables/Subheading";

// Contexts
import { useTranslationContext } from "@/contexts/TranslationContext";

const PaymentInformation = () => {
    const { _t } = useTranslationContext();
    return (
        <section>
            <Subheading>{_t("form.steps.paymentInfo.heading")}:</Subheading>
            <div className="mt-5 grid grid-cols-1 gap-5 @xl:grid-cols-2">
                <FormInput
                    name="details.paymentInformation.bankName"
                    label={_t("form.steps.paymentInfo.bankName")}
                    placeholder={_t("form.steps.paymentInfo.bankName")}
                    vertical
                />
                <FormInput
                    name="details.paymentInformation.accountName"
                    label={_t("form.steps.paymentInfo.accountName")}
                    placeholder={_t("form.steps.paymentInfo.accountName")}
                    vertical
                />
                <FormInput
                    name="details.paymentInformation.accountNumber"
                    label={_t("form.steps.paymentInfo.accountNumber")}
                    placeholder={_t("form.steps.paymentInfo.accountNumber")}
                    vertical
                />
                <div className="@xl:col-span-2">
                    <FormTextarea
                        name="details.paymentInstructions"
                        label={_t("designer.paymentInstructions")}
                        placeholder={_t("designer.paymentInstructionsPlaceholder")}
                        maxLength={1000}
                    />
                </div>
            </div>
        </section>
    );
};

export default PaymentInformation;
