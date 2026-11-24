#!/usr/bin/env node
// Lightweight, non-obfuscating build script for StoryGraph Sync.
// Copies src/plugin.js -> storygraph-sync.crosspoint-plugin/plugin.js while
// stripping comments, blank lines, and leading indentation (preserving all
// strings, template literals, regex literals, identifiers, and line breaks).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'plugin.js');
const DEST = path.join(ROOT, 'storygraph-sync.crosspoint-plugin', 'plugin.js');
const MAX_BYTES = 262144; // CrossInk /api/plugin-fs 256 KB upload cap

const REGEX_PREV_KEYWORDS = new Set([
  'return', 'case', 'throw', 'in', 'instanceof', 'typeof', 'void', 'delete', 'new', 'do', 'else', 'of', 'yield', 'await'
]);

function canStartRegex(prevTok, prevWord) {
  if (!prevTok) return true;
  if ('([{:;,=!?&|+-*%^~<>'.includes(prevTok)) return true;
  if (prevTok === '\n') return true;
  if (prevWord && REGEX_PREV_KEYWORDS.has(prevWord)) return true;
  return false;
}

export function compactSource(src) {
  const normalized = String(src || '').replace(/\r\n/g, '\n');
  const out = [];
  const n = normalized.length;
  let i = 0;
  let atLineStart = true;
  let prevSigChar = '';
  let prevWord = '';
  let curWord = '';
  let inTemplateExprDepth = 0;
  const templateBraceStack = [];

  const flushWord = () => {
    if (curWord) {
      prevWord = curWord;
      curWord = '';
    }
  };

  while (i < n) {
    const ch = normalized[i];
    const next = i + 1 < n ? normalized[i + 1] : '';

    // Line start: skip leading spaces/tabs outside strings/templates
    if (atLineStart && (ch === ' ' || ch === '\t')) {
      i++;
      continue;
    }

    // Blank line skip
    if (atLineStart && ch === '\n') {
      i++;
      continue;
    }

    // Line comment
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && normalized[i] !== '\n') i++;
      if (!atLineStart) {
        while (out.length > 0 && (out[out.length - 1] === ' ' || out[out.length - 1] === '\t')) out.pop();
      }
      continue;
    }

    // Block comment
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(normalized[i] === '*' && normalized[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // Single or double quoted string
    if (ch === "'" || ch === '"') {
      flushWord();
      atLineStart = false;
      const quote = ch;
      out.push(ch);
      i++;
      while (i < n) {
        const c = normalized[i];
        out.push(c);
        i++;
        if (c === '\\' && i < n) {
          out.push(normalized[i]);
          i++;
          continue;
        }
        if (c === quote) break;
      }
      prevSigChar = quote;
      prevWord = '';
      continue;
    }

    // Template literal
    if (ch === '`') {
      flushWord();
      atLineStart = false;
      out.push(ch);
      i++;
      while (i < n) {
        const c = normalized[i];
        if (c === '\\' && i + 1 < n) {
          out.push(c, normalized[i + 1]);
          i += 2;
          continue;
        }
        if (c === '$' && normalized[i + 1] === '{') {
          out.push('${');
          i += 2;
          templateBraceStack.push(inTemplateExprDepth);
          inTemplateExprDepth = 1;
          prevSigChar = '{';
          prevWord = '';
          break;
        }
        out.push(c);
        i++;
        if (c === '`') {
          prevSigChar = '`';
          prevWord = '';
          break;
        }
      }
      continue;
    }

    // Closing brace of a template expression -> resume template literal verbatim
    if (ch === '}' && inTemplateExprDepth === 1 && templateBraceStack.length > 0) {
      flushWord();
      atLineStart = false;
      out.push('}');
      i++;
      inTemplateExprDepth = templateBraceStack.pop();
      while (i < n) {
        const c = normalized[i];
        if (c === '\\' && i + 1 < n) {
          out.push(c, normalized[i + 1]);
          i += 2;
          continue;
        }
        if (c === '$' && normalized[i + 1] === '{') {
          out.push('${');
          i += 2;
          templateBraceStack.push(inTemplateExprDepth);
          inTemplateExprDepth = 1;
          prevSigChar = '{';
          prevWord = '';
          break;
        }
        out.push(c);
        i++;
        if (c === '`') {
          prevSigChar = '`';
          prevWord = '';
          break;
        }
      }
      continue;
    }

    // Regex literal
    if (ch === '/' && canStartRegex(prevSigChar, prevWord)) {
      flushWord();
      atLineStart = false;
      out.push(ch);
      i++;
      let inClass = false;
      while (i < n) {
        const c = normalized[i];
        out.push(c);
        i++;
        if (c === '\\' && i < n) {
          out.push(normalized[i]);
          i++;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
      }
      while (i < n && /[a-z]/i.test(normalized[i])) {
        out.push(normalized[i]);
        i++;
      }
      prevSigChar = '/';
      prevWord = '';
      continue;
    }

    // Newline
    if (ch === '\n') {
      flushWord();
      while (out.length > 0 && (out[out.length - 1] === ' ' || out[out.length - 1] === '\t')) out.pop();
      if (out.length > 0 && out[out.length - 1] !== '\n') {
        out.push('\n');
      }
      atLineStart = true;
      i++;
      continue;
    }

    atLineStart = false;
    if (inTemplateExprDepth > 0) {
      if (ch === '{') inTemplateExprDepth++;
      else if (ch === '}') inTemplateExprDepth--;
    }

    if (/[A-Za-z0-9_$]/.test(ch)) {
      curWord += ch;
      prevSigChar = ch;
    } else {
      flushWord();
      if (ch !== ' ' && ch !== '\t') {
        prevSigChar = ch;
        prevWord = '';
      }
    }
    out.push(ch);
    i++;
  }

  const header =
    '// StoryGraph Sync — CrossPoint / CrossInk Browser Plugin (built from src/plugin.js via scripts/build.mjs)\n';
  return header + out.join('').trim() + '\n';
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const srcText = fs.readFileSync(SRC, 'utf8');
  const built = compactSource(srcText);
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
