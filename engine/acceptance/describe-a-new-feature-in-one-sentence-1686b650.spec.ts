import { expect, test, type Locator } from "@playwright/test";

test("Describe a new feature in one sentence", async ({ page }) => {
  const sentence = "Let me pin a feature to the top";
  const question = "Should a pinned feature stay pinned after you accept it?";
  const recommended = page.getByRole("button", {
    name: "No, unpin it when accepted",
  });
  const existingFeatures = [
    "Greeting says hello",
    "Farewell says goodbye",
    "Dark mode for the settings page",
    "Import contacts from a file",
    "Title is bold",
  ];

  await test.step('Type "Let me pin a feature to the top" in the new-feature box and send it', async () => {
    try {
      await page.goto("/");
      // The card does not prescribe the box's label. Identify the top textbox
      // visually, above the existing features, without needing any draft section.
      let newFeature: Locator | undefined;
      await expect.poll(async () => {
        const featureBoxes = await Promise.all(existingFeatures.map((title) =>
          page.getByText(title, { exact: true }).boundingBox()));
        const candidates: Locator[] = [];
        for (const textbox of await page.getByRole("textbox").all()) {
          if (!(await textbox.isVisible())) continue;
          const box = await textbox.boundingBox();
          if (box && featureBoxes.every((feature) =>
            feature !== null && box.y + box.height <= feature.y)) {
            candidates.push(textbox);
          }
        }
        newFeature = candidates.length === 1 ? candidates[0] : undefined;
        return candidates.length;
      }, { message: "One visible new-feature textbox above the feature cards" }).toBe(1);
      await expect(newFeature!).toBeVisible();
      await newFeature!.fill(sentence);
      await expect(newFeature!).toHaveValue(sentence);
      await newFeature!.press("Enter");
    } finally {
      await page.screenshot({ path: test.info().outputPath("step-1.png") });
    }
  });

  await test.step('See the question "Should a pinned feature stay pinned after you accept it?" with the recommended answer "No, unpin it when accepted"', async () => {
    try {
      await expect(page.getByText(question, { exact: true })).toBeVisible();
      await expect(recommended).toBeVisible();
      await expect(recommended).toBeEnabled();
    } finally {
      await page.screenshot({ path: test.info().outputPath("step-2.png") });
    }
  });

  await test.step('Pick the recommended answer and see "Pin a feature to the top" under "Needs your yes"', async () => {
    try {
      await recommended.click();
      const section = page.getByRole("heading", { name: "Needs your yes", exact: true });
      const draft = page.getByText("Pin a feature to the top", { exact: true });
      await expect(section).toBeVisible();
      await expect(draft).toBeVisible();
      // Check the named card's visible placement in the draft area without
      // prescribing a section, article, list, or other DOM wrapper.
      await expect.poll(async () => {
        const sectionBox = await section.boundingBox();
        const draftBox = await draft.boundingBox();
        if (!sectionBox || !draftBox || draftBox.y < sectionBox.y + sectionBox.height) return false;
        const featureBoxes = await Promise.all(existingFeatures.map((title) =>
          page.getByText(title, { exact: true }).boundingBox()));
        return featureBoxes.every((feature) =>
          feature !== null && draftBox.y + draftBox.height <= feature.y);
      }, { message: '"Pin a feature to the top" appears under "Needs your yes", above the ordinary features' }).toBe(true);
    } finally {
      await page.screenshot({ path: test.info().outputPath("step-3.png") });
    }
  });
});
