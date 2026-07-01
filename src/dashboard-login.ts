// Garmin login for the dashboard — two modes:
//
//  performLogin()     — opens a real browser and waits for the user to log in
//                       by hand (used by the one-click "Log in" button).
//  performAutoLogin() — unattended login using stored credentials: fills the
//                       Garmin SSO form and captures the session with no window
//                       and no user interaction. Cannot pass a 2FA prompt.
//
// Both share captureSession(), which polls the page until login is detectable
// (CSRF meta tag + Garmin auth cookies) and writes ~/.garmin-connect-mcp/session.json.

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSessionDir, getSessionFile } from "./garmin-client.js";
import { loadCredentials } from "./credentials.js";

export interface LoginResult {
  ok: boolean;
  method: "chrome-profile" | "fresh-chromium" | "credentials";
  cookies: number;
  csrf: boolean;
  message: string;
}

const SIGNIN_URL =
  "https://sso.garmin.com/portal/sso/en-US/sign-in?clientId=GarminConnect&service=https%3A%2F%2Fconnect.garmin.com%2Fapp%2Factivities";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const AUTH_COOKIE_RE = /SESSIONID|GARMIN-SSO|JWT_FGP|GARMIN-SSO-CUST-GUID/i;

const CSRF_EVAL =
  "() => document.querySelector('meta[name=\"csrf-token\"]')?.content ?? null";

// True if the page is showing a 2FA / verification-code step.
const MFA_EVAL =
  '() => !!document.querySelector(\'input[autocomplete="one-time-code"], input[name*="code" i], input[name*="mfa" i], input[name*="verif" i]\')';

class MfaRequiredError extends Error {
  constructor() {
    super(
      "Garmin is asking for a 2FA/verification code — automated login can't complete it. Use the manual login (click the auth pill / `login`) or disable 2FA."
    );
    this.name = "MfaRequiredError";
  }
}

async function importPlaywright(): Promise<typeof import("playwright")> {
  try {
    return await import("playwright");
  } catch {
    throw new Error(
      "Playwright is required for login. Install: npm install playwright && npx playwright install chromium"
    );
  }
}

/**
 * Poll `page` until login completes (redirected to connect.garmin.com with a
 * CSRF token + auth cookies), then write the session file. When `detectMfa` is
 * set, throws MfaRequiredError if a verification-code step appears.
 */
async function captureSession(
  page: any,
  context: any,
  method: LoginResult["method"],
  timeoutMs: number,
  log: (msg: string) => void,
  detectMfa: boolean
): Promise<LoginResult> {
  const deadline = Date.now() + timeoutMs;
  let csrf: string | null = null;
  let cookies: { name: string; value: string; domain: string }[] = [];

  while (Date.now() < deadline) {
    await sleep(1500);
    let url = "";
    try {
      url = page.url();
    } catch {
      continue; // page navigating; retry next tick
    }

    if (detectMfa && /\/(mfa|verification|verify|totp)/i.test(url)) {
      throw new MfaRequiredError();
    }

    // Still on the sign-in flow — keep waiting (and watch for a 2FA prompt).
    if (
      url.includes("sso.garmin.com") ||
      url.includes("signin") ||
      url.includes("sign-in")
    ) {
      if (detectMfa) {
        const mfa = await page.evaluate(MFA_EVAL).catch(() => false);
        if (mfa) throw new MfaRequiredError();
      }
      continue;
    }
    if (!url.includes("connect.garmin.com")) continue;

    csrf = await page.evaluate(CSRF_EVAL).catch(() => null);
    cookies = await context.cookies().catch(() => []);
    const hasAuth = cookies.some(
      (c: { name: string; domain?: string }) =>
        c.domain?.includes("garmin") && AUTH_COOKIE_RE.test(c.name)
    );
    if (csrf && hasAuth) break;
  }

  const garminCookies = cookies
    .filter((c) => c.domain?.includes("garmin"))
    .map((c) => ({ name: c.name, value: c.value, domain: c.domain }));

  if (!csrf || garminCookies.length === 0) {
    return {
      ok: false,
      method,
      cookies: garminCookies.length,
      csrf: Boolean(csrf),
      message: "Timed out waiting for login to complete.",
    };
  }

  mkdirSync(getSessionDir(), { recursive: true, mode: 0o700 });
  writeFileSync(
    getSessionFile(),
    JSON.stringify({ csrf_token: csrf, cookies: garminCookies }, null, 2),
    { mode: 0o600 }
  );
  log(`Session saved (${garminCookies.length} cookies) via ${method}.`);
  return {
    ok: true,
    method,
    cookies: garminCookies.length,
    csrf: true,
    message: `Logged in. Saved ${garminCookies.length} cookies to ${getSessionFile()}.`,
  };
}

/**
 * Open a real browser, let the user log in to Garmin Connect by hand, and
 * capture the session automatically once login completes.
 */
