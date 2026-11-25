"use client";

import { useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import BaseButton from "@/app/components/reusables/BaseButton";
import GuardedLink from "@/app/components/layout/GuardedLink";
import { useInvoiceContext } from "@/contexts/InvoiceContext";
import { useTranslationContext } from "@/contexts/TranslationContext";

import { BarChart3, FilePlus2, LayoutTemplate, Trash2, UserPlus, Zap } from "lucide-react";

/** Pick a saved template to start from, or delete ones you no longer use. */
export const TemplatePicker = ({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) => {
    const { _t } = useTranslationContext();
    const { templates, applyTemplate, deleteTemplate } = useInvoiceContext();

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{_t("templates.title")}</DialogTitle>
                    <DialogDescription>{_t("templates.subtitle")}</DialogDescription>
                </DialogHeader>
                {templates.length === 0 ? (
                    <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                        {_t("templates.empty")}
                    </p>
                ) : (
                    <ul className="max-h-80 space-y-2 overflow-y-auto">
                        {templates.map((t) => (
                            <li key={t.id} className="flex items-center justify-between gap-2 rounded-lg border p-3">
                                <div className="min-w-0">
                                    <p className="truncate font-medium">{t.name}</p>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {t.data.receiver.name || "—"} · {t.data.details.items.length} {_t("templates.items")}
                                    </p>
                                </div>
                                <div className="flex shrink-0 gap-1">
                                    <BaseButton
                                        size="sm"
                                        onClick={() => {
                                            onOpenChange(false);
                                            applyTemplate(t.id);
                                        }}
                                    >
                                        {_t("templates.use")}
                                    </BaseButton>
                                    <BaseButton
                                        size="icon"
                                        variant="ghost"
                                        className="text-destructive hover:text-destructive"
                                        aria-label={`${_t("templates.delete")} ${t.name}`}
                                        onClick={() => void deleteTemplate(t.id)}
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </BaseButton>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </DialogContent>
        </Dialog>
    );
};

/** The handful of things people do all day, one click from the dashboard. */
const QuickActions = () => {
    const { _t } = useTranslationContext();
    const { quickInvoice } = useInvoiceContext();
    const [pickerOpen, setPickerOpen] = useState(false);

    const linkCls =
        "inline-flex h-9 items-center gap-2 rounded-md border bg-background px-3 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

    return (
        <>
            <div className="flex flex-wrap gap-2" role="group" aria-label={_t("dashboard.quickActions")}>
                <GuardedLink
                    href="/"
                    className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    <FilePlus2 className="h-4 w-4" aria-hidden />
                    {_t("dashboard.newInvoice")}
                </GuardedLink>
                <BaseButton variant="outline" size="sm" className="h-9" onClick={quickInvoice}>
                    <Zap className="h-4 w-4" aria-hidden />
                    {_t("app.quickInvoice")}
                </BaseButton>
                <BaseButton variant="outline" size="sm" className="h-9" onClick={() => setPickerOpen(true)}>
                    <LayoutTemplate className="h-4 w-4" aria-hidden />
                    {_t("templates.fromTemplate")}
                </BaseButton>
                <GuardedLink href="/clients?new=1" className={linkCls}>
                    <UserPlus className="h-4 w-4" aria-hidden />
                    {_t("dashboard.addClient")}
                </GuardedLink>
                <GuardedLink href="/analytics" className={linkCls}>
                    <BarChart3 className="h-4 w-4" aria-hidden />
                    {_t("app.nav.analytics")}
                </GuardedLink>
            </div>
            <TemplatePicker open={pickerOpen} onOpenChange={setPickerOpen} />
        </>
    );
};

export default QuickActions;
