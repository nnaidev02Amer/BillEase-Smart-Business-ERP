"use client";

import { useEffect, useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/use-toast";
import BaseButton from "@/app/components/reusables/BaseButton";

import { useTranslationContext } from "@/contexts/TranslationContext";
import { categoriesOf, identityOf, findPotentialDuplicates, type CustomerRecord, type DuplicateMatch } from "@/lib/crm";
import { normaliseGstin, validateGstin } from "@/lib/gst";
import { clientKey } from "@/lib/invoiceRecords";
import { cleanTags, readParties, replaceParties, type SavedParty } from "@/lib/partyStore";
import { stripControlChars } from "@/lib/schemas";

import { AlertTriangle } from "lucide-react";

/* ------------------------------------------------------------------ form */

export const EMPTY_FORM = {
    name: "", email: "", phone: "", address: "", zipCode: "", city: "", country: "",
    shipAddress: "", shipZip: "", shipCity: "", shipCountry: "", notes: "",
    company: "", contactPerson: "", gstin: "", website: "", category: "", tags: "", active: true,
};
export type Form = typeof EMPTY_FORM;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const toForm = (r: CustomerRecord | null): Form => {
    if (!r) return EMPTY_FORM;
    const p = r.profile;
    if (!p) {
        // A customer known only from documents: start from what those say.
        return { ...EMPTY_FORM, name: r.name, email: r.email, phone: r.phone, gstin: r.gstin, city: r.city };
    }
    return {
        name: p.name, email: p.email, phone: p.phone, address: p.address, zipCode: p.zipCode, city: p.city, country: p.country,
        shipAddress: p.shippingAddress?.address ?? "", shipZip: p.shippingAddress?.zipCode ?? "",
        shipCity: p.shippingAddress?.city ?? "", shipCountry: p.shippingAddress?.country ?? "",
        notes: p.notes ?? "",
        company: p.company ?? "", contactPerson: p.contactPerson ?? "", gstin: p.gstin ?? "", website: p.website ?? "",
        category: p.category ?? "", tags: (p.tags ?? []).join(", "), active: p.inactive !== true,
    };
};

/* ------------------------------------------------------------------ save */

export type SaveOutcome =
    | { ok: true; profile: SavedParty }
    | { ok: false; error: string }
    | { ok: false; warning: DuplicateMatch[] };

/**
 * Saves a customer profile.
 *
 * Two different duplicate rules, deliberately:
 *   - The same e-mail (or, without one, the same name) is the same customer by
 *     definition, so it is refused: there would be no way to tell the two apart
 *     on an invoice.
 *   - A look-alike (same GSTIN or phone, or a near-identical name) is only
 *     *reported*. The user decides, because two branches of one company, or two
 *     people who share an office number, are legitimately separate customers.
 */
export async function saveCustomer(
    form: Form,
    existing: CustomerRecord | null,
    all: CustomerRecord[],
    acknowledged: boolean,
    t: (key: string) => string
): Promise<SaveOutcome> {
    const clean = (s: string) => stripControlChars(s).trim();
    if (clean(form.name).length < 2) return { ok: false, error: t("clients.errors.name") };
    if (form.email && !EMAIL_RE.test(form.email.trim())) return { ok: false, error: t("clients.errors.email") };

    const gstin = normaliseGstin(form.gstin);
    if (gstin && !validateGstin(gstin).valid) return { ok: false, error: t("clients.errors.gstin") };

    const list = await readParties("receiver");
    const key = clientKey({ name: clean(form.name), email: clean(form.email) });
    const editingId = existing?.profile?.id;
    if (list.some((p) => p.id !== editingId && clientKey(p) === key)) return { ok: false, error: t("clients.errors.duplicate") };

    if (!acknowledged) {
        const candidate = { key, name: clean(form.name), email: clean(form.email), phone: clean(form.phone), gstin };
        const matches = findPotentialDuplicates(candidate, all.map(identityOf), existing?.key);
        if (matches.length > 0) return { ok: false, warning: matches };
    }

    const hasShip = [form.shipAddress, form.shipZip, form.shipCity, form.shipCountry].some((v) => v.trim());
    const tags = cleanTags(form.tags);
    const old = existing?.profile;
    const next: SavedParty = {
        id: editingId ?? crypto.randomUUID(),
        createdAt: old?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        name: clean(form.name).slice(0, 50),
        email: clean(form.email).slice(0, 254),
        phone: clean(form.phone).slice(0, 50),
        address: clean(form.address).slice(0, 70),
        zipCode: clean(form.zipCode).slice(0, 20),
        city: clean(form.city).slice(0, 50),
        country: clean(form.country).slice(0, 70),
        customInputs: old?.customInputs ?? [],
        ...(gstin ? { gstin } : {}),
        ...(clean(form.company) ? { company: clean(form.company).slice(0, 100) } : {}),
        ...(clean(form.contactPerson) ? { contactPerson: clean(form.contactPerson).slice(0, 60) } : {}),
        ...(clean(form.website) ? { website: clean(form.website).slice(0, 200) } : {}),
        ...(clean(form.category) ? { category: clean(form.category).slice(0, 40) } : {}),
        ...(tags.length ? { tags } : {}),
        ...(form.active ? {} : { inactive: true }),
        ...(form.notes.trim() ? { notes: stripControlChars(form.notes).slice(0, 2000) } : {}),
        ...(hasShip
            ? {
                  shippingAddress: {
                      address: clean(form.shipAddress).slice(0, 120),
                      zipCode: clean(form.shipZip).slice(0, 20),
                      city: clean(form.shipCity).slice(0, 50),
                      country: clean(form.shipCountry).slice(0, 70),
                  },
              }
            : {}),
    };
    await replaceParties("receiver", editingId ? list.map((p) => (p.id === editingId ? next : p)) : [...list, next]);
    return { ok: true, profile: next };
}

/* ---------------------------------------------------------------- dialog */

const Field = ({ id, label, value, onChange, type = "text", hint, ...rest }: { id: string; label: string; value: string; onChange: (v: string) => void; type?: string; hint?: string } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "type" | "id">) => (
    <div className="space-y-1.5">
        <Label htmlFor={id}>{label}</Label>
        <Input id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} {...rest} />
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
);

