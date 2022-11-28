import * as csstree from 'css-tree';
import { v4 as uuid } from 'uuid';

import { StyleData } from './fetch.js';
import { validatedForPositioning } from './validate.js';

interface DeclarationWithValue extends csstree.Declaration {
  value: csstree.Value;
}

interface AtRuleRaw extends csstree.Atrule {
  prelude: csstree.Raw | null;
}

interface AnchorNames {
  // `key` is the `anchor-name` value
  // `value` is an array of all element selectors with that anchor name
  [key: string]: string[];
}

type InsetProperty = 'top' | 'left' | 'right' | 'bottom';

type AnchorSideKeyword =
  | 'top'
  | 'left'
  | 'right'
  | 'bottom'
  | 'start'
  | 'end'
  | 'self-start'
  | 'self-end'
  | 'center';

export type AnchorSide = AnchorSideKeyword | number;

interface AnchorFunction {
  anchorEl?: HTMLElement | null;
  anchorName?: string;
  anchorEdge?: AnchorSide;
  fallbackValue: string;
  customPropName?: string;
  key: string;
}

// `key` is the property being declared
// `value` is the anchor-positioning data for that property
type AnchorFunctionDeclaration = Partial<Record<InsetProperty, AnchorFunction>>;

interface AnchorFunctionDeclarations {
  // `key` is the target element selector
  // `value` is an object with all anchor-function declarations on that element
  [key: string]: AnchorFunctionDeclaration;
}

interface AnchorPosition {
  declarations?: AnchorFunctionDeclaration;
  fallbacks?: TryBlock[];
}

export interface AnchorPositions {
  // `key` is the target element selector
  // `value` is an object with all anchor-positioning data for that element
  [key: string]: AnchorPosition;
}

// `key` is the property being declared
// `value` is the property value, or parsed anchor-fn data
type TryBlock = Partial<
  Record<string | InsetProperty, string | AnchorFunction>
>;

interface FallbackNames {
  // `key` is the target element selector
  // `value` is the `position-fallback` value (name)
  [key: string]: string;
}

interface Fallbacks {
  // `key` is the `position-fallback` value (name)
  // `value` is an array of `@try` block declarations (in order)
  [key: string]: TryBlock[];
}

function isDeclaration(node: csstree.CssNode): node is DeclarationWithValue {
  return node.type === 'Declaration';
}

function isAnchorNameDeclaration(
  node: csstree.CssNode,
): node is DeclarationWithValue {
  return node.type === 'Declaration' && node.property === 'anchor-name';
}

function isAnchorFunction(
  node: csstree.CssNode | null,
): node is csstree.FunctionNode {
  return Boolean(node && node.type === 'Function' && node.name === 'anchor');
}

function isVarFunction(
  node: csstree.CssNode | null,
): node is csstree.FunctionNode {
  return Boolean(node && node.type === 'Function' && node.name === 'var');
}

function isFallbackDeclaration(
  node: csstree.CssNode,
): node is DeclarationWithValue {
  return node.type === 'Declaration' && node.property === 'position-fallback';
}

function isFallbackAtRule(node: csstree.CssNode): node is AtRuleRaw {
  return node.type === 'Atrule' && node.name === 'position-fallback';
}

function isTryAtRule(node: csstree.CssNode): node is AtRuleRaw {
  return node.type === 'Atrule' && node.name === 'try';
}

function isIdentifier(node: csstree.CssNode): node is csstree.Identifier {
  return Boolean(node.type === 'Identifier' && node.name);
}

function isPercentage(node: csstree.CssNode): node is csstree.Percentage {
  return Boolean(node.type === 'Percentage' && node.value);
}

function parseAnchorFn(
  node: csstree.FunctionNode,
  replaceCss?: boolean,
): AnchorFunction {
  let anchorName: string | undefined,
    anchorEdge: AnchorSide | undefined,
    fallbackValue = '',
    foundComma = false,
    customPropName: string | undefined;

  node.children.toArray().forEach((child, idx) => {
    if (foundComma) {
      fallbackValue = `${fallbackValue}${csstree.generate(child)}`;
      return;
    }
    if (child.type === 'Operator' && child.value === ',') {
      foundComma = true;
      return;
    }
    switch (idx) {
      case 0:
        if (isIdentifier(child)) {
          // Store anchor name
          anchorName = child.name;
        } else if (isVarFunction(child) && child.children.first) {
          // Store CSS custom prop for anchor name
          const name = (child.children.first as csstree.Identifier).name;
          customPropName = name;
        }
        break;
      case 1:
        if (isIdentifier(child)) {
          anchorEdge = child.name as AnchorSideKeyword;
        } else if (isPercentage(child)) {
          const number = Number(child.value);
          anchorEdge = Number.isNaN(number) ? undefined : number;
        }
        break;
    }
  });

  const key = `--anchor-${uuid()}`;
  if (replaceCss) {
    // Replace anchor function with unique CSS custom property.
    // This allows us to update the value of the new custom property
    // every time the position changes.
    Object.assign(node, {
      type: 'Raw',
      value: `var(${key})`,
      children: null,
    });
    Reflect.deleteProperty(node, 'name');
  }

  return {
    anchorName,
    anchorEdge,
    fallbackValue: fallbackValue || '0px',
    customPropName,
    key,
  };
}

