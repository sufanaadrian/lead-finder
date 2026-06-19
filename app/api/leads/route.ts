// Read and update the saved leads (the local "CRM").
//   GET   /api/leads            -> all saved leads + today's API usage
//   PATCH /api/leads            -> { id, status?, note? } update one lead

import { getAllLeads, updateLead, getUsageToday } from "@/lib/db";
import type { LeadStatus } from "@/lib/types";

const VALID_STATUS: LeadStatus[] = ["new", "contacted", "client", "skip"];

export async function GET() {
  return Response.json({ leads: getAllLeads(), usageToday: getUsageToday() });
}

export async function PATCH(req: Request) {
  let body: { id?: string; status?: LeadStatus; note?: string; interested?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Cerere invalidă." }, { status: 400 });
  }

  if (!body.id) {
    return Response.json({ error: "Lipsește id-ul." }, { status: 400 });
  }
  if (body.status !== undefined && !VALID_STATUS.includes(body.status)) {
    return Response.json({ error: "Status invalid." }, { status: 400 });
  }

  const updated = updateLead(body.id, {
    status: body.status,
    note: body.note,
    interested: body.interested,
  });
  if (!updated) {
    return Response.json({ error: "Lead inexistent." }, { status: 404 });
  }
  return Response.json({ lead: updated });
}
