export const runtime = "nodejs";
export const maxDuration = 60;

import { NextRequest } from "next/server";

import { generateReportPdfService } from "@/services/report/server/generateReportPdfService";

export async function POST(req: NextRequest) {
    return generateReportPdfService(req);
}
