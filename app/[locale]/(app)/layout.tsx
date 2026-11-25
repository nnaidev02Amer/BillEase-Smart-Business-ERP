import { AppSidebar } from "@/app/components/layout/AppSidebar";

/**
 * Shell for the management pages (dashboard, invoices, clients, analytics,
 * settings). The invoice builder keeps its own full-bleed layout and is not
 * inside this group.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex min-h-[calc(100dvh-4rem)] flex-col lg:flex-row">
            <AppSidebar />
            <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 md:py-8 lg:px-8">
                <div className="mx-auto w-full max-w-7xl">{children}</div>
            </main>
        </div>
    );
}