function getAnchorNameData(node: csstree.CssNode, rule?: csstree.Raw) {
  if (
    isAnchorNameDeclaration(node) &&
    node.value.children.first &&
    rule?.value
  ) {
    const name = (node.value.children.first as csstree.Identifier).name;
    return { name, selector: rule.value };
  }
  return {};
}

const customPropAssignments: Record<string, AnchorFunction> = {};

function getAnchorFunctionData(
  node: csstree.CssNode,
  declaration: csstree.Declaration | null,
  rule?: csstree.Raw,
) {
  if (isAnchorFunction(node) && rule?.value && declaration) {
    if (declaration.property.startsWith('--')) {
      const data = parseAnchorFn(node);
      customPropAssignments[declaration.property] = data;
      return;
    }
    if (isInset(declaration.property)) {
      const data = parseAnchorFn(node, true);
      return { [declaration.property]: data };
    }
  }
}

function getPositionFallbackDeclaration(
  node: csstree.CssNode,
  rule?: csstree.Raw,
) {
  if (isFallbackDeclaration(node) && node.value.children.first && rule?.value) {
    const name = (node.value.children.first as csstree.Identifier).name;
    return { name, selector: rule.value };
  }
  return {};
}

function isInset(property: string): property is InsetProperty {
  const insetProperties: InsetProperty[] = ['left', 'right', 'top', 'bottom'];

  return insetProperties.includes(property as InsetProperty);
}

function getPositionFallbackRules(node: csstree.CssNode) {
  if (isFallbackAtRule(node) && node.prelude?.value && node.block?.children) {
    const name = node.prelude.value;
    const tryBlocks: TryBlock[] = [];
    const tryAtRules = node.block.children.filter(isTryAtRule);
    tryAtRules.forEach((atRule) => {
      if (atRule.block?.children) {
        const tryBlock: TryBlock = {};
        // Only declarations are allowed inside a `@try` block
        const declarations = atRule.block.children.filter(isDeclaration);
        declarations.forEach((child) => {
          const firstChild = child.value.children.first as csstree.CssNode;
          // Parse value if it's an `anchor()` fn; otherwise store it raw
          if (firstChild && isAnchorFunction(firstChild)) {
            tryBlock[child.property] = parseAnchorFn(firstChild);
          } else {
            tryBlock[child.property] = csstree.generate(child.value);
          }
        });
        tryBlocks.push(tryBlock);
      }
    });
    return { name, fallbacks: tryBlocks };
  }
  return {};
}

function getCSSPropertyValue(el: HTMLElement, prop: string) {
  return getComputedStyle(el).getPropertyValue(prop).trim();
}

const anchorNames: AnchorNames = {};

function getAnchorEl(targetEl: HTMLElement | null, anchorObj: AnchorFunction) {
  let anchorName = anchorObj.anchorName;
  const customPropName = anchorObj.customPropName;
  if (targetEl && !anchorName && customPropName) {
    anchorName = getCSSPropertyValue(targetEl, customPropName);
  }
  const anchorSelectors = anchorName ? anchorNames[anchorName] ?? [] : [];
  return validatedForPositioning(targetEl, anchorSelectors);
}

function getAST(cssText: string) {
  const ast = csstree.parse(cssText, {
    parseAtrulePrelude: false,
    parseRulePrelude: false,
    parseCustomProperty: true,
  });

  return ast;
}

