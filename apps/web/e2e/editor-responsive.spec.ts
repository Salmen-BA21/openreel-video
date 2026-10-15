import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Viewport validation for the editor redesign.
 *
 * Every tier (phone / compact / desktop) is exercised at real device sizes:
 * correct layout tier, preview + timeline coexisting, zero horizontal
 * overflow, touch-sized controls, sheet interaction on phones, and
 * screenshots (light + dark) for visual review.
 */

type Tier = "phone" | "compact" | "desktop";

const VIEWPORTS: ReadonlyArray<{
  name: string;
  width: number;
  height: number;
  tier: Tier;
}> = [
  { name: "phone-360", width: 360, height: 740, tier: "phone" },
  { name: "phone-390", width: 390, height: 844, tier: "phone" },
  { name: "phone-414", width: 414, height: 896, tier: "phone" },
  { name: "tablet-768", width: 768, height: 1024, tier: "compact" },
  { name: "laptop-1024", width: 1024, height: 768, tier: "compact" },
  { name: "desktop-1440", width: 1440, height: 900, tier: "desktop" },
  { name: "desktop-1920", width: 1920, height: 1080, tier: "desktop" },
];

const SHOTS = "e2e/screenshots";
mkdirSync(SHOTS, { recursive: true });

async function openEditor(page: Page, viewport: { name: string; width: number; height: number; tier: Tier }) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  // Fresh profile → skip onboarding tours so they never cover the editor.
  await page.addInitScript(() => {
    try {
      localStorage.setItem("openreel-onboarding-complete", "true");
      localStorage.setItem("openreel-mograph-tour-complete", "true");
    } catch {
      /* private mode */
    }
  });
  await page.goto("/#/editor");
  await page.waitForSelector(".editor-shell", { timeout: 60_000 });
  await expect(page.locator(".editor-shell")).toHaveAttribute(
    "data-editor-layout",
    viewport.tier,
  );
  await expect(page.locator("[data-tour='timeline']")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("[data-tour='preview']")).toBeVisible({ timeout: 60_000 });
}

/** Document-level horizontal overflow (body clips, so scrollWidth is honest). */
async function documentOverflow(page: Page) {
  return page.evaluate(() => ({
    html: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
}

/** Elements visually escaping the viewport, ignoring intentional scrollers. */
async function overflowOffenders(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const width = window.innerWidth;
    const offenders: string[] = [];
    for (const node of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (style.position === "fixed") continue; // sheets/backdrops are inset by design
      if (Number(style.opacity) === 0) continue;
      // Non-interactive decoration (scrub thumb, handles) may overhang the
      // track edge by design — it can't trap taps or create page scroll.
      if (style.pointerEvents === "none") continue;
      // Anything inside a non-visible overflow ancestor is clipped there
      // (timeline lanes use translateX inside overflow: hidden) and never
      // reaches the page. Stop before html/body — those are the page itself.
      let parent: HTMLElement | null = node.parentElement;
      let clipped = false;
      while (parent && parent !== document.body && parent !== document.documentElement) {
        const overflowX = window.getComputedStyle(parent).overflowX;
        if (overflowX !== "visible" && overflowX !== "") {
          clipped = true;
          break;
        }
        parent = parent.parentElement;
      }
      if (clipped) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right > width + 1 || rect.left < -1) {
        const id = node.id ? `#${node.id}` : "";
        const cls =
          typeof node.className === "string"
            ? `.${node.className.trim().split(/\s+/).slice(0, 2).join(".")}`
            : "";
        offenders.push(
          `${node.tagName.toLowerCase()}${id}${cls} → ${Math.round(rect.left)}…${Math.round(rect.right)}px`,
        );
      }
    }
    return offenders.slice(0, 12);
  });
}

