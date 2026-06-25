// Shared app settings (currently just the WhatsApp message template, scoped
// per business-vertical group — see lib/groups.ts).
//   GET   /api/settings?group=turism -> { template: string | null, updatedBy?: string }
//   PATCH /api/settings -> { template, group, actor? } save the template

import { getTemplate, setTemplate } from "@/lib/db";
import { DEFAULT_GROUP, GROUPS } from "@/lib/types";
import type { Group } from "@/lib/types";

function parseGroup(value: string | null): Group {
  return (GROUPS as string[]).includes(value || "") ? (value as Group) : DEFAULT_GROUP;
}

export async function GET(req: Request) {
  const group = parseGroup(new URL(req.url).searchParams.get("group"));
  const row = await getTemplate(group);
  return Response.json({ template: row?.value ?? null, updatedBy: row?.updatedBy });
}

export async function PATCH(req: Request) {
  let body: { template?: string; actor?: string; group?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Cerere invalidă." }, { status: 400 });
  }
  if (typeof body.template !== "string") {
    return Response.json({ error: "Lipsește mesajul." }, { status: 400 });
  }
  const group = parseGroup(body.group ?? null);
  await setTemplate(body.template, group, body.actor);
  return Response.json({ ok: true });
}
