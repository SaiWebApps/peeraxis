import { expect, test } from "@playwright/test";

test("Watch a waiting feature's recording and accept it", async ({ page }) => {
  const title = page.getByText("Greeting says hello", { exact: true });
  // Find the feature by its visible title without requiring a particular card markup.
  // Exclude containers spanning other cards, especially the already accepted fixture.
  const featureContainers = title.locator("xpath=ancestor::*").filter({
    hasNot: page.getByText(
      /^(Farewell says goodbye|Dark mode for the settings page|Import contacts from a file|Title is bold)$/,
    ),
  });
  const waitingFeature = featureContainers.filter({
    has: page.getByRole("button", { name: "Accept", exact: true }),
  }).filter({ has: page.locator("video") }).first();

  await test.step('Open Peeraxis and see the recording of "Greeting says hello" on the page', async () => {
    await page.goto("/");
    await expect(title).toBeVisible();
    const recording = waitingFeature.locator("video");
    const accept = waitingFeature.getByRole("button", { name: "Accept", exact: true });
    await expect(recording).toHaveCount(1);
    await expect(recording).toBeVisible();
    await expect(accept).toHaveCount(1);
    await expect(accept).toBeVisible();
    await expect(accept).toBeEnabled();

    const videoBox = await recording.boundingBox();
    const buttonBox = await accept.boundingBox();
    expect(videoBox!.width * videoBox!.height).toBeGreaterThan(buttonBox!.width * buttonBox!.height);

    // Exercise the browser's media player and verify actual playback, not just a poster.
    await recording.evaluate((video: HTMLVideoElement) => {
      video.muted = true;
      return video.play();
    });
    await expect.poll(() => recording.evaluate((video: HTMLVideoElement) =>
      video.currentTime > 0 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA,
    )).toBe(true);
  });

  await test.step('Press Accept on "Greeting says hello" and see it marked Accepted', async () => {
    await waitingFeature.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(title).toBeVisible();
    const acceptedFeature = featureContainers.filter({
      has: page.getByText("Accepted", { exact: true }),
    }).first();
    await expect(acceptedFeature.getByText("Accepted", { exact: true })).toBeVisible();
  });
});
