"use client";

import { useState } from "react";
import Image from "next/image";
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
      setError("Incorrect password. Try again.");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface px-4">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-6">
          <Image
            src="/valstone-logo-dark.png"
            alt="Valstone"
            width={216}
            height={60}
            className="h-[40px] w-auto"
            priority
          />
        </div>

        <div className="bg-surface-2 rounded-md p-8 border border-line">
          <h1 className="text-xl font-normal text-ink text-center mb-1.5 tracking-tight">
            Valstone platform
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
              Sign in
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