/** Interactive controls smaller than the given touch minimum. */
async function smallTargets(page: Page, minSize: number): Promise<string[]> {
  return page.evaluate((min) => {
    const selectors = [
      ".editor-tool-dock .dock-item",
      "[data-tour='preview'] .preview-controls button",
      "[data-tour='timeline'] .tl-toolbar button",
      ".panel-sheet-head button",
    ];
    const bad: string[] = [];
    for (const selector of selectors) {
      for (const node of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.width < min || rect.height < min) {
          bad.push(
            `${node.getAttribute("aria-label") ?? node.textContent?.trim()} ${Math.round(rect.width)}×${Math.round(rect.height)}`,
          );
        }
      }
    }
    return bad;
  }, minSize);
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name} (${viewport.width}×${viewport.height})`, () => {
    test("editor fits the viewport with usable controls", async ({ page }) => {
      await openEditor(page, viewport);

      // Preview and timeline coexist — editing context is never hidden.
      await expect(page.locator("#editor-panel-timeline")).toBeVisible();

      if (viewport.tier === "desktop") {
        await expect(page.locator(".editor-rail")).toBeVisible();
        await expect(page.locator(".editor-tool-dock")).toBeHidden();
      } else {
        const dock = page.getByRole("navigation", { name: "Editor workspace" });
        await expect(dock).toBeVisible();
        // Panel launchers stay reachable by scrolling.
        await expect(dock.getByRole("button", { name: "Media" })).toBeVisible();
        await expect(dock.getByRole("button", { name: "Edit" })).toBeVisible();
        await expect(dock.getByRole("button", { name: "Chat" })).toBeVisible();
      }

      const overflow = await documentOverflow(page);
      expect(overflow.html, "document must not scroll horizontally").toBeLessThanOrEqual(1);
      expect(overflow.body, "body must not scroll horizontally").toBeLessThanOrEqual(1);
      expect(await overflowOffenders(page), "no element may escape the viewport").toEqual([]);

      if (viewport.tier !== "desktop") {
        // 44px on phones, 40px floor on tablets (Apple HIG touch minimum).
        const min = viewport.tier === "phone" ? 44 : 40;
        expect(await smallTargets(page, min), "controls must be touch-sized").toEqual([]);
      }

      await page.screenshot({ path: `${SHOTS}/${viewport.name}.png` });
    });

    if (viewport.tier === "phone") {
      test("tool dock opens panels as sheets without hiding the timeline", async ({ page }) => {
        await openEditor(page, viewport);
        const dock = page.getByRole("navigation", { name: "Editor workspace" });

        await dock.getByRole("button", { name: "Media" }).click();
        await expect(page.locator("#editor-panel-media")).toBeVisible();
        await expect(page.locator("#editor-panel-timeline")).toBeVisible();
        await expect(dock.getByRole("button", { name: "Media" })).toHaveAttribute("aria-pressed", "true");
        // Let the open animation finish so the capture isn't mid-fade.
        await page.waitForTimeout(350);
        await page.screenshot({ path: `${SHOTS}/${viewport.name}-media-sheet.png` });

        await page.getByRole("button", { name: "Close Media" }).click();
        await expect(page.locator("#editor-panel-media")).toBeHidden();

        await dock.getByRole("button", { name: "Edit" }).click();
        await expect(page.locator("#editor-panel-inspector")).toBeVisible();
        await page.waitForTimeout(350);
        await page.screenshot({ path: `${SHOTS}/${viewport.name}-inspector-sheet.png` });

        // Sheet must be dismissed before the dock is tappable again
        // (the backdrop sits above it by design).
        await page.getByRole("button", { name: "Close Edit clip" }).click();
        await expect(page.locator("#editor-panel-inspector")).toBeHidden();

        // The mixer opens as a sheet anchored to the timeline as well.
        await dock.getByRole("button", { name: "Mixer" }).click();
        await expect(page.locator(".timeline-audio-mixer")).toBeVisible();
        await expect(page.locator("#editor-panel-timeline")).toBeVisible();
        await page.waitForTimeout(350);
        await page.screenshot({ path: `${SHOTS}/${viewport.name}-mixer-sheet.png` });
        await page.getByRole("button", { name: "Close mixer" }).click();
        await expect(page.locator(".timeline-audio-mixer")).toBeHidden();

        expect(await documentOverflow(page)).toEqual({ html: 0, body: 0 });
        expect(await overflowOffenders(page)).toEqual([]);
      });
    }

    if (viewport.tier !== "desktop") {
      test("timeline tools overflow panel opens and closes", async ({ page }) => {
        await openEditor(page, viewport);
        await page.getByRole("button", { name: "More timeline tools" }).click();
        await expect(page.locator(".tl-tools-overflow")).toBeVisible();

        // Every secondary tool must be fully on-screen inside the panel —
        // including the last group (snap / track size / maximize), which
        // used to run past the panel edge.
        const tools: Array<[string, ReturnType<Page["getByLabel"]>]> = [
          ["Ripple delete", page.getByLabel("Ripple delete (⇧Del)")],
          ["Add track", page.getByRole("button", { name: "Add track" })],
          ["Track layers", page.getByRole("button", { name: "Track layers" })],
          ["Snap", page.getByLabel(/^Snap (on|off)/)],
          ["Large tracks", page.getByLabel("Large tracks")],
          ["Compact tracks", page.getByLabel("Compact tracks")],
        ];
        for (const [name, tool] of tools) {
          await expect(tool.first(), name).toBeVisible();
          const box = await tool.first().boundingBox();
          expect(box, name).not.toBeNull();
          expect(box!.x, `${name} left edge`).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width, `${name} right edge`).toBeLessThanOrEqual(
            viewport.width,
          );
        }

        await page.screenshot({ path: `${SHOTS}/${viewport.name}-timeline-more.png` });
        expect(await documentOverflow(page)).toEqual({ html: 0, body: 0 });
      });

      test("preview secondary controls live behind the more menu", async ({ page }) => {
        await openEditor(page, viewport);
        await page.getByRole("button", { name: "More preview controls" }).click();
        await expect(page.locator(".preview-secondary")).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/${viewport.name}-preview-more.png` });
      });
    }
  });
}

