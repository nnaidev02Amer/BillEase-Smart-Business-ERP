import { z } from "zod";

// Variables
import { DATE_OPTIONS, SIGNATURE_FONTS } from "@/lib/variables";
import { gstIssues } from "@/lib/gst";

/**
 * Roughly 2MB of binary once base64-decoded — generous for a logo, but bounded.
 */
const MAX_LOGO_CHARS = 3_000_000;

/**
 * The logo is rendered as `<img src>` inside the HTML handed to Puppeteer, so
 * an arbitrary URL here means the server fetches it — a straightforward SSRF
 * into cloud metadata endpoints or internal services. The app only ever
 * produces base64 data URLs (see FormFile), so anything else is rejected.
 */
const imageDataUrl = z
    .string()
    .max(MAX_LOGO_CHARS, { message: "Logo is too large" })
    .refine((value) => value === "" || /^data:image\/[a-z0-9.+-]+;base64,/i.test(value), {
        message: "Logo must be an embedded image",
    });

/**
 * Removes characters that have no business in an invoice: C0/C1 controls (except
 * tab and newline) and the bidirectional override/isolate characters, which can
 * make text display as something other than what it is. Output is always
 * escaped by React / renderToStaticMarkup, so this is defence in depth and a
 * data-quality rule rather than the XSS control.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;
export const stripControlChars = (value: string) => value.replace(CONTROL_CHARS, "");

/** A bounded, cleaned free-text field. */
const cleanText = (max: number) =>
    z
        .string()
        .max(max, { message: `Must be at most ${max} characters` })
        .transform(stripControlChars);

// TODO: Refactor some of the validators. Ex: name and zipCode or address and country have same rules
// Field Validators
const fieldValidators = {
    name: z
        .string()
        .min(2, { message: "Must be at least 2 characters" })
        .max(50, { message: "Must be at most 50 characters" }),
    address: z
        .string()
        .min(2, { message: "Must be at least 2 characters" })
        .max(70, { message: "Must be between 2 and 70 characters" }),
    zipCode: z
        .string()
        .min(2, { message: "Must be between 2 and 20 characters" })
        .max(20, { message: "Must be between 2 and 20 characters" }),
    city: z
        .string()
        .min(1, { message: "Must be between 1 and 50 characters" })
        .max(50, { message: "Must be between 1 and 50 characters" }),
    country: z
        .string()
        .min(1, { message: "Must be between 1 and 70 characters" })
        .max(70, { message: "Must be between 1 and 70 characters" }),
    email: z
        .string()
        .email({ message: "Email must be a valid email" })
        .min(5, { message: "Must be between 5 and 254 characters" })
        // 254 is the RFC 5321 limit. The old cap of 30 rejected ordinary
        // business addresses.
        .max(254, { message: "Must be between 5 and 254 characters" }),
    phone: z
        .string()
        .min(1, { message: "Must be between 1 and 50 characters" })
        .max(50, {
            message: "Must be between 1 and 50 characters",
        }),

    /*
     * Dates.
     *
     * On the client react-hook-form holds real Date objects, but JSON has no
     * date type — over the wire these arrive as ISO strings. A bare `z.date()`
     * therefore passes in the browser and fails on the server, so accept both
     * and normalise. The `.pipe` keeps the existing display-string transform.
     */
    date: z
        .union([z.date(), z.string(), z.number()])
        .pipe(z.coerce.date())
        .transform((date) =>
            new Date(date).toLocaleDateString("en-US", DATE_OPTIONS)
        ),

    // Items
    quantity: z.coerce
        .number()
        .gt(0, { message: "Must be a number greater than 0" }),
    unitPrice: z.coerce
        .number()
        .gt(0, { message: "Must be a number greater than 0" })
        .lte(Number.MAX_SAFE_INTEGER, { message: `Must be ≤ ${Number.MAX_SAFE_INTEGER}` }),

    // Strings
    string: z.string(),
    stringMin1: z.string().min(1, { message: "Must be at least 1 character" }),
    stringToNumber: z.coerce.number(),

    // Charges
    stringToNumberWithMax: z.coerce
        .number()
        .min(0, { message: "Must be 0 or more" })
        .max(1000000, { message: "Must be at most 1,000,000" }),

    stringOptional: z.string().optional(),

    nonNegativeNumber: z.coerce.number().nonnegative({
        message: "Must be a positive number",
    }),
};

const CustomInputSchema = z.object({
    key: z.string(),
    value: z.string(),
});

