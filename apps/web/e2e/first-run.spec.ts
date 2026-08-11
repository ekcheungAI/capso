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

const onePixelPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+8xwAAAAASUVORK5CYII=";

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

/**
 * A real ClipboardEvent, not an Event with `clipboardData` assigned onto it.
 * The handler in capture.tsx reads `e.clipboardData.items`, and only a genuine
 * ClipboardEvent constructed with a DataTransfer populates that — the assigned
 * plain-Event version dispatches happily and delivers an empty item list, so the
 * test passed the dispatch and then timed out waiting for a capture.
 */
async function paste(page: Page) {
  await page.evaluate(async (dataUrl) => {
    const blob = await (await fetch(dataUrl)).blob();
    const data = new DataTransfer();
    data.items.add(new File([blob], "capture.png", { type: "image/png" }));
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
  }, onePixelPng);
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

  const buttons = page.locator("main button");
  const count = await buttons.count();
  expect(count).toBeGreaterThan(0);

  for (let i = 0; i < count; i += 1) {
    const box = await buttons.nth(i).boundingBox();
    if (!box) continue;
    expect(box.height, await buttons.nth(i).innerText()).toBeGreaterThanOrEqual(44);
  }
});
