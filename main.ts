// mend: one patch tool for every AI edit format.
//
// Applies an edit written as a unified diff, SEARCH/REPLACE blocks, a V4A
// patch, or JSON text-editor tool calls, to a tree of text files, following
// SPEC.md (version 1) in the kit. Every file is changed or none is: edits
// apply in order to an in-memory tree, a failed edit is rolled back on its
// own, and nothing is written to disk unless every edit succeeded.
//
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.
// When MAKEFUN_ENV_URL is set, the run is handed to runner.ts, which reads
// the checks from the env and runs this file on each one.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: the whole run stops and prints this one line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed with this code against this path. */
class EditFail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC section 3: a path is safe when it is not empty, does not start with /, holds no \, and none of its segments is empty, . or ... */
function safePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, its lines, and whether it ends with a break. */
interface FileModel {
  br: string;
  lines: string[];
  ends: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { br, lines: parts, ends };
}

function joinFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.ends ? f.br : '');
}

/** The tree as the edits leave it. `now` holds paths changed by edits so far (null: deleted); the rest is read from disk and cached. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; next: string }[] = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** SPEC section 5: one line normalised at a tier. */
function tierLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in the file's lines at one tier. Occurrences may overlap. */
function occurrencesAt(fileLines: string[], oldLines: string[], tier: number): number[] {
  const out: number[] = [];
  if (oldLines.length === 0) return out;
  const normOld = oldLines.map((l) => tierLine(l, tier));
  const normFile = fileLines.map((l) => tierLine(l, tier));
  for (let i = 0; i + oldLines.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (normFile[i + j] !== normOld[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs, with its positions. */
function findTier(fileLines: string[], oldLines: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = occurrencesAt(fileLines, oldLines, t);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line at this index of O) or a new line. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/**
 * Replace the k matched lines at `pos` with N. A context line is written as
 * the file's own matched line, never the patch's. At tier 2 every other line
 * of N is re-indented: its P prefix (the leading spaces and tabs of O's
 * first line) is replaced by F (those of the file's first matched line).
 */
function replaceAt(fileLines: string[], pos: number, oldLines: string[], newLines: NewLine[], tier: number): string[] {
  const out = fileLines.slice(0, pos);
  let prefixOld = '';
  let prefixFile = '';
  if (tier === 2 && oldLines.length > 0) {
    prefixOld = /^[ \t]*/.exec(oldLines[0]!)![0];
    prefixFile = /^[ \t]*/.exec(fileLines[pos]!)![0];
  }
  for (const nl of newLines) {
    if (nl.ctx !== null) {
      out.push(fileLines[pos + nl.ctx]!);
    } else {
      let t = nl.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(prefixOld)) t = prefixFile + t.slice(prefixOld.length);
      out.push(t);
    }
  }
  out.push(...fileLines.slice(pos + oldLines.length));
  return out;
}

/** Format detection, SPEC section 4. Null when no format is detected. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** SPEC section 9: JSON edits. One edit object, or null when it is not one. */
function jsonEdit(value: unknown): Edit | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;

  const readExisting = (tree: Tree): string => {
    if (!safePath(p)) throw new EditFail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new EditFail('missing', p);
    return t;
  };

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new EditFail('unsafe', p);
      if (tree.get(p) !== null) throw new EditFail('exists', p);
      tree.now.set(p, text);
    };
  }

  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = readExisting(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFail('no-match', p);
      if (count > 1) throw new EditFail('ambiguous', p);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + toLf(newStr) + text.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const lineNo = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = readExisting(tree);
      const f = splitFile(before);
      if (lineNo < 0 || lineNo > f.lines.length) throw new EditFail('no-match', p);
      f.lines.splice(lineNo, 0, ...add);
      tree.now.set(p, joinFile(f));
    };
  }

  return null;
}

/** Read the patch as JSON: one array of edit objects, or one edit object a line. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** SPEC section 6: unified diffs. */

interface HunkBodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  /** True when this line is a zero-length patch line (only for ctx lines). */
  emptyLine: boolean;
}