const InvoiceSenderSchema = z.object({
    name: fieldValidators.name,
    address: fieldValidators.address,
    zipCode: fieldValidators.zipCode,
    city: fieldValidators.city,
    country: fieldValidators.country,
    email: fieldValidators.email,
    phone: fieldValidators.phone,
    // Format and check-character are validated in the cross-field rules below.
    gstin: cleanText(20).optional(),
    customInputs: z.array(CustomInputSchema).optional(),
});

const ShippingAddressSchema = z.object({
    address: cleanText(120).optional(),
    zipCode: cleanText(20).optional(),
    city: cleanText(50).optional(),
    country: cleanText(70).optional(),
});

const InvoiceReceiverSchema = z.object({
    shippingAddress: ShippingAddressSchema.optional(),
    name: fieldValidators.name,
    address: fieldValidators.address,
    zipCode: fieldValidators.zipCode,
    city: fieldValidators.city,
    country: fieldValidators.country,
    email: fieldValidators.email,
    phone: fieldValidators.phone,
    gstin: cleanText(20).optional(),
    customInputs: z.array(CustomInputSchema).optional(),
});

const ItemSchema = z.object({
    name: fieldValidators.stringMin1,
    description: fieldValidators.stringOptional,
    quantity: fieldValidators.quantity,
    unitPrice: fieldValidators.unitPrice,
    total: fieldValidators.stringToNumber,
    // GST fields: optional so invoices saved before GST existed keep validating.
    hsn: cleanText(8).optional(),
    gstRate: z.coerce.number().min(0).max(100).optional(),
    // Link to the product catalogue and the unit it was sold in. A line with no
    // productId is a free-text or service line and never touches stock.
    productId: z.string().max(64).optional(),
    unit: cleanText(20).optional(),
});

const PaymentInformationSchema = z.object({
    bankName: fieldValidators.stringMin1,
    accountName: fieldValidators.stringMin1,
    accountNumber: fieldValidators.stringMin1,
});

const DiscountDetailsSchema = z.object({
    amount: fieldValidators.stringToNumberWithMax,
    amountType: fieldValidators.string,
});

const TaxDetailsSchema = z.object({
    amount: fieldValidators.stringToNumberWithMax,
    // Optional: an empty tax ID is normal, and ChargesContext creates this
    // object without one when it loads an invoice that never had tax set.
    taxID: fieldValidators.stringOptional,
    amountType: fieldValidators.string,
});

const ShippingDetailsSchema = z.object({
    cost: fieldValidators.stringToNumberWithMax,
    costType: fieldValidators.string,
});

const SignatureSchema = z.object({
    data: fieldValidators.string,
    // Interpolated into a Google Fonts URL during PDF generation, so it is
    // restricted to the fonts the UI actually offers.
    fontFamily: z
        .enum(SIGNATURE_FONTS.map((font) => font.name) as [string, ...string[]])
        .optional(),
});

/**
 * Presentation options. Every field optional with a default so existing saved
 * invoices keep validating.
 */
const ThemeSchema = z.object({
    // Restricted to a hex literal: the value is interpolated into inline
    // styles in the templates, including in the PDF.
    accentColor: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/, { message: "Must be a hex colour" })
        .optional(),
    fontId: z
        .enum(["outfit", "plexSans", "sourceSerif", "plexMono"])
        .optional(),
    // "spacious" is new; the two older values still validate, so invoices
    // saved before it existed keep loading.
    density: z.enum(["compact", "comfortable", "spacious"]).optional(),
    // Output paper. Drives the PDF page size and the sheet's height.
    paper: z.enum(["a4", "letter", "legal"]).optional(),
    // Printed above and below the invoice on every template.
    headerText: cleanText(200).optional(),
    footerText: cleanText(300).optional(),
});

/**
 * States a user can set. Everything else is derived: "paid", "partial" from the
 * recorded payments and "overdue" from the due date, so none of them can drift
 * out of step with the data they describe.
 */
export const INVOICE_STATUSES = ["draft", "sent", "cancelled"] as const;

/**
 * Accepted on read. "pending", "paid" and "partial" were stored by the first
 * version of the dashboard; they are normalised on load and never written.
 */
export const INVOICE_STATUS_VALUES = [
    ...INVOICE_STATUSES,
    "pending",
    "paid",
    "partial",
] as const;

const PaymentSchema = z.object({
    id: z.string().min(1).max(64),
    // Calendar date, ISO (yyyy-mm-dd or full ISO).
    date: z.string().min(8).max(40),
    amount: z.number().gt(0).max(1e12),
    method: cleanText(40).optional(),
    note: cleanText(200).optional(),
});

