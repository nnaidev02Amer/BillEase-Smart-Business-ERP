"use client";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import GuardedLink from "@/app/components/layout/GuardedLink";

import { useTranslationContext } from "@/contexts/TranslationContext";
import type { DuplicateGroup } from "@/lib/crm";

/**
 * Customers that look like the same one. Detection only: it never merges or
 * deletes anything, because only you know whether two branches are separate
 * customers. Each member links to its profile so you can compare and clean up.
 */
const DuplicatesDialog = ({ groups, open, onClose }: { groups: DuplicateGroup[]; open: boolean; onClose: () => void }) => {
    const { _t } = useTranslationContext();
    return (
        <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto" data-testid="duplicates-dialog">
                <DialogHeader>
                    <DialogTitle>{_t("crm.duplicates.title")}</DialogTitle>
                    <DialogDescription>{_t("crm.duplicates.hint")}</DialogDescription>
                </DialogHeader>
                {groups.length === 0 ? (
                    <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{_t("crm.duplicates.none")}</p>
                ) : (
                    <ul className="space-y-4">
                        {groups.map((g, i) => (
                            <li key={i} className="rounded-lg border p-3" data-testid="duplicate-group">
                                <p className="mb-2 text-xs text-muted-foreground">{g.reasons.map((r) => _t(`crm.duplicate.reason.${r}`)).join(" · ")}</p>
                                <ul className="divide-y">
                                    {g.members.map((m) => (
                                        <li key={m.key} className="flex items-center justify-between gap-3 py-2 text-sm">
                                            <span className="min-w-0">
                                                <span className="block truncate font-medium">{m.name}</span>
                                                <span className="block truncate text-xs text-muted-foreground">{[m.email, m.phone, m.gstin].filter(Boolean).join(" · ") || "—"}</span>
                                            </span>
                                            <GuardedLink href={`/clients/profile?key=${encodeURIComponent(m.key)}`} onClick={onClose} className="shrink-0 text-xs font-medium text-primary hover:underline">
                                                {_t("crm.duplicates.open")}
                                            </GuardedLink>
                                        </li>
                                    ))}
                                </ul>
                            </li>
                        ))}
                    </ul>
                )}
            </DialogContent>
        </Dialog>
    );
};

export default DuplicatesDialog;
