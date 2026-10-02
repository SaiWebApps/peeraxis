import { expect, test, type Locator } from "@playwright/test";

test("Approve a drafted card", async ({ page }) => {
  const title = "Show the date each feature finished";
  const otherTitles = [
    "Greeting says hello",
    "Farewell says goodbye",
    "Dark mode for the settings page",
    "Import contacts from a file",
    "Title is bold",
  ];
  const draftTitle = page.getByText(title, { exact: true });
  const approve = page.getByRole("button", { name: "Approve", exact: true });

  async function visibleBox(locator: Locator) {
    await expect(locator).toBeVisible();
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    return box!;
  }

  await test.step('See "Show the date each feature finished" under "Needs your yes" with its Before, After and the step "See "Title is bold" say it was accepted today"', async () => {
    await page.goto("/");
    const section = await visibleBox(page.getByRole("heading", {
      name: "Needs your yes", exact: true,
    }));
    const name = await visibleBox(draftTitle);
    // Match the seed's words, allowing labels such as "Before:" on the same line.
    const before = page.getByText("Finished features do not say when they finished.");
    const after = page.getByText("Each accepted feature shows the date it was accepted.");
    const watch = page.getByText('See "Title is bold" say it was accepted today', { exact: true });
    const contents = await Promise.all([before, after, watch].map(visibleBox));
    const button = await visibleBox(approve);

    // Use the visible section boundaries, not a required article/list/section wrapper.
    // Checking the ordinary features as well prevents a draft at the bottom passing.
    expect(name.y).toBeGreaterThanOrEqual(section.y + section.height);
    expect(button.y).toBeGreaterThanOrEqual(section.y + section.height);
    for (const box of contents) {
      expect(box.y).toBeGreaterThanOrEqual(name.y + name.height);
    }
    for (const otherTitle of otherTitles) {
      const other = await visibleBox(page.getByText(otherTitle, { exact: true }));
      for (const box of [section, name, ...contents, button]) {
        expect(box.y + box.height).toBeLessThanOrEqual(other.y);
      }
    }
  });

  await test.step('Press Approve and see "Show the date each feature finished" marked Queued', async () => {
    await approve.click();
    await expect(draftTitle).toBeVisible();

    // There is already another Queued card. A label must visually belong to this
    // title, rather than merely exist somewhere on the page. Box distances work
    // for labels beside or below titles without prescribing a DOM container.
    await expect.poll(async () => {
      const name = await draftTitle.boundingBox();
      if (!name) return false;
      const others = await Promise.all(otherTitles.map((text) =>
        page.getByText(text, { exact: true }).boundingBox()));
      const distance = (a: NonNullable<typeof name>, b: NonNullable<typeof name>) =>
        Math.hypot(
          Math.max(a.x - b.x - b.width, b.x - a.x - a.width, 0),
          Math.max(a.y - b.y - b.height, b.y - a.y - a.height, 0),
        );
      for (const label of await page.getByText("Queued", { exact: true }).all()) {
        if (!(await label.isVisible())) continue;
        const box = await label.boundingBox();
        if (box && others.every((other) =>
          other !== null && distance(box, name) < distance(box, other))) return true;
      }
      return false;
    }, { message: `The visible Queued label belongs to "${title}"` }).toBe(true);
  });
});