test.describe("dark theme", () => {
  for (const viewport of [VIEWPORTS[1], VIEWPORTS[5]]) {
    test(`${viewport.name} renders in dark theme`, async ({ page }) => {
      // Seed the persisted theme store so the app itself boots dark — the
      // same path as rehydration, so nothing can revert it afterwards.
      await page.addInitScript(() => {
        try {
          localStorage.setItem(
            "openreel-theme",
            JSON.stringify({ state: { mode: "dark", isDark: true }, version: 0 }),
          );
        } catch {
          /* private mode */
        }
      });
      await openEditor(page, viewport);
      expect(
        await page.evaluate(() => document.documentElement.classList.contains("dark")),
        "app must have applied the dark theme",
      ).toBe(true);
      const overflow = await documentOverflow(page);
      expect(overflow.html).toBeLessThanOrEqual(1);
      expect(overflow.body).toBeLessThanOrEqual(1);
      await page.screenshot({ path: `${SHOTS}/${viewport.name}-dark.png` });
    });
  }
});

test.describe("export dialog", () => {
  for (const viewport of [VIEWPORTS[0], VIEWPORTS[1], VIEWPORTS[5]]) {
    test(`${viewport.name} export dialog adapts to the viewport`, async ({ page }) => {
      await openEditor(page, viewport);

      // Reach the dialog through the export options menu (works without clips).
      await page.getByRole("button", { name: "Export options" }).click();
      await page.getByRole("menuitem", { name: /Custom export/ }).click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();

      // The portaled dialog mirrors the layout tier for its responsive CSS.
      await expect(page.locator(".export-dialog")).toHaveAttribute(
        "data-editor-layout",
        viewport.tier,
      );

      // It stays inside the viewport and never overflows horizontally.
      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(
        await dialog.evaluate((el) => el.scrollWidth - el.clientWidth),
        "dialog must not overflow horizontally",
      ).toBeLessThanOrEqual(1);

      const columnCount = (selector: string) =>
        page
          .locator(selector)
          .first()
          .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);

      if (viewport.tier === "phone") {
        // The platform rail becomes a horizontal picker above a 1-up grid.
        await expect(page.locator(".export-presets")).toHaveCSS("flex-direction", "column");
        await expect(page.locator(".export-browse-list")).toHaveCSS("flex-direction", "row");
        expect(await columnCount(".export-grid")).toBe(1);

        // Mode tabs shorten instead of ellipsizing.
        const truncated = await page
          .locator(".export-mode-tabs [role=radio] span")
          .evaluateAll((nodes) =>
            nodes
              .filter((n) => (n as HTMLElement).scrollWidth > (n as HTMLElement).clientWidth + 1)
              .map((n) => n.textContent),
          );
        expect(truncated, "mode tabs must not ellipsize").toEqual([]);

        // Footer actions stack into a full-width pair, and every control
        // inside the dialog meets the 44pt touch minimum.
        await expect(page.locator(".export-footer-actions")).toHaveCSS(
          "flex-direction",
          "column",
        );
        const actionBox = await page.getByRole("button", { name: "Export Video" }).boundingBox();
        expect(actionBox!.width).toBeGreaterThan(box!.width * 0.4);
        const small = await page.evaluate((min) => {
          const bad: string[] = [];
          for (const node of Array.from(
            document.querySelectorAll<HTMLElement>(".export-dialog button"),
          )) {
            const style = getComputedStyle(node);
            if (style.display === "none" || style.visibility === "hidden") continue;
            const rect = node.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            if (rect.width < min || rect.height < min) {
              bad.push(
                `${node.textContent?.trim().slice(0, 24) || node.getAttribute("aria-label")} ${Math.round(rect.width)}×${Math.round(rect.height)}`,
              );
            }
          }
          return bad;
        }, 44);
        expect(small, "dialog controls must be touch-sized").toEqual([]);
      } else {
        // Desktop keeps the two-column browser and the 2-up preset grid.
        await expect(page.locator(".export-presets")).toHaveCSS("flex-direction", "row");
        expect(await columnCount(".export-grid")).toBe(2);
      }

      await page.screenshot({ path: `${SHOTS}/${viewport.name}-export.png` });

      // The custom settings form collapses to one field per row on phones.
      await page
        .getByRole("radio", { name: viewport.tier === "phone" ? "Custom" : "Custom Settings" })
        .click();
      expect(await columnCount(".export-field-grid")).toBe(viewport.tier === "phone" ? 1 : 2);
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${SHOTS}/${viewport.name}-export-custom.png` });
    });
  }
});
