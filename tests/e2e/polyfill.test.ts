import { expect, type Locator, type Page, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // Listen for all console logs
  // eslint-disable-next-line no-console
  page.on('console', (msg) => console.log(msg.text()));
  await page.goto('/');
});

const btnSelector = '#apply-polyfill';
const targetSelector = '#my-target-positioning';
const anchorSelector = '#my-anchor-positioning';

async function applyPolyfill(page: Page) {
  const btn = page.locator(btnSelector);
  return await btn.click();
}

async function getElementWidth(page: Page, sel: string) {
  return page
    .locator(sel)
    .first()
    .evaluate((node: HTMLElement) => node.getBoundingClientRect().width);
}

async function getParentWidth(page: Page, sel: string) {
  return page
    .locator(sel)
    .first()
    .evaluate((node: HTMLElement) => node.offsetParent?.clientWidth ?? 0);
}

async function getParentHeight(page: Page, sel: string) {
  return page
    .locator(sel)
    .first()
    .evaluate((node: HTMLElement) => node.offsetParent?.clientHeight ?? 0);
}

async function expectWithinOne(
  locator: Locator,
  attr: string,
  expected: number,
  not?: boolean,
) {
  const getValue = async () => {
    const actual = await locator.evaluate(
      (node: HTMLElement, attribute: string) =>
        window.getComputedStyle(node).getPropertyValue(attribute),
      attr,
    );
    return Number(actual.slice(0, -2));
  };
  if (not) {
    return expect
      .poll(getValue, { timeout: 10 * 1000 })
      .not.toBeCloseTo(expected, 0);
  }
  return expect.poll(getValue, { timeout: 10 * 1000 }).toBeCloseTo(expected, 0);
}

test('applies polyfill for `anchor()`', async ({ page }) => {
  const target = page.locator(targetSelector);
  const width = await getElementWidth(page, anchorSelector);
  const parentWidth = await getParentWidth(page, targetSelector);
  const parentHeight = await getParentHeight(page, targetSelector);
  const expected = parentWidth - width;

  await expect(target).toHaveCSS('top', '0px');
  await expectWithinOne(target, 'right', expected, true);

  await applyPolyfill(page);

  await expect(target).toHaveCSS('top', `${parentHeight}px`);
  await expectWithinOne(target, 'right', expected);
});

test('applies polyfill from inline styles', async ({ page }) => {
  const targetInLine = page.locator('#my-target-inline');
  const width = await getElementWidth(page, anchorSelector);
  const parentWidth = await getParentWidth(page, targetSelector);
  const parentHeight = await getParentHeight(page, targetSelector);
  const expected = parentWidth - width;

  await expect(targetInLine).toHaveCSS('top', '0px');
  await expectWithinOne(targetInLine, 'right', expected, true);

  await applyPolyfill(page);

  await expect(targetInLine).toHaveCSS('top', `${parentHeight}px`);
  await expectWithinOne(targetInLine, 'right', expected);
});

test('updates when sizes change', async ({ page }) => {
  const target = page.locator(targetSelector);
  const width = await getElementWidth(page, anchorSelector);
  const parentWidth = await getParentWidth(page, targetSelector);
  const parentHeight = await getParentHeight(page, targetSelector);
  await applyPolyfill(page);

  await expect(target).toHaveCSS('top', `${parentHeight}px`);
  await expectWithinOne(target, 'right', parentWidth - width);

  await page
    .locator(anchorSelector)
    .evaluate((anchor) => (anchor.style.width = '50px'));

  await expectWithinOne(target, 'right', parentWidth - 50);
});

test('applies polyfill for `@position-fallback`', async ({ page }) => {
  const targetSel = '#my-target-fallback';
  const target = page.locator(targetSel);

  await expect(target).toHaveCSS('left', '0px');

  await applyPolyfill(page);

  await expect(target).not.toHaveCSS('left', '0px');
  await expect(target).not.toHaveCSS('width', '100px');

  await target.evaluate(
    (node: HTMLElement) =>
      ((node.offsetParent as HTMLElement).style.height = '20px'),
  );

  await expect(target).toHaveCSS('width', '100px');
});
