import {
  autoUpdate,
  detectOverflow,
  MiddlewareState,
  platform,
  type Rect,
} from '@floating-ui/dom';

import { fetchCSS } from './fetch.js';
import {
  AnchorFunction,
  AnchorFunctionDeclaration,
  type AnchorPositions,
  type AnchorSide,
  type AnchorSize,
  getCSSPropertyValue,
  InsetProperty,
  isInsetProp,
  isSizingProp,
  parseCSS,
  PositionTryOrder,
  SizingProperty,
  TryBlock,
} from './parse.js';
import { transformCSS } from './transform.js';

const platformWithCache = { ...platform, _c: new Map() };

const getOffsetParent = async (el: HTMLElement) => {
  let offsetParent = await platform.getOffsetParent?.(el);
  if (!(await platform.isElement?.(offsetParent))) {
    offsetParent =
      (await platform.getDocumentElement?.(el)) ||
      window.document.documentElement;
  }
  return offsetParent as HTMLElement;
};

export const resolveLogicalSideKeyword = (side: AnchorSide, rtl: boolean) => {
  let percentage: number | undefined;
  switch (side) {
    case 'start':
    case 'self-start':
      percentage = 0;
      break;
    case 'end':
    case 'self-end':
      percentage = 100;
      break;
    default:
      if (typeof side === 'number' && !Number.isNaN(side)) {
        percentage = side;
      }
  }
  if (percentage !== undefined) {
    return rtl ? 100 - percentage : percentage;
  }
  return undefined;
};

export const resolveLogicalSizeKeyword = (
  size: AnchorSize,
  vertical: boolean,
) => {
  let resolved: 'width' | 'height' | undefined;
  switch (size) {
    case 'block':
    case 'self-block':
      resolved = vertical ? 'width' : 'height';
      break;
    case 'inline':
    case 'self-inline':
      resolved = vertical ? 'height' : 'width';
      break;
  }
  return resolved;
};

// This should also check the writing-mode
// See: https://github.com/oddbird/css-anchor-positioning/pull/22#discussion_r966348526
// https://trello.com/c/KnqCnHx3
export const getAxis = (position?: string) => {
  switch (position) {
    case 'top':
    case 'bottom':
      return 'y';
    case 'left':
    case 'right':
      return 'x';
  }
  return null;
};

export const getAxisProperty = (axis: 'x' | 'y' | null) => {
  switch (axis) {
    case 'x':
      return 'width';
    case 'y':
      return 'height';
  }
  return null;
};

const isInline = (el: HTMLElement) =>
  getCSSPropertyValue(el, 'display') === 'inline';

const getBorders = (el: HTMLElement, axis: 'x' | 'y') => {
  const props =
    axis === 'x'
      ? ['border-left-width', 'border-right-width']
      : ['border-top-width', 'border-bottom-width'];
  return (
    props.reduce(
      (total, prop) => total + parseInt(getCSSPropertyValue(el, prop), 10),
      0,
    ) || 0
  );
};

const getMargin = (el: HTMLElement, dir: 'top' | 'right' | 'bottom' | 'left') =>
  parseInt(getCSSPropertyValue(el, `margin-${dir}`), 10) || 0;

const getMargins = (el: HTMLElement) => {
  return {
    top: getMargin(el, 'top'),
    right: getMargin(el, 'right'),
    bottom: getMargin(el, 'bottom'),
    left: getMargin(el, 'left'),
  };
};

export interface GetPixelValueOpts {
  targetEl?: HTMLElement;
  targetProperty: InsetProperty | SizingProperty;
  anchorRect?: Rect;
  anchorSide?: AnchorSide;
  anchorSize?: AnchorSize;
  fallback: string;
}

