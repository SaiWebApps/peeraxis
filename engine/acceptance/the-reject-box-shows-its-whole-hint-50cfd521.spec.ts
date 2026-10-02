import { expect, test } from "@playwright/test";

test("The Reject box shows its whole hint", async ({ page }) => {
  await page.goto("/");

  await test.step('See the whole hint "Why reject? One sentence." in the box next to Reject on "Greeting says hello"', async () => {
    const feature = page.getByRole("article").filter({
      has: page.getByRole("heading", { name: "Greeting says hello", exact: true }),
    });
    await expect(feature.getByRole("heading", {
      name: "Greeting says hello", exact: true,
    })).toBeVisible();
    await expect(feature.getByRole("button", { name: "Reject", exact: true })).toBeVisible();

    const hint = "Why reject? One sentence.";
    const reason = feature.getByRole("textbox").and(
      feature.getByPlaceholder(hint, { exact: true }),
    );
    await expect(reason).toBeVisible();
    await expect(reason).toHaveValue("");
    await reason.scrollIntoViewIfNeeded();

    // A placeholder can exist while its last words are clipped. Compare the
    // rendered text width with the box's usable space, without prescribing a
    // width, font, or whether Reject sits beside or below the reason box.
    await expect.poll(() => reason.evaluate(async (box, text) => {
      await document.fonts.ready;
      const style = getComputedStyle(box);
      const placeholder = getComputedStyle(box, "::placeholder");
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d")!;
      context.font = `${placeholder.fontStyle} ${placeholder.fontWeight} ${placeholder.fontSize} ${placeholder.fontFamily}`;
      const letterSpacing = Number.parseFloat(placeholder.letterSpacing) || 0;
      const wordSpacing = Number.parseFloat(placeholder.wordSpacing) || 0;
      const textWidth = context.measureText(text).width
        + letterSpacing * text.length
        + wordSpacing * (text.split(" ").length - 1);
      const usableWidth = box.clientWidth
        - Number.parseFloat(style.paddingLeft)
        - Number.parseFloat(style.paddingRight);
      return usableWidth >= textWidth;
    }, hint), "The entire hint fits in the visible reason box").toBe(true);
  });
});
