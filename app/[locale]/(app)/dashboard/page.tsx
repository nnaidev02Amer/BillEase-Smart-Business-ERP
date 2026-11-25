import DashboardMain from "@/app/components/dashboard/DashboardMain";

// A private view of this browser's data: nothing here is worth indexing.
export const metadata = { robots: { index: false, follow: false } };

export default function DashboardPage() {
    return (
        <main className="container py-6 md:py-10">
            <DashboardMain />
        </main>
    );
}