export function parseCSS(styleData: StyleData[]) {
  const anchorFunctions: AnchorFunctionDeclarations = {};
  const fallbackNames: FallbackNames = {};
  const fallbacks: Fallbacks = {};
  for (const styleObj of styleData) {
    let changed = false;
    const ast = getAST(styleObj.css);
    csstree.walk(ast, function (node) {
      const rule = this.rule?.prelude as csstree.Raw | undefined;

      // Parse `anchor-name` declaration
      const { name: anchorName, selector: anchorSelector } = getAnchorNameData(
        node,
        rule,
      );
      if (anchorName && anchorSelector) {
        if (anchorNames[anchorName]) {
          anchorNames[anchorName].push(anchorSelector);
        } else {
          anchorNames[anchorName] = [anchorSelector];
        }
      }

      // Parse `anchor()` function
      const anchorFnData = getAnchorFunctionData(node, this.declaration, rule);
      if (anchorFnData && rule?.value) {
        // This will override earlier declarations
        // with the same exact rule selector
        // *and* the same exact declaration property:
        // (e.g. multiple `top: anchor(...)` declarations
        // for the same `.foo {...}` selector)
        anchorFunctions[rule.value] = {
          ...anchorFunctions[rule.value],
          ...anchorFnData,
        };
        changed = true;
      }

      // Parse `position-fallback` declaration
      const { name: fbName, selector: fbSelector } =
        getPositionFallbackDeclaration(node, rule);
      if (fbName && fbSelector) {
        // This will override earlier `position-fallback` declarations
        // with the same rule selector:
        // (e.g. multiple `position-fallback:` declarations
        // for the same `.foo {...}` selector)
        fallbackNames[fbSelector] = fbName;
      }

      // Parse `@position-fallback` rule
      const { name: fbRuleName, fallbacks: fbTryBlocks } =
        getPositionFallbackRules(node);
      if (fbRuleName && fbTryBlocks.length) {
        // This will override earlier `@position-fallback` lists
        // with the same name:
        // (e.g. multiple `@position-fallback --my-fallback {...}` uses
        // with the same `--my-fallback` name)
        fallbacks[fbRuleName] = fbTryBlocks;
      }
    });
    if (changed) {
      // Update CSS
      styleObj.css = csstree.generate(ast);
      styleObj.changed = true;
    }
  }

  // Find where CSS custom properties are used
  if (Object.values(customPropAssignments).length > 0) {
    for (const styleObj of styleData) {
      let changed = false;
      const ast = getAST(styleObj.css);
      csstree.walk(ast, function (node) {
        const rule = this.rule?.prelude as csstree.Raw | undefined;
        if (
          rule?.value &&
          isVarFunction(node) &&
          node.children.first &&
          this.declaration &&
          isInset(this.declaration.property)
        ) {
          const child = node.children.first as csstree.Identifier;
          const anchorFnData = customPropAssignments[child.name];
          const prop = this.declaration.property;
          if (anchorFnData) {
            const data = { ...anchorFnData };
            // When `anchor()` is used multiple times in different inset
            // properties, the value will be different each time.
            // So we append the property to the key, and update the CSS property
            // to point to the new key:
            const key = `${data.key}-${prop}`;
            data.key = key;
            anchorFunctions[rule.value] = {
              ...anchorFunctions[rule.value],
              [prop]: data,
            };
            // Update CSS property to new name with declaration property added
            child.name = key;
            changed = true;
          }
        }
      });
      if (changed) {
        // Update CSS
        styleObj.css = csstree.generate(ast);
        styleObj.changed = true;
      }
    }
  }

  // Merge data together under target-element selector key
  const validPositions: AnchorPositions = {};

  // Store any `position-fallback` declarations
  for (const [targetSel, fallbackName] of Object.entries(fallbackNames)) {
    const positionFallbacks = fallbacks[fallbackName];
    if (positionFallbacks) {
      const targetEl: HTMLElement | null = document.querySelector(targetSel);
      // Populate `anchorEl` for each fallback `anchor()` fn
      positionFallbacks.forEach((tryBlock) => {
        for (const [prop, value] of Object.entries(tryBlock)) {
          if (typeof value === 'object') {
            const anchorEl = getAnchorEl(targetEl, value as AnchorFunction);
            (tryBlock[prop] as AnchorFunction).anchorEl = anchorEl;
          }
        }
      });
      validPositions[targetSel] = {
        fallbacks: positionFallbacks,
      };
    }
  }

  // Store any `anchor()` fns
  for (const [targetSel, anchorFns] of Object.entries(anchorFunctions)) {
    const targetEl: HTMLElement | null = document.querySelector(targetSel);
    for (const [targetProperty, anchorObj] of Object.entries(anchorFns)) {
      const anchorEl = getAnchorEl(targetEl, anchorObj);
      // Populate `anchorEl` for each `anchor()` fn
      validPositions[targetSel] = {
        ...validPositions[targetSel],
        declarations: {
          ...validPositions[targetSel]?.declarations,
          [targetProperty]: {
            ...anchorObj,
            anchorEl,
          },
        },
      };
    }
  }

  /* Example data shape:
    {
      '#my-target-element': {
        declarations: {
          top: {
            targetEl: <HTMLElement>,
            anchorName: '--my-anchor',
            anchorEl: <HTMLElement>,
            anchorEdge: 'bottom',
            fallbackValue: '50px',
          },
        },
        fallbacks: [
          {
            top: {
              targetEl: <HTMLElement>,
              anchorName: '--my-anchor',
              anchorEl: <HTMLElement>,
              anchorEdge: 'top',
              fallbackValue: '0px',
            },
            width: '35px',
          },
        ],
      },
    }
    */
  return validPositions;
}