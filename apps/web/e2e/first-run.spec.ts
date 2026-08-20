import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * First run had no coverage at all, and it had shipped three defects because of
 * that: the picker killed the capture layer, the welcome screen was unreachable,
 * and the welcome it did have offered no control to press. Each test below pins
 * one of those.
 *
 * The account gate is bypassed here because playwright.config.ts runs with empty
 * Supabase env, so `isConfigured()` is false and AccountGate renders children
 * directly. That is also why these tests can navigate straight to "/".
 */

/**
 * Note for anyone adding a capture test: do NOT reuse review-ready.spec.ts's
 * `onePixelPng`. That fixture is only ever written straight into IndexedDB as a
 * stored `imageDataUrl`, so nothing decodes it — and `createImageBitmap` rejects
 * it outright with "the source image could not be decoded". Capture runs every
 * file through `downscale`, which decodes, so it needs an image that really is
 * one. `paste()` below paints a real PNG in-page instead.
 */

/**
 * Inverse of review-ready.spec.ts's seedReviewLibrary. Reached via /extension for
 * the same reason that spec uses it: it is a same-origin page that is exempt from
 * the first-run cover, so storage can be cleared without the picker in the way.
 */
async function clearLibrary(page: Page) {
  await page.goto("/extension");
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase("capso");
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  });
}

/** Paste a real, decodable image the way a user would. */
async function paste(page: Page) {
  await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 240;
    c.height = 160;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#3355aa";
    ctx.fillRect(0, 0, 240, 160);
    const blob = await new Promise<Blob>((resolve) => c.toBlob((b) => resolve(b!), "image/png"));

    const data = new DataTransfer();
    data.items.add(new File([blob], "capture.png", { type: "image/png" }));
    // A genuine ClipboardEvent: capture.tsx reads `e.clipboardData.items`, and
    // only the real constructor populates that.
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
  });
}

test.beforeEach(async ({ page }) => {
  await clearLibrary(page);
});

test("first run keeps drop, paste and Capture alive", async ({ page }) => {
  // The regression: Shell used to return early for the picker and never mount
  // CaptureLayer, so the one screen that says "drop an image anywhere, paste
  // from the clipboard, or press Capture" could do none of those things.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /what kind of work/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Capture$/ })).toBeVisible();
  await expect(page.locator("#capso-import-input")).toBeAttached();
});

test("pasting during first run creates a capture", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /what kind of work/i })).toBeVisible();
  await paste(page);
  await expect(page.getByRole("heading", { name: /what kind of work/i })).toBeHidden({
    timeout: 15_000,
  });
});

test("picking a role lands on a welcome with a real CTA, not an empty tray", async ({ page }) => {
  // The core bug. page.tsx gated its welcome on `threads.length === 0`, which a
  // role template makes false immediately, so this landed on "Today's tray" with
  // an empty tray and no welcome anywhere.
  await page.goto("/");
  await page.getByRole("button", { name: /Product & design/ }).click();

  await expect(
    page.getByRole("heading", { name: /your visual memory starts with one screenshot/i }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: /today’s tray/i })).toBeHidden();

  // And it is a control, not the inert string the old `action` prop rendered.
  const cta = page.getByRole("button", { name: /add screenshots/i });
  await expect(cta).toBeEnabled();
});

test("the welcome survives 'Start empty', which creates no projects", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Start empty/ }).click();
  await expect(
    page.getByRole("heading", { name: /your visual memory starts with one screenshot/i }),
  ).toBeVisible();
});

test("the nudge appears for samples and does not return after a capture", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Explore with sample captures/ }).click();

  const nudge = page.getByText(/These are samples, so you can see how filing works/);
  await expect(nudge).toBeVisible();

  await paste(page);
  await expect(nudge).toBeHidden({ timeout: 15_000 });

  // The latch is what makes this permanent — no dismiss button exists, per the
  // ban on checklists that outlive onboarding.
  await page.reload();
  await expect(nudge).toBeHidden();
});

test("sample setup resolves suggested projects instead of confirming back to Inbox", async ({ page }) => {
  await page.goto("/review");
  await page.getByRole("button", { name: /Explore with sample captures/ }).click();

  await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Confirm - Onboarding teardown/ })).toHaveCount(2);
  await expect(page.getByRole("button", { name: /Confirm - Q3 launch campaign/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Confirm - Inbox/ })).toHaveCount(0);
});

test("finishing the tall picker reveals the top of the destination page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/library");
  await page.getByRole("button", { name: /Explore with sample captures/ }).click();

  await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test("'Skip for now' leaves first run without choosing a role", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Skip for now/ }).click();
  await expect(page.getByRole("heading", { name: /what kind of work/i })).toBeHidden();

  // And it stays gone on the next route, which is what the escape hatch is for.
  await page.goto("/library");
  await expect(page.getByRole("heading", { name: /what kind of work/i })).toBeHidden();
});

test("first run and the welcome have no serious accessibility violations", async ({ page }) => {
  await page.goto("/");
  const picker = await new AxeBuilder({ page }).include("main").analyze();
  expect(
    picker.violations.filter((v) => v.impact === "serious" || v.impact === "critical"),
  ).toEqual([]);

  await page.getByRole("button", { name: /Product & design/ }).click();
  await expect(
    page.getByRole("heading", { name: /your visual memory starts with one screenshot/i }),
  ).toBeVisible();

  const welcome = await new AxeBuilder({ page }).include("main").analyze();
  expect(
    welcome.violations.filter((v) => v.impact === "serious" || v.impact === "critical"),
  ).toEqual([]);
});

test("every first-run control clears 44px at 390px wide", async ({ page }) => {
  // The role cards carried no minimum height before this change.
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/");
  // count() does not auto-wait, so this has to gate on something that does or it
  // measures an unhydrated page and finds nothing.
  await expect(page.getByRole("heading", { name: /what kind of work/i })).toBeVisible();

  const buttons = page.locator("main button");
  const count = await buttons.count();
  expect(count).toBeGreaterThan(0);

  for (let i = 0; i < count; i += 1) {
    const box = await buttons.nth(i).boundingBox();
    if (!box) continue;
    expect(box.height, await buttons.nth(i).innerText()).toBeGreaterThanOrEqual(44);
  }
});