const RecurringSchema = z.object({
    frequency: z.enum(["none", "weekly", "monthly", "quarterly", "yearly"]),
    nextDate: z.string().max(40).optional(),
    endDate: z.string().max(40).optional(),
    /** Set on invoices a schedule generated, so they can be traced back. */
    sourceNumber: z.string().max(100).optional(),
});

/** A previous version of the invoice, minus the bulky logo and signature. */
const RevisionSchema = z.object({
    id: z.string().min(1).max(64),
    savedAt: z.string().max(40),
    total: z.number(),
    status: z.string().max(20).optional(),
    snapshot: z.record(z.any()),
});

/**
 * GST settings for one invoice. `cgst`, `sgst`, `igst`, `taxableValue` and
 * `totalTax` are derived by the form from the line items and are stored only so
 * the PDF, exports and lists do not have to recompute them; reports recompute
 * from the lines (see gstOfInvoice) and never trust these.
 */
const GstSchema = z.object({
    enabled: z.boolean(),
    pricing: z.enum(["exclusive", "inclusive"]).optional(),
    /** Two-digit GST state code of the place of supply. */
    placeOfSupply: z.string().max(2).optional(),
    reverseCharge: z.boolean().optional(),
    taxableValue: z.number().optional(),
    cgst: z.number().optional(),
    sgst: z.number().optional(),
    igst: z.number().optional(),
    totalTax: z.number().optional(),
});

/** Set on invoices created from a quotation, so the origin is never lost. */
const QuotationRefSchema = z.object({
    id: z.string().min(1).max(64),
    number: cleanText(100),
});

const InvoiceDetailsBaseSchema = z.object({
    gst: GstSchema.optional(),
    quotationRef: QuotationRefSchema.optional(),
    status: z.enum(INVOICE_STATUS_VALUES).optional(),
    payments: z.array(PaymentSchema).max(200).optional(),
    recurring: RecurringSchema.optional(),
    revisions: z.array(RevisionSchema).max(25).optional(),
    terms: cleanText(2000).optional(),
    paymentInstructions: cleanText(1000).optional(),
    theme: ThemeSchema.optional(),
    invoiceLogo: imageDataUrl.optional(),
    invoiceNumber: fieldValidators.stringMin1,
    invoiceDate: fieldValidators.date,
    dueDate: fieldValidators.date,
    purchaseOrderNumber: fieldValidators.stringOptional,
    currency: fieldValidators.string,
    language: fieldValidators.string,
    items: z.array(ItemSchema),
    paymentInformation: PaymentInformationSchema.optional(),
    taxDetails: TaxDetailsSchema.optional(),
    discountDetails: DiscountDetailsSchema.optional(),
    shippingDetails: ShippingDetailsSchema.optional(),
    subTotal: fieldValidators.nonNegativeNumber,
    totalAmount: fieldValidators.nonNegativeNumber,
    totalAmountInWords: fieldValidators.string,
    additionalNotes: fieldValidators.stringOptional,
    paymentTerms: fieldValidators.stringMin1,
    signature: SignatureSchema.optional(),
    updatedAt: fieldValidators.stringOptional,
    pdfTemplate: z.number(),
});

/**
 * By this point the dates have been normalised to display strings
 * ("January 5, 2026"), which `Date` parses back reliably.
 */
const InvoiceDetailsSchema = InvoiceDetailsBaseSchema.superRefine((d, ctx) => {
    const issued = new Date(d.invoiceDate).getTime();
    const due = new Date(d.dueDate).getTime();
    if (Number.isFinite(issued) && Number.isFinite(due) && due < issued) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["dueDate"],
            message: "Due date cannot be before the invoice date",
        });
    }
});

const InvoiceSchema = z
    .object({
        sender: InvoiceSenderSchema,
        receiver: InvoiceReceiverSchema,
        details: InvoiceDetailsSchema,
    })
    .superRefine((invoice, ctx) => {
        // GSTIN / HSN / place-of-supply rules live in lib/gst so the form and
        // the server routes enforce exactly the same thing.
        const messages: Record<string, string> = {
            invalidGstin: "Enter a valid 15-character GSTIN",
            invalidHsn: "HSN must be 2–8 digits; SAC must be 6 digits starting 99",
            sellerGstinRequired: "Your GSTIN is required when GST is enabled",
            placeOfSupplyRequired: "Select the place of supply",
        };
        for (const issue of gstIssues(invoice)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: issue.path,
                message: messages[issue.code] ?? "Invalid GST value",
            });
        }
    });

export { InvoiceSchema, ItemSchema };
