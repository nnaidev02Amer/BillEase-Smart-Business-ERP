"use client";

import React, {
    SetStateAction,
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
} from "react";

// RHF
import { useFormContext, useWatch } from "react-hook-form";

// Helpers
import { fetchCurrencyDetails, formatPriceToString } from "@/lib/helpers";
import { computeTotals } from "@/lib/calculations";
import { computeGst, supplyTypeOf } from "@/lib/gst";

// Types
import { InvoiceType, ItemType } from "@/types";

const defaultChargesContext = {
    discountSwitch: false,
    setDiscountSwitch: (newValue: boolean) => {},
    taxSwitch: false,
    setTaxSwitch: (newValue: boolean) => {},
    shippingSwitch: false,
    setShippingSwitch: (newValue: boolean) => {},
    discountType: "amount",
    setDiscountType: (newValue: SetStateAction<string>) => {},
    taxType: "amount",
    setTaxType: (newValue: SetStateAction<string>) => {},
    shippingType: "amount",
    setShippingType: (newValue: SetStateAction<string>) => {},
    totalInWordsSwitch: true,
    setTotalInWordsSwitch: (newValue: boolean) => {},
    currency: "USD",
    subTotal: 0,
    totalAmount: 0,
    calculateTotal: () => {},
};

export const ChargesContext = createContext(defaultChargesContext);

export const useChargesContext = () => {
    return useContext(ChargesContext);
};

type ChargesContextProps = {
    children: React.ReactNode;
};

