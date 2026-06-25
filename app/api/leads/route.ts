// Read and update the saved leads (the local "CRM").
//   GET   /api/leads            -> all saved leads + today's API usage
//   PATCH /api/leads            -> { id, status?, note?, interested?, pitchType?, assignedTo?, claim?, actor? } update one lead

import { getAllLeads, updateLead, getUsageToday, getSearches, purgeWebsiteLeads, countLeadsMissingGeo } from "@/lib/db";
import type { LeadStatus } from "@/lib/types";

const VALID_STATUS: LeadStatus[] = ["new", "contacted", "client", "skip"];

export async function GET() {
  // Clean out any leads that have a website — we only keep ones without.
  await purgeWebsiteLeads();
  const [leads, usageToday, searches, missingGeo] = await Promise.all([
    getAllLeads(),
    getUsageToday(),
    getSearches(),
    countLeadsMissingGeo(),
  ]);
  return Response.json({ leads, usageToday, searches, missingGeo });
}

export async function PATCH(req: Request) {
  let body: {
    id?: string;
    status?: LeadStatus;
    note?: string;
    interested?: boolean;
    pitchType?: string;
    assignedTo?: string | null;
    claim?: boolean;
    actor?: string;
  };
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
  if (body.pitchType !== undefined && typeof body.pitchType !== "string") {
    return Response.json({ error: "Tip invalid." }, { status: 400 });
  }

  const updated = await updateLead(body.id, {
    status: body.status,
    note: body.note,
    interested: body.interested,
    pitchType: body.pitchType,
    assignedTo: body.assignedTo,
    claim: body.claim,
    actor: body.actor,
  });
  if (!updated) {
    return Response.json({ error: "Lead inexistent." }, { status: 404 });
  }
  return Response.json({ lead: updated });
}
