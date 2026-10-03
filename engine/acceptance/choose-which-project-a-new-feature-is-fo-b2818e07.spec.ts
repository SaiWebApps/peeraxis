import { expect, test } from "@playwright/test";

test("Choose which project a new feature is for", async ({ page }) => {
  const picker = page.getByRole("combobox");
  const newFeature = page.getByRole("textbox", { name: "New feature", exact: true });
  let nativePicker = false;

  await test.step('See a project picker next to the new-feature box offering "sample-project" and "second-project"', async () => {
    try {
      await page.goto("/");
      await expect(picker).toBeVisible();
      await expect(newFeature).toBeVisible();

      // Use screen coordinates only to check the promised placement.
      const projectBox = await picker.boundingBox();
      const featureBox = await newFeature.boundingBox();
      expect(projectBox).not.toBeNull();
      expect(featureBox).not.toBeNull();
      expect(projectBox!.x + projectBox!.width).toBeLessThanOrEqual(featureBox!.x);
      expect(projectBox!.y).toBeLessThan(featureBox!.y + featureBox!.height);
      expect(projectBox!.y + projectBox!.height).toBeGreaterThan(featureBox!.y);

      // Native selects expose their choices differently from custom comboboxes.
      nativePicker = await picker.evaluate((element) => element.tagName === "SELECT");
      if (!nativePicker) await picker.click();
      for (const name of ["sample-project", "second-project"]) {
        const option = nativePicker
          ? picker.getByRole("option", { name, exact: true })
          : page.getByRole("option", { name, exact: true });
        if (nativePicker) {
          await expect(option).toHaveText(name);
          await expect(option).toBeEnabled();
        } else {
          await expect(option).toBeVisible();
        }
      }
    } finally {
      await page.screenshot({ path: test.info().outputPath("step-1.png") });
    }
  });

  await test.step('Choose "second-project", describe a feature, answer the question, and see "Pin a feature to the top" under "Needs your yes" labelled "second-project"', async () => {
    try {
      if (nativePicker) {
        await picker.selectOption({ label: "second-project" });
      } else {
        await page.getByRole("option", { name: "second-project", exact: true }).click();
      }
      await newFeature.fill("Let me pin a feature to the top");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(page.getByText("Should a pinned feature stay pinned after you accept it?", {
        exact: true,
      })).toBeVisible();
      await page.getByRole("button", { name: "No, unpin it when accepted", exact: true }).click();

      const drafts = page.getByRole("region", { name: "Needs your yes", exact: true });
      await expect(drafts.getByRole("heading", { name: "Needs your yes", exact: true })).toBeVisible();
      const card = drafts.getByRole("article").filter({
        has: page.getByRole("heading", { name: "Pin a feature to the top", exact: true }),
      });
      await expect(card.getByRole("heading", { name: "Pin a feature to the top", exact: true })).toBeVisible();
      await expect(card.getByText("second-project", { exact: true })).toBeVisible();
    } finally {
      await page.screenshot({ path: test.info().outputPath("step-2.png") });
    }
  });
});
