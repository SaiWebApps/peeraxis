import { expect, test } from "@playwright/test";

test("See which model does each job", async ({ page }) => {
  await test.step("Open Models from the Peeraxis page", async () => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Peeraxis", exact: true })).toBeVisible();
    const models = page.getByRole("link", { name: "Models", exact: true });
    await expect(models).toBeVisible();
    await models.click();

    for (const job of [
      "Asks you questions",
      "Checks the test matches the card",
      "Builds",
      "Writes the hidden test",
      "Reviews the change",
      "Reviews how it looks",
      "Splits stuck work",
    ]) {
      await expect(page.getByText(job, { exact: true })).toBeVisible();
    }
  });

  await test.step('See "Builds" done by claude-opus-5-5 and "Writes the hidden test" done by gpt-6-astra', async () => {
    for (const [job, model] of [
      ["Builds", "claude-opus-5-5"],
      ["Writes the hidden test", "gpt-6-astra"],
    ]) {
      const jobLabel = page.getByText(job, { exact: true });
      await expect(jobLabel).toBeVisible();

      // The same model can do several jobs. Check its visible position beside
      // this job in the promised two-column list, without requiring DOM wrappers.
      await expect.poll(async () => {
        const jobBox = await jobLabel.boundingBox();
        if (!jobBox) return false;
        for (const modelLabel of await page.getByText(model, { exact: true }).all()) {
          if (!(await modelLabel.isVisible())) continue;
          const modelBox = await modelLabel.boundingBox();
          if (modelBox && modelBox.x >= jobBox.x + jobBox.width &&
              Math.min(jobBox.y + jobBox.height, modelBox.y + modelBox.height) >
              Math.max(jobBox.y, modelBox.y)) return true;
        }
        return false;
      }, { message: `${job} shows ${model} in the model column on its row` }).toBe(true);
    }
  });
});
