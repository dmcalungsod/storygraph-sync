#!/usr/bin/env node
// Lightweight, non-obfuscating build script for StoryGraph Sync.
// Compacts src/plugin.js -> storygraph-sync.crosspoint-plugin/plugin.js by
// stripping comments, redundant whitespace, ASI-safe line breaks, and adjacent
// same-quote string concatenations without mangling identifiers or strings.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'plugin.js');
const DEST = path.join(ROOT, 'storygraph-sync.crosspoint-plugin', 'plugin.js');
const MAX_BYTES = 262144; // CrossInk /api/plugin-fs 256 KB upload cap

const REGEX_PREV_KEYWORDS = new Set([
  'return', 'case', 'throw', 'in', 'instanceof', 'typeof', 'void',
  'delete', 'new', 'do', 'else', 'of', 'yield', 'await', 'export', 'default'
]);

const NON_ENDING_KEYWORDS = new Set([
  'const', 'let', 'var', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
  'default', 'try', 'catch', 'finally', 'function', 'async', 'await', 'return',
  'throw', 'typeof', 'void', 'delete', 'new', 'in', 'instanceof', 'of', 'yield',
  'export', 'import'
]);

const ASI_RESTRICTED_KEYWORDS = new Set([
  'return', 'throw', 'break', 'continue', 'yield'
]);

const MULTI_OPS = [
  '>>>=', '===', '!==', '>>>', '<<=', '>>=', '**=', '&&=', '||=', '??=', '...',
  '==', '!=', '<=', '>=', '&&', '||', '??', '=>', '++', '--', '**', '<<', '>>',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^='
];

const SAFE_BEFORE_FOLD = new Set([
  '(', '[', '{', ',', ';', ':', '?', '=', '+=', '=>',
  '&&', '||', '??', '==', '!=', '===', '!=='
]);

const SAFE_AFTER_FOLD = new Set([
  '+', ';', ',', ')', ']', '}', ':',
  '&&', '||', '??', '==', '!=', '===', '!=='
]);

const CONTINUATION_AFTER_BRACE_KEYWORDS = new Set([
  'else', 'catch', 'finally', 'while'
]);

const CONTINUATION_AFTER_BRACE_OPS = new Set([
  ';', ',', ')', ']', '}', '.', '?.', ':'
]);

const CONTINUATION_AFTER_STMT_OPS = new Set([
  ';', ',', ')', ']', '}', '.', '?.'
]);

function canStartRegex(lastSig) {
  if (!lastSig) return true;
  if (lastSig.type === 'tpl_head' || lastSig.type === 'tpl_mid') return true;
  if (lastSig.type === 'id') return REGEX_PREV_KEYWORDS.has(lastSig.text);
  if (lastSig.type === 'op') {
    return lastSig.text !== ')' && lastSig.text !== ']' && lastSig.text !== '++' && lastSig.text !== '--';
  }
  return false;
}

function readTemplateSegment(src, start, openText) {
  const n = src.length;
  let i = start;
  let text = openText;
  while (i < n) {
    const c = src[i];
    if (c === '\\' && i + 1 < n) {
      text += c + src[i + 1];
      i += 2;
      continue;
    }
    if (c === '$' && src[i + 1] === '{') {
      text += '${';
      i += 2;
      return { endedExpr: true, text, nextIndex: i };
    }
    text += c;
    i++;
    if (c === '`') {
      return { endedExpr: false, text, nextIndex: i };
    }
  }
  return { endedExpr: false, text, nextIndex: i };
}

