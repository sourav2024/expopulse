import fs from 'node:fs/promises'
import { parse as babelParse } from '@babel/parser'
import type { ParseResult } from '@babel/parser'
import _traverse from '@babel/traverse'
import type { TraverseOptions } from '@babel/traverse'
import type * as t from '@babel/types'
import type { Logger, SourceFile } from '../../shared/types.js'

/**
 * `@babel/traverse` is CJS with a `default` export, so depending on how the
 * consumer's bundler interops it the import binding is either the function or
 * a namespace wrapping it. Unwrap once here rather than at every call site.
 *
 * The explicit `TraverseFn` annotation is load-bearing: under NodeNext,
 * `typeof _traverse` widens to the module namespace type, which is not
 * callable, so casting via it produces a "not callable" error.
 */
export type TraverseFn = <S = unknown>(
  parent: t.Node | t.Node[],
  opts?: TraverseOptions<S>,
  scope?: unknown,
  state?: S,
) => void

export const traverse = ((_traverse as unknown as { default?: TraverseFn }).default ??
  (_traverse as unknown as TraverseFn)) as TraverseFn

/** A source file that parsed successfully, with the facts rules ask for most. */
export interface ParsedFile {
  /** Project-relative path, POSIX separators. */
  file: string
  ast: ParseResult<t.File>
  /** Raw source, retained so rules can build excerpts without re-reading. */
  source: string
  facts: FileFacts
}

/**
 * Facts gathered in a single shared pass so that individual rules do not each
 * re-walk the tree for the same trivia.
 */
export interface FileFacts {
  /** Total lines in the file, counted from the source text. */
  lineCount: number
  /** True when the file contains any JSX element or fragment. */
  hasJSX: boolean
  /** True when the file renders a FlatList or SectionList element. */
  hasListComponent: boolean
  /** Local binding name -> the import that introduced it. */
  imports: Map<string, ImportedBinding>
  /**
   * Every identifier name referenced outside of import declarations, including
   * names appearing only in type positions and in JSX element names.
   */
  referencedNames: Set<string>
  /** Names of function/class/variable declarations that look like components. */
  componentNames: string[]
}

export interface ImportedBinding {
  /** Local name the binding is available under in this file. */
  local: string
  /** Name as exported by the module, or `default` / `*` for those forms. */
  imported: string
  /** Module specifier the binding came from. */
  source: string
  /** True for `import type { X }` or `import { type X }`. */
  typeOnly: boolean
  line: number
  column: number
}

/** A file that could not be parsed, with the reason why. */
export interface ParseError {
  file: string
  message: string
}

/** The model the code layer's rules run against. */
export interface CodeModel {
  files: ParsedFile[]
  /**
   * Files that failed to read or parse. Surfaced as analysis warnings rather
   * than aborting the run: one unparseable file must not blind the layer.
   */
  parseErrors: ParseError[]
}

/** JSX component names treated as virtualised lists. */
export const LIST_COMPONENTS = new Set(['FlatList', 'SectionList', 'FlashList', 'VirtualizedList'])

/**
 * Parsing is CPU-bound but reading is not, and an unbounded `Promise.all` over
 * a few thousand files exhausts the libuv threadpool and file descriptors.
 */
export const PARSE_CONCURRENCY = 16

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      const item = items[index]
      // `noUncheckedIndexedAccess`: index is bounds-checked above, but the
      // compiler cannot see that through the shared cursor.
      if (item === undefined) continue
      results[index] = await fn(item, index)
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker)
  await Promise.all(workers)
  return results
}

/**
 * Read and parse every source file once.
 *
 * `errorRecovery` is on so that a file with a single syntax error still yields
 * a usable tree — most rules can still say something useful about it.
 */
export async function buildCodeModel(
  sourceFiles: readonly SourceFile[],
  logger: Logger,
): Promise<CodeModel> {
  const files: ParsedFile[] = []
  const parseErrors: ParseError[] = []

  const outcomes = await mapLimit(sourceFiles, PARSE_CONCURRENCY, async (sourceFile) => {
    try {
      const source = await fs.readFile(sourceFile.absolutePath, 'utf8')
      const ast = babelParse(source, {
        sourceType: 'module',
        errorRecovery: true,
        plugins: ['jsx', 'typescript'],
        sourceFilename: sourceFile.path,
      })
      return { parsed: { file: sourceFile.path, ast, source, facts: prescan(ast, source) } }
    } catch (err) {
      return {
        error: {
          file: sourceFile.path,
          message: err instanceof Error ? err.message : String(err),
        },
      }
    }
  })

  for (const outcome of outcomes) {
    if ('parsed' in outcome && outcome.parsed) files.push(outcome.parsed)
    else if ('error' in outcome && outcome.error) parseErrors.push(outcome.error)
  }

  if (parseErrors.length > 0) {
    logger.debug(`code layer: ${parseErrors.length} file(s) failed to parse`)
  }
  logger.debug(`code layer: parsed ${files.length} file(s)`)

  return { files, parseErrors }
}

/**
 * One traversal per file collecting the facts several rules share.
 *
 * Reference collection deliberately includes type positions and JSX names,
 * because `code/unused-import` reports a false positive for every import used
 * only as a type or only as a JSX tag if it does not.
 */
