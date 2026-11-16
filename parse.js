// marked-faster: a from-scratch Markdown renderer whose output matches
// marked 18.1.3 (default options: GFM on, line breaks off) byte for byte,
// written to run the same work with less overhead.
//
// The pipeline mirrors the classic two-phase shape: a block lexer turns
// the source into block tokens (collecting link definitions on the way),
// inline lexing is queued while blocks are scanned and drained once the
// block pass finishes, and a renderer walks the token tree emitting HTML.

/* ------------------------------------------------------------------ */
/* Small string helpers                                                */
/* ------------------------------------------------------------------ */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_ALWAYS = /[&<>"']/g;
const ESCAPE_KEEP_ENTITIES = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Escape HTML metacharacters. With `encode` set, every ampersand is
// escaped; without it, an ampersand that already introduces something
// shaped like a character reference is left alone.
function escapeHtml(text, encode) {
  if (encode) {
    return ESCAPE_ALWAYS.test(text) ? text.replace(ESCAPE_ALWAYS, ch => HTML_ESCAPES[ch]) : text;
  }
  return ESCAPE_KEEP_ENTITIES.test(text) ? text.replace(ESCAPE_KEEP_ENTITIES, ch => HTML_ESCAPES[ch]) : text;
}

const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Resolve numeric character references the way the reference renderer
// does before its (entity-preserving) escaping pass: valid code points
// become the character itself, a bare ampersand becomes "&amp;", and
// out-of-range or surrogate values become U+FFFD. Named references are
// deliberately not resolved.
function decodeNumericRefs(text) {
  if (!NUMERIC_REF.test(text)) return text;
  return text.replace(NUMERIC_REF_OR_AMP, (match, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

// Percent-encode a link destination the way the reference does: a plain
// encodeURI with "%25" folded back to "%"; an unencodable URL yields
// null, which callers render as bare link text.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Expand tabs to the next multiple-of-4 column, counting from `column`.
function expandTabs(text, column = 0) {
  if (!text.includes('\t')) return text;
  let out = '';
  let col = column;
  for (const ch of text) {
    if (ch === '\t') {
      const width = 4 - (col % 4);
      out += ' '.repeat(width);
      col += width;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Drop trailing occurrences of `ch` (or, with `invert`, trailing
// characters that are not `ch`).
function trimEndChar(text, ch, invert = false) {
  const len = text.length;
  if (len === 0) return '';
  let count = 0;
  while (count < len) {
    const c = text.charAt(len - count - 1);
    if (invert ? c !== ch : c === ch) count++;
    else break;
  }
  return count === 0 ? text : text.slice(0, len - count);
}

const BLANK_LINE = /^[ \t]*$/;

// The indented-code cleanup: when more than one trailing blank line was
// captured, cut the text back to the last content line.
function trimCodeBlock(text) {
  const lines = text.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && BLANK_LINE.test(lines[last])) last--;
  if (lines.length - last <= 2) return text;
  return lines.slice(0, last + 1).join('\n');
}

// Link labels compare after trimming, collapsing inner whitespace to
// single spaces and folding case (via a lowercase/uppercase round trip,
// which also folds a few non-ASCII cases the simple way misses).
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the closing bracket for a run starting at depth 0, honouring
// backslash escapes. Returns the index of the closer, -1 when the string
// is balanced with nothing outstanding, and -2 when it ends mid-nesting.
function findClosingBracket(text, pair) {
  if (!text.includes(pair[0]) && !text.includes(pair[1])) return -1;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === pair[0]) depth++;
    else if (text[i] === pair[1]) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Split a table row on unescaped pipes, drop the empty edge cells the
// outer pipes produce, pad or truncate to `count` cells when given, and
// unescape the pipes that were literal content.
function splitTableRow(row, count) {
  const spaced = row.replace(/\|/g, (match, offset, full) => {
    let escaped = false;
    let p = offset;
    while (--p >= 0 && full[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = spaced.split(' |');
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

/* ------------------------------------------------------------------ */
/* Grammar patterns                                                    */
/* ------------------------------------------------------------------ */

// Block-level tag names that can open an HTML block (CommonMark's list).
const TAG_NAMES = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_COMMENT = '<!--(?:-?>|[\\s\\S]*?(?:-->|$))';
const HTML_ATTR = ' +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?';
// "An HTML block may start here" prefix used by several patterns.
const HTML_BLOCK_START =
  ' {0,3}(?:</?(?:' + TAG_NAMES + ')(?: +|\\n|/?>)' +
  '|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
const HR_SOURCE = ' {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';

const RE = {
  // Block patterns, tried in order by the block lexer.
  blankLines: /^(?:[ \t]*(?:\n|$))+/,
  indentedCode: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  atxHeading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  thematicBreak: new RegExp('^' + HR_SOURCE),
  htmlBlock: new RegExp(
    '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|' +
    HTML_COMMENT + '[^\\n]*(\\n+|$)' +
    '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)' +
    '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)' +
    '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)' +
    '|</?(?:' + TAG_NAMES + ')(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)' +
    '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:' + HTML_ATTR + ')*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)' +
    '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$))', 'i'),
  listStart: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
  oneLine: /^[^\n]+/,

  // Paragraph continuation interrupts, evaluated at the start of the
  // following line against the remaining source.
  intHr: new RegExp('^' + HR_SOURCE),
  intHeading: /^ {0,3}#{1,6}(?:\s|$)/,
  intBlockquote: /^ {0,3}>/,
  intFences: /^ {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/,
  intList: /^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/,
  intHtml: new RegExp('^' + HTML_BLOCK_START),
  intBlank: /^[ \t]+\n/,
};

// The table pattern is assembled from parts: a header line, a delimiter
// row, then body lines that do not themselves open another block.
const TABLE_INTERRUPT =
  '(?! *\\n|' + HR_SOURCE +
  '| {0,3}#{1,6}(?:\\s|$)' +
  '| {0,3}>' +
  '|(?: {4}| {0,3}\t)[^\\n]' +
  '| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)' +
  '| {0,3}(?:[*+-]|1[.)])[ \\t]' +
  '|' + HTML_BLOCK_START + ')';
const TABLE_SOURCE =
  ' *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)' +
  '(?:\\n((?:' + TABLE_INTERRUPT + '.*(?:\\n|$))*)\\n*|$)';
RE.table = new RegExp('^' + TABLE_SOURCE);
RE.intTable = new RegExp('^(?:' + TABLE_SOURCE + ')');

// Setext heading: a run of text lines (none of which opens another
// block) followed by an === or --- underline.
const SETEXT_FIRST =
  '(?! {0,3}(?:[*+-]|\\d{1,9}[.)]) |(?: {4}| {0,3}\\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\\s|$)| {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n)';
const HR_SOURCE_NC = ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const SETEXT_NEXT =
  '(?!\\s*?\\n| {0,3}(?:[*+-]|\\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\\s|$)|' + HR_SOURCE_NC + '| {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n)';
RE.setextHeading = new RegExp(
  '^' + SETEXT_FIRST + '((?:.|\\n' + SETEXT_NEXT + ')+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)');

// Cheap necessary conditions that let the block driver skip the two
// most expensive patterns. Each is a strict superset of what the real
// pattern accepts: a table needs a delimiter row (only [ \-:|] chars,
// at least one '-') as its second line; a setext heading needs an
// underline line before any blank or block-opening line, and a first
// line that does not itself open a block.
const DELIM_LINE = /^[ \-:|]*$/;
function tablePossible(src) {
  const nl = src.indexOf('\n');
  if (nl === -1) return false;
  const start = nl + 1;
  const end = src.indexOf('\n', start);
  const line = end === -1 ? src.slice(start) : src.slice(start, end);
  return line.includes('-') && DELIM_LINE.test(line);
}

const SETEXT_UNDERLINE_LINE = /^ {0,3}(=+|-+)[ \t]*$/;
const BLOCK_FIRST_LINE =
  /^(?: {0,3}(?:[*+-]|\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}<[^\n>]+>$| {0,3}\|?(?:[:\- ]*\|)+[:\- ]*$| {4}| {0,3}\t)/;
const BLOCK_NEXT_LINE =
  /^(?: {0,3}(?:[*+-]|\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$| {0,3}<[^\n>]+>$| {0,3}\|?(?:[:\- ]*\|)+[:\- ]*$)/;
function setextPossible(src) {
  const nl = src.indexOf('\n');
  if (nl === -1) return false;
  if (BLOCK_FIRST_LINE.test(src.slice(0, nl))) return true; // let the real pattern decide
  let pos = nl + 1;
  while (pos < src.length) {
    const end = src.indexOf('\n', pos);
    const line = end === -1 ? src.slice(pos) : src.slice(pos, end);
    if (SETEXT_UNDERLINE_LINE.test(line)) return true;
    if (BLANK_LINE.test(line) || BLOCK_NEXT_LINE.test(line)) return false;
    if (end === -1) return false;
    pos = end + 1;
  }
  return false;
}

// Blockquote: a run of ">" lines whose content is a paragraph-like run
// (the inner pattern absorbs lazy continuation lines but stops at lines
// that open another block, including another ">" line).
const QUOTE_INNER =
  '([^\\n]+(?:\\n(?!(?:' + HR_SOURCE +
  '| {0,3}#{1,6}(?:\\s|$)' +
  '| {0,3}>' +
  '| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)' +
  '| {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)' +
  '|' + HTML_BLOCK_START +
  '|[ \\t]+\\n))[^\\n]+)*)';
RE.blockquote = new RegExp('^((?: {0,3}> ?(?:(?![ \\t]*(?:\\n|$))' + QUOTE_INNER + '|[^\\n]*)(?:\\n|$))+)');

// Link reference definition.
const DEF_LABEL = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const DEF_TITLE = '(?:"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\))';
RE.definition = new RegExp(
  '^ {0,3}\\[(' + DEF_LABEL + ')\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)' +
  '(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(' + DEF_TITLE + '))? *(?:\\n+|$)');

/* ------------------------------------------------------------------ */
/* Inline grammar patterns                                             */
/* ------------------------------------------------------------------ */

const PUNCT = '[\\p{P}\\p{S}]';
const PUNCT_NO_TILDE = '(?!~)[\\p{P}\\p{S}]';
const PUNCT_SPACE = '[\\s\\p{P}\\p{S}]';
const PUNCT_SPACE_NO_TILDE = '(?!~)[\\s\\p{P}\\p{S}]';
const NOT_PUNCT_SPACE = '[^\\s\\p{P}\\p{S}]';
const NOT_PUNCT_SPACE_OR_TILDE = '(?:[^\\s\\p{P}\\p{S}]|~)';

const INLINE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  codeSpan: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  hardBreak: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  anyPunctuation: /\\([\p{P}\p{S}])/gu,
  punctuation: /^((?![*_])[\s\p{P}\p{S}])/u,
  // Opening delimiter run for emphasis/strong: the run plus, when it can
  // open, the punctuation or non-space character that follows it.
  emStrongOpen: new RegExp(
    '^(?:\\*+(?:((?!\\*)' + PUNCT_NO_TILDE + ')|([^\\s*]))?)' +
    '|^_+(?:((?!_)' + PUNCT_NO_TILDE + ')|([^\\s_]))?', 'u'),
  // Closing-run finders for * and _; each alternative captures a run in
  // one of groups 1..6 (asterisk) or 1..5 (underscore), classified by
  // what surrounds the run.
  emStrongCloseAst: new RegExp(
    '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])' +
    '|(?!\\*)' + PUNCT_NO_TILDE + '(\\*+)(?=[\\s]|$)' +
    '|' + NOT_PUNCT_SPACE_OR_TILDE + '(\\*+)(?!\\*)(?=' + PUNCT_SPACE_NO_TILDE + '|$)' +
    '|(?!\\*)' + PUNCT_SPACE_NO_TILDE + '(\\*+)(?=' + NOT_PUNCT_SPACE_OR_TILDE + ')' +
    '|[\\s](\\*+)(?!\\*)(?=' + PUNCT_NO_TILDE + ')' +
    '|(?!\\*)' + PUNCT_NO_TILDE + '(\\*+)(?!\\*)(?=' + PUNCT_NO_TILDE + ')' +
    '|' + NOT_PUNCT_SPACE_OR_TILDE + '(\\*+)(?=' + NOT_PUNCT_SPACE_OR_TILDE + ')', 'gu'),
  emStrongCloseUnd: new RegExp(
    '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])' +
    '|(?!_)' + PUNCT + '(_+)(?=[\\s]|$)' +
    '|' + NOT_PUNCT_SPACE + '(_+)(?!_)(?=' + PUNCT_SPACE + '|$)' +
    '|(?!_)' + PUNCT_SPACE + '(_+)(?=' + NOT_PUNCT_SPACE + ')' +
    '|[\\s](_+)(?!_)(?=' + PUNCT + ')' +
    '|(?!_)' + PUNCT + '(_+)(?!_)(?=' + PUNCT + ')', 'gu'),
  delOpen: /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u,
  delClose: new RegExp(
    '^[^~]+(?=[^~])' +
    '|(?!~)' + PUNCT + '(~~?)(?=[\\s]|$)' +
    '|' + NOT_PUNCT_SPACE + '(~~?)(?!~)(?=' + PUNCT_SPACE + '|$)' +
    '|(?!~)' + PUNCT_SPACE + '(~~?)(?=' + NOT_PUNCT_SPACE + ')' +
    '|[\\s](~~?)(?!~)(?=' + PUNCT + ')' +
    '|(?!~)' + PUNCT + '(~~?)(?!~)(?=' + PUNCT + ')' +
    '|' + NOT_PUNCT_SPACE + '(~~?)(?=' + NOT_PUNCT_SPACE + ')', 'gu'),
  autolink: /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/,
  tag: new RegExp(
    '^(?:' + '<!--(?:-?>|[\\s\\S]*?-->)' +
    '|</[a-zA-Z][a-zA-Z0-9-]*\\s*>' +
    '|<[a-zA-Z][a-zA-Z0-9-]*(?:\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*"[^"]*"|\\s*=\\s*\'[^\']*\'|\\s*=\\s*[^\\s"\'=<>`]+)?)*?\\s*/?>' +
    '|<\\?[\\s\\S]*?\\?>' +
    '|<![a-zA-Z]+\\s[\\s\\S]*?>' +
    '|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>)'),
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
};

// Link labels may contain balanced bracket pairs, escapes and code spans.
const BRACKET_PAIR = '\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]';
const LINK_LABEL = '(?:\\[(?:' + BRACKET_PAIR + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
const LINK_HREF = '<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\))';
const LINK_TITLE = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\\\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)';
const REF_TEXT = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
INLINE.link = new RegExp('^!?\\[(' + LINK_LABEL + ')\\]\\([ \\t\\n]*(' + LINK_HREF + ')(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(' + LINK_TITLE + '))?[ \\t\\n]*\\)');
INLINE.reflink = new RegExp('^!?\\[(' + LINK_LABEL + ')\\]\\[(' + REF_TEXT + ')\\]');
INLINE.nolink = new RegExp('^!?\\[(' + REF_TEXT + ')\\](?:\\[\\])?');

// Patterns used by the emphasis masker: find link-ish and code spans so
// their contents can be blanked out before delimiter scanning.
const MASK_LABEL = '(?:[^\\[\\]\\\\`]*(?:\\[(?:' + BRACKET_PAIR + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?';
const MASK_REF = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}';
INLINE.reflinkSearch = new RegExp(
  '!?\\[(' + MASK_LABEL + ')\\]\\[(' + MASK_REF + ')\\]' +
  '|!?\\[(' + MASK_REF + ')\\](?:\\[\\])?(?!\\()', 'g');
INLINE.blockSkip = new RegExp(
  '\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)' +
  '|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)' +
  '|<(?! )[^<>]*?>', 'g');
INLINE.punctOutsideCode = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;

// GFM extended autolinks: bare URLs, www. links and email addresses.
const EMAIL_CORE = '[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
INLINE.url = new RegExp(
  '^(?:mailto:' + EMAIL_CORE + '|xmpp:' + EMAIL_CORE + '(?:\\/[A-Za-z0-9@.]+)?)' +
  '|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*' +
  '|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])');

// Inline plain-text run: consume up to the next construct that could
// start a token, with the GFM stops for URLs and email addresses.
INLINE.text = new RegExp(
  '^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)' +
  '|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\\n)' +
  '|(?=[a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-]+@)' +
  '|[\\s\\S]*?(?:(?=[\\\\<!\\[`*~_]|\\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\\/\\/|(?<![^\\s*_~(])www\\.|$)' +
  '|[^ ](?= {2,}\\n)' +
  '|[^a-zA-Z0-9](?=(?:mailto|xmpp):)' +
  '|[^a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-]+@))))');

/* ------------------------------------------------------------------ */
/* Emphasis masking                                                    */
/* ------------------------------------------------------------------ */

// Scan a (masked) inline string once and remember, for each of '*', '_'
// and '~', the last position where a closing delimiter run could start:
// a run whose preceding character is not whitespace.
function scanDelimiters(text) {
  const em = { '*': -1, '_': -1 };
  let del = -1;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : text[i - 1];
    let j = i + 1;
    while (j < n && text[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') del = i;
      else em[ch] = i;
    }
    i = j - 1;
  }
  return { em, del };
}

// Does this fragment contain a real link (used by the masker to decide
// which bracket pairs to blank out)? Mirrors the reference behaviour.
function linkInText(lx, text) {
  if (!text.includes('[')) return false;
  INLINE.blockSkip.lastIndex = 0;
  for (const m of text.matchAll(INLINE.blockSkip)) {
    if (INLINE.link.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  INLINE.reflinkSearch.lastIndex = 0;
  for (const m of text.matchAll(INLINE.reflinkSearch)) {
    const s = m[0];
    const open = s.lastIndexOf('[');
    const known = Object.hasOwn(lx.links, normalizeLabel(s.slice(open + 1, -1)));
    if (!(s.charAt(0) === '!' || !known) && !(open > 1 && linkInText(lx, s.slice(1, open - 1)))) return true;
  }
  return false;
}

// Produce the masked twin of an inline string: same length, but with
// link destinations, code-span contents and escaped punctuation blanked
// (to 'a' / '+' runs) so delimiter runs inside them are invisible to the
// emphasis and strikethrough matchers.
function maskInline(lx, src) {
  let out = src;
  const hasBracket = src.includes('[');
  if (Object.keys(lx.links).length > 0 && hasBracket) {
    const blankRef = match => {
      const open = match.lastIndexOf('[');
      if (!Object.hasOwn(lx.links, normalizeLabel(match.slice(open + 1, -1)))) return match;
      if (open > 1 && match.charAt(0) !== '!') {
        const inner = match.slice(1, open - 1);
        if (linkInText(lx, inner)) {
          return '[' + inner.replace(INLINE.reflinkSearch, blankRef) + '][' + 'a'.repeat(match.length - open - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match.length - 2) + ']';
    };
    out = out.replace(INLINE.reflinkSearch, blankRef);
  }
  // The punctuation masker can only match at backticks and backslashes;
  // the span masker only at '[', '`' or '<'. Skip both when inert.
  if (src.includes('`') || src.includes('\\')) {
    out = out.replace(INLINE.punctOutsideCode, (match, ticks, punct) => {
      if (punct !== undefined) return '+'.repeat(match.length);
      if (ticks !== undefined) {
        return ticks + match.slice(ticks.length, match.length - ticks.length).replace(/`/g, '+') + ticks;
      }
      return match;
    });
  }
  if (hasBracket || src.includes('`') || src.includes('<')) {
    out = out.replace(INLINE.blockSkip, (match, a, empty) => {
      const keep = empty ? empty.length : 0;
      return match.slice(0, keep) + '[' + 'a'.repeat(match.length - keep - 2) + ']';
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Block tokenizers                                                    */
/* ------------------------------------------------------------------ */

// The lexer context shared by one parse: link definitions collected so
// far, the queue of pending inline jobs, inline state flags, the "top
// level" flag (paragraphs only lex at the top or inside list items via
// their own recursion) and the delimiter-scan stack.
function newLexer() {
  return {
    links: Object.create(null),
    queue: [],
    maskStack: [],
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
  };
}

// Queue a string for inline lexing; the returned token array is filled
// in place once the block pass completes.
function queueInline(lx, src) {
  const tokens = [];
  lx.queue.push({ src, tokens });
  return tokens;
}

function indentedCodeToken(cap) {
  const raw = trimCodeBlock(cap[0]);
  return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(/^(?: {0,3}\t| {1,4})/gm, '') };
}

// Fenced code: the kit's indentation compensation — when the opening
// fence was itself indented, strip up to that much space from each line.
function fencedCodeToken(cap) {
  const raw = cap[0];
  let text = cap[3] || '';
  const indentMatch = raw.match(/^(\s+)(?:```)/);
  if (indentMatch) {
    const indent = indentMatch[1].length;
    text = text.split('\n').map(line => {
      const lead = line.match(/^\s+/);
      return lead ? line.slice(Math.min(lead[0].length, indent)) : line;
    }).join('\n');
  }
  return {
    type: 'code',
    raw,
    lang: cap[2] ? cap[2].trim().replace(INLINE.anyPunctuation, '$1') : cap[2],
    text,
  };
}

function headingToken(lx, cap) {
  let text = cap[2].trim();
  if (text.endsWith('#')) {
    const stripped = trimEndChar(text, '#');
    if (!stripped || /[ \t]$/.test(stripped)) text = stripped.trim();
  }
  return { type: 'heading', raw: trimEndChar(cap[0], '\n'), depth: cap[1].length, text, tokens: queueInline(lx, text) };
}

function htmlBlockToken(cap) {
  const raw = trimCodeBlock(cap[0]);
  return { type: 'html', block: true, raw, pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style', text: raw };
}

function definitionToken(cap) {
  if (!cap[2].startsWith('<') && findClosingBracket(cap[2], '()') !== -1) return null;
  return {
    type: 'def',
    tag: normalizeLabel(cap[1]),
    raw: trimEndChar(cap[0], '\n'),
    href: cap[2] ? cap[2].replace(/^<(.*)>$/, '$1').replace(INLINE.anyPunctuation, '$1') : '',
    title: cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(INLINE.anyPunctuation, '$1') : cap[3],
  };
}

function tableToken(lx, cap) {
  if (!/[:|]/.test(cap[2])) return null;
  const headers = splitTableRow(cap[1]);
  const alignCells = cap[2].replace(/^\||\| *$/g, '').split('|');
  if (headers.length !== alignCells.length) return null;
  const align = alignCells.map(cell =>
    /^ *-+: *$/.test(cell) ? 'right' : /^ *:-+: *$/.test(cell) ? 'center' : /^ *:-+ *$/.test(cell) ? 'left' : null);
  const token = { type: 'table', raw: trimEndChar(cap[0], '\n'), header: [], align, rows: [] };
  for (let i = 0; i < headers.length; i++) {
    token.header.push({ text: headers[i], tokens: queueInline(lx, headers[i]), header: true, align: align[i] });
  }
  const body = cap[3]?.trim() ? cap[3].replace(/\n[ \t]*$/, '').split('\n') : [];
  for (const row of body) {
    token.rows.push(splitTableRow(row, headers.length).map((cell, j) => ({
      text: cell, tokens: queueInline(lx, cell), header: false, align: align[j],
    })));
  }
  return token;
}

function setextToken(lx, cap) {
  const text = cap[1].trim();
  return {
    type: 'heading',
    raw: trimEndChar(cap[0], '\n'),
    depth: cap[2].charAt(0) === '=' ? 1 : 2,
    text,
    tokens: queueInline(lx, text),
  };
}

// Paragraphs are scanned line by line: the first line always belongs,
// each following line joins unless it opens another block (the same
// interrupt set the reference's lookahead uses).
function paragraphToken(lx, src) {
  const firstEnd = src.indexOf('\n');
  const firstLine = firstEnd === -1 ? src : src.slice(0, firstEnd);
  if (firstLine.length === 0) return null;
  let text = firstLine;
  let pos = firstLine.length;
  while (src.charCodeAt(pos) === 10) {
    const rest = src.slice(pos + 1);
    if (rest.length === 0 || rest.charCodeAt(0) === 10) break;
    if (RE.intBlank.test(rest) || RE.intHr.test(rest) || RE.intHeading.test(rest) ||
        RE.intBlockquote.test(rest) || RE.intFences.test(rest) || RE.intList.test(rest) ||
        RE.intHtml.test(rest) || (tablePossible(rest) && RE.intTable.test(rest))) break;
    const end = rest.indexOf('\n');
    const line = end === -1 ? rest : rest.slice(0, end);
    text += '\n' + line;
    pos += 1 + line.length;
  }
  const tokText = text.endsWith('\n') ? text.slice(0, -1) : text;
  return { type: 'paragraph', raw: src.slice(0, pos), text: tokText, tokens: queueInline(lx, tokText) };
}

/* ------------------------------------------------------------------ */
/* Blockquote                                                          */
/* ------------------------------------------------------------------ */

const QUOTE_MARKER = /^ {0,3}>/;
const QUOTE_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const QUOTE_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const QUOTE_STRIP = /^ {0,3}>[ \t]?/gm;

function blockquoteToken(lx, src) {
  const cap = RE.blockquote.exec(src);
  if (!cap) return null;
  let lines = trimEndChar(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    // One chunk: marked lines plus any lazy lines that precede the
    // first marker of the next chunk boundary.
    let seenMarker = false;
    const chunk = [];
    let p = 0;
    for (; p < lines.length; p++) {
      if (QUOTE_MARKER.test(lines[p])) { chunk.push(lines[p]); seenMarker = true; }
      else if (!seenMarker) chunk.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const chunkRaw = chunk.join('\n');
    const chunkText = chunkRaw
      .replace(QUOTE_MARKER_WS, (m, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(QUOTE_SETEXT, '\n    $1')
      .replace(QUOTE_STRIP, '');
    raw = raw ? raw + '\n' + chunkRaw : chunkRaw;
    text = text ? text + '\n' + chunkText : chunkText;
    const savedTop = lx.top;
    lx.top = true;
    blockLex(lx, chunkText, tokens, true);
    lx.top = savedTop;
    if (lines.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' ||
        last?.type === 'html' || last?.type === 'table') break;
    if (last?.type === 'blockquote') {
      // A nested quote that ended early: re-lex it together with the
      // remaining lines so the nesting comes out right.
      const joined = last.raw + '\n' + lines.join('\n').replace(QUOTE_STRIP, '');
      const merged = blockquoteToken(lx, joined);
      tokens[tokens.length - 1] = merged;
      const leftover = joined.substring(merged.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const kept = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (kept.length > 0) raw += '\n' + kept.join('\n');
      text = text.substring(0, text.length - last.text.length) + merged.text;
      lines = lines.slice(kept.length);
      if (lines.length > 0 && QUOTE_MARKER.test(lines[0])) continue;
      break;
    }
    if (last?.type === 'list') {
      const joined = last.raw + '\n' + lines.join('\n');
      const merged = listToken(lx, joined);
      tokens[tokens.length - 1] = merged;
      const consumed = merged.raw.length > last.raw.length
        ? joined.slice(last.raw.length + 1, merged.raw.length).split('\n').length : 0;
      if (consumed > 0) {
        const added = lines.slice(0, consumed).join('\n');
        raw += '\n' + added;
        text += '\n' + added;
      }
      lines = lines.slice(consumed);
      continue;
    }
  }
  return { type: 'blockquote', raw, tokens, text };
}

/* ------------------------------------------------------------------ */
/* Lists                                                               */
/* ------------------------------------------------------------------ */

const TASK_ITEM = /^\[[ xX]\][ \t]+\S/;
const TASK_STRIP = /^\[[ xX]\][ \t]+/;
const DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;

// "Does a line open construct X if indented by up to N" probes used
// while gathering list item contents; the reference caps the effective
// indent at 3 (argument minus one, clamped), so cache by that.
const beginCache = new Map();
function beginPattern(kind, indent) {
  const n = Math.max(0, Math.min(3, indent - 1));
  const key = kind + n;
  let re = beginCache.get(key);
  if (re) return re;
  const pre = '^ {0,' + n + '}';
  if (kind === 'bullet') re = new RegExp(pre + '(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))');
  else if (kind === 'hr') re = new RegExp(pre + '((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)');
  else if (kind === 'fences') re = new RegExp(pre + '(?:```|~~~)');
  else if (kind === 'heading') re = new RegExp(pre + '#{1,6}(?:\\s|$)');
  else if (kind === 'quote') re = new RegExp(pre + '>');
  else re = new RegExp(pre + '(?:</?(?:' + TAG_NAMES + ')(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)', 'i');
  beginCache.set(key, re);
  return re;
}

// The begin-patterns each allow up to `indent - 1` (clamped to 0..3)
// leading spaces before one fixed construct character, so the first
// non-space character of a line decides which of them can match at all.
function blockStartChar(line, maxSpaces) {
  let i = 0;
  while (i <= maxSpaces && line.charCodeAt(i) === 32) i++;
  return i > maxSpaces ? '' : line.charAt(i);
}

// Would this line open a block (and so end a list item's lazy text)?
// With `subset`, only the fences/heading/html/hr probes the reference
// applies to a previous line's content are considered.
function opensBlock(line, indent, subset) {
  const n = Math.max(0, Math.min(3, indent - 1));
  const c = blockStartChar(line, n);
  switch (c) {
    case '`': case '~': return beginPattern('fences', indent).test(line);
    case '#': return beginPattern('heading', indent).test(line);
    case '>': return !subset && beginPattern('quote', indent).test(line);
    case '<': return beginPattern('html', indent).test(line);
    case '*': case '-':
      return beginPattern('hr', indent).test(line) || (!subset && beginPattern('bullet', indent).test(line));
    case '_': return beginPattern('hr', indent).test(line);
    case '+': return !subset && beginPattern('bullet', indent).test(line);
    default:
      return !subset && c >= '0' && c <= '9' && beginPattern('bullet', indent).test(line);
  }
}

function firstLineOf(text) {
  const nl = text.indexOf('\n');
  return nl === -1 ? text : text.slice(0, nl);
}

function listToken(lx, src) {
  const first = RE.listStart.exec(src);
  if (!first) return null;
  const whole = src;
  const consumed = () => whole.length - src.length;
  const bullet = first[1].trim();
  const ordered = bullet.length > 1;
  const list = {
    type: 'list', raw: '', ordered,
    start: ordered ? +bullet.slice(0, -1) : '',
    loose: false, items: [],
  };
  const bulletPattern = ordered ? '\\d{1,9}\\' + bullet.slice(-1) : '\\' + bullet;
  const itemRe = new RegExp('^( {0,3}' + bulletPattern + ')((?:[ \\t][^\\n]*)?(?:\\n|$))');
  let looseNext = false;

  while (src) {
    let endsBlank = false;
    const cap = itemRe.exec(src);
    if (!cap || RE.thematicBreak.test(src)) break;
    const startIndex = consumed();
    src = src.substring(cap[0].length);

    const bulletLen = cap[1].length;
    let content = firstLineOf(cap[2]).replace(/^[ \t]+/, m => expandTabs(m, bulletLen));
    let nextLine = firstLineOf(src);
    let blankFirst = !content.trim();
    let indent = 0;
    let itemText = '';
    if (blankFirst) {
      indent = bulletLen + 1;
    } else {
      indent = content.search(/[^ ]/);
      indent = indent > 4 ? 1 : indent;
      itemText = content.slice(indent);
      indent += bulletLen;
    }
    if (blankFirst && BLANK_LINE.test(nextLine)) {
      src = src.substring(nextLine.length + 1);
      endsBlank = true;
    }

    if (!endsBlank) {
      while (src) {
        const rawLine = firstLineOf(src);
        nextLine = rawLine;
        const line = rawLine.replace(/^[ \t]+/, m => expandTabs(m));
        if (opensBlock(rawLine, indent, false)) break;
        if (line.search(/[^ ]/) >= indent || !rawLine.trim()) {
          itemText += '\n' + line.slice(indent);
        } else {
          // A lazy continuation line, unless the previous line's
          // content already opens a block of its own.
          const flatContent = content.includes('\t') ? content.replace(/\t/g, '    ') : content;
          if (blankFirst || flatContent.search(/[^ ]/) >= 4 || opensBlock(content, indent, true)) break;
          const isSetext = /^ {0,3}(?:=+|-+) *$/.test(rawLine) && RE.setextHeading.test(content + '\n' + rawLine);
          itemText += '\n' + (isSetext ? '    ' + line.replace(/^ {0,3}/, '') : rawLine);
        }
        blankFirst = !rawLine.trim();
        src = src.substring(rawLine.length + 1);
        content = line.slice(indent);
      }
    }

    const itemRaw = whole.slice(startIndex, consumed());
    if (!list.loose) {
      if (looseNext) list.loose = true;
      else if (DOUBLE_BLANK.test(itemRaw)) looseNext = true;
    }
    list.items.push({
      type: 'list_item', raw: itemRaw,
      task: TASK_ITEM.test(itemText), loose: false, text: itemText, tokens: [],
    });
  }

  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = whole.slice(0, consumed()).trimEnd();

  // Lex each item's contents; an item whose blocks are separated by a
  // blank line that produced a multi-line space token loosens the list.
  for (const item of list.items) {
    lx.top = false;
    item.tokens = blockLex(lx, item.text, [], false);
    if (!list.loose) {
      const spaces = item.tokens.filter(t => t.type === 'space');
      if (spaces.length > 0 && spaces.some(t => /\n.*\n/.test(t.raw))) list.loose = true;
    }
  }

  // Task list items: strip the "[ ]" / "[x]" marker from the text and
  // substitute a checkbox token.
  for (const item of list.items) {
    const firstTok = item.tokens[0];
    if (item.task && (firstTok?.type === 'text' || firstTok?.type === 'paragraph')) {
      item.text = item.text.replace(TASK_STRIP, '');
      firstTok.raw = firstTok.raw.replace(TASK_STRIP, '');
      firstTok.text = firstTok.text.replace(TASK_STRIP, '');
      for (let g = lx.queue.length - 1; g >= 0; g--) {
        if (TASK_ITEM.test(lx.queue[g].src)) {
          lx.queue[g].src = lx.queue[g].src.replace(TASK_STRIP, '');
          break;
        }
      }
      const cb = /\[[ xX]\]/.exec(item.raw);
      if (cb) {
        const checkbox = { type: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
        item.checked = checkbox.checked;
        if (list.loose) {
          if (firstTok && (firstTok.type === 'paragraph' || firstTok.type === 'text') && firstTok.tokens) {
            firstTok.raw = checkbox.raw + firstTok.raw;
            firstTok.text = checkbox.raw + firstTok.text;
            firstTok.tokens.unshift(checkbox);
          } else {
            item.tokens.unshift({ type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox] });
          }
        } else {
          item.tokens.unshift(checkbox);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }

  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const tok of item.tokens) if (tok.type === 'text') tok.type = 'paragraph';
    }
  }
  return list;
}

/* ------------------------------------------------------------------ */
/* The block lexer driver                                              */
/* ------------------------------------------------------------------ */

function blockLex(lx, src, tokens, inQuote) {
  let mergePara = inQuote;
  let lastLen = Infinity;
  while (src) {
    if (src.length < lastLen) lastLen = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    let cap;
    let tok;

    if ((cap = RE.blankLines.exec(src)) && cap[0].length > 0) {
      src = src.substring(cap[0].length);
      const last = tokens[tokens.length - 1];
      if (cap[0].length === 1 && last !== undefined) last.raw += '\n';
      else tokens.push({ type: 'space', raw: cap[0] });
      continue;
    }
    if (cap = RE.indentedCode.exec(src)) {
      src = src.substring(cap[0].length);
      tok = indentedCodeToken(cap);
      const last = tokens[tokens.length - 1];
      if (last?.type === 'paragraph' || last?.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.text;
        lx.queue[lx.queue.length - 1].src = last.text;
      } else tokens.push(tok);
      continue;
    }
    // Every remaining block pattern allows up to 3 leading spaces
    // before one fixed construct character; skip the ones the first
    // significant character rules out.
    const c0 = blockStartChar(src, 3);
    if ((c0 === '`' || c0 === '~') && (cap = RE.fences.exec(src))) {
      src = src.substring(cap[0].length);
      tokens.push(fencedCodeToken(cap));
      continue;
    }
    if (c0 === '#' && (cap = RE.atxHeading.exec(src))) {
      src = src.substring(cap[0].length);
      tokens.push(headingToken(lx, cap));
      continue;
    }
    if ((c0 === '-' || c0 === '_' || c0 === '*') && (cap = RE.thematicBreak.exec(src))) {
      src = src.substring(cap[0].length);
      tokens.push({ type: 'hr', raw: trimEndChar(cap[0], '\n') });
      continue;
    }
    if (c0 === '>' && (tok = blockquoteToken(lx, src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((c0 === '*' || c0 === '+' || c0 === '-' || (c0 >= '0' && c0 <= '9')) && (tok = listToken(lx, src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (c0 === '<' && (cap = RE.htmlBlock.exec(src))) {
      src = src.substring(cap[0].length);
      tokens.push(htmlBlockToken(cap));
      continue;
    }
    if (c0 === '[' && (cap = RE.definition.exec(src))) {
      const def = definitionToken(cap);
      if (def) {
        src = src.substring(cap[0].length);
        const last = tokens[tokens.length - 1];
        if (last?.type === 'paragraph' || last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + def.raw;
          last.text += '\n' + def.raw;
          lx.queue[lx.queue.length - 1].src = last.text;
        } else {
          if (!Object.hasOwn(lx.links, def.tag)) lx.links[def.tag] = { href: def.href, title: def.title };
          tokens.push(def);
        }
        continue;
      }
    }
    if (tablePossible(src) && (cap = RE.table.exec(src))) {
      const table = tableToken(lx, cap);
      if (table) {
        src = src.substring(cap[0].length);
        tokens.push(table);
        continue;
      }
    }
    if (setextPossible(src) && (cap = RE.setextHeading.exec(src))) {
      src = src.substring(cap[0].length);
      tokens.push(setextToken(lx, cap));
      continue;
    }
    if (lx.top && (tok = paragraphToken(lx, src))) {
      src = src.substring(tok.raw.length);
      const last = tokens[tokens.length - 1];
      if (mergePara && last?.type === 'paragraph') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.text;
        lx.queue.pop();
        lx.queue[lx.queue.length - 1].src = last.text;
      } else tokens.push(tok);
      mergePara = false;
      continue;
    }
    if (cap = RE.oneLine.exec(src)) {
      src = src.substring(cap[0].length);
      const queued = queueInline(lx, cap[0]);
      const last = tokens[tokens.length - 1];
      if (last?.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + cap[0];
        last.text += '\n' + cap[0];
        lx.queue.pop();
        lx.queue[lx.queue.length - 1].src = last.text;
      } else {
        tokens.push({ type: 'text', raw: cap[0], text: cap[0], tokens: queued });
      }
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  lx.top = true;
  return tokens;
}

/* ------------------------------------------------------------------ */
/* Inline tokenizers                                                   */
/* ------------------------------------------------------------------ */

// The "does the label hide a link or tag" probe run before a link is
// emitted: a label containing an <a> tag or an autolink that would
// swallow the closing bracket disqualifies the link.
function labelHidesLink(src, label, offset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const cap = INLINE.codeSpan.exec(label.slice(s));
      if (cap) { s += cap[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const cap = INLINE.tag.exec(src.slice(offset + s)) || INLINE.autolink.exec(src.slice(offset + s));
    if (cap) {
      if (cap[0].length > label.length - s) return true;
      s += cap[0].length - 1;
    }
  }
  return false;
}

// Build a link or image token, lexing the label immediately. If the
// label itself emitted a link, a non-image outer link is abandoned
// (links may not nest); the state juggling reproduces the reference.
function outputLink(lx, cap, link, raw) {
  const text = cap[1].replace(/\\([\[\]])/g, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const prevInLink = lx.inLink;
  const prevEmitted = lx.linkEmitted;
  const prevRawBlock = lx.inRawBlock;
  lx.inLink = true;
  lx.linkEmitted = false;
  const tokens = inlineRun(lx, text, []);
  const emitted = lx.linkEmitted;
  lx.linkEmitted = prevEmitted;
  lx.inLink = prevInLink;
  if (!isImage) {
    if (emitted) {
      lx.inRawBlock = prevRawBlock;
      return null;
    }
    lx.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href: link.href, title: link.title || null, text, tokens };
}

function linkToken(lx, src) {
  if (lx.linkParenPossible === false) return null;
  const cap = INLINE.link.exec(src);
  if (!cap) return null;
  const offset = cap[0].charAt(0) === '!' ? 2 : 1;
  if (labelHidesLink(src, cap[1], offset)) return null;
  let href = cap[2].trim();
  if (href.startsWith('<')) {
    if (!href.endsWith('>')) return null;
    const stripped = trimEndChar(href.slice(0, -1), '\\');
    if ((href.length - stripped.length) % 2 === 0) return null;
  } else {
    const paren = findClosingBracket(cap[2], '()');
    if (paren === -2) return null;
    if (paren > -1) {
      const end = (cap[0].indexOf('!') === 0 ? 5 : 4) + cap[1].length + paren;
      cap[2] = cap[2].substring(0, paren);
      cap[0] = cap[0].substring(0, end).trim();
      cap[3] = '';
    }
  }
  const backslashes = trimEndChar(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - backslashes.length) % 2 === 0) return null;
  href = cap[2].trim();
  if (href.startsWith('<')) href = href.slice(1, -1);
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  return outputLink(lx, cap, {
    href: href.replace(INLINE.anyPunctuation, '$1'),
    title: title.replace(INLINE.anyPunctuation, '$1'),
  }, cap[0]);
}

function reflinkToken(lx, src) {
  const cap = INLINE.reflink.exec(src) || INLINE.nolink.exec(src);
  if (!cap) return null;
  const offset = cap[0].charAt(0) === '!' ? 2 : 1;
  if (labelHidesLink(src, cap[1], offset)) return null;
  const link = lx.links[normalizeLabel(cap[2] || cap[1])];
  if (!link) {
    const ch = cap[0].charAt(0);
    return { type: 'text', raw: ch, text: ch };
  }
  return outputLink(lx, cap, link, cap[0]);
}

function maskCloser(lx, masked, marker) {
  const top = lx.maskStack[lx.maskStack.length - 1];
  if (top && top.src === masked) return top.scan.em[marker];
  return scanDelimiters(masked).em[marker];
}

function maskDelCloser(lx, masked) {
  const top = lx.maskStack[lx.maskStack.length - 1];
  if (top && top.src === masked) return top.scan.del;
  return scanDelimiters(masked).del;
}

function emStrongToken(lx, src, masked, prevChar) {
  const cap = INLINE.emStrongOpen.exec(src);
  if (!cap || (!cap[1] && !cap[2] && !cap[3] && !cap[4])) return null;
  const marker = cap[0].charAt(0);
  const sameMarker = prevChar === marker;
  const endIdx = masked.length - src.length;
  let runStart = endIdx;
  while (runStart > 0 && masked[runStart - 1] === marker) runStart--;
  const beforeRun = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const beforeIsPunct = beforeRun === '*' || beforeRun === '_' || INLINE.punctuation.test(beforeRun);
  let prev = prevChar;
  if (runStart < endIdx) prev = beforeRun;
  const prevIsPunct = runStart < endIdx ? beforeIsPunct : INLINE.punctuation.test(prev);
  if (cap[4] && /[\p{L}\p{N}]/u.test(prev)) return null;
  const punctAfter = cap[1] || cap[3] || '';
  if (punctAfter && prev && !prevIsPunct) return null;

  const openLen = [...cap[0]].length - 1;
  let remaining = openLen;
  let skipped = 0;
  const totalRun = endIdx - runStart + openLen;
  const canSkip = !!beforeRun.trim() && (!!punctAfter || (marker === '*' && !beforeIsPunct));
  const closerRe = marker === '*' ? INLINE.emStrongCloseAst : INLINE.emStrongCloseUnd;
  const afterOpen = endIdx + openLen;
  if (maskCloser(lx, masked, marker) < afterOpen) return null;
  const rest = masked.slice(afterOpen);
  const maxIndex = maskCloser(lx, masked, marker) - afterOpen;
  let m;
  closerRe.lastIndex = 0;
  while ((m = closerRe.exec(rest)) !== null && m.index <= maxIndex) {
    const run = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
    if (!run) continue;
    const closeLen = [...run].length;
    if (m[3] || m[4]) { remaining += closeLen; continue; }
    if (m[5] || m[6] || canSkip) {
      if (sameMarker && (m[5] || m[6])) break;
      if (totalRun % 3 && (totalRun + closeLen) % 3 === 0) { skipped += closeLen; continue; }
    }
    remaining -= closeLen;
    if (remaining > 0) continue;
    const useLen = Math.min(closeLen, closeLen + remaining + skipped);
    const firstCharLen = [...m[0]][0].length;
    const raw = src.slice(0, openLen + m.index + firstCharLen + useLen);
    if (Math.min(openLen, useLen) % 2) {
      const inner = raw.slice(1, -1);
      return { type: 'em', raw, text: inner, tokens: inlineRun(lx, inner, []) };
    }
    const inner = raw.slice(2, -2);
    return { type: 'strong', raw, text: inner, tokens: inlineRun(lx, inner, []) };
  }
  return null;
}

function delToken(lx, src, masked, prevChar) {
  const cap = INLINE.delOpen.exec(src);
  if (!cap) return null;
  if (cap[1] && prevChar && !INLINE.punctuation.test(prevChar)) return null;
  const openLen = [...cap[0]].length - 1;
  let remaining = openLen;
  const start = masked.length - src.length + openLen;
  const closer = maskDelCloser(lx, masked);
  if (closer < start) return null;
  const rest = masked.slice(start);
  const maxIndex = closer - start;
  let m;
  INLINE.delClose.lastIndex = 0;
  while ((m = INLINE.delClose.exec(rest)) !== null && m.index <= maxIndex) {
    const run = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
    if (!run) continue;
    const closeLen = [...run].length;
    if (closeLen !== openLen) continue;
    if (m[3] || m[4]) { remaining += closeLen; continue; }
    remaining -= closeLen;
    if (remaining > 0) continue;
    const useLen = Math.min(closeLen, closeLen + remaining);
    const firstCharLen = [...m[0]][0].length;
    const raw = src.slice(0, openLen + m.index + firstCharLen + useLen);
    const inner = raw.slice(openLen, raw.length - openLen);
    return { type: 'del', raw, text: inner, tokens: inlineRun(lx, inner, []) };
  }
  return null;
}

function codespanToken(src) {
  const cap = INLINE.codeSpan.exec(src);
  if (!cap) return null;
  let text = cap[2].replace(/\n/g, ' ');
  if (/[^ ]/.test(text) && text.startsWith(' ') && text.endsWith(' ')) {
    text = text.substring(1, text.length - 1);
  }
  return { type: 'codespan', raw: cap[0], text };
}

function autolinkToken(src) {
  const cap = INLINE.autolink.exec(src);
  if (!cap) return null;
  const isEmail = cap[2] === '@';
  const text = cap[1];
  return {
    type: 'link', raw: cap[0], text,
    href: isEmail ? 'mailto:' + text : text,
    autolink: true, tokens: [{ type: 'text', raw: text, text }],
  };
}

function urlToken(src) {
  const cap = INLINE.url.exec(src);
  if (!cap) return null;
  let text;
  let href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + cap[0];
  } else {
    let prev;
    do {
      prev = cap[0];
      cap[0] = INLINE.backpedal.exec(cap[0])?.[0] ?? '';
    } while (prev !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  return { type: 'link', raw: cap[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

function tagToken(lx, src) {
  const cap = INLINE.tag.exec(src);
  if (!cap) return null;
  if (!lx.inLink && /^<a /i.test(cap[0])) lx.inLink = true;
  else if (lx.inLink && /^<\/a>/i.test(cap[0])) lx.inLink = false;
  if (!lx.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(cap[0])) lx.inRawBlock = true;
  else if (lx.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(cap[0])) lx.inRawBlock = false;
  return { type: 'html', raw: cap[0], inLink: lx.inLink, inRawBlock: lx.inRawBlock, block: false, text: cap[0] };
}

function inlineTextToken(lx, src) {
  const cap = INLINE.text.exec(src);
  if (!cap) return null;
  const inRaw = lx.inRawBlock;
  return { type: 'text', raw: cap[0], text: inRaw ? cap[0] : decodeNumericRefs(cap[0]), escaped: inRaw };
}

/* ------------------------------------------------------------------ */
/* The inline lexer driver                                             */
/* ------------------------------------------------------------------ */

function inlineRun(lx, src, tokens) {
  const savedParen = lx.linkParenPossible;
  lx.linkParenPossible = savedParen && src.includes(')');
  try {
    const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
    const masked = needsMask ? maskInline(lx, src) : src;
    if (needsMask) lx.maskStack.push({ src: masked, scan: scanDelimiters(masked) });
    try {
      return inlineInner(lx, src, masked, tokens);
    } finally {
      if (needsMask) lx.maskStack.pop();
    }
  } finally {
    lx.linkParenPossible = savedParen;
  }
}

function inlineInner(lx, src, masked, tokens) {
  let prevChar = '';
  let wasText = false;
  let lastLen = Infinity;
  while (src) {
    if (src.length < lastLen) lastLen = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    if (!wasText) prevChar = '';
    wasText = false;
    let cap;
    let tok;

    if (cap = INLINE.escape.exec(src)) {
      src = src.substring(cap[0].length);
      tokens.push({ type: 'escape', raw: cap[0], text: cap[1] });
      continue;
    }
    if (tok = tagToken(lx, src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if (tok = linkToken(lx, src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if (tok = reflinkToken(lx, src)) {
      src = src.substring(tok.raw.length);
      const last = tokens[tokens.length - 1];
      if (tok.type === 'text' && last?.type === 'text') { last.raw += tok.raw; last.text += tok.text; }
      else tokens.push(tok);
      continue;
    }
    if (tok = emStrongToken(lx, src, masked, prevChar)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if (tok = codespanToken(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if (cap = INLINE.hardBreak.exec(src)) {
      src = src.substring(cap[0].length);
      tokens.push({ type: 'br', raw: cap[0] });
      continue;
    }
    if (tok = delToken(lx, src, masked, prevChar)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if (tok = autolinkToken(src)) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if (!lx.inLink && (tok = urlToken(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
    if (tok = inlineTextToken(lx, src)) {
      src = src.substring(tok.raw.length);
      if (!tok.raw.endsWith('_')) prevChar = tok.raw.slice(-1);
      wasText = true;
      const last = tokens[tokens.length - 1];
      if (last?.type === 'text') { last.raw += tok.raw; last.text += tok.text; }
      else tokens.push(tok);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  return tokens;
}

/* ------------------------------------------------------------------ */
/* Renderer                                                            */
/* ------------------------------------------------------------------ */

function renderTextToken(tok, plain) {
  if (tok.tokens) return renderInline(tok.tokens, plain);
  if (plain) return tok.text;
  return tok.escaped ? tok.text : escapeHtml(tok.text);
}

function renderCheckbox(tok) {
  return '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderInline(tokens, plain = false) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'escape': out += plain ? tok.text : escapeHtml(tok.text); break;
      case 'html': out += tok.text; break;
      case 'link': {
        if (plain) { out += renderTextToken(tok, true); break; }
        const inner = tok.autolink ? escapeHtml(tok.text, true) : renderInline(tok.tokens);
        const url = cleanUrl(tok.href);
        if (url === null) { out += inner; break; }
        out += '<a href="' + escapeHtml(url, tok.autolink) + '"';
        if (tok.title) out += ' title="' + escapeHtml(tok.title) + '"';
        out += '>' + inner + '</a>';
        break;
      }
      case 'image': {
        const alt = tok.tokens ? renderInline(tok.tokens, true) : tok.text;
        if (plain) { out += alt; break; }
        const url = cleanUrl(tok.href);
        if (url === null) { out += escapeHtml(alt); break; }
        out += '<img src="' + escapeHtml(url) + '" alt="' + escapeHtml(alt) + '"';
        if (tok.title) out += ' title="' + escapeHtml(tok.title) + '"';
        out += '>';
        break;
      }
      case 'checkbox': out += plain ? tok.raw : renderCheckbox(tok); break;
      case 'strong': out += plain ? renderInline(tok.tokens, true) : '<strong>' + renderInline(tok.tokens) + '</strong>'; break;
      case 'em': out += plain ? renderInline(tok.tokens, true) : '<em>' + renderInline(tok.tokens) + '</em>'; break;
      case 'del': out += plain ? renderInline(tok.tokens, true) : '<del>' + renderInline(tok.tokens) + '</del>'; break;
      case 'codespan': out += plain ? tok.text : '<code>' + escapeHtml(tok.text, true) + '</code>'; break;
      case 'br': out += plain ? '' : '<br>'; break;
      case 'text': out += renderTextToken(tok, plain); break;
      default: throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  return (cell.align ? '<' + tag + ' align="' + cell.align + '">' : '<' + tag + '>') +
    renderInline(cell.tokens) + '</' + tag + '>\n';
}

function renderBlocks(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
      case 'def':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += '<h' + tok.depth + '>' + renderInline(tok.tokens) + '</h' + tok.depth + '>\n';
        break;
      case 'code': {
        const lang = (tok.lang || '').match(/^\S*/)?.[0];
        const body = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
        const escaped = escapeHtml(body, true);
        out += lang
          ? '<pre><code class="language-' + escapeHtml(lang) + '">' + escaped + '</code></pre>\n'
          : '<pre><code>' + escaped + '</code></pre>\n';
        break;
      }
      case 'table': {
        let head = '';
        for (const cell of tok.header) head += renderTableCell(cell);
        let body = '';
        for (const row of tok.rows) {
          let cells = '';
          for (const cell of row) cells += renderTableCell(cell);
          body += '<tr>\n' + cells + '</tr>\n';
        }
        if (body) body = '<tbody>' + body + '</tbody>';
        out += '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n' + body + '</table>\n';
        break;
      }
      case 'blockquote':
        out += '<blockquote>\n' + renderBlocks(tok.tokens) + '</blockquote>\n';
        break;
      case 'list': {
        let items = '';
        for (const item of tok.items) items += '<li>' + renderBlocks(item.tokens) + '</li>\n';
        const tag = tok.ordered ? 'ol' : 'ul';
        const start = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
        out += '<' + tag + start + '>\n' + items + '</' + tag + '>\n';
        break;
      }
      case 'checkbox':
        out += renderCheckbox(tok);
        break;
      case 'html':
        out += tok.text;
        break;
      case 'paragraph':
        out += '<p>' + renderInline(tok.tokens) + '</p>\n';
        break;
      case 'text':
        out += renderTextToken(tok, false);
        break;
      default:
        throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/** Render a Markdown document to HTML, matching marked 18.1.3 defaults. */
export function parse(markdown) {
  const lx = newLexer();
  const src = markdown.replace(/\r\n|\r/g, '\n');
  const tokens = [];
  blockLex(lx, src, tokens, false);
  for (let i = 0; i < lx.queue.length; i++) {
    const job = lx.queue[i];
    lx.inRawBlock = false;
    inlineRun(lx, job.src, job.tokens);
  }
  lx.queue.length = 0;
  return renderBlocks(tokens);
}