function tokenize(src) {
  const norm = String(src || '').replace(/\r\n/g, '\n');
  const n = norm.length;
  const tokens = [];
  const tplStack = [];
  let i = 0;
  let lastSig = null;

  const pushTok = (tok) => {
    if (tok.type === 'nl') {
      if (tokens.length > 0 && tokens[tokens.length - 1].type !== 'nl') {
        tokens.push(tok);
      }
      return;
    }
    tokens.push(tok);
    lastSig = tok;
  };

  while (i < n) {
    const ch = norm[i];
    const next = i + 1 < n ? norm[i + 1] : '';

    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }

    if (ch === '\n') {
      pushTok({ type: 'nl' });
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && norm[i] !== '\n') i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      const start = i + 2;
      i = start;
      let hasNewline = false;
      while (i < n && !(norm[i] === '*' && norm[i + 1] === '/')) {
        if (norm[i] === '\n') hasNewline = true;
        i++;
      }
      i += 2;
      if (hasNewline) pushTok({ type: 'nl' });
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      let text = ch;
      i++;
      while (i < n) {
        const c = norm[i];
        text += c;
        i++;
        if (c === '\\' && i < n) {
          text += norm[i];
          i++;
          continue;
        }
        if (c === quote) break;
      }
      pushTok({ type: 'str', quote, text });
      continue;
    }

    if (ch === '`') {
      const seg = readTemplateSegment(norm, i + 1, '`');
      i = seg.nextIndex;
      if (seg.endedExpr) {
        tplStack.push({ braceDepth: 1 });
        pushTok({ type: 'tpl_head', text: seg.text });
      } else {
        pushTok({ type: 'tpl', text: seg.text });
      }
      continue;
    }

    if (ch === '}' && tplStack.length > 0 && tplStack[tplStack.length - 1].braceDepth === 1) {
      tplStack.pop();
      const seg = readTemplateSegment(norm, i + 1, '}');
      i = seg.nextIndex;
      if (seg.endedExpr) {
        tplStack.push({ braceDepth: 1 });
        pushTok({ type: 'tpl_mid', text: seg.text });
      } else {
        pushTok({ type: 'tpl_tail', text: seg.text });
      }
      continue;
    }

    if (ch === '/' && canStartRegex(lastSig)) {
      let text = '/';
      i++;
      let inClass = false;
      while (i < n) {
        const c = norm[i];
        text += c;
        i++;
        if (c === '\\' && i < n) {
          text += norm[i];
          i++;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
      }
      while (i < n && /[a-z]/i.test(norm[i])) {
        text += norm[i];
        i++;
      }
      pushTok({ type: 'regex', text });
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(next))) {
      let end = i;
      if (ch === '0' && (next === 'x' || next === 'X' || next === 'b' || next === 'B' || next === 'o' || next === 'O')) {
        end += 2;
        while (end < n && /[0-9a-fA-F_]/.test(norm[end])) end++;
      } else {
        while (end < n && /[0-9_]/.test(norm[end])) end++;
        if (end < n && norm[end] === '.' && end + 1 < n && /[0-9_]/.test(norm[end + 1])) {
          end++;
          while (end < n && /[0-9_]/.test(norm[end])) end++;
        } else if (end < n && norm[end] === '.' && norm[end + 1] !== '.' && !/[A-Za-z_$]/.test(norm[end + 1] || '')) {
          end++;
        }
        if (end < n && (norm[end] === 'e' || norm[end] === 'E')) {
          let eEnd = end + 1;
          if (eEnd < n && (norm[eEnd] === '+' || norm[eEnd] === '-')) eEnd++;
          if (eEnd < n && /[0-9]/.test(norm[eEnd])) {
            end = eEnd;
            while (end < n && /[0-9_]/.test(norm[end])) end++;
          }
        }
      }
      if (end < n && norm[end] === 'n') end++;
      pushTok({ type: 'id', text: norm.slice(i, end) });
      i = end;
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      let end = i + 1;
      while (end < n && /[A-Za-z0-9_$]/.test(norm[end])) end++;
      pushTok({ type: 'id', text: norm.slice(i, end) });
      i = end;
      continue;
    }

    if (ch === '?' && next === '.' && !(i + 2 < n && /[0-9]/.test(norm[i + 2]))) {
      pushTok({ type: 'op', text: '?.' });
      i += 2;
      continue;
    }

    let matchedOp = '';
    for (const op of MULTI_OPS) {
      if (norm.startsWith(op, i)) {
        matchedOp = op;
        break;
      }
    }
    if (matchedOp) {
      pushTok({ type: 'op', text: matchedOp });
      i += matchedOp.length;
      continue;
    }

    if (tplStack.length > 0) {
      if (ch === '{') tplStack[tplStack.length - 1].braceDepth++;
      else if (ch === '}') tplStack[tplStack.length - 1].braceDepth--;
    }
    pushTok({ type: 'op', text: ch });
    i++;
  }

  return tokens;
}

function isSafeBeforeFold(tok) {
  if (!tok) return true;
  if (tok.type === 'tpl_head' || tok.type === 'tpl_mid') return true;
  if (tok.type === 'op') return SAFE_BEFORE_FOLD.has(tok.text);
  if (tok.type === 'id') return tok.text === 'return' || tok.text === 'throw';
  return false;
}

function isSafeAfterFold(tok) {
  if (!tok) return true;
  if (tok.type === 'tpl_mid' || tok.type === 'tpl_tail') return true;
  if (tok.type === 'op') return SAFE_AFTER_FOLD.has(tok.text);
  return false;
}