export const getPixelValue = async ({
  targetEl,
  targetProperty,
  anchorRect,
  anchorSide,
  anchorSize,
  fallback,
}: GetPixelValueOpts) => {
  if (!((anchorSize || anchorSide !== undefined) && targetEl && anchorRect)) {
    return fallback;
  }
  if (anchorSize) {
    // anchor-size() can only be assigned to sizing properties:
    // https://drafts.csswg.org/css-anchor-1/#queries
    if (!isSizingProp(targetProperty)) {
      return fallback;
    }
    // Calculate value for `anchor-size()` fn...
    let size: AnchorSize | undefined;
    switch (anchorSize) {
      case 'width':
      case 'height':
        size = anchorSize;
        break;
      default: {
        let vertical = false;
        // Logical keywords require checking the writing-mode
        // of the target element (or its containing block):
        // `block` and `inline` should use the writing-mode of the element's
        // containing block, not the element itself:
        // https://trello.com/c/KnqCnHx3
        const writingMode = getCSSPropertyValue(targetEl, 'writing-mode');
        vertical =
          writingMode.startsWith('vertical-') ||
          writingMode.startsWith('sideways-');
        size = resolveLogicalSizeKeyword(anchorSize, vertical);
      }
    }
    if (size) {
      return `${anchorRect[size]}px`;
    }
    return fallback;
  }

  if (anchorSide !== undefined) {
    // Calculate value for `anchor()` fn...
    let percentage: number | undefined;
    let offsetParent;
    const axis = getAxis(targetProperty);

    // anchor() can only be assigned to inset properties,
    // and if a physical keyword ('left', 'right', 'top', 'bottom') is used,
    // the axis of the keyword must match the axis of the inset property:
    // https://drafts.csswg.org/css-anchor-1/#queries
    if (
      !(
        isInsetProp(targetProperty) &&
        axis &&
        (!isInsetProp(anchorSide) || axis === getAxis(anchorSide))
      )
    ) {
      return fallback;
    }

    switch (anchorSide) {
      case 'left':
        percentage = 0;
        break;
      case 'right':
        percentage = 100;
        break;
      case 'top':
        percentage = 0;
        break;
      case 'bottom':
        percentage = 100;
        break;
      case 'center':
        percentage = 50;
        break;
      default:
        // Logical keywords require checking the writing direction
        // of the target element (or its containing block)
        if (targetEl) {
          // `start` and `end` should use the writing-mode of the element's
          // containing block, not the element itself:
          // https://trello.com/c/KnqCnHx3
          const rtl = (await platform.isRTL?.(targetEl)) || false;
          percentage = resolveLogicalSideKeyword(anchorSide, rtl);
        }
    }

    const hasPercentage =
      typeof percentage === 'number' && !Number.isNaN(percentage);

    const dir = getAxisProperty(axis);
    if (hasPercentage && dir) {
      if (targetProperty === 'bottom' || targetProperty === 'right') {
        offsetParent = await getOffsetParent(targetEl);
      }
      let value =
        anchorRect[axis] + anchorRect[dir] * ((percentage as number) / 100);
      switch (targetProperty) {
        case 'bottom': {
          if (!offsetParent) {
            break;
          }
          let offsetHeight = offsetParent.clientHeight;
          // This is a hack for inline elements with `clientHeight: 0`,
          // but it doesn't take scrollbar size into account
          if (offsetHeight === 0 && isInline(offsetParent)) {
            const border = getBorders(offsetParent, axis);
            offsetHeight = offsetParent.offsetHeight - border;
          }
          value = offsetHeight - value;
          break;
        }
        case 'right': {
          if (!offsetParent) {
            break;
          }
          let offsetWidth = offsetParent.clientWidth;
          // This is a hack for inline elements with `clientWidth: 0`,
          // but it doesn't take scrollbar size into account
          if (offsetWidth === 0 && isInline(offsetParent)) {
            const border = getBorders(offsetParent, axis);
            offsetWidth = offsetParent.offsetWidth - border;
          }
          value = offsetWidth - value;
          break;
        }
      }
      return `${value}px`;
    }
  }

  return fallback;
};

async function applyAnchorPositions(
  declarations: AnchorFunctionDeclaration,
  useAnimationFrame = false,
) {
  const root = document.documentElement;

  for (const [property, anchorValues] of Object.entries(declarations) as [
    InsetProperty | SizingProperty,
    AnchorFunction[],
  ][]) {
    for (const anchorValue of anchorValues) {
      const anchor = anchorValue.anchorEl;
      const target = anchorValue.targetEl;
      if (anchor && target) {
        autoUpdate(
          anchor,
          target,
          async () => {
            const rects = await platform.getElementRects({
              reference: anchor,
              floating: target,
              strategy: 'absolute',
            });
            const resolved = await getPixelValue({
              targetEl: target,
              targetProperty: property,
              anchorRect: rects.reference,
              anchorSide: anchorValue.anchorSide,
              anchorSize: anchorValue.anchorSize,
              fallback: anchorValue.fallbackValue,
            });
            root.style.setProperty(anchorValue.uuid, resolved);
          },
          { animationFrame: useAnimationFrame },
        );
      } else {
        // Use fallback value
        const resolved = await getPixelValue({
          targetProperty: property,
          anchorSide: anchorValue.anchorSide,
          anchorSize: anchorValue.anchorSize,
          fallback: anchorValue.fallbackValue,
        });
        root.style.setProperty(anchorValue.uuid, resolved);
      }
    }
  }
}

