import { expect, test } from "@playwright/test";

test("A stopped feature shows why it stopped", async ({ page }) => {
  await page.goto("/");

  await test.step('See the row for "Import contacts from a file" say "Parked: the project\'s own check fails before any change, so nothing was built."', async () => {
    const title = "Import contacts from a file";
    const reason = "Parked: the project's own check fails before any change, so nothing was built.";
    await expect(page.getByText(title, { exact: true })).toBeVisible();

    // A feature can be presented as an article, table row, list item, or ordinary
    // group. Match its visible contents without requiring a heading or CSS hook.
    let row = page.getByRole("article")
      .or(page.getByRole("row"))
      .or(page.getByRole("listitem"))
      .or(page.getByRole("group"))
      .or(page.getByRole("region"))
      .or(page.getByRole("generic"))
      .filter({ has: page.getByText(title, { exact: true }) });

    // Exclude the overall feature list and other multi-feature containers: the
    // sentence must belong to this feature's own group, not merely the page.
    for (const otherTitle of [
      "Greeting says hello",
      "Farewell says goodbye",
      "Dark mode for the settings page",
      "Title is bold",
    ]) {
      row = row.filter({ hasNot: page.getByText(otherTitle, { exact: true }) });
    }

    await expect(row.getByText(reason, { exact: true })).toBeVisible();
  });
});
