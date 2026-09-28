import { expect, test } from "@playwright/test";

test("Peeraxis page lists every feature with where it is", async ({ page }) => {
  const titles = [
    "Greeting says hello",
    "Farewell says goodbye",
    "Dark mode for the settings page",
    "Import contacts from a file",
    "Title is bold",
  ];

  async function expectFeature(title: string, status: string) {
    const name = page.getByText(title, { exact: true });
    await expect(name).toHaveCount(1);
    await expect(name).toBeVisible();

    // Associate the label with this feature, without prescribing table/list markup.
    let containers = name.locator("xpath=ancestor::*");
    for (const other of titles.filter((value) => value !== title)) {
      containers = containers.filter({ hasNot: page.getByText(other, { exact: true }) });
    }
    const row = containers.filter({ has: page.getByText(status, { exact: true }) }).first();
    const label = row.getByText(status, { exact: true });
    await expect(label).toHaveCount(1);
    await expect(label).toBeVisible();

    // A compact label sits beside the title on the same visible row.
    const nameBox = (await name.boundingBox())!;
    const labelBox = (await label.boundingBox())!;
    const rowBox = (await row.boundingBox())!;
    expect(Math.min(nameBox.y + nameBox.height, labelBox.y + labelBox.height))
      .toBeGreaterThan(Math.max(nameBox.y, labelBox.y));
    expect(labelBox.width).toBeLessThan(rowBox.width);
    expect(labelBox.height).toBeLessThanOrEqual(nameBox.height * 2);

    // Check visible colour treatment, without choosing the product's palette.
    const titleColours = await name.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.color, style.backgroundColor, style.borderTopColor];
    });
    await expect.poll(() => label.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.color, style.backgroundColor, style.borderTopColor];
    })).not.toEqual(titleColours);
  }

  await test.step('Open Peeraxis and see "Greeting says hello" marked Waiting for you', async () => {
    await page.goto("/");
    await expectFeature("Greeting says hello", "Waiting for you");
  });

  await test.step('See "Farewell says goodbye" marked Building and "Dark mode for the settings page" marked Queued', async () => {
    await expectFeature("Farewell says goodbye", "Building");
    await expectFeature("Dark mode for the settings page", "Queued");
  });

  await test.step('See "Import contacts from a file" marked Stopped', async () => {
    await expectFeature("Import contacts from a file", "Stopped");
  });

  await test.step('See "Title is bold" marked Accepted', async () => {
    await expectFeature("Title is bold", "Accepted");
  });
});
