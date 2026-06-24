// Gates the whole app behind a shared username/password. The Supabase anon
// key is already locked to read-only via RLS, but this also keeps random
// visitors who find the Vercel URL from burning the Google Places budget.
//
// If APP_PASSWORD isn't set, the gate is a no-op (so local dev works without
// configuring it) — set it before deploying anywhere public.
import { NextResponse, type NextRequest } from "next/server";

export function proxy(req: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next();

  const user = process.env.APP_USER || "lead-finder";
  const header = req.headers.get("authorization");
  if (header?.startsWith("Basic ")) {
    const decoded = atob(header.slice(6));
    const sep = decoded.indexOf(":");
    if (decoded.slice(0, sep) === user && decoded.slice(sep + 1) === password) {
      return NextResponse.next();
    }
  }
  return new NextResponse("Autentificare necesară.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Lead Finder"' },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
