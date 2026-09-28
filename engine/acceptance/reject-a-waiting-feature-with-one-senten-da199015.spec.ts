import { expect, test } from "@playwright/test";

test("Reject a waiting feature with one sentence of why", async ({ page }) => {
  const title = "Greeting says hello";
  const reason = "The greeting should be warmer";
  const feature = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: title, exact: true }),
  });

  await test.step('Press Reject on "Greeting says hello" and type "The greeting should be warmer"', async () => {
    await page.goto("/");
    await expect(feature.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(feature.getByText("Waiting for you", { exact: true })).toBeVisible();
    const reject = feature.getByRole("button", { name: "Reject", exact: true });
    await expect(reject).toBeVisible();
    await reject.click();

    // The reason may be requested on the feature itself or in a dialog.
    const reasonBox = feature.getByRole("textbox").or(
      page.getByRole("dialog").getByRole("textbox"),
    );
    await expect(reasonBox).toBeVisible();
    await reasonBox.fill(reason);
    await expect(reasonBox).toHaveValue(reason);
    await reasonBox.press("Enter");
  });

  await test.step('See "Greeting says hello" marked Rejected with "The greeting should be warmer" under it', async () => {
    const heading = feature.getByRole("heading", { name: title, exact: true });
    const explanation = feature.getByText(reason, { exact: true });
    await expect(heading).toBeVisible();
    await expect(feature.getByText("Rejected", { exact: true })).toBeVisible();
    await expect(explanation).toBeVisible();

    const headingBox = await heading.boundingBox();
    const reasonBox = await explanation.boundingBox();
    expect(reasonBox!.y).toBeGreaterThanOrEqual(headingBox!.y + headingBox!.height);
  });
});
