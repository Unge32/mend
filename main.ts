// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format.
// It reads all four formats to one specification — a unified diff (often with wrong
// line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool
// calls as JSON — finds the lines an edit names even when the model drifted their
// whitespace or indentation, and changes every file or none. Node 22, the standard
// library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Set from --strict in run(): only tier 0 of section 5 is tried. */
let STRICT = false;

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves that succeeded, in order: used to fold a D/A pair into one R line. */
  readonly moves: { old: string; new: string }[] = [];
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

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Section 3: a file's lines, its line break, and whether it ends with one.
// ---------------------------------------------------------------------------

interface FileParts {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileParts): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers, and writing the replacement.
// ---------------------------------------------------------------------------

function matchLine(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return a.replace(/[ \t]+$/, '') === b.replace(/[ \t]+$/, '');
  return a.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '') === b.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function matchesAt(O: string[], lines: string[], at: number, tier: number): boolean {
  for (let j = 0; j < O.length; j++) {
    if (!matchLine(O[j]!, lines[at + j]!, tier)) return false;
  }
  return true;
}

/**
 * The first tier at which O occurs at least once at or after `start`
 * (and, for an end-of-file chunk, only occurrences ending at the last line),
 * with every occurrence at that tier. Null when O occurs at no tier.
 */
function findOccurrence(
  O: string[],
  lines: string[],
  start: number,
  eofOnly: boolean,
): { tier: number; positions: number[] } | null {
  const maxTier = STRICT ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const positions: number[] = [];
    for (let i = start; i + O.length <= lines.length; i++) {
      if (eofOnly && i + O.length !== lines.length) continue;
      if (matchesAt(O, lines, i, tier)) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

type Item = { kind: 'ctx' | 'old' | 'new'; text: string };

/** A line of N that is not a context line, re-indented at tier 2 (section 5). */
function reindent(line: string, P: string, F: string): string {
  if (line === '' || line.trim() === '') return line;
  if (line.startsWith(P)) return F + line.slice(P.length);
  return line;
}

/**
 * The lines that replace O at `pos`: context lines are the file's own matched
 * lines, never the patch's; other lines are re-indented at tier 2.
 */
function buildNewLines(fileLines: string[], pos: number, items: Item[], tier: number): string[] {
  const O = items.filter((it) => it.kind !== 'new').map((it) => it.text);
  let P = '';
  let F = '';
  if (tier === 2 && O.length > 0) {
    P = leadingWs(O[0]!);
    F = leadingWs(fileLines[pos] ?? '');
  }
  const out: string[] = [];
  let o = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(fileLines[pos + o]!);
      o++;
    } else if (it.kind === 'old') {
      o++;
    } else {
      out.push(tier === 2 ? reindent(it.text, P, F) : it.text);
    }
  }
  return out;
}

