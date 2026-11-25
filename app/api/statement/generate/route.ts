export const runtime = "nodejs";
export const maxDuration = 60;

import { NextRequest } from "next/server";

import { generateStatementPdfService } from "@/services/statement/server/generateStatementPdfService";

export async function POST(req: NextRequest) {
    return generateStatementPdfService(req);
}
