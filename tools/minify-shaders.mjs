// Minifies the shader code inside a JavaScript source file, for tools/bundle.mjs.
//
// The shaders are WGSL text kept in template strings, which a JavaScript
// minifier leaves exactly as they are, comments and indentation included.
// Every template string marked with the comment /* wgsl */ in front of it is
// shortened here: comments go, and so does all white space that does not
// separate two words or two operators.  What is interpolated into the string
// with ${...} is left alone (and looked through for more shader strings).
//
// This is not a JavaScript parser, only enough of a scanner to find template
// strings without being misled by quotes, comments and regular expressions.

// Returns the source with its marked shader strings minified.  If `report`
// is given it is called with (line, text) for every template string that is
// not marked but looks like shader code.
export function minifyShaderStrings(src, report = null) {
  if (/[-]/.test(src)) throw new Error('the source uses private-use characters, which this tool needs for itself');
  return scanCode(src, 0, false, report).out;
}

const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'do', 'else', 'yield', 'await']);

// Copies JavaScript from position i on, handing template strings to
// scanTemplate.  Inside a ${...} it stops at the closing brace.
function scanCode(src, i, inTemplate, report) {
  const n = src.length;
  let out = '', marked = false, depth = 0, prev = '', word = '';
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') {
      const e = src.indexOf('\n', i), end = e < 0 ? n : e;
      out += src.slice(i, end); i = end;
      continue;
    }
    if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2), end = e < 0 ? n : e + 2, text = src.slice(i, end);
      marked = /^\/\*\s*wgsl\s*\*\/$/.test(text);
      out += text; i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1); i = j + 1; marked = false; prev = c; word = '';
      continue;
    }
    if (c === '`') {
      const t = scanTemplate(src, i, marked, report);
      out += t.out; i = t.end; marked = false; prev = c; word = '';
      continue;
    }
    if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || KEYWORDS_BEFORE_REGEX.has(word))) {
      // a regular expression: up to the closing slash that is not in a [class]
      let j = i + 1, inClass = false, ok = false;
      for (; j < n && src[j] !== '\n'; j++) {
        if (src[j] === '\\') j++;
        else if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) { ok = true; break; }
      }
      if (ok) {
        out += src.slice(i, j + 1); i = j + 1; marked = false; prev = '/'; word = '';
        continue;
      }
    }
    if (inTemplate) {
      if (c === '{') depth++;
      else if (c === '}') { if (depth === 0) return { out, end: i }; depth--; }
    }
    if (/\s/.test(c)) {
      if (/\w/.test(prev)) prev = ' ' + prev; // (a word has ended; `word` keeps it)
    } else {
      marked = false;
      word = /[\w$]/.test(c) ? (prev.length === 1 && /[\w$]/.test(prev) ? word + c : c) : '';
      prev = c;
    }
    out += c; i++;
  }
  if (inTemplate) throw new Error('a ${ without its }');
  return { out, end: n };
}

// A template string starting at position i (the backtick).
function scanTemplate(src, i, marked, report) {
  const n = src.length, texts = [], exprs = [];
  let j = i + 1, start = j;
  for (;;) {
    if (j >= n) throw new Error(`a template string without its end (it starts at line ${src.slice(0, i).split('\n').length})`);
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') { texts.push(src.slice(start, j)); j++; break; }
    if (c === '$' && src[j + 1] === '{') {
      texts.push(src.slice(start, j));
      const e = scanCode(src, j + 2, true, report);
      exprs.push(e.out);
      j = e.end + 1; start = j;
      continue;
    }
    j++;
  }
  let parts = texts.map((t, k) => (k ? '${' + exprs[k - 1] + '}' : '') + t);
  if (marked) {
    // the interpolations stand in the text as single characters while it is minified
    const min = minifyWgsl(texts.map((t, k) => (k ? String.fromCharCode(0xE000 + k - 1) : '') + t).join(''));
    parts = [...min].map((ch) => (isHole(ch) ? '${' + exprs[ch.charCodeAt(0) - 0xE000] + '}' : ch));
  } else if (report && /\bfn\s+\w+\s*\(|@(vertex|fragment|group|location)\b|\bvec[234]f\(/.test(texts.join(' ')) && texts.join('').length > 80) {
    report(src.slice(0, i).split('\n').length, texts.join('…').trim().slice(0, 60));
  }
  return { out: '`' + parts.join('') + '`', end: j };
}

const isHole = (ch) => ch >= '' && ch <= '';

// WGSL text, with interpolations as private-use characters and JavaScript's
// string escapes left as they are.
export function minifyWgsl(s) {
  // comments out (block comments nest in WGSL); an interpolation inside one goes with it
  let t = '';
  for (let i = 0; i < s.length;) {
    const c = s[i], d = s[i + 1];
    if (c === '\\') { t += s.slice(i, i + 2); i += 2; continue; }
    if (c === '/' && d === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      let depth = 1;
      i += 2;
      while (i < s.length && depth) {
        if (s[i] === '/' && s[i + 1] === '*') { depth++; i += 2; } else if (s[i] === '*' && s[i + 1] === '/') { depth--; i += 2; } else i++;
      }
      t += ' ';
      continue;
    }
    t += c; i++;
  }
  // White space stays, as one space, only where taking it out would run two
  // words or two operators together ("let x", "a - -b", "f32> ="); an
  // interpolation or an escape may turn out to be either.  A line break
  // after an interpolation stays a line break, in case what is put in there
  // ends in a comment.  And a string keeps a line break at each end that had
  // white space, because it is joined to other pieces of shader code when
  // the page runs.
  const either = (ch) => isHole(ch) || ch === '\\';
  const wordy = (ch) => /[\w.]/.test(ch) || either(ch);
  const opy = (ch) => '+-*/%&|^!=<>~'.includes(ch) || either(ch);
  const pieces = t.split(/(\s+)/); // white space at the odd positions
  let out = '';
  for (let k = 0; k < pieces.length; k++) {
    if (k % 2 === 0) { out += pieces[k]; continue; }
    const a = out[out.length - 1], b = (pieces[k + 1] || '')[0];
    if (a === undefined || b === undefined || (isHole(a) && pieces[k].includes('\n'))) out += '\n';
    else if ((wordy(a) && wordy(b)) || (opy(a) && opy(b))) out += ' ';
  }
  return out;
}