/** SEARCH/REPLACE new lines, re-indented at tier 2 (no context lines there). */
function buildSRNewLines(fileLines: string[], pos: number, oldLines: string[], newLines: string[], tier: number): string[] {
  if (tier !== 2) return [...newLines];
  const P = leadingWs(oldLines[0]!);
  const F = leadingWs(fileLines[pos]!);
  return newLines.map((l) => reindent(l, P, F));
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits (one JSON array, or JSON Lines).
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
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
    if (blank(l)) return;
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

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface UHunk {
  /** The hunk's -A start line (1-based, old file). */
  a: number;
  items: Item[];
  /** A `\` line follows the hunk's last context or `+` line. */
  bsAfterCtxPlus: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  bsAfterPlus: boolean;
}

function buildHunk(a: number, body: string[]): UHunk {
  const items: Item[] = [];
  let lastCtxOrPlus = -1;
  let lastPlus = -1;
  body.forEach((l, idx) => {
    if (l.startsWith(' ')) {
      items.push({ kind: 'ctx', text: l.slice(1) });
      lastCtxOrPlus = idx;
    } else if (l.startsWith('-')) {
      items.push({ kind: 'old', text: l.slice(1) });
    } else if (l.startsWith('+')) {
      items.push({ kind: 'new', text: l.slice(1) });
      lastCtxOrPlus = idx;
      lastPlus = idx;
    } else if (l.startsWith('\\')) {
      // A `\` line (as in `\ No newline at end of file`) refers to the body
      // line before it; it carries no line of its own.
    } else if (l === '') {
      items.push({ kind: 'ctx', text: '' });
      lastCtxOrPlus = idx;
    }
  });
  const bsAfterCtxPlus =
    lastCtxOrPlus >= 0 && body[lastCtxOrPlus + 1] !== undefined && body[lastCtxOrPlus + 1]!.startsWith('\\');
  const bsAfterPlus =
    lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.startsWith('\\');
  return { a, items, bsAfterCtxPlus, bsAfterPlus };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A `--- <path>` / `+++ <path>` line: text after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string {
  return line.slice(4).split('\t')[0]!.trim();
}

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

interface USection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UHunk[];
  startLine: number;
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  let body: string[] | null = null;
  let hunkA = 0;
  let skipping = false; // inside a deletion section: its hunks are not read
  const newSection = (startLine: number): USection => {
    const s: USection = {
      pairOld: undefined,
      pairNew: undefined,
      renameFrom: null,
      renameTo: null,
      diffOld: null,
      diffNew: null,
      newFile: false,
      deletedFile: false,
      hunks: [],
      startLine,
    };
    sections.push(s);
    return s;
  };
  const isDeletion = (s: USection): boolean => s.deletedFile || s.pairNew === null;
  const endBody = (): void => {
    if (body !== null && cur !== null) {
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(buildHunk(hunkA, body));
    }
    body = null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (skipping) {
      if (line.startsWith('diff --git ') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        skipping = false;
        continue;
      }
      i++;
      continue;
    }
    if (body !== null) {
      if (line.startsWith('diff --git ')) {
        endBody();
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        endBody();
        continue;
      }
      if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\') || line === '') {
        body.push(line);
        i++;
        continue;
      }
      endBody();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line.trimEnd());
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection(i + 1);
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(line);
      const newP = headerPath(lines[i + 1]!);
      if (cur !== null && inHeader) {
        cur.pairOld = oldP === '/dev/null' ? null : stripAB(oldP);
        cur.pairNew = newP === '/dev/null' ? null : stripAB(newP);
      } else {
        cur = newSection(i + 1);
        cur.pairOld = oldP === '/dev/null' ? null : stripAB(oldP);
        cur.pairNew = newP === '/dev/null' ? null : stripAB(newP);
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      if (isDeletion(cur)) {
        skipping = true;
        i++;
        continue;
      }
      hunkA = parseInt(m[1]!, 10);
      body = [];
      inHeader = false;
      i++;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      // `index`, `old mode`, `new mode`, `similarity index`,
      // `dissimilarity index`, `Index:` and any other line are ignored.
      i++;
      continue;
    }
    i++;
  }
  endBody();

  const edits: Edit[] = [];
  for (const s of sections) {
    const oldP = s.pairOld !== undefined ? s.pairOld : (s.renameFrom ?? s.diffOld);
    const newP = s.pairNew !== undefined ? s.pairNew : (s.renameTo ?? s.diffNew);
    if (oldP === null && newP === null) throw new Exit2(`error: parse ${s.startLine}`);
    if (oldP === null || s.newFile) {
      // A creation: the new path does not exist; the file is the `+` lines.
      const p = newP!;
      const hunks = s.hunks;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const made: string[] = [];
        for (const h of hunks) for (const it of h.items) if (it.kind === 'new') made.push(it.text);
        let final = false;
        if (made.length > 0) {
          let bs = false;
          for (let k = hunks.length - 1; k >= 0; k--) {
            if (hunks[k]!.items.some((it) => it.kind === 'new')) {
              bs = hunks[k]!.bsAfterPlus;
              break;
            }
          }
          final = !bs;
        }
        tree.now.set(p, made.length === 0 ? '' : made.join('\n') + (final ? '\n' : ''));
      });
    } else if (newP === null || s.deletedFile) {
      // A deletion: the old path exists; it is deleted, its hunks not read.
      const p = oldP;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else if (oldP !== newP) {
      // A move: hunks apply to the old file's lines, written at the new path.
      const o = oldP;
      const n = newP;
      const hunks = s.hunks;
      edits.push((tree) => {
        if (!safe(o)) throw new Fail('unsafe', o);
        if (!safe(n)) throw new Fail('unsafe', n);
        const text = tree.get(o);
        if (text === null) throw new Fail('missing', o);
        if (tree.get(n) !== null) throw new Fail('exists', n);
        const out = applyHunks(text, hunks, o);
        tree.now.set(o, null);
        tree.now.set(n, out);
        tree.moves.push({ old: o, new: n });
      });
    } else {
      // A change of the one path, which exists.
      const p = oldP;
      const hunks = s.hunks;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        const text = tree.get(p);
        if (text === null) throw new Fail('missing', p);
        tree.now.set(p, applyHunks(text, hunks, p));
      });
    }
  }
  return edits;
}