export const ChargesContextProvider = ({ children }: ChargesContextProps) => {
    const { control, setValue, getValues } = useFormContext<InvoiceType>();

    // Form Fields
    const itemsArray = useWatch({
        name: `details.items`,
        control,
    });

    const currency = useWatch({
        name: `details.currency`,
        control,
    });

    // GST. Primitives only, for the same reason as the charge amounts below:
    // calculateTotal writes into details.gst, so depending on the object would
    // loop.
    const gstEnabled = useWatch({ name: `details.gst.enabled`, control }) === true;
    const gstPricing = useWatch({ name: `details.gst.pricing`, control });
    const placeOfSupply = useWatch({ name: `details.gst.placeOfSupply`, control });
    const sellerGstin = useWatch({ name: `sender.gstin`, control });

    // Charges
    const charges = {
        discount: useWatch({ name: `details.discountDetails`, control }) || {
            amount: 0,
            amountType: "amount",
        },
        tax: useWatch({ name: `details.taxDetails`, control }) || {
            amount: 0,
            amountType: "amount",
        },
        shipping: useWatch({ name: `details.shippingDetails`, control }) || {
            cost: 0,
            costType: "amount",
        },
    };

    const { discount, tax, shipping } = charges;

    // Switch states. On/Off
    const [discountSwitch, setDiscountSwitch] = useState<boolean>(
        discount?.amount ? true : false
    );
    const [taxSwitch, setTaxSwitch] = useState<boolean>(
        tax?.amount ? true : false
    );
    const [shippingSwitch, setShippingSwitch] = useState<boolean>(
        shipping?.cost ? true : false
    );

    // ? Old approach of using totalInWords variable
    // totalInWords ? true : false
    const [totalInWordsSwitch, setTotalInWordsSwitch] = useState<boolean>(true);

    // Initial subtotal and total
    const [subTotal, setSubTotal] = useState<number>(0);
    const [totalAmount, setTotalAmount] = useState<number>(0);

    // Types for discount, tax, and shipping. Amount | Percentage
    const [discountType, setDiscountType] = useState("amount");
    const [taxType, setTaxType] = useState("amount");
    const [shippingType, setShippingType] = useState("amount");

    // When loading invoice, if received values, turn on the switches
    useEffect(() => {
        if (discount?.amount) {
            setDiscountSwitch(true);
        }

        if (tax?.amount) {
            setTaxSwitch(true);
        }

        if (shipping?.cost) {
            setShippingSwitch(true);
        }

        if (discount?.amountType == "amount") {
            setDiscountType("amount");
        } else {
            setDiscountType("percentage");
        }

        if (tax?.amountType == "amount") {
            setTaxType("amount");
        } else {
            setTaxType("percentage");
        }

        if (shipping?.costType == "amount") {
            setShippingType("amount");
        } else {
            setShippingType("percentage");
        }
    }, [discount?.amount, tax?.amount, shipping?.cost]);

    // Check switches, if off set values to zero
    useEffect(() => {
        if (!discountSwitch) {
            setValue("details.discountDetails.amount", 0);
        }

        if (!taxSwitch) {
            setValue("details.taxDetails.amount", 0);
        }

        if (!shippingSwitch) {
            setValue("details.shippingDetails.cost", 0);
        }
    }, [discountSwitch, taxSwitch, shippingSwitch]);

    /**
     * Calculates the subtotal, total, and the total amount in words on the invoice.
     */
    const calculateTotal = useCallback(() => {
        // Here Number(item.total) fixes a bug where an extra zero appears
        // at the beginning of subTotal caused by toFixed(2) in item.total in single item
        // Reason: toFixed(2) returns string, not a number instance
        const totalSum: number = itemsArray.reduce(
            (sum: number, item: ItemType) => sum + Number(item.total),
            0
        );

        setValue("details.subTotal", totalSum);
        setSubTotal(totalSum);

        /*
         * Arithmetic lives in lib/calculations so it is one tested function
         * rather than inline mutation. It rounds to the currency's decimals
         * (0.1 + 0.2 no longer yields 0.30000000000000004) and refuses to let a
         * discount push the total below zero, which the schema would otherwise
         * reject with an unhelpful message.
         */
        const decimals = fetchCurrencyDetails(currency)?.decimals ?? 2;
        const totals = computeTotals({
            subTotal: totalSum,
            discount: { value: discount?.amount, type: discountType },
            tax: { value: gstEnabled ? 0 : tax?.amount, type: taxType },
            shipping: { value: shipping?.cost, type: shippingType },
            decimals,
        });
        let total = totals.total;

        /*
         * GST replaces the single flat "tax" charge. Discount and shipping keep
         * their meaning; tax is derived per line from each item's GST rate.
         * When GST is on but incomplete (no seller GSTIN / place of supply yet)
         * the invoice falls back to the plain calculation and the schema blocks
         * saving until the missing fields are filled in.
         */
        const supply = gstEnabled ? supplyTypeOf(sellerGstin, placeOfSupply) : null;
        if (gstEnabled && supply) {
            const gstResult = computeGst({
                lines: (itemsArray as ItemType[]).map((item) => ({
                    amount: Number(item.total) || 0,
                    rate: item.gstRate ?? 0,
                    hsn: item.hsn,
                    quantity: Number(item.quantity) || 0,
                })),
                pricing: gstPricing === "inclusive" ? "inclusive" : "exclusive",
                supply,
                discount: { value: discount?.amount, type: discountType },
                shipping: { value: shipping?.cost, type: shippingType },
                decimals,
            });
            total = gstResult.total;
            setValue("details.gst.taxableValue", gstResult.taxableValue);
            setValue("details.gst.cgst", gstResult.cgst);
            setValue("details.gst.sgst", gstResult.sgst);
            setValue("details.gst.igst", gstResult.igst);
            setValue("details.gst.totalTax", gstResult.totalTax);
        } else if (!gstEnabled && getValues("details.gst.totalTax")) {
            // GST was switched off: drop the derived figures so nothing stale
            // is printed or exported.
            setValue("details.gst.taxableValue", 0);
            setValue("details.gst.cgst", 0);
            setValue("details.gst.sgst", 0);
            setValue("details.gst.igst", 0);
            setValue("details.gst.totalTax", 0);
        }

        const discountAmount = parseFloat(String(discount?.amount));
        // With GST on, the flat tax charge is not used (the UI hides it).
        const taxAmount = gstEnabled ? 0 : parseFloat(String(tax?.amount));
        const shippingCost = parseFloat(String(shipping?.cost));

        const discountAmountType = discountType == "amount" ? "amount" : "percentage";
        const taxAmountType = taxType == "amount" ? "amount" : "percentage";
        const shippingCostType = shippingType == "amount" ? "amount" : "percentage";

        if (!isNaN(discountAmount)) setValue("details.discountDetails.amount", discountAmount);
        if (!isNaN(taxAmount)) setValue("details.taxDetails.amount", taxAmount);
        if (!isNaN(shippingCost)) setValue("details.shippingDetails.cost", shippingCost);

        setTotalAmount(total);

        setValue("details.discountDetails.amountType", discountAmountType);
        setValue("details.taxDetails.amountType", taxAmountType);
        setValue("details.shippingDetails.costType", shippingCostType);

        setValue("details.totalAmount", total);
        
        if (totalInWordsSwitch) {
            setValue("details.totalAmountInWords", formatPriceToString(total, getValues("details.currency")));
        } else {
            setValue("details.totalAmountInWords", "");
        }
        /*
         * These deps are deliberately the primitive amounts, not the
         * discount/tax/shipping objects.
         *
         * calculateTotal calls setValue on those same sub-objects, so useWatch
         * hands back a fresh object identity on every run. Depending on the
         * objects therefore re-memoises the callback, re-fires the effect
         * below, and loops until React throws "Maximum update depth exceeded".
         * The primitives only change when a value genuinely changes.
         */
    }, [
        itemsArray,
        discount?.amount,
        tax?.amount,
        shipping?.cost,
        discountType,
        taxType,
        shippingType,
        totalInWordsSwitch,
        gstEnabled,
        gstPricing,
        placeOfSupply,
        sellerGstin,
        // read via getValues inside, but a change must still recalculate
        currency,
        setValue,
        getValues,
    ]);

    // Calculate total when values change. calculateTotal is memoised on
    // exactly those values, so depending on its identity keeps this in step
    // rather than duplicating the dependency list in two places.
    useEffect(() => {
        calculateTotal();
    }, [calculateTotal]);


    /*
     * Memoised: this object was rebuilt on every render, so every consumer of
     * useChargesContext re-rendered on each keystroke anywhere in the form.
     * The setters from useState are already stable identities.
     */
    const contextValue = useMemo(
        () => ({
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
            calculateTotal,
        }),
        [
            discountSwitch,
            taxSwitch,
            shippingSwitch,
            discountType,
            taxType,
            shippingType,
            totalInWordsSwitch,
            currency,
            subTotal,
            totalAmount,
            calculateTotal,
        ]
    );

    return (
        <ChargesContext.Provider value={contextValue}>
            {children}
        </ChargesContext.Provider>
    );
};
