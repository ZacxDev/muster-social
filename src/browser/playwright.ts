// The real browser driver: Playwright (playwright-core, which downloads no
// browser) on the owner's installed Chrome/Edge/Chromium, launched on a
// dedicated profile directory the owner signed into once (`muster-social login`).
// It never attaches to the owner's everyday browser.
// UNVERIFIED LIVE: this module has not been run against the live sites.

import { chromium, type BrowserContext, type Page } from "playwright-core";
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
