// Lightweight "who's using this browser" identity, separate from the shared
// app password (middleware.ts) — that one just keeps strangers out, this one
// lets the two of you attribute actions ("contacted by Andrei") and claim
// leads to avoid double-messaging. Stored per-browser, not per-account.
const KEY = "lf_actor";

export function getActor(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(KEY) ?? "";
}

export function setActor(name: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(KEY, name.trim());
}
