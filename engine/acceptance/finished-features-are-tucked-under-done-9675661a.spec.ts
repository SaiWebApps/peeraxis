import { expect, test, type Page } from "@playwright/test";

const titles = [
  "Greeting says hello",
  "Farewell says goodbye",
  "Dark mode for the settings page",
  "Import contacts from a file",
  "Title is bold",
  "Show the date each feature finished",
  "Second project is set up",
];

function featureStatus(page: Page, title: string, status: string) {
  // Locate the named feature's visible group, allowing different accessible
  // presentations. Exclude groups containing other features so a status
  // elsewhere on the page cannot satisfy this check.
  let feature = page.getByRole("article")
    .or(page.getByRole("row"))
    .or(page.getByRole("listitem"))
    .or(page.getByRole("group"))
    .or(page.getByRole("region"))
    .or(page.getByRole("generic"))
    .filter({ has: page.getByText(title, { exact: true }) });
  for (const other of titles.filter((name) => name !== title)) {
    feature = feature.filter({ hasNot: page.getByText(other, { exact: true }) });
  }
  return feature.getByText(status, { exact: true });
}

test("Finished features are tucked under Done", async ({ page }) => {
  await page.goto("/");
  const done = page.getByRole("heading", { name: "Done", exact: true });

  await test.step('See "Greeting says hello" (Waiting for you) above the "Done" heading', async () => {
    try {
      const title = page.getByText("Greeting says hello", { exact: true });
      const status = featureStatus(page, "Greeting says hello", "Waiting for you");
      await expect(title).toBeVisible();
      await expect(status).toBeVisible();
      await expect(done).toBeVisible();
      await expect.poll(async () => {
        const headingBox = await done.boundingBox();
        const titleBox = await title.boundingBox();
        const statusBox = await status.boundingBox();
        return !!headingBox && !!titleBox && !!statusBox
          && titleBox.y + titleBox.height <= headingBox.y
          && statusBox.y + statusBox.height <= headingBox.y;
      }).toBe(true);
    } finally {
      await page.screenshot({ path: test.info().outputPath("step-1.png"), fullPage: true });
    }
  });

  await test.step('See "Title is bold" (Accepted) under the "Done" heading', async () => {
    try {
      const title = page.getByText("Title is bold", { exact: true });
      const status = featureStatus(page, "Title is bold", "Accepted");
      await expect(done).toBeVisible();
      await expect(title).toBeVisible();
      await expect(status).toBeVisible();
      await expect.poll(async () => {
        const headingBox = await done.boundingBox();
        const titleBox = await title.boundingBox();
        const statusBox = await status.boundingBox();
        return !!headingBox && !!titleBox && !!statusBox
          && titleBox.y >= headingBox.y + headingBox.height
          && statusBox.y >= headingBox.y + headingBox.height;
      }).toBe(true);
    } finally {
      await page.screenshot({ path: test.info().outputPath("step-2.png"), fullPage: true });
    }
  });
});