function foldAdjacentStrings(tokens) {
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const cur = tokens[i];
    if (cur.type !== 'str') {
      out.push(cur);
      i++;
      continue;
    }

    let prevSig = null;
    for (let k = out.length - 1; k >= 0; k--) {
      if (out[k].type !== 'nl') {
        prevSig = out[k];
        break;
      }
    }

    let merged = cur;
    let j = i + 1;
    if (isSafeBeforeFold(prevSig)) {
      while (j < tokens.length) {
        let p = j;
        if (tokens[p] && tokens[p].type === 'nl') p++;
        if (!tokens[p] || tokens[p].type !== 'op' || tokens[p].text !== '+') break;
        let q = p + 1;
        if (tokens[q] && tokens[q].type === 'nl') q++;
        const rhs = tokens[q];
        if (!rhs || rhs.type !== 'str' || rhs.quote !== merged.quote) break;

        let afterSig = null;
        for (let r = q + 1; r < tokens.length; r++) {
          if (tokens[r].type !== 'nl') {
            afterSig = tokens[r];
            break;
          }
        }
        if (!isSafeAfterFold(afterSig)) break;

        merged = {
          type: 'str',
          quote: merged.quote,
          text: merged.text.slice(0, -1) + rhs.text.slice(1)
        };
        j = q + 1;
      }
    }
    out.push(merged);
    i = j;
  }
  return out;
}

function canDropNewline(prev, next) {
  if (!prev || !next) return true;
  if (prev.type === 'id' && ASI_RESTRICTED_KEYWORDS.has(prev.text)) {
    return next.type === 'op' && (next.text === ';' || next.text === '}' || next.text === ')');
  }
  if (next.type === 'op' && (next.text === '++' || next.text === '--')) {
    return false;
  }
  if (prev.type === 'op' && prev.text === '}') {
    if (next.type === 'id') return CONTINUATION_AFTER_BRACE_KEYWORDS.has(next.text);
    if (next.type === 'op') return CONTINUATION_AFTER_BRACE_OPS.has(next.text);
    return false;
  }
  if (prev.type === 'tpl_head' || prev.type === 'tpl_mid') return true;
  if (prev.type === 'id' && NON_ENDING_KEYWORDS.has(prev.text)) return true;
  if (prev.type === 'op' && prev.text !== ')' && prev.text !== ']' && prev.text !== '++' && prev.text !== '--') {
    return true;
  }
  return next.type === 'op' && CONTINUATION_AFTER_STMT_OPS.has(next.text);
}

function isWordChar(ch) {
  return Boolean(ch) && /[A-Za-z0-9_$]/.test(ch);
}

function needsSpace(prev, next) {
  if (!prev || !next) return false;
  const a = prev.text[prev.text.length - 1];
  const b = next.text[0];
  if (isWordChar(a) && isWordChar(b)) return true;
  if ((prev.text === '+' || prev.text === '++') && (next.text === '+' || next.text === '++')) return true;
  if ((prev.text === '-' || prev.text === '--') && (next.text === '-' || next.text === '--')) return true;
  if (prev.text === '/' && (next.text === '/' || next.text === '*')) return true;
  if (prev.text === '<' && next.text === '!') return true;
  if (prev.type === 'id' && /^[0-9]+$/.test(prev.text) && next.text.startsWith('.')) return true;
  if (prev.type === 'id' && next.type === 'regex') return true;
  return false;
}

function emitTokens(tokens) {
  const out = [];
  let prevSig = null;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type === 'nl') {
      let nextSig = null;
      for (let j = i + 1; j < tokens.length; j++) {
        if (tokens[j].type !== 'nl') {
          nextSig = tokens[j];
          break;
        }
      }
      if (!canDropNewline(prevSig, nextSig) && out.length > 0 && out[out.length - 1] !== '\n') {
        out.push('\n');
        prevSig = { type: 'nl', text: '\n' };
      }
      continue;
    }
    if (prevSig && prevSig.type !== 'nl' && needsSpace(prevSig, tok)) {
      out.push(' ');
    }
    out.push(tok.text);
    prevSig = tok;
  }
  return out.join('').trim();
}

export function compactSource(src) {
  const tokens = foldAdjacentStrings(tokenize(src));
  const body = emitTokens(tokens);
  const header =
    '// StoryGraph Sync — CrossPoint / CrossInk Browser Plugin (built from src/plugin.js via scripts/build.mjs)\n';
  return header + body + '\n';
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const srcText = fs.readFileSync(SRC, 'utf8');
  const built = compactSource(srcText);
  new vm.Script(built, { filename: 'plugin.js' });
  fs.writeFileSync(DEST, built, 'utf8');
  const srcBytes = Buffer.byteLength(srcText, 'utf8');
  const builtBytes = Buffer.byteLength(built, 'utf8');
  const saved = srcBytes - builtBytes;
  const margin = MAX_BYTES - builtBytes;
  console.log(
    `Built ${path.relative(ROOT, DEST)}: ${builtBytes.toLocaleString()} B (saved ${saved.toLocaleString()} B from ${srcBytes.toLocaleString()} B; margin ${margin.toLocaleString()} B under 256 KB)`
  );
  if (builtBytes > MAX_BYTES) {
    console.error(`ERROR: Built plugin.js (${builtBytes} B) exceeds CrossInk 256 KB (${MAX_BYTES} B) limit!`);
    process.exit(1);
  }
}
