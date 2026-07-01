// Optional stored Garmin credentials for automated (unattended) login.
//
// SECURITY: these are your real Garmin password. They are read from either
// environment variables (GARMIN_EMAIL / GARMIN_PASSWORD) or a local file at
// ~/.garmin-connect-mcp/credentials.json written with 0600 (owner read/write
// only). The file lives outside the repo and is never logged or committed.
// Automated login cannot complete if your account has 2FA enabled.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getSessionDir } from "./garmin-client.js";

export interface Credentials {
  email: string;
  password: string;
}

function credentialsFile(): string {
  return join(getSessionDir(), "credentials.json");
}

export function getCredentialsFile(): string {
  return credentialsFile();
}

/** Load credentials from env vars first, then the local file. Null if none. */
export function loadCredentials(): Credentials | null {
  const envEmail = process.env.GARMIN_EMAIL;
  const envPass = process.env.GARMIN_PASSWORD;
  if (envEmail && envPass) return { email: envEmail, password: envPass };

  const file = credentialsFile();
  if (existsSync(file)) {
    try {
      const c = JSON.parse(readFileSync(file, "utf-8")) as Partial<Credentials>;
      if (c && c.email && c.password) {
        return { email: String(c.email), password: String(c.password) };
      }
    } catch {
      // malformed file — treat as no credentials
    }
  }
  return null;
}

export function hasCredentials(): boolean {
  return loadCredentials() !== null;
}

/** Persist credentials to the local file with owner-only permissions. */
export function saveCredentials(email: string, password: string): string {
  if (!email || !password) {
    throw new Error("Both email and password are required.");
  }
  mkdirSync(getSessionDir(), { recursive: true, mode: 0o700 });
  const file = credentialsFile();
  writeFileSync(file, JSON.stringify({ email, password }, null, 2), {
    mode: 0o600,
  });
  return file;
}
