import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const stores = ["screenshots", "threads", "corrections", "revisits", "messages", "images"];
const onePixelPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+8xwAAAAASUVORK5CYII=";

async function seedReviewLibrary(page: Page) {
  await page.goto("/extension");
  await page.evaluate(
    async ({ storeNames, onePixelPng }) => {
      const now = new Date().toISOString();
      const thread = {
        id: "qa-project",
        name: "Launch research",
        description: "Pricing and positioning references",
        createdAt: now,
        lastActiveAt: now,
        archived: false,
      };
      const screenshot = {
        id: "qa-pricing",
        title: "Pricing ideas",
        summary: "A calm pricing page reference",
        whySaved: "Review the hierarchy and comparison pattern",
        ocrText: "Simple pricing for small teams",
        intent: "competitor",
        type: "web_page",
        threadId: thread.id,
        suggestedThreadId: thread.id,
        confidence: 0.82,
        status: "done",
        simulated: false,
        assignmentSource: "manual",
        source: "web_upload",
        capturedAt: now,
        imageDataUrl: onePixelPng,
        thumbDataUrl: onePixelPng,
        width: 800,
        height: 500,
        hue: 20,
        aspect: "wide",
        archived: false,
        pageUrl: "https://example.com/pricing",
        pageTitle: "Example pricing",
        sourceApp: null,
        tags: ["pricing", "layout"],
        userTags: [],
        ocrSource: "llm",
        ocrLangs: ["en"],
        contentHash: "qa-pricing",
        originalPath: null,
        thumbPath: null,
      };

      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("capso", 3);
        request.onupgradeneeded = () => {
          for (const name of storeNames) {
            if (!request.result.objectStoreNames.contains(name)) {
              request.result.createObjectStore(name, { keyPath: "id" });
            }
          }
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const transaction = request.result.transaction(["threads", "screenshots"], "readwrite");
          transaction.objectStore("threads").put(thread);
          transaction.objectStore("screenshots").put(screenshot);
          transaction.oncomplete = () => {
            request.result.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
      });
    },
    { storeNames: stores, onePixelPng },
  );
}

async function expectNoSeriousViolations(page: Page, selector: string) {
  const results = await new AxeBuilder({ page })
    .include(selector)
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations).toEqual([]);
}

test("search filters are visible, reversible, and stable through reload", async ({ page }) => {
  await seedReviewLibrary(page);
  await page.goto("/search?q=pricing&project=qa-project&intent=competitor&date=30d");

  await expect(page.getByRole("textbox", { name: "Search query" })).toHaveValue("pricing");
  await expect(page.getByRole("combobox", { name: "Project" })).toHaveValue("qa-project");
  await expect(page.getByRole("combobox", { name: "Intent" })).toHaveValue("competitor");
  await expect(page.getByRole("combobox", { name: "Date captured" })).toHaveValue("30d");
  await expect(page.getByLabel("Active search filters").getByRole("button")).toHaveCount(3);
  await expect(page.getByRole("link", { name: /Pricing ideas/ })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("textbox", { name: "Search query" })).toHaveValue("pricing");
  await expect(page).toHaveURL(/project=qa-project.*intent=competitor.*date=30d/);

  await page.getByRole("button", { name: /Intent: Competitor/ }).click();
  await expect(page).not.toHaveURL(/intent=/);
  await expectNoSeriousViolations(page, "main");
});

test("mobile More sheet owns focus, closes with Escape, and keeps 44px controls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedReviewLibrary(page);
  await page.goto("/search");

  const trigger = page.getByRole("button", { name: "More" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "More" });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("button", { name: "Close panel" })).toBeFocused();

  const measuredControls = await page
    .locator('button[aria-label="Close panel"], button[aria-label="More"], select')
    .evaluateAll((nodes) => nodes.map((node) => ({
      label: node.getAttribute("aria-label") || node.textContent?.trim() || node.tagName,
      height: Math.round(node.getBoundingClientRect().height),
    })));
  expect(
    measuredControls.filter(({ height }) => height < 44),
    `Controls smaller than 44px: ${JSON.stringify(measuredControls)}`,
  ).toEqual([]);
  await expectNoSeriousViolations(page, '[role="dialog"]');

  await dialog.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("dialog", { name: "Capso settings" })).toBeVisible();

  // Close Settings so the focus-return assertion still verifies the original
  // More trigger rather than a synthetic second journey.
  await page.getByRole("button", { name: "Close panel" }).click();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(page.getByRole("dialog", { name: "More" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("system dark mode reaches the app shell", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await seedReviewLibrary(page);
  await page.goto("/search");

  const palette = await page.evaluate(() => ({
    background: getComputedStyle(document.body).backgroundColor,
    foreground: getComputedStyle(document.body).color,
  }));
  expect(palette).toEqual({
    background: "rgb(20, 20, 18)",
    foreground: "rgb(237, 237, 234)",
  });
});

test("copy image writes PNG pixels instead of a data URL string", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "http://127.0.0.1:3013",
  });
  await seedReviewLibrary(page);
  await page.goto("/s/qa-pricing");

  await page.getByRole("button", { name: "Copy image" }).click();
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await navigator.clipboard.read()).flatMap((item) => item.types),
      ),
    )
    .toContain("image/png");
});

test("delete confirmation distinguishes cloud deletion from retained Mac originals", async ({ page }) => {
  await seedReviewLibrary(page);
  await page.goto("/s/qa-pricing");

  const dialogMessage = new Promise<string>((resolve) => {
    page.once("dialog", async (dialog) => {
      resolve(dialog.message());
      await dialog.dismiss();
    });
  });
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(dialogMessage).resolves.toMatch(/cloud copy.*Mac original.*stays local/i);
});

test("mobile capture detail keeps every visible control touch-sized", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/library");
  await page.getByRole("button", { name: /Explore with sample captures/ }).click();
  await page.locator('a[href^="/s/"]').first().click();

  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const undersized = await page.locator("main").evaluate((main) =>
    [...main.querySelectorAll<HTMLElement>("a, button, input, select, textarea")]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          box.width > 0 &&
          box.height > 0 &&
          (box.width < 44 || box.height < 44)
        );
      })
      .map((element) => ({
        label: element.getAttribute("aria-label") || element.textContent?.trim() || element.tagName,
        width: Math.round(element.getBoundingClientRect().width),
        height: Math.round(element.getBoundingClientRect().height),
      })),
  );

  expect(undersized).toEqual([]);
});
