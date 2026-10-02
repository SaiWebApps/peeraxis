import { expect, test } from "@playwright/test";

test("Change which model does a job", async ({ page }) => {
  const builds = page.getByRole("combobox", { name: "Builds", exact: true });

  // Use displayed model names, without depending on option values. Support
  // both the browser's dropdown and an accessible custom dropdown.
  async function chooseModel(model: string) {
    await expect(builds).toBeVisible();
    if (await builds.evaluate((element) => element instanceof HTMLSelectElement)) {
      await builds.selectOption({ label: model });
    } else {
      await builds.click();
      await page.getByRole("option", { name: model, exact: true }).click();
    }
  }

  async function expectModel(model: string) {
    await expect(builds).toBeVisible();
    await expect.poll(() => builds.evaluate((element) => {
      if (element instanceof HTMLSelectElement) {
        return element.selectedOptions.item(0)?.label;
      }
      if (element instanceof HTMLInputElement) return element.value;
      return (element as HTMLElement).innerText.trim();
    }), { message: `Builds visibly shows ${model}` }).toBe(model);
  }

  await test.step('On the Models page, change "Builds" to claude-fable-5-1, reload, and see claude-fable-5-1 still shown for Builds', async () => {
    try {
      await page.goto("/models");
      await chooseModel("claude-fable-5-1");
      await expectModel("claude-fable-5-1");
      await page.reload();
      await expectModel("claude-fable-5-1");
    } finally {
      await page.screenshot({ path: test.info().outputPath("step-1.png") });
    }
  });

  await test.step('Change "Builds" to gpt-6-sol and see "The builder and its checker can\'t be from the same family." with Builds unchanged', async () => {
    try {
      await chooseModel("gpt-6-sol");
      await expect(page.getByText(
        "The builder and its checker can't be from the same family.",
        { exact: true },
      )).toBeVisible();
      await expectModel("claude-fable-5-1");
    } finally {
      await page.screenshot({ path: test.info().outputPath("step-2.png") });
    }
  });
});