interface Hunk {
  /** Old start line A (1-based) from the header. */
  a: number;
  oldLines: string[];
  newLines: NewLine[];
  /** The + lines of the hunk, in order (a creation's file is these). */
  plusLines: string[];
  /** Whether a \ line follows the hunk's last context or + line. */
  noBreakAfterLast: boolean;
  /** Whether a \ line follows the hunk's last + line. */
  noBreakAfterPlus: boolean;
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

/** A hunk header `@@ -A[,B] +C[,D] @@` with optional text after it, or null. */
function hunkHeader(line: string): { a: number } | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
  if (m === null) return null;
  return { a: Number(m[1]) };
}

/** The path after `--- ` or `+++ `: text after the four characters, up to the first tab, surrounding spaces removed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

/** Strip one leading a/ or b/ from a header path; /dev/null means no file. */
function cleanHeaderPath(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/**
 * Parse the patch as a unified diff: a list of sections. Throws Exit2 on a
 * parse fault, naming the patch line the section says.
 */
function unifiedSections(lines: string[]): UnifiedSection[] {
  const sections: UnifiedSection[] = [];
  let i = 0;

  const diffGitPaths = (line: string): { old: string; next: string } | null => {
    const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
    if (m === null) return null;
    return { old: m[1]!, next: m[2]! };
  };

  while (i < lines.length) {
    const l = lines[i]!;
    let sec: UnifiedSection | null = null;
    let pairSeen = false;
    if (l.startsWith('@@')) {
      // A hunk before any section is a parse error at its line.
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (l.startsWith('diff --git ')) {
      const dg = diffGitPaths(l);
      if (dg === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = { oldPath: dg.old, newPath: dg.next, creation: false, deletion: false, hunks: [] };
      i += 1;
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sec = { oldPath: cleanHeaderPath(headerPath(l)), newPath: cleanHeaderPath(headerPath(lines[i + 1]!)), creation: false, deletion: false, hunks: [] };
      pairSeen = true;
      i += 2;
    } else {
      i += 1;
      continue;
    }

    // The section's header: lines before its first hunk.
    let sawHeaderPair = pairSeen;
    let renameOld: string | null = null;
    let renameNew: string | null = null;
    while (i < lines.length) {
      const h = lines[i]!;
      if (h.startsWith('@@')) break;
      if (h.startsWith('diff --git ')) break;
      if (h.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (sawHeaderPair) break; // a later pair starts a new section
          sec.oldPath = cleanHeaderPath(headerPath(h));
          sec.newPath = cleanHeaderPath(headerPath(lines[i + 1]!));
          sawHeaderPair = true;
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (h.startsWith('rename from ')) {
        renameOld = h.slice('rename from '.length);
        i += 1;
        continue;
      }
      if (h.startsWith('rename to ')) {
        renameNew = h.slice('rename to '.length);
        i += 1;
        continue;
      }
      if (h.startsWith('new file mode')) {
        sec.creation = true;
        i += 1;
        continue;
      }
      if (h.startsWith('deleted file mode')) {
        sec.deletion = true;
        i += 1;
        continue;
      }
      i += 1; // index, modes, similarity, Index:, any other line: ignored
    }
    if (sec.oldPath === null && renameOld !== null) sec.oldPath = renameOld;
    if (sec.newPath === null && renameNew !== null) sec.newPath = renameNew;

    // The section's hunks, with prose between them ignored.
    while (i < lines.length) {
      const h = lines[i]!;
      if (h.startsWith('diff --git ')) break;
      if (h.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      if (h.startsWith('@@')) {
        const head = hunkHeader(h);
        if (head === null) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
        const body: HunkBodyLine[] = [];
        while (i < lines.length) {
          const b = lines[i]!;
          if (b.startsWith('diff --git ')) break;
          if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
          if (b === '') {
            body.push({ kind: 'ctx', text: '', emptyLine: true });
            i += 1;
          } else if (b[0] === ' ') {
            body.push({ kind: 'ctx', text: b.slice(1), emptyLine: false });
            i += 1;
          } else if (b[0] === '-') {
            body.push({ kind: 'old', text: b.slice(1), emptyLine: false });
            i += 1;
          } else if (b[0] === '+') {
            body.push({ kind: 'new', text: b.slice(1), emptyLine: false });
            i += 1;
          } else if (b[0] === '\\') {
            body.push({ kind: 'bs', text: b.slice(1), emptyLine: false });
            i += 1;
          } else break;
        }
        while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.emptyLine) body.pop();
        const oldLines: string[] = [];
        const newLines: NewLine[] = [];
        const plusLines: string[] = [];
        let lastCtxOrNew = -1;
        for (let k = 0; k < body.length; k++) {
          const item = body[k]!;
          if (item.kind === 'ctx') {
            newLines.push({ text: item.text, ctx: oldLines.length });
            oldLines.push(item.text);
            lastCtxOrNew = k;
          } else if (item.kind === 'old') {
            oldLines.push(item.text);
          } else if (item.kind === 'new') {
            newLines.push({ text: item.text, ctx: null });
            plusLines.push(item.text);
            lastCtxOrNew = k;
          }
        }
        const noBreakAfterLast =
          lastCtxOrNew >= 0 && lastCtxOrNew + 1 < body.length && body[lastCtxOrNew + 1]!.kind === 'bs';
        let lastPlus = -1;
        for (let k = 0; k < body.length; k++) if (body[k]!.kind === 'new') lastPlus = k;
        const noBreakAfterPlus = lastPlus >= 0 && lastPlus + 1 < body.length && body[lastPlus + 1]!.kind === 'bs';
        sec.hunks.push({ a: head.a, oldLines, newLines, plusLines, noBreakAfterLast, noBreakAfterPlus });
        continue;
      }
      if (h.startsWith('--- ')) {
        // A --- line not followed by +++ after the hunks: prose, ignored.
        i += 1;
        continue;
      }
      i += 1; // prose, code fences, anything else: ignored
    }
    sections.push(sec);
  }
  return sections;
}

/** Apply a section's hunks in order to one file's text. Throws EditFail on a hunk that fails. */
function applyUnifiedHunks(content: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(content);
  let d = 0;
  for (const h of hunks) {
    if (h.oldLines.length === 0) {
      const at = Math.min(h.a + d, f.lines.length);
      const atEnd = at >= f.lines.length;
      f.lines.splice(at, 0, ...h.newLines.map((n) => n.text));
      if (atEnd) f.ends = !h.noBreakAfterLast;
      d += h.newLines.length;
      continue;
    }
    const found = findTier(f.lines, h.oldLines, strict);
    if (found === null) throw new EditFail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.positions[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.positions) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const runsToEnd = best + h.oldLines.length >= f.lines.length;
    f.lines = replaceAt(f.lines, best, h.oldLines, h.newLines, found.tier);
    if (runsToEnd) f.ends = !h.noBreakAfterLast;
    d += h.newLines.length - h.oldLines.length;
  }
  return joinFile(f);
}

/** One unified section is one edit. */
function unifiedEdit(sec: UnifiedSection, strict: boolean): Edit {
  return (tree) => {
    // A creation is an old /dev/null or a new-file-mode line; a deletion is a
    // new /dev/null or a deleted-file-mode line.
    if (sec.creation || sec.oldPath === null) {
      const p = sec.newPath;
      if (p === null) return;
      if (!safePath(p)) throw new EditFail('unsafe', p);
      if (tree.get(p) !== null) throw new EditFail('exists', p);
      const plus: string[] = [];
      let ends = true;
      for (const h of sec.hunks) {
        if (h.plusLines.length > 0) ends = !h.noBreakAfterPlus;
        plus.push(...h.plusLines);
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (ends ? '\n' : ''));
      return;
    }
    if (sec.deletion || sec.newPath === null) {
      const p = sec.oldPath;
      if (p === null) return;
      if (!safePath(p)) throw new EditFail('unsafe', p);
      if (tree.get(p) === null) throw new EditFail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP === null || newP === null) return;
    if (oldP !== newP) {
      if (!safePath(oldP)) throw new EditFail('unsafe', oldP);
      if (!safePath(newP)) throw new EditFail('unsafe', newP);
      const content = tree.get(oldP);
      if (content === null) throw new EditFail('missing', oldP);
      if (tree.get(newP) !== null) throw new EditFail('exists', newP);
      const result = applyUnifiedHunks(content, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, result);
      tree.moves.push({ old: oldP, next: newP });
      return;
    }
    if (!safePath(oldP)) throw new EditFail('unsafe', oldP);
    const content = tree.get(oldP);
    if (content === null) throw new EditFail('missing', oldP);
    tree.now.set(oldP, applyUnifiedHunks(content, sec.hunks, strict, oldP));
  };
}

/** Read the patch as a unified diff: every section is one edit. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return unifiedSections(lines).map((sec) => unifiedEdit(sec, strict));
}

/** SPEC section 7: SEARCH/REPLACE blocks. */

/** One block is one edit. */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safePath(path)) throw new EditFail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const content = tree.get(path);
    if (content === null) throw new EditFail('missing', path);
    const f = splitFile(content);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new EditFail('no-match', path);
    if (found.positions.length > 1) throw new EditFail('ambiguous', path);
    const nLines: NewLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    f.lines = replaceAt(f.lines, found.positions[0]!, oldLines, nLines, found.tier);
    tree.now.set(path, joinFile(f));
  };
}

/** Read the patch as SEARCH/REPLACE blocks, in order. Throws Exit2 on a parse fault. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    let si = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        si = j;
        break;
      }
    }
    if (si < 0) break;
    let path: string | null = null;
    for (let j = si - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${si + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = si + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${si + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${si + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(si + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/** SPEC section 8: V4A patches. */

interface V4aChunk {
  /** The anchor text after @@, or null when the chunk has no anchor. */
  anchor: string | null;
  /** True when a *** End of File line ends this chunk. */
  eof: boolean;
  oldLines: string[];
  newLines: NewLine[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: V4aChunk[];
}

/** One V4A section is one edit. */
function v4aEdit(sec: V4aSection, strict: boolean): Edit {
  return (tree) => {
    if (!safePath(sec.path)) throw new EditFail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new EditFail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new EditFail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    // Update: every path the edit names is safety-checked before anything
    // else about it, so the Move to target is checked before the old file
    // is even looked for.
    if (sec.moveTo !== null && !safePath(sec.moveTo)) throw new EditFail('unsafe', sec.moveTo);
    const content = tree.get(sec.path);
    if (content === null) throw new EditFail('missing', sec.path);
    const target = sec.moveTo;
    if (target !== null) {
      if (tree.get(target) !== null) throw new EditFail('exists', target);
    }
    const f = splitFile(content);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        // The anchor is found at the first tier at which any line at or
        // after the cursor equals it, and the first such line at that tier.
        let foundAt = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          const normAnchor = tierLine(chunk.anchor, t);
          for (let j = cursor; j < f.lines.length; j++) {
            if (tierLine(f.lines[j]!, t) === normAnchor) {
              foundAt = j;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new EditFail('no-match', sec.path);
        cursor = foundAt + 1;
      }
      if (chunk.oldLines.length === 0) {
        const at = chunk.eof ? f.lines.length : cursor;
        f.lines.splice(at, 0, ...chunk.newLines.map((n) => n.text));
        cursor = at + chunk.newLines.length;
        continue;
      }
      // The first occurrence at or after the cursor, at the first tier with one.
      let picked: { tier: number; pos: number } | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        const positions = occurrencesAt(f.lines, chunk.oldLines, t).filter((p) => p >= cursor);
        const usable = chunk.eof ? positions.filter((p) => p + chunk.oldLines.length === f.lines.length) : positions;
        if (usable.length > 0) {
          picked = { tier: t, pos: usable[0]! };
          break;
        }
      }
      if (picked === null) throw new EditFail('no-match', sec.path);
      f.lines = replaceAt(f.lines, picked.pos, chunk.oldLines, chunk.newLines, picked.tier);
      cursor = picked.pos + chunk.newLines.length;
    }
    const result = joinFile(f);
    if (target !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(target, result);
      tree.moves.push({ old: sec.path, next: target });
    } else {
      tree.now.set(sec.path, result);
    }
  };
}

/** Read the patch as a V4A patch: every section is one edit. Throws Exit2 on a parse fault. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && isBlank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const edits: Edit[] = [];
  let i = first + 1;
  const sectionStart = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };

  while (i < last) {
    const l = lines[i]!;
    if (isBlank(l)) {
      i += 1;
      continue;
    }
    const kind = sectionStart(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = l.slice(l.indexOf(':') + 1).trim();
    const startLine = i + 1;
    i += 1;
    // The section's raw lines: up to the next section or *** End Patch.
    const raw: { text: string; lineNo: number }[] = [];
    while (i < last) {
      const s = lines[i]!;
      if (sectionStart(s) !== null) break;
      raw.push({ text: s, lineNo: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && isBlank(raw[raw.length - 1]!.text)) raw.pop();

    if (kind === 'add') {
      const addLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) addLines.push(r.text.slice(1));
        else if (r.text === '') addLines.push('');
        else throw new Exit2(`error: parse ${r.lineNo}`);
      }
      edits.push(v4aEdit({ kind, path, moveTo: null, addLines, chunks: [] }, strict));
      continue;
    }
    if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.lineNo}`);
      edits.push(v4aEdit({ kind, path, moveTo: null, addLines: [], chunks: [] }, strict));
      continue;
    }
    // Update: an optional *** Move to: as the first line, then chunks.
    let moveTo: string | null = null;
    let rest = raw;
    if (rest.length > 0 && rest[0]!.text.startsWith('*** Move to: ')) {
      moveTo = rest[0]!.text.slice('*** Move to: '.length).trim();
      rest = rest.slice(1);
    }
    const chunks: V4aChunk[] = [];
    const isBodyLine = (t: string): boolean => t.startsWith(' ') || t.startsWith('-') || t.startsWith('+') || t === '';
    const makeChunk = (anchor: string | null, eof: boolean, body: { text: string; lineNo: number }[]): V4aChunk => {
      const oldLines: string[] = [];
      const newLines: NewLine[] = [];
      for (const r of body) {
        if (r.text.startsWith(' ')) {
          newLines.push({ text: r.text.slice(1), ctx: oldLines.length });
          oldLines.push(r.text.slice(1));
        } else if (r.text.startsWith('-')) {
          oldLines.push(r.text.slice(1));
        } else if (r.text.startsWith('+')) {
          newLines.push({ text: r.text.slice(1), ctx: null });
        } else {
          newLines.push({ text: '', ctx: oldLines.length });
          oldLines.push('');
        }
      }
      return { anchor, eof, oldLines, newLines };
    };
    let ri = 0;
    while (ri < rest.length) {
      const r = rest[ri]!;
      if (r.text.startsWith('@@')) {
        const anchorText = r.text.slice(2).trim();
        const anchor = anchorText === '' ? null : anchorText;
        ri += 1;
        const body: { text: string; lineNo: number }[] = [];
        while (ri < rest.length) {
          const b = rest[ri]!;
          if (b.text.startsWith('@@') || b.text === '*** End of File') break;
          if (!isBodyLine(b.text)) throw new Exit2(`error: parse ${b.lineNo}`);
          body.push(b);
          ri += 1;
        }
        const chunk = makeChunk(anchor, false, body);
        if (ri < rest.length && rest[ri]!.text === '*** End of File') {
          chunk.eof = true;
          ri += 1;
        }
        chunks.push(chunk);
        continue;
      }
      if (r.text === '*** End of File') throw new Exit2(`error: parse ${r.lineNo}`);
      if (isBodyLine(r.text)) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${r.lineNo}`);
        const body: { text: string; lineNo: number }[] = [];
        while (ri < rest.length) {
          const b = rest[ri]!;
          if (b.text.startsWith('@@') || b.text === '*** End of File') break;
          if (!isBodyLine(b.text)) throw new Exit2(`error: parse ${b.lineNo}`);
          body.push(b);
          ri += 1;
        }
        const chunk = makeChunk(null, false, body);
        if (ri < rest.length && rest[ri]!.text === '*** End of File') {
          chunk.eof = true;
          ri += 1;
        }
        chunks.push(chunk);
        continue;
      }
      throw new Exit2(`error: parse ${r.lineNo}`);
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
    edits.push(v4aEdit({ kind, path, moveTo, addLines: [], chunks }, strict));
  }
  return edits;
}

/** SPEC sections 1, 2 and 10: the command line, the answers, and the all-or-nothing write. */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  // The changed paths, in byte order of the paths (UTF-8); a move sorts by its new path.
  const rows: { key: string; text: string }[] = [];
  const covered = new Set<string>();
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.now.get(m.old) === null && tree.original(m.next) === null && tree.now.get(m.next) !== null) {
      rows.push({ key: m.next, text: `R ${m.old} -> ${m.next}` });
      covered.add(m.old);
      covered.add(m.next);
    }
  }
  const changed = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const p of changed) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