async function checkOverflow(target: HTMLElement, offsetParent: HTMLElement) {
  const rects = await platform.getElementRects({
    reference: target,
    floating: target,
    strategy: 'absolute',
  });
  const overflow = await detectOverflow(
    {
      x: target.offsetLeft,
      y: target.offsetTop,
      platform: platformWithCache,
      rects,
      elements: { floating: target },
      strategy: 'absolute',
    } as unknown as MiddlewareState,
    {
      boundary: offsetParent,
      rootBoundary: 'document',
      padding: getMargins(target),
    },
  );
  return overflow;
}

async function applyPositionFallbacks(
  targetSel: string,
  fallbacks: TryBlock[],
  order: PositionTryOrder = 'normal',
  useAnimationFrame = false,
) {
  if (!fallbacks.length) {
    return;
  }

  const targets: NodeListOf<HTMLElement> = document.querySelectorAll(targetSel);

  for (const target of targets) {
    let checking = false;
    const offsetParent = await getOffsetParent(target);

    autoUpdate(
      target,
      target,
      async () => {
        // If this auto-update was triggered while the polyfill is already looping
        // through the possible `@position-try` blocks, do not check again.
        if (checking) {
          return;
        }
        checking = true;
        target.removeAttribute('data-anchor-polyfill');
        const defaultOverflow = await checkOverflow(target, offsetParent);
        // If none of the sides overflow, don't try fallbacks
        if (Object.values(defaultOverflow).every((side) => side <= 0)) {
          checking = false;
          return;
        }
        if (order === 'normal') {
          // Apply the styles from each `@position-try` block (in order), stopping
          // when we reach one that does not cause the target's margin-box to
          // overflow its offsetParent (containing block).
          for (const [index, { uuid }] of fallbacks.entries()) {
            target.setAttribute('data-anchor-polyfill', uuid);

            const overflow = await checkOverflow(target, offsetParent);

            // If none of the sides overflow, use this `@try` block and stop loop...
            if (Object.values(overflow).every((side) => side <= 0)) {
              checking = false;
              break;
            }
            // If it's the last fallback, and none have matched, revert to base.
            if (index === fallbacks.length - 1) {
              checking = false;
              target.removeAttribute('data-anchor-polyfill');
              break;
            }
          }
        } else {
          // Get visible area for all fallbacks. This is not the correct
          // measurement- we want the inset-modified containing block, not the
          // target's size.
          const visibleArea = await Promise.all(
            fallbacks.map(async ({ uuid }) => {
              target.setAttribute('data-anchor-polyfill', uuid);

              const overflow = await checkOverflow(target, offsetParent);
              const { clientHeight, clientWidth } = target;
              const visible = {
                height:
                  clientHeight -
                  Math.max(0, overflow.top) -
                  Math.max(0, overflow.bottom),
                width:
                  clientWidth -
                  Math.max(0, overflow.left) -
                  Math.max(0, overflow.right),
              };

              return { uuid, visible };
            }),
          );
          // sort
          const sorter = ['most-height', 'most-block-size'].includes(order)
            ? 'height'
            : 'width';
          visibleArea.sort((a, b) => {
            return b.visible[sorter] - a.visible[sorter];
          });
          // return winner
          target.setAttribute('data-anchor-polyfill', visibleArea[0].uuid);
          checking = false;
        }
      },
      { animationFrame: useAnimationFrame },
    );
  }
}

async function position(rules: AnchorPositions, useAnimationFrame = false) {
  for (const pos of Object.values(rules)) {
    // Handle `anchor()` and `anchor-size()` functions...
    await applyAnchorPositions(pos.declarations ?? {}, useAnimationFrame);
  }

  for (const [targetSel, position] of Object.entries(rules)) {
    // Handle `@position-try` blocks...
    await applyPositionFallbacks(
      targetSel,
      position.fallbacks ?? [],
      position.order,
      useAnimationFrame,
    );
  }
}

export async function polyfill(animationFrame?: boolean) {
  const useAnimationFrame =
    animationFrame === undefined
      ? Boolean(window.UPDATE_ANCHOR_ON_ANIMATION_FRAME)
      : animationFrame;
  // fetch CSS from stylesheet and inline style
  const styleData = await fetchCSS();

  // parse CSS
  const { rules, inlineStyles } = await parseCSS(styleData);

  if (Object.values(rules).length) {
    // update source code
    await transformCSS(styleData, inlineStyles);

    // calculate position values
    await position(rules, useAnimationFrame);
  }

  return rules;
}
