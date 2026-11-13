// The real browser driver: Playwright (playwright-core, which downloads no
// browser) on the owner's installed Chrome/Edge/Chromium, either
//   persistent: launched on a dedicated profile directory the owner signed into
//               once (recommended), or
//   cdp:        attached to a browser the owner started with
//               --remote-debugging-port on a loopback address.
// UNVERIFIED LIVE: this module has not been run against the live sites.

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { BrowserConfig } from "../config.ts";
import type { BrowserDriver } from "../sites/types.ts";
import type { DriverSession } from "../poster.ts";

const ACTION_TIMEOUT_MS = 15_000;

class PlaywrightDriver implements BrowserDriver {
  private readonly page: Page;
  constructor(page: Page) {
    this.page = page;
  }
  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  }
  html(): Promise<string> {
    return this.page.content();
  }
  async insertText(selector: string, text: string): Promise<void> {
    const el = this.page.locator(selector).first();
    await el.click({ timeout: ACTION_TIMEOUT_MS });
    await this.page.keyboard.insertText(text);
  }
  async attachFiles(selector: string, paths: string[], opts?: { viaChooser?: boolean }): Promise<void> {
    if (opts?.viaChooser) {
      const [chooser] = await Promise.all([
        this.page.waitForEvent("filechooser", { timeout: ACTION_TIMEOUT_MS }),
        this.page.locator(selector).first().click({ timeout: ACTION_TIMEOUT_MS }),
      ]);
      await chooser.setFiles(paths);
      return;
    }
    await this.page.locator(selector).first().setInputFiles(paths, { timeout: ACTION_TIMEOUT_MS });
  }
  async click(selector: string): Promise<void> {
    // Playwright waits for the element to be visible, stable, enabled and to
    // receive the pointer event at its centre (nothing covering it) before it
    // clicks, and clicks once.
    await this.page.locator(selector).first().click({ timeout: ACTION_TIMEOUT_MS });
  }
  sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
  now(): number {
    return Date.now();
  }
}

export async function openPlaywright(cfg: BrowserConfig): Promise<DriverSession> {
  if (cfg.mode === "cdp") {
    const browser: Browser = await chromium.connectOverCDP(cfg.cdp_endpoint as string);
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close().catch(() => undefined);
      throw new Error("the browser at cdp_endpoint has no default context");
    }
    const page = await context.newPage();
    // A background tab is throttled and a click on it can be dropped; ask the
    // page to behave as focused without raising its window.
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined);
    return {
      driver: new PlaywrightDriver(page),
      close: async () => {
        await page.close().catch(() => undefined);
        // Disconnect only: closing a connectOverCDP browser object detaches,
        // it never quits the owner's browser.
        await browser.close().catch(() => undefined);
      },
    };
  }
  const opts: Parameters<typeof chromium.launchPersistentContext>[1] = { headless: cfg.headless, viewport: null };
  if (cfg.channel) opts.channel = cfg.channel;
  if (cfg.executable_path) opts.executablePath = cfg.executable_path;
  const context: BrowserContext = await chromium.launchPersistentContext(cfg.user_data_dir, opts);
  const page = context.pages()[0] ?? await context.newPage();
  return {
    driver: new PlaywrightDriver(page),
    close: () => context.close(),
  };
}

/** Open the dedicated profile so the owner can sign in by hand (`muster-social login`). */
export async function openForLogin(cfg: BrowserConfig, urls: string[]): Promise<BrowserContext> {
  if (cfg.mode !== "persistent") throw new Error("login is for persistent mode; in cdp mode sign in in your own browser");
  const opts: Parameters<typeof chromium.launchPersistentContext>[1] = { headless: false, viewport: null };
  if (cfg.channel) opts.channel = cfg.channel;
  if (cfg.executable_path) opts.executablePath = cfg.executable_path;
  const context = await chromium.launchPersistentContext(cfg.user_data_dir, opts);
  for (const u of urls) {
    const p = await context.newPage();
    await p.goto(u).catch(() => undefined);
  }
  return context;
}
