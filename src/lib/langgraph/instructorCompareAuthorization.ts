import { createHmac, timingSafeEqual } from "node:crypto";
import { getServerEnv } from "@/lib/env";

function signature(threadId: string): string {
  return createHmac("sha256", getServerEnv().supabaseServiceRoleKey)
    .update(`instructor-compare:${threadId}`, "utf8")
    .digest("base64url");
}

export function instructorCompareSessionToken(threadId: string): string {
  return signature(threadId);
}

export function authorizeInstructorCompareSession(threadId: string, token: unknown): boolean {
  if (typeof token !== "string" || token.length < 32 || token.length > 100) return false;
  const expected = Buffer.from(signature(threadId));
  const received = Buffer.from(token);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
