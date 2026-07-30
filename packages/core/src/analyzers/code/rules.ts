import type { NodePath } from '@babel/traverse'
import type * as t from '@babel/types'
import type { FindingDraft, Rule } from '../../shared/types.js'
import { truncate } from '../../shared/utils.js'
import type { CodeModel, ParsedFile } from './parse.js'
import { LIST_COMPONENTS, excerptFor, isTestFile, jsxElementName, traverse } from './parse.js'

/** Files over this many lines are called out as hard to review. */
const LARGE_FILE_LINES = 400

/** Line count above which a list-rendering file is worth a memo suggestion. */
const MEMO_HINT_LINES = 100

/** Build the `location` field from a node, tolerating nodes without loc. */
function locationOf(node: t.Node): FindingDraft['location'] {
  const loc = node.loc
  if (!loc) return undefined
  return {
    line: loc.start.line,
    column: loc.start.column,
    endLine: loc.end.line,
    endColumn: loc.end.column,
  }
}

/** Common shape for a per-node finding: location plus a truncated excerpt. */
function at(file: ParsedFile, node: t.Node, message: string): FindingDraft {
  return {
    message,
    file: file.file,
    location: locationOf(node),
    excerpt: truncate(excerptFor(file.source, node)),
  }
}

/** Find a JSX attribute by name on an opening element. */
function findAttribute(element: t.JSXOpeningElement, name: string): t.JSXAttribute | null {
  for (const attr of element.attributes) {
    if (
      attr.type === 'JSXAttribute' &&
      attr.name.type === 'JSXIdentifier' &&
      attr.name.name === name
    ) {
      return attr
    }
  }
  return null
}

/** True when the element has a spread that could supply any prop. */
function hasSpread(element: t.JSXOpeningElement): boolean {
  return element.attributes.some((attr) => attr.type === 'JSXSpreadAttribute')
}

/** Unwrap `{expr}` attribute values to the expression inside. */
function attributeExpression(attr: t.JSXAttribute): t.Expression | null {
  const value = attr.value
  if (!value) return null
  if (value.type !== 'JSXExpressionContainer') return null
  return value.expression.type === 'JSXEmptyExpression' ? null : value.expression
}

function isFunctionExpression(
  node: t.Node,
): node is t.ArrowFunctionExpression | t.FunctionExpression {
  return node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression'
}

// ---------------------------------------------------------------------------
// react/no-inline-style
// ---------------------------------------------------------------------------

export const noInlineStyle: Rule<CodeModel> = {
  meta: {
    id: 'react/no-inline-style',
    category: 'code',
    severity: 'warning',
    description: 'JSX `style` prop given an inline object literal.',
    rationale:
      'An object literal in JSX is rebuilt on every render, so the style object is never ' +
      'referentially equal to the previous one. On React Native that defeats the shallow prop ' +
      'comparison in memoised children and sends a fresh style payload across the bridge, ' +
      'which is most costly inside list rows that re-render often.',
    recommendation:
      'Hoist the object into a `StyleSheet.create` block, or wrap genuinely dynamic values in ' +
      '`useMemo` and combine them with the static style in an array.',
    fixable: false,
  },

  check(model) {
    const findings: FindingDraft[] = []

    for (const file of model.files) {
      traverse(file.ast, {
        JSXAttribute(path) {
          const name = path.node.name
          if (name.type !== 'JSXIdentifier' || name.name !== 'style') return
          const expr = attributeExpression(path.node)
          if (!expr) return

          // Only literal objects are rebuilt per render. `style={styles.row}`
          // and `style={someMemo}` are already stable, so leave them alone.
          const objects = collectInlineStyleObjects(expr)
          for (const object of objects) {
            findings.push(
              at(
                file,
                object,
                `Inline style object on \`${describeOwner(path)}\` is recreated on every render.`,
              ),
            )
          }
        },
      })
    }

    return findings
  },
}

/**
 * Pull the object literals out of a style value, descending into arrays and
 * conditionals since `style={[styles.a, { flex: 1 }]}` is the common form.
 */
