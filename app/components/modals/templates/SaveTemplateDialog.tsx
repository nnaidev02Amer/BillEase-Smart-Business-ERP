"use client";

import { useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import BaseButton from "@/app/components/reusables/BaseButton";
import { useInvoiceContext } from "@/contexts/InvoiceContext";
import { useTranslationContext } from "@/contexts/TranslationContext";

/**
 * Saves the current form as a reusable template: sender, client, items,
 * charges, notes and look. The invoice number, dates, payments and history are
 * deliberately left out; they are filled in fresh whenever the template is used.
 */
const SaveTemplateDialog = ({ children }: { children: React.ReactNode }) => {
    const { _t } = useTranslationContext();
    const { saveTemplate } = useInvoiceContext();
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>{children}</DialogTrigger>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{_t("templates.saveTitle")}</DialogTitle>
                    <DialogDescription>{_t("templates.saveBody")}</DialogDescription>
                </DialogHeader>
                <form
                    className="space-y-4"
                    onSubmit={async (e) => {
                        // The dialog lives inside the invoice <form>; this must not submit it.
                        e.preventDefault();
                        e.stopPropagation();
                        setBusy(true);
                        const ok = await saveTemplate(name);
                        setBusy(false);
                        if (ok) {
                            setName("");
                            setOpen(false);
                        }
                    }}
                >
                    <div className="space-y-1.5">
                        <Label htmlFor="tpl-name">{_t("templates.name")}</Label>
                        <Input id="tpl-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus />
                    </div>
                    <div className="flex justify-end">
                        <BaseButton type="submit" loading={busy} disabled={!name.trim()}>
                            {_t("templates.save")}
                        </BaseButton>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
};

export default SaveTemplateDialog;