export async function performLogin(
  opts: { timeoutMs?: number; onProgress?: (msg: string) => void } = {}
): Promise<LoginResult> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const log = (msg: string): void => {
    console.error(`[login] ${msg}`);
    opts.onProgress?.(msg);
  };
  const playwright = await importPlaywright();

  // Prefer the user's real Chrome profile (best Cloudflare bypass); fall back to
  // a fresh Playwright Chromium if Chrome is unavailable or locked (already open).
  const chromeDataDir = join(
    homedir(),
    "Library/Application Support/Google/Chrome"
  );
  let method: LoginResult["method"] = "fresh-chromium";
  let browser: any = null;
  let context: any;

  if (existsSync(chromeDataDir)) {
    try {
      log(
        "Opening your Chrome profile (close other Chrome windows if this hangs)…"
      );
      context = await playwright.chromium.launchPersistentContext(
        chromeDataDir,
        { headless: false, channel: "chrome" }
      );
      method = "chrome-profile";
    } catch {
      log(
        "Chrome profile unavailable (Chrome may be open) — using a fresh browser instead."
      );
      context = null;
    }
  }

  if (!context) {
    try {
      // Real Chrome with a fresh profile — works even when the user's Chrome
      // profile is locked (Chrome already open). Preferred over the bundled
      // Chromium, whose headful mode crashes (dlopen) on some macOS setups.
      browser = await playwright.chromium.launch({
        headless: false,
        channel: "chrome",
      });
      log("Using Google Chrome (fresh profile).");
    } catch {
      log("Google Chrome unavailable — falling back to the bundled browser.");
      browser = await playwright.chromium.launch({ headless: false });
    }
    context = await browser.newContext();
    method = "fresh-chromium";
  }

  try {
    const page = await context.newPage();
    log("Navigating to Garmin Connect — log in if prompted…");
    await page.goto("https://connect.garmin.com/app/activities", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    const result = await captureSession(
      page,
      context,
      method,
      timeoutMs,
      log,
      false
    );
    if (!result.ok) {
      result.message =
        "Timed out waiting for login. Make sure you finished logging in and reached your activities list, then try again.";
    }
    return result;
  } finally {
    await closeQuietly(context, browser);
  }
}

/**
 * Unattended login using stored credentials (env vars or credentials.json).
 * Fills the Garmin SSO form headlessly and captures the session. Throws if no
 * credentials are configured; returns ok:false (with a hint) on failure.
 * Set GARMIN_LOGIN_HEADFUL=1 to watch it in a visible window (helps if
 * Cloudflare challenges the headless browser).
 */
export async function performAutoLogin(
  opts: { onProgress?: (msg: string) => void } = {}
): Promise<LoginResult> {
  const log = (msg: string): void => {
    console.error(`[auto-login] ${msg}`);
    opts.onProgress?.(msg);
  };
  const creds = loadCredentials();
  if (!creds) {
    throw new Error(
      "No stored credentials. Set GARMIN_EMAIL/GARMIN_PASSWORD or run `save-credentials`."
    );
  }
  const playwright = await importPlaywright();
  const headful = Boolean(process.env.GARMIN_LOGIN_HEADFUL);

  let browser: any;
  try {
    // Real Chrome has the best fingerprint against Cloudflare; fall back to the
    // bundled Chromium if Chrome isn't installed.
    browser = await playwright.chromium.launch({
      headless: !headful,
      channel: "chrome",
    });
  } catch {
    browser = await playwright.chromium.launch({ headless: !headful });
  }
  const context = await browser.newContext();

  try {
    const page = await context.newPage();
    log("Signing in with stored credentials…");
    await page.goto(SIGNIN_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForSelector("#email", { timeout: 30000 });
    await page.fill("#email", creds.email);
    await page.fill("#password", creds.password);
    // "Remember me" for a longer-lived session.
    try {
      await page.check('input[name="remember"]', { timeout: 2000 });
    } catch {
      // checkbox optional / absent — ignore
    }
    await page
      .click('button[data-testid="g__button"]', { timeout: 10000 })
      .catch(() => page.click('button[type="submit"]'));

    const result = await captureSession(
      page,
      context,
      "credentials",
      90 * 1000,
      log,
      true
    );
    if (!result.ok) {
      result.message =
        "Automated login didn't complete — check your stored email/password. If your account has 2FA, use manual login instead.";
    }
    return result;
  } catch (e) {
    if (e instanceof MfaRequiredError) {
      return {
        ok: false,
        method: "credentials",
        cookies: 0,
        csrf: false,
        message: e.message,
      };
    }
    throw e;
  } finally {
    await closeQuietly(context, browser);
  }
}

async function closeQuietly(context: any, browser: any): Promise<void> {
  try {
    await context?.close();
  } catch {
    /* ignore */
  }
  if (browser) {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
  }
}
