"use client";

import { KeyRound, Loader2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { type FormEvent, useState } from "react";

export function UnlockForm() {
  const searchParams = useSearchParams();
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!pin.trim() || submitting) return;

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Incorrect PIN.");
        setPin("");
        return;
      }

      // Full reload so the middleware sees the new cookie on the next request.
      window.location.href = searchParams.get("next") ?? "/";
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-6 bg-background">
      <div className="w-full max-w-sm">
        <div className="rounded-2xl border border-border bg-card shadow-sm p-8">
          <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-secondary mb-5">
            <KeyRound size={20} className="text-foreground" />
          </div>

          <h1 className="text-xl font-semibold tracking-tight">ZenCub RAG</h1>
          <p className="mt-1.5 text-sm text-muted-foreground leading-relaxed">
            This is the full engineering demo: LangGraph workflows, instructor
            comparison, and trace inspection. Enter the PIN to continue.
          </p>

          <form onSubmit={submit} className="mt-6 space-y-3">
            <input
              type="password"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              value={pin}
              onChange={(event) => setPin(event.target.value)}
              placeholder="Demo PIN"
              aria-label="Demo PIN"
              className="w-full px-4 py-2.5 rounded-xl border border-border bg-background text-foreground tracking-[0.3em] text-center outline-none focus:ring-2 focus:ring-ring"
            />

            <button
              type="submit"
              disabled={submitting || !pin.trim()}
              className="w-full px-4 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {submitting && <Loader2 size={14} className="animate-spin" />}
              {submitting ? "Checking…" : "Unlock"}
            </button>
          </form>

          {error && (
            <p role="alert" className="mt-3 text-sm text-red-600">
              {error}
            </p>
          )}
        </div>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          Looking for transcript search?{" "}
          <a href="https://search.zencub.com" className="underline underline-offset-2">
            search.zencub.com
          </a>
        </p>
      </div>
    </main>
  );
}