/** A section's hunks, in order, each applied to the result of the ones before it. */
function applyHunks(text: string, hunks: UHunk[], path: string): string {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const O = h.items.filter((it) => it.kind !== 'new').map((it) => it.text);
    if (O.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), f.lines.length);
      const atEnd = at === f.lines.length;
      const add = h.items.filter((it) => it.kind === 'new').map((it) => it.text);
      f.lines.splice(at, 0, ...add);
      if (atEnd && add.length > 0) f.final = !h.bsAfterCtxPlus;
      d += add.length;
      continue;
    }
    const found = findOccurrence(O, f.lines, 0, false);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.positions[0]!;
    for (const p of found.positions) {
      if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    }
    const touchesEnd = pos + O.length === f.lines.length;
    const rep = buildNewLines(f.lines, pos, h.items, found.tier);
    f.lines.splice(pos, O.length, ...rep);
    if (touchesEnd) f.final = !h.bsAfterCtxPlus;
    d += rep.length - O.length;
  }
  return joinFile(f);
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE' || lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const text = tree.get(p);
      if (text === null) throw new Fail('missing', p);
      const f = splitFile(text);
      const found = findOccurrence(oldLines, f.lines, 0, false);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const repLines = buildSRNewLines(f.lines, pos, oldLines, newLines, found.tier);
      f.lines.splice(pos, oldLines.length, ...repLines);
      tree.now.set(p, joinFile(f));
    });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface VChunk {
  /** Null: no anchor. */
  anchor: string | null;
  eof: boolean;
  items: Item[];
}

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const headerRe = /^\*\*\* (Add|Delete|Update) File: (.*)$/;
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const hm = headerRe.exec(line);
    if (!hm) throw new Exit2(`error: parse ${i + 1}`);
    const kind = hm[1]!;
    const path = hm[2]!.trim();
    const headerLine = i + 1;
    i++;
    // The section's raw lines: until the next section header or *** End Patch.
    const raw: { text: string; no: number }[] = [];
    while (i < last) {
      if (headerRe.test(lines[i]!)) break;
      raw.push({ text: lines[i]!, no: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();

    if (kind === 'Add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (kind === 'Delete') {
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.no}`);
      }
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      // Update File: an optional `*** Move to:` first, then chunks.
      let moveTo: string | null = null;
      let idx = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      for (; idx < raw.length; idx++) {
        const r = raw[idx]!;
        const text = r.text;
        if (text.startsWith('@@')) {
          const anchor = text.slice(2).trim();
          curChunk = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
          chunks.push(curChunk);
          continue;
        }
        if (text.trim() === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${r.no}`);
          curChunk.eof = true;
          curChunk = null;
          continue;
        }
        if (blank(text) && curChunk === null && chunks.length > 0) {
          // A blank line after a chunk closed by `*** End of File` is part of
          // no chunk: blank lines are noise in this format (blank lines
          // between sections are ignored, and blank lines at the end of a
          // section are not part of it). A non-blank body line here still
          // fails below: only the first chunk may start at a body line.
          continue;
        }
        if (text.startsWith(' ') || text.startsWith('-') || text.startsWith('+') || text === '') {
          if (curChunk === null) {
            // Only the first chunk may start at a body line.
            if (chunks.length > 0) throw new Exit2(`error: parse ${r.no}`);
            curChunk = { anchor: null, eof: false, items: [] };
            chunks.push(curChunk);
          }
          if (text.startsWith(' ')) curChunk.items.push({ kind: 'ctx', text: text.slice(1) });
          else if (text.startsWith('-')) curChunk.items.push({ kind: 'old', text: text.slice(1) });
          else if (text.startsWith('+')) curChunk.items.push({ kind: 'new', text: text.slice(1) });
          else curChunk.items.push({ kind: 'ctx', text: '' });
          continue;
        }
        throw new Exit2(`error: parse ${r.no}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      const p = path;
      const mv = moveTo;
      const chs = chunks;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
        const text = tree.get(p);
        if (text === null) throw new Fail('missing', p);
        if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
        const f = splitFile(text);
        let cursor = 0;
        for (const chunk of chs) {
          if (chunk.anchor !== null) {
            let foundAt: number | null = null;
            const maxTier = STRICT ? 0 : 2;
            for (let tier = 0; tier <= maxTier && foundAt === null; tier++) {
              for (let k = cursor; k < f.lines.length; k++) {
                if (matchLine(chunk.anchor, f.lines[k]!, tier)) {
                  foundAt = k;
                  break;
                }
              }
            }
            if (foundAt === null) throw new Fail('no-match', p);
            cursor = foundAt + 1;
          }
          const O = chunk.items.filter((it) => it.kind !== 'new').map((it) => it.text);
          if (O.length === 0) {
            const at = chunk.eof ? f.lines.length : cursor;
            const add = chunk.items.filter((it) => it.kind === 'new').map((it) => it.text);
            f.lines.splice(at, 0, ...add);
            cursor = at + add.length;
            continue;
          }
          const found = findOccurrence(O, f.lines, cursor, chunk.eof);
          if (found === null) throw new Fail('no-match', p);
          const pos = found.positions[0]!;
          const rep = buildNewLines(f.lines, pos, chunk.items, found.tier);
          f.lines.splice(pos, O.length, ...rep);
          cursor = pos + rep.length;
        }
        const out = joinFile(f);
        if (mv !== null) {
          tree.now.set(p, null);
          tree.now.set(mv, out);
          tree.moves.push({ old: p, new: mv });
        } else {
          tree.now.set(p, out);
        }
      });
    }
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 1, 2 and 10: invocation, output and exit codes, order and atomicity.
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  STRICT = strict;
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines)
            : v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const dSet = new Set<string>();
  const aSet = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null) aSet.add(p);
    else if (now === null) dSet.add(p);
    else rows.push({ key: p, text: `M ${p}` });
  }
  const usedD = new Set<string>();
  const usedA = new Set<string>();
  tree.moves.forEach((mv, k) => {
    let dest = mv.new;
    for (let j = k + 1; j < tree.moves.length; j++) {
      if (tree.moves[j]!.old === dest) dest = tree.moves[j]!.new;
    }
    if (dSet.has(mv.old) && !usedD.has(mv.old) && aSet.has(dest) && !usedA.has(dest)) {
      usedD.add(mv.old);
      usedA.add(dest);
      rows.push({ key: dest, text: `R ${mv.old} -> ${dest}` });
    }
  });
  for (const p of dSet) if (!usedD.has(p)) rows.push({ key: p, text: `D ${p}` });
  for (const p of aSet) if (!usedA.has(p)) rows.push({ key: p, text: `A ${p}` });
  rows.sort((a, b) => byteCmp(a.key, b.key));
  if (!check) {
    // Deletions first, so a path freed by a move or a delete can be created.
    for (const p of [...dSet].sort(byteCmp)) rmSync(p, { force: true });
    const writes = [...tree.now.keys()]
      .filter((p) => {
        const was = tree.original(p);
        const now = tree.now.get(p)!;
        return now !== null && was !== now;
      })
      .sort(byteCmp);
    for (const p of writes) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, tree.now.get(p)!);
    }
  }
  const texts = rows.map((r) => r.text);
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
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