type DialogProps = {
    state: { row: CustomerRecord | null } | null;
    records: CustomerRecord[];
    onClose: () => void;
    onSaved?: (profile: SavedParty) => void;
};

/** Create or edit a customer. Used by the directory and by the profile page. */
export const CustomerDialog = ({ state, records, onClose, onSaved }: DialogProps) => {
    const { _t } = useTranslationContext();
    const [form, setForm] = useState<Form>(EMPTY_FORM);
    const [error, setError] = useState<string | null>(null);
    const [warning, setWarning] = useState<DuplicateMatch[] | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (state) {
            setForm(toForm(state.row));
            setError(null);
            setWarning(null);
        }
    }, [state]);

    const set = (k: keyof Form) => (v: string) => {
        setForm((f) => ({ ...f, [k]: v }));
        // Changing what makes two customers look alike withdraws the warning.
        if (["name", "email", "phone", "gstin"].includes(k)) setWarning(null);
    };

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        try {
            const outcome = await saveCustomer(form, state?.row ?? null, records, warning !== null, _t);
            if (outcome.ok) {
                toast({ title: _t("clients.toast.saved"), description: outcome.profile.name });
                onSaved?.(outcome.profile);
                onClose();
            } else if ("warning" in outcome) {
                setError(null);
                setWarning(outcome.warning);
            } else {
                setWarning(null);
                setError(outcome.error);
            }
        } finally {
            setBusy(false);
        }
    };

    const categories = categoriesOf(records);

    return (
        <Dialog open={state !== null} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{state?.row?.profile ? _t("clients.edit") : _t("clients.add")}</DialogTitle>
                    <DialogDescription>{_t("clients.formHint")}</DialogDescription>
                </DialogHeader>
                <form className="space-y-5" noValidate onSubmit={submit}>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Field id="c-name" label={_t("clients.fields.name")} value={form.name} onChange={set("name")} maxLength={50} required />
                        <Field id="c-email" label={_t("clients.fields.email")} value={form.email} onChange={set("email")} type="email" maxLength={254} />
                        <Field id="c-phone" label={_t("clients.fields.phone")} value={form.phone} onChange={set("phone")} maxLength={50} inputMode="tel" />
                    </div>

                    <fieldset className="space-y-3">
                        <legend className="mb-1 text-sm font-semibold">{_t("crm.form.business")}</legend>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <Field id="c-company" label={_t("crm.form.company")} value={form.company} onChange={set("company")} maxLength={100} />
                            <Field id="c-contact" label={_t("crm.form.contactPerson")} value={form.contactPerson} onChange={set("contactPerson")} maxLength={60} />
                            <Field
                                id="c-gstin"
                                label={_t("crm.form.gstin")}
                                value={form.gstin}
                                onChange={(v) => set("gstin")(v.toUpperCase().replace(/[^0-9A-Z]/g, ""))}
                                maxLength={15}
                                spellCheck={false}
                                hint={_t("crm.form.gstinHint")}
                            />
                            <Field id="c-web" label={_t("crm.form.website")} value={form.website} onChange={set("website")} maxLength={200} />
                        </div>
                    </fieldset>

                    <fieldset className="space-y-3">
                        <legend className="mb-1 text-sm font-semibold">{_t("clients.billing")}</legend>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <div className="sm:col-span-2"><Field id="c-addr" label={_t("clients.fields.address")} value={form.address} onChange={set("address")} maxLength={70} /></div>
                            <Field id="c-zip" label={_t("clients.fields.zip")} value={form.zipCode} onChange={set("zipCode")} maxLength={20} />
                            <Field id="c-city" label={_t("clients.fields.city")} value={form.city} onChange={set("city")} maxLength={50} />
                            <Field id="c-country" label={_t("clients.fields.country")} value={form.country} onChange={set("country")} maxLength={70} />
                        </div>
                    </fieldset>

                    <fieldset className="space-y-3">
                        <legend className="mb-1 text-sm font-semibold">{_t("clients.shipping")} <span className="font-normal text-muted-foreground">({_t("clients.optional")})</span></legend>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <div className="sm:col-span-2"><Field id="s-addr" label={_t("clients.fields.address")} value={form.shipAddress} onChange={set("shipAddress")} maxLength={120} /></div>
                            <Field id="s-zip" label={_t("clients.fields.zip")} value={form.shipZip} onChange={set("shipZip")} maxLength={20} />
                            <Field id="s-city" label={_t("clients.fields.city")} value={form.shipCity} onChange={set("shipCity")} maxLength={50} />
                            <Field id="s-country" label={_t("clients.fields.country")} value={form.shipCountry} onChange={set("shipCountry")} maxLength={70} />
                        </div>
                    </fieldset>

                    <fieldset className="space-y-3">
                        <legend className="mb-1 text-sm font-semibold">{_t("crm.form.organise")}</legend>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <div className="space-y-1.5">
                                <Label htmlFor="c-category">{_t("crm.form.category")}</Label>
                                <Input id="c-category" list="c-categories" value={form.category} maxLength={40} onChange={(e) => set("category")(e.target.value)} />
                                <datalist id="c-categories">
                                    {categories.map((c) => (
                                        <option key={c} value={c} />
                                    ))}
                                </datalist>
                            </div>
                            <Field id="c-tags" label={_t("crm.form.tags")} value={form.tags} onChange={set("tags")} hint={_t("crm.form.tagsHint")} />
                        </div>
                        <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
                            <div>
                                <Label htmlFor="c-active">{_t("crm.form.active")}</Label>
                                <p className="text-xs text-muted-foreground">{_t("crm.form.activeHint")}</p>
                            </div>
                            <Switch id="c-active" checked={form.active} onCheckedChange={(v) => setForm((f) => ({ ...f, active: v }))} />
                        </div>
                    </fieldset>

                    <div className="space-y-1.5">
                        <Label htmlFor="c-notes">{_t("clients.notes")}</Label>
                        <Textarea id="c-notes" rows={3} maxLength={2000} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
                    </div>

                    {warning && (
                        <div role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm" data-testid="duplicate-warning">
                            <p className="flex items-center gap-2 font-medium">
                                <AlertTriangle className="h-4 w-4" aria-hidden />
                                {_t("crm.duplicate.title")}
                            </p>
                            <ul className="mt-2 space-y-1">
                                {warning.map((m) => (
                                    <li key={m.record.key}>
                                        <span className="font-medium">{m.record.name}</span>
                                        <span className="ms-2 text-muted-foreground">{m.reasons.map((r) => _t(`crm.duplicate.reason.${r}`)).join(" · ")}</span>
                                    </li>
                                ))}
                            </ul>
                            <p className="mt-2 text-xs text-muted-foreground">{_t("crm.duplicate.hint")}</p>
                        </div>
                    )}
                    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

                    <div className="flex justify-end gap-2">
                        <BaseButton variant="ghost" onClick={onClose}>{_t("guards.cancel")}</BaseButton>
                        <BaseButton type="submit" loading={busy} data-testid="save-customer">
                            {warning ? _t("crm.duplicate.saveAnyway") : _t("clients.save")}
                        </BaseButton>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
};
