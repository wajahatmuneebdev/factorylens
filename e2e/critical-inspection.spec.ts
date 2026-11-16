import { expect, test, type Page } from "@playwright/test";

import { videoFixture } from "./support/video-fixture.js";

async function signIn(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await page.getByRole("link", { name: "Continue with Google" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

async function createInspection(page: Page, title: string): Promise<void> {
  await page.getByRole("link", { name: "New inspection" }).first().click();
  await page.getByLabel("Inspection name").fill(title);
  await page.getByLabel("Video file").setInputFiles(videoFixture);
  await page.getByRole("button", { name: "Create and upload" }).click();
  await expect(page).toHaveURL(/\/inspections\/[0-9a-f-]+$/);
}

test("uploads and investigates a completed inspection", async ({ page }) => {
  await signIn(page);
  await createInspection(page, "Critical journey");

  await expect(page.getByText("Queued", { exact: true })).toBeVisible();
  await expect(page.getByText("Processing", { exact: true })).toBeVisible({
    timeout: 8_000,
  });
  await expect(page.getByText("Completed", { exact: true })).toBeVisible({
    timeout: 8_000,
  });
  await expect(page.getByText(/1 visible prediction at 0\.0s/)).toBeVisible();

  const video = page.locator("video");
  await video.evaluate((video) => {
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      value: 0.8,
      writable: true,
    });
    video.dispatchEvent(new Event("timeupdate"));
  });
  await expect(page.getByText(/0 visible predictions at 0\.8s/)).toBeVisible();

  await page.getByRole("checkbox", { name: "NO-Hardhat" }).uncheck();
  await expect(page.getByText("0 of 1 visible")).toBeVisible();
  await page.getByRole("checkbox", { name: "NO-Hardhat" }).check();
  const event = page.getByRole("button", {
    name: /Missing hard hat at 0\.0 seconds/,
  });
  await event.click();
  await expect(event).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(/1 visible prediction at 0\.0s/)).toBeVisible();
  await expect(
    page.getByRole("status", { name: "Selected event details" }),
  ).toContainText("peak confidence 93%");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV" }).click();
  await expect((await download).suggestedFilename()).toMatch(
    /^factorylens-[0-9a-f-]+-results\.csv$/,
  );
});

test("offers recovery after a terminal processing attempt", async ({
  page,
}) => {
  await signIn(page);
  await createInspection(page, "Representative failure");

  await expect(page.getByText("Queued", { exact: true })).toBeVisible();
  await expect(page.getByText("Processing", { exact: true })).toBeVisible({
    timeout: 8_000,
  });
  await expect(page.getByText("Failed", { exact: true })).toBeVisible({
    timeout: 8_000,
  });
  await expect(
    page.getByText("Fixture inference is temporarily unavailable."),
  ).toBeVisible();

  await page.getByRole("button", { name: "Retry inspection" }).click();
  await expect(page.getByText("Queued", { exact: true })).toBeVisible();
});
