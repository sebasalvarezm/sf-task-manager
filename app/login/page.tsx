"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/app/components/ui/Input";
import { Button } from "@/app/components/ui/Button";
import { Alert } from "@/app/components/ui/Alert";

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });

    if (res.ok) {
      router.push("/");
      router.refresh();
    } else {
      setError("Incorrect password. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-navy px-4">
      <div className="bg-surface-2 rounded-xl shadow-lg p-10 w-full max-w-sm border border-line">
        <div className="flex justify-center mb-8">
          <div className="text-3xl font-bold text-navy tracking-tight">
            <span className="text-brand">V</span>ALSTONE
          </div>
        </div>

        <h1 className="text-xl font-semibold text-ink text-center mb-1.5 tracking-tight">
          Valstone Platform
        </h1>
        <p className="text-sm text-ink-muted text-center mb-8">
          Enter your access password to continue
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoFocus
            disabled={loading}
          />

          {error && <Alert variant="danger">{error}</Alert>}

          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={loading}
            disabled={!password}
            className="w-full"
          >
            {loading ? "Signing in…" : "Sign In"}
          </Button>
        </form>
      </div>
    </div>
  );
}