function collectInlineStyleObjects(expr: t.Expression): t.ObjectExpression[] {
  if (expr.type === 'ObjectExpression') return [expr]

  if (expr.type === 'ArrayExpression') {
    const out: t.ObjectExpression[] = []
    for (const element of expr.elements) {
      if (element && element.type !== 'SpreadElement')
        out.push(...collectInlineStyleObjects(element))
    }
    return out
  }

  if (expr.type === 'ConditionalExpression') {
    return [
      ...collectInlineStyleObjects(expr.consequent),
      ...collectInlineStyleObjects(expr.alternate),
    ]
  }

  if (expr.type === 'LogicalExpression') {
    return collectInlineStyleObjects(expr.right)
  }

  return []
}

/** Name the element an attribute belongs to, for a more useful message. */
function describeOwner(path: NodePath<t.JSXAttribute>): string {
  const element = path.parentPath
  if (element.isJSXOpeningElement()) return jsxElementName(element.node.name) ?? 'element'
  return 'element'
}

// ---------------------------------------------------------------------------
// react/no-anonymous-callback
// ---------------------------------------------------------------------------

export const noAnonymousCallback: Rule<CodeModel> = {
  meta: {
    id: 'react/no-anonymous-callback',
    category: 'code',
    severity: 'info',
    description: 'Anonymous handler passed to a JSX `on*` prop inside a list row.',
    rationale:
      'A fresh closure per render only costs something when the child compares props to skip ' +
      'work, and it costs it once per row. This rule therefore reports handlers only inside a ' +
      '`renderItem` callback or a `.map()` body — the places where the allocation is multiplied ' +
      'by the number of items. Outside of lists an inline handler is idiomatic React and is not ' +
      'flagged, because hoisting it there adds `useCallback` noise for no measurable gain.',
    recommendation:
      'Extract the row into its own memoised component and pass the item id, letting the row ' +
      'call a stable `useCallback` handler from the parent.',
    fixable: false,
  },

  check(model) {
    const findings: FindingDraft[] = []

    for (const file of model.files) {
      traverse(file.ast, {
        JSXAttribute(path) {
          const name = path.node.name
          if (name.type !== 'JSXIdentifier' || !/^on[A-Z]/.test(name.name)) return

          const expr = attributeExpression(path.node)
          if (!expr || !isFunctionExpression(expr)) return

          const context = listRenderContext(path)
          if (!context) return

          findings.push(
            at(
              file,
              expr,
              `Anonymous \`${name.name}\` handler is allocated for every row rendered by ${context}.`,
            ),
          )
        },
      })
    }

    return findings
  },
}

/**
 * Describe the list-rendering construct enclosing a path, or null if there is
 * none. Walking up from the attribute keeps this conservative: we need real
 * evidence of per-item rendering, not just a component that happens to
 * contain a list somewhere else in its tree.
 */
function listRenderContext(path: NodePath<t.Node>): string | null {
  let current: NodePath<t.Node> | null = path.parentPath

  while (current) {
    if (isFunctionExpression(current.node) || current.node.type === 'FunctionDeclaration') {
      const holder: NodePath<t.Node> | null = current.parentPath

      // `renderItem={({ item }) => ...}` and `renderItem={renderRow}` alike.
      if (holder?.isJSXExpressionContainer()) {
        const attr = holder.parentPath
        if (attr?.isJSXAttribute() && attr.node.name.type === 'JSXIdentifier') {
          const attrName = attr.node.name.name
          if (attrName === 'renderItem' || attrName === 'renderSectionHeader') {
            const element = attr.parentPath
            const owner = element.isJSXOpeningElement() ? jsxElementName(element.node.name) : null
            return owner && LIST_COMPONENTS.has(owner)
              ? `\`${owner}.${attrName}\``
              : `\`${attrName}\``
          }
        }
      }

      // `items.map((item) => ...)` — the callback argument of a `.map` call.
      if (holder?.isCallExpression()) {
        const callee = holder.node.callee
        if (
          callee.type === 'MemberExpression' &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'map'
        ) {
          return 'a `.map()` callback'
        }
      }
    }
    current = current.parentPath
  }

  return null
}

// ---------------------------------------------------------------------------
// react-native/flatlist-missing-key-extractor
// ---------------------------------------------------------------------------

