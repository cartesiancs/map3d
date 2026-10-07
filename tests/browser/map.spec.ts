import { test, expect } from "@playwright/test";

// All external assets and Overpass responses are deterministic in this smoke test.
test("select area, generate scene, and download a GLB without startup errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const hdr = Buffer.concat([Buffer.from("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n"), Buffer.from([128, 128, 128, 128])]);
  await page.route("**/*", async route => {
    const url = route.request().url();
    if (url.startsWith("http://127.0.0.1:5179")) return route.continue();
    if (url.includes("overpass-api.de")) {
      const query = route.request().postData() || "";
      const building = { id: 1, tags: { building: "yes", height: "15", name: "Test building" }, geometry: [
        { lat: 40.799, lon: -73.951 }, { lat: 40.799, lon: -73.949 },
        { lat: 40.801, lon: -73.949 }, { lat: 40.801, lon: -73.951 }, { lat: 40.799, lon: -73.951 },
      ] };
      return route.fulfill({ json: { elements: query.includes('"building"') ? [building] : [] } });
    }
    if (url.includes("tile.openstreetmap.org")) return route.fulfill({ contentType: "image/png", body: pixel });
    if (/\.hdr(?:\?|$)/.test(url)) return route.fulfill({ contentType: "application/octet-stream", body: hdr });
    return route.fulfill({ contentType: "text/css", body: "" });
  });
  await page.goto("/");
  await expect(page.getByText("Generate 3d map", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next Step" })).toBeDisabled();
  await page.getByRole("button", { name: "Select Box" }).click();
  const box = await page.locator(".leaflet-container").boundingBox();
  if (!box) throw new Error("Map bounds unavailable");
  await page.mouse.move(box.x + box.width * .4, box.y + box.height * .4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .6, box.y + box.height * .6, { steps: 10 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Next Step" }).click();
  await expect(page.getByText("Processing", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next Step" }).click();
  await expect(page.getByText("Building 1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next Step" }).click();
  await page.getByRole("button", { name: "Export GLB" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "GLB Download" }).click();
  expect((await download).suggestedFilename()).toBe("scene.glb");
  expect(errors).toEqual([]);
});
