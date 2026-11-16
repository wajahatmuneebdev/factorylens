import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { videoFixture } from "./support/video-fixture.js";

const accessibilityTags = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22aa",
];

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(accessibilityTags)
    .analyze();
  expect(
    results.violations,
    results.violations
      .map((violation) => `${violation.id}: ${violation.help}`)
      .join("\n"),
  ).toEqual([]);
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await page.getByRole("link", { name: "Continue with Google" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(
    page.getByRole("heading", { name: "Inspection dashboard" }),
  ).toBeVisible();
}

test("critical routes pass automated WCAG checks", async ({ page }) => {
  await page.goto("/sign-in");
  await expectNoAccessibilityViolations(page);

  await signIn(page);
  await expect(
    page.getByRole("heading", { name: "No inspections yet" }),
  ).toBeVisible();
  await expectNoAccessibilityViolations(page);

  await page.goto("/inspections/new");
  await expectNoAccessibilityViolations(page);

  await page.goto("/history");
  await expect(
    page.getByRole("heading", { name: "No inspection history yet" }),
  ).toBeVisible();
  await expectNoAccessibilityViolations(page);

  await page.goto("/inspections/new");
  await page.getByLabel("Inspection name").fill("Accessibility review");
  await page.getByLabel("Video file").setInputFiles(videoFixture);
  await page.getByRole("button", { name: "Create and upload" }).click();
  await expect(page.getByText("Completed", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/visible prediction at/)).toBeVisible();
  await expectNoAccessibilityViolations(page);
});

test("keyboard routing, tablet reflow, zoom reflow, and reduced motion remain usable", async ({
  page,
}) => {
  await signIn(page);
  await expect(page.locator("#main-content")).toBeFocused();
  const skipLink = page.getByRole("link", { name: "Skip to main content" });
  await skipLink.focus();
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();

  const newInspectionLink = page
    .getByRole("link", { name: "New inspection" })
    .first();
  await newInspectionLink.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/inspections\/new$/);
  await expect(page.locator("#main-content")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Inspection name")).toBeFocused();

  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 640, height: 720 },
  ]) {
    await page.setViewportSize(viewport);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await expect(page.getByLabel("Inspection name")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Create and upload" }),
    ).toBeVisible();
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  const transitionDuration = await newInspectionLink.evaluate((element) =>
    getComputedStyle(element)
      .transitionDuration.split(",")
      .map((value) => Number.parseFloat(value))
      .reduce((longest, value) => Math.max(longest, value), 0),
  );
  expect(transitionDuration).toBeLessThanOrEqual(0.001);

  const accountLink = page.getByRole("link", { name: "Account", exact: true });
  await accountLink.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
  await page.keyboard.press("Tab");
  const signOutTrigger = page.getByRole("button", { name: "Sign out" });
  await expect(signOutTrigger).toBeFocused();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Leave FactoryLens?" });
  await expect(
    dialog.getByRole("button", { name: "Close dialog" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  expect(
    await dialog.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(signOutTrigger).toBeFocused();
});