export const flatlistMissingKeyExtractor: Rule<CodeModel> = {
  meta: {
    id: 'react-native/flatlist-missing-key-extractor',
    category: 'code',
    severity: 'warning',
    description: 'FlatList or SectionList rendered without a `keyExtractor`.',
    rationale:
      'Without `keyExtractor`, the list falls back to `item.key`, then `item.id`, then the array ' +
      'index. Index keys make React reuse the wrong row when data is inserted, reordered or ' +
      'filtered, which shows up as rows keeping stale state and as full re-renders where a ' +
      'targeted update would do.',
    recommendation:
      'Add `keyExtractor={(item) => String(item.id)}` using a field that is stable for the ' +
      'lifetime of the item.',
    fixable: false,
  },

  check(model) {
    const findings: FindingDraft[] = []

    for (const file of model.files) {
      if (!file.facts.hasListComponent) continue

      traverse(file.ast, {
        JSXOpeningElement(path) {
          const name = jsxElementName(path.node.name)
          if (!name || !LIST_COMPONENTS.has(name)) return
          if (findAttribute(path.node, 'keyExtractor')) return
          // A spread may carry `keyExtractor` from a props object; reporting it
          // would be a guess, so stay quiet.
          if (hasSpread(path.node)) return

          findings.push(at(file, path.node, `<${name}> has no \`keyExtractor\` prop.`))
        },
      })
    }

    return findings
  },
}

// ---------------------------------------------------------------------------
// react-native/flatlist-inline-render-item
// ---------------------------------------------------------------------------

export const flatlistInlineRenderItem: Rule<CodeModel> = {
  meta: {
    id: 'react-native/flatlist-inline-render-item',
    category: 'code',
    severity: 'warning',
    description: 'FlatList `renderItem` given an inline function.',
    rationale:
      'An inline `renderItem` is a new function identity on every parent render. VirtualizedList ' +
      'compares it against the previous one to decide whether cached cells are still valid, so a ' +
      'fresh identity invalidates every mounted cell and re-renders the whole visible window ' +
      'instead of just the rows whose data changed.',
    recommendation:
      'Move the renderer out of the render body and wrap it in `useCallback` with the values it ' +
      'actually depends on.',
    fixable: false,
  },

  check(model) {
    const findings: FindingDraft[] = []

    for (const file of model.files) {
      if (!file.facts.hasListComponent) continue

      traverse(file.ast, {
        JSXOpeningElement(path) {
          const name = jsxElementName(path.node.name)
          if (!name || !LIST_COMPONENTS.has(name)) return

          for (const propName of ['renderItem', 'renderSectionHeader'] as const) {
            const attr = findAttribute(path.node, propName)
            if (!attr) continue
            const expr = attributeExpression(attr)
            if (!expr || !isFunctionExpression(expr)) continue

            findings.push(at(file, expr, `<${name}> \`${propName}\` is an inline function.`))
          }
        },
      })
    }

    return findings
  },
}

// ---------------------------------------------------------------------------
// react/missing-memo-on-list-item
// ---------------------------------------------------------------------------

export const missingMemoOnListItem: Rule<CodeModel> = {
  meta: {
    id: 'react/missing-memo-on-list-item',
    category: 'code',
    severity: 'info',
    description: 'Large list-rendering file whose components are not memoised.',
    rationale:
      'Whether a component is used as a list row cannot be determined statically — the renderer ' +
      'receives it as a value, often through a prop or a registry. This rule is therefore a ' +
      'heuristic, not a proof: it flags files that both render a list and are long enough ' +
      '(>' +
      String(MEMO_HINT_LINES) +
      ' lines) that a row component is probably declared alongside the list. Expect false ' +
      'positives on long screen files whose components are not rows; it is reported at `info` ' +
      'for that reason.',
    recommendation:
      'If any component in this file is rendered per list item, wrap it in `React.memo` and ' +
      'give it only primitive or stable props so the comparison can actually skip work.',
    fixable: false,
  },

  check(model) {
    const findings: FindingDraft[] = []

    for (const file of model.files) {
      const { facts } = file
      if (!facts.hasListComponent) continue
      if (facts.lineCount <= MEMO_HINT_LINES) continue

      // If the file already calls memo/forwardRef, the author has considered
      // this and a nag adds nothing.
      if (usesMemo(file)) continue
      if (facts.componentNames.length === 0) continue

      findings.push({
        message:
          `${file.file} renders a list and declares ` +
          `${facts.componentNames.length === 1 ? 'component' : 'components'} ` +
          `${facts.componentNames
            .slice(0, 3)
            .map((n) => `\`${n}\``)
            .join(', ')}` +
          `${facts.componentNames.length > 3 ? ', …' : ''} without \`React.memo\`.`,
        file: file.file,
        location: { line: 1 },
        data: {
          lineCount: facts.lineCount,
          componentNames: facts.componentNames,
          heuristic: true,
        },
      })
    }

    return findings
  },
}

