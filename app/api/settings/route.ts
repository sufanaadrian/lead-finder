// Shared app settings (currently just the WhatsApp message template).
//   GET   /api/settings -> { template: string | null, updatedBy?: string }
//   PATCH /api/settings -> { template, actor? } save the template

import { getTemplate, setTemplate } from "@/lib/db";

export async function GET() {
  const row = await getTemplate();
  return Response.json({ template: row?.value ?? null, updatedBy: row?.updatedBy });
}

export async function PATCH(req: Request) {
  let body: { template?: string; actor?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Cerere invalidă." }, { status: 400 });
  }
  if (typeof body.template !== "string") {
    return Response.json({ error: "Lipsește mesajul." }, { status: 400 });
  }
  await setTemplate(body.template, body.actor);
  return Response.json({ ok: true });
}
