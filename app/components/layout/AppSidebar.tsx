"use client";

import { useState } from "react";

import { usePathname } from "@/i18n/navigation";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useTranslationContext } from "@/contexts/TranslationContext";
import { useInvoiceContext } from "@/contexts/InvoiceContext";
import GuardedLink, { NAV_PREFETCH } from "@/app/components/layout/GuardedLink";
import BaseButton from "@/app/components/reusables/BaseButton";
import { cn } from "@/lib/utils";

import {
    BarChart3,
    FilePlus2,
    FileText,
    FileSignature,
    LayoutDashboard,
    Menu,
    ClipboardList,
    Package,
    PackageCheck,
    Receipt,
    ScrollText,
    Scale,
    Wallet,
    Settings,
    Truck,
    Users,
    Zap,
} from "lucide-react";

export const APP_NAV = [
    { href: "/dashboard", key: "dashboard", Icon: LayoutDashboard },
    { href: "/invoices", key: "invoices", Icon: FileText },
    { href: "/quotations", key: "quotations", Icon: FileSignature },
    { href: "/clients", key: "clients", Icon: Users },
    { href: "/products", key: "products", Icon: Package },
    { href: "/suppliers", key: "suppliers", Icon: Truck },
    { href: "/purchase-orders", key: "purchaseOrders", Icon: ClipboardList },
    { href: "/goods-receipts", key: "goodsReceipts", Icon: PackageCheck },
    { href: "/purchase-bills", key: "purchaseBills", Icon: ScrollText },
    { href: "/payables", key: "payables", Icon: Wallet },
    { href: "/expenses", key: "expenses", Icon: Receipt },
    { href: "/profit-loss", key: "profitLoss", Icon: Scale },
    { href: "/analytics", key: "analytics", Icon: BarChart3 },
    { href: "/settings", key: "settings", Icon: Settings },
] as const;

const NavList = ({ onNavigate }: { onNavigate?: () => void }) => {
    const { _t } = useTranslationContext();
    const pathname = usePathname();
    const { quickInvoice } = useInvoiceContext();

    return (
        <div className="flex h-full flex-col gap-6">
            <div className="flex flex-col gap-2">
                <GuardedLink
                    href="/"
                    prefetch={NAV_PREFETCH}
                    onClick={onNavigate}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                    <FilePlus2 className="h-4 w-4" aria-hidden />
                    {_t("app.newInvoice")}
                </GuardedLink>
                <BaseButton
                    variant="outline"
                    onClick={() => {
                        onNavigate?.();
                        quickInvoice();
                    }}
                >
                    <Zap className="h-4 w-4" aria-hidden />
                    {_t("app.quickInvoice")}
                </BaseButton>
            </div>

            <nav aria-label={_t("app.sectionsNav")} className="flex flex-col gap-1">
                {APP_NAV.map(({ href, key, Icon }) => {
                    const active = pathname.startsWith(href);
                    return (
                        <GuardedLink
                            key={href}
                            href={href}
                            prefetch={NAV_PREFETCH}
                            onClick={onNavigate}
                            aria-current={active ? "page" : undefined}
                            className={cn(
                                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                active
                                    ? "bg-accent text-accent-foreground"
                                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                            )}
                        >
                            <Icon className="h-4 w-4" aria-hidden />
                            {_t(`app.nav.${key}`)}
                        </GuardedLink>
                    );
                })}
            </nav>

            <p className="mt-auto hidden text-xs text-muted-foreground lg:block">
                {_t("app.shortcutsHint")}
            </p>
        </div>
    );
};

/**
 * Sidebar for the management area. A fixed column from lg up; below that it is
 * a slide-in sheet opened from a bar under the main navbar, so phones lose no
 * horizontal space to it.
 */
export const AppSidebar = () => {
    const [open, setOpen] = useState(false);
    const { _t } = useTranslationContext();

    return (
        <>
            <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] w-60 shrink-0 border-e bg-card/50 p-4 lg:block">
                <NavList />
            </aside>

            <div className="sticky top-16 z-30 flex items-center border-b bg-background/90 px-4 py-2 backdrop-blur lg:hidden">
                <BaseButton
                    variant="ghost"
                    size="sm"
                    aria-label={_t("app.openMenu")}
                    onClick={() => setOpen(true)}
                >
                    <Menu className="h-4 w-4" />
                    {_t("app.menu")}
                </BaseButton>
            </div>
            <Sheet open={open} onOpenChange={setOpen}>
                <SheetContent side="left" className="w-72 max-w-[85vw]">
                    <SheetHeader className="mb-6">
                        <SheetTitle>{_t("app.menu")}</SheetTitle>
                    </SheetHeader>
                    <NavList onNavigate={() => setOpen(false)} />
                </SheetContent>
            </Sheet>
        </>
    );
};