/** True when the file references React.memo or forwardRef in any form. */
function usesMemo(file: ParsedFile): boolean {
  let found = false
  traverse(file.ast, {
    MemberExpression(path) {
      if (found) return
      const prop = path.node.property
      if (prop.type === 'Identifier' && (prop.name === 'memo' || prop.name === 'forwardRef')) {
        found = true
        path.stop()
      }
    },
    Identifier(path) {
      if (found) return
      if (path.node.name === 'memo' || path.node.name === 'forwardRef') {
        found = true
        path.stop()
      }
    },
  })
  return found
}

// ---------------------------------------------------------------------------
// code/large-component-file
// ---------------------------------------------------------------------------

export const largeComponentFile: Rule<CodeModel> = {
  meta: {
    id: 'code/large-component-file',
    category: 'code',
    severity: 'info',
    description: `Source file longer than ${LARGE_FILE_LINES} lines.`,
    rationale:
      'Long files tend to hold several components and their state in one render scope, so any ' +
      'state change re-renders all of it. They are also the files where the other findings in ' +
      'this report are hardest to act on, since the blast radius of a change is unclear.',
    recommendation:
      'Split the file along its state boundaries — move each component that owns independent ' +
      'state, and its styles, into its own module.',
    fixable: false,
  },

  check(model) {
    const findings: FindingDraft[] = []

    for (const file of model.files) {
      const { lineCount } = file.facts
      if (lineCount <= LARGE_FILE_LINES) continue

      findings.push({
        message: `${file.file} is ${lineCount} lines long.`,
        file: file.file,
        location: { line: 1 },
        data: { lineCount, threshold: LARGE_FILE_LINES },
      })
    }

    return findings
  },
}

// ---------------------------------------------------------------------------
// code/unused-import
// ---------------------------------------------------------------------------

export const unusedImport: Rule<CodeModel> = {
  meta: {
    id: 'code/unused-import',
    category: 'code',
    severity: 'warning',
    description: 'Imported binding is never referenced in the file.',
    rationale:
      'Metro resolves and loads every imported module even when nothing from it is used, so an ' +
      'unused import of a native or barrel module still costs bundle bytes and module-init time ' +
      'at startup. Tree shaking does not save you here: Metro does not perform it by default.',
    recommendation:
      'Delete the unused specifier, or the whole import when nothing from it is used.',
    fixable: true,
  },

  check(model) {
    const findings: FindingDraft[] = []

    for (const file of model.files) {
      const { imports, referencedNames, hasJSX } = file.facts

      for (const binding of imports.values()) {
        if (referencedNames.has(binding.local)) continue

        // Classic JSX runtime compiles `<View />` to `React.createElement`, so
        // React is used by any file containing JSX even without a textual
        // reference. The automatic runtime does not need it, but we cannot see
        // the babel config from here, and a wrong removal breaks the build.
        if (hasJSX && binding.local === 'React') continue

        findings.push({
          message: `\`${binding.local}\` is imported from '${binding.source}' but never used.`,
          file: file.file,
          location: { line: binding.line, column: binding.column },
          excerpt: truncate(`import { ${binding.local} } from '${binding.source}'`),
          fixable: true,
          data: {
            local: binding.local,
            imported: binding.imported,
            source: binding.source,
            typeOnly: binding.typeOnly,
          },
          // Type-only imports are erased at compile time, so they cost nothing
          // at runtime — still worth deleting, but not a warning.
          ...(binding.typeOnly ? { severity: 'info' as const } : {}),
        })
      }
    }

    return findings
  },
}

// ---------------------------------------------------------------------------
// performance/require-in-render
// ---------------------------------------------------------------------------