function prescan(ast: ParseResult<t.File>, source: string): FileFacts {
  const imports = new Map<string, ImportedBinding>()
  const referencedNames = new Set<string>()
  const componentNames: string[] = []
  let hasJSX = false
  let hasListComponent = false

  traverse(ast, {
    ImportDeclaration(path) {
      const source_ = path.node.source.value
      const declTypeOnly = path.node.importKind === 'type'
      for (const spec of path.node.specifiers) {
        const local = spec.local.name
        const specTypeOnly =
          spec.type === 'ImportSpecifier' && spec.importKind === 'type' ? true : declTypeOnly
        imports.set(local, {
          local,
          imported: importedNameOf(spec),
          source: source_,
          typeOnly: specTypeOnly,
          line: spec.loc?.start.line ?? path.node.loc?.start.line ?? 1,
          column: spec.loc?.start.column ?? path.node.loc?.start.column ?? 0,
        })
      }
      // Do not descend: the specifiers are bindings, not references.
      path.skip()
    },

    Identifier(path) {
      // Property keys and non-computed member properties are not references to
      // a binding of that name (`obj.View` must not mark `View` as used).
      if (path.key === 'property' && path.parent.type === 'MemberExpression') return
      if (path.parentPath?.isObjectProperty() && path.key === 'key') return
      referencedNames.add(path.node.name)
    },

    JSXIdentifier(path) {
      // Attribute names are not value references; element/member names are.
      if (path.parent.type === 'JSXAttribute') return
      referencedNames.add(path.node.name)
    },

    TSTypeReference(path) {
      for (const name of typeReferenceNames(path.node.typeName)) referencedNames.add(name)
    },

    TSQualifiedName(path) {
      for (const name of typeReferenceNames(path.node)) referencedNames.add(name)
    },

    JSXElement(path) {
      hasJSX = true
      const name = jsxElementName(path.node.openingElement.name)
      if (name && LIST_COMPONENTS.has(name)) hasListComponent = true
    },

    JSXFragment() {
      hasJSX = true
    },

    FunctionDeclaration(path) {
      const name = path.node.id?.name
      if (name && looksLikeComponentName(name)) componentNames.push(name)
    },

    ClassDeclaration(path) {
      const name = path.node.id?.name
      if (name && looksLikeComponentName(name)) componentNames.push(name)
    },

    VariableDeclarator(path) {
      if (path.node.id.type !== 'Identifier') return
      const init = path.node.init
      if (!init) return
      const isFunctionLike =
        init.type === 'ArrowFunctionExpression' ||
        init.type === 'FunctionExpression' ||
        // React.memo(...) / forwardRef(...) wrappers.
        init.type === 'CallExpression'
      if (isFunctionLike && looksLikeComponentName(path.node.id.name)) {
        componentNames.push(path.node.id.name)
      }
    },
  })

  return {
    lineCount: countLines(source),
    hasJSX,
    hasListComponent,
    imports,
    referencedNames,
    componentNames,
  }
}

/** Resolve the exported name a specifier binds to. */
function importedNameOf(spec: t.ImportDeclaration['specifiers'][number]): string {
  if (spec.type === 'ImportDefaultSpecifier') return 'default'
  if (spec.type === 'ImportNamespaceSpecifier') return '*'
  const imported = spec.imported
  return imported.type === 'Identifier' ? imported.name : imported.value
}

/** Flatten `A.B.C` in type position to its constituent identifier names. */
function typeReferenceNames(node: t.TSEntityName): string[] {
  if (node.type === 'Identifier') return [node.name]
  return [...typeReferenceNames(node.left), node.right.name]
}

/** Render a JSX element name, or null for namespaced names we do not match on. */
export function jsxElementName(
  name: t.JSXOpeningElement['name'] | t.JSXMemberExpression['object'],
): string | null {
  if (name.type === 'JSXIdentifier') return name.name
  // `Animated.FlatList` etc. — the property carries the component identity.
  if (name.type === 'JSXMemberExpression') return name.property.name
  return null
}

/** React's own convention: components are the capitalised callables. */
export function looksLikeComponentName(name: string): boolean {
  const first = name[0]
  return first !== undefined && first === first.toUpperCase() && /^[A-Z]/.test(name)
}

/** Count lines the way an editor does: a trailing newline adds no line. */
export function countLines(source: string): number {
  if (source.length === 0) return 0
  let lines = 1
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') lines++
  }
  // A file ending in a newline has no content on that final line.
  return source.endsWith('\n') ? lines - 1 : lines
}

/** Extract the source text a node spans, for use as a finding excerpt. */
export function excerptFor(source: string, node: t.Node): string {
  const { start, end } = node
  if (typeof start !== 'number' || typeof end !== 'number') return ''
  return source.slice(start, end)
}

/** Heuristic: does this path look like a test or spec file? */
export function isTestFile(file: string): boolean {
  return (
    /(^|\/)__tests__\//.test(file) ||
    /(^|\/)__mocks__\//.test(file) ||
    /\.(test|spec)\.[jt]sx?$/.test(file) ||
    /(^|\/)(e2e|tests?)\//.test(file)
  )
}