export const requireInRender: Rule<CodeModel> = {
  meta: {
    id: 'performance/require-in-render',
    category: 'performance',
    severity: 'warning',
    description: '`require()` called inside a function body rather than at module scope.',
    rationale:
      'Metro resolves `require()` at build time wherever it appears, so a call inside a render ' +
      'body buys no lazy loading — the module is still in the bundle. What it does add is a ' +
      'module-registry lookup on every call, which for a render function or a list row means ' +
      'once per frame per row.',
    recommendation:
      'Hoist the `require()` to module scope as an `import`. For genuine lazy loading use ' +
      '`React.lazy` or an async `import()`, which Metro can split.',
    fixable: false,
  },

  check(model) {
    const findings: FindingDraft[] = []

    for (const file of model.files) {
      traverse(file.ast, {
        CallExpression(path) {
          if (path.node.callee.type !== 'Identifier' || path.node.callee.name !== 'require') return
          // A local binding named `require` is not the module registry.
          if (path.scope.hasBinding('require', { noGlobals: true })) return

          const fn = path.getFunctionParent()
          if (!fn) return

          findings.push(
            at(
              file,
              path.node,
              `\`require()\` inside ${describeFunction(fn)} runs on every call, not once at load.`,
            ),
          )
        },
      })
    }

    return findings
  },
}

/** Best-effort name for a function-like node, for finding messages. */
function describeFunction(fn: NodePath<t.Function>): string {
  const node = fn.node
  if (node.type === 'FunctionDeclaration' && node.id) return `\`${node.id.name}()\``
  if (node.type === 'ObjectMethod' && node.key.type === 'Identifier')
    return `\`${node.key.name}()\``
  if (node.type === 'ClassMethod' && node.key.type === 'Identifier') return `\`${node.key.name}()\``

  const parent = fn.parentPath
  if (parent?.isVariableDeclarator() && parent.node.id.type === 'Identifier') {
    return `\`${parent.node.id.name}()\``
  }
  if (parent?.isJSXExpressionContainer()) {
    const attr = parent.parentPath
    if (attr?.isJSXAttribute() && attr.node.name.type === 'JSXIdentifier') {
      return `the \`${attr.node.name.name}\` callback`
    }
  }
  return 'a function body'
}

// ---------------------------------------------------------------------------
// performance/console-in-production
// ---------------------------------------------------------------------------

export const consoleInProduction: Rule<CodeModel> = {
  meta: {
    id: 'performance/console-in-production',
    category: 'performance',
    severity: 'info',
    description: '`console.*` call left in application source.',
    rationale:
      'On a release build with a debugger attached, every console call serialises its arguments ' +
      'and crosses the bridge, which is slow enough to be visible in a render path or a list ' +
      'scroll. Console arguments also keep whole object graphs reachable, and they are a common ' +
      'route for leaking tokens and user data into device logs.',
    recommendation:
      'Route diagnostics through a logger that is a no-op in production, or strip calls at build ' +
      'time with `babel-plugin-transform-remove-console`.',
    fixable: false,
  },

  check(model) {
    const findings: FindingDraft[] = []

    for (const file of model.files) {
      // Tests log deliberately and never ship, so path-exclude them rather
      // than making users configure an ignore for every test directory.
      if (isTestFile(file.file)) continue

      traverse(file.ast, {
        MemberExpression(path) {
          if (path.node.object.type !== 'Identifier' || path.node.object.name !== 'console') return
          if (!path.parentPath.isCallExpression() || path.parentPath.node.callee !== path.node)
            return

          const method = path.node.property.type === 'Identifier' ? path.node.property.name : '*'

          findings.push({
            ...at(file, path.parentPath.node, `\`console.${method}()\` left in source.`),
            // console.error/warn are usually deliberate error reporting; the
            // chatty debug levels are the ones worth removing.
            ...(method === 'error' || method === 'warn' ? { severity: 'info' as const } : {}),
          })
        },
      })
    }

    return findings
  },
}

/** Every rule the code layer contributes, in report order. */
export const codeRules: Rule<CodeModel>[] = [
  noInlineStyle,
  noAnonymousCallback,
  flatlistMissingKeyExtractor,
  flatlistInlineRenderItem,
  missingMemoOnListItem,
  largeComponentFile,
  unusedImport,
  requireInRender,
  consoleInProduction,
]
