// markdown.mjs - minimal markdown -> HTML for the blog publish lanes (wordpress/ghost).
//
// Blog posts are authored as markdown (that is what the composer and every agent
// naturally write), but the blog platforms want HTML bodies. This renderer is a
// deliberately HONEST SUBSET, not a CommonMark engine - a dependency-free file we
// can fully reason about beats a 10k-line parser sitting on the publish path:
//
//   Block:  # ## ### #### headings, paragraphs, unordered lists (- or *),
//           ordered lists (1.), blockquotes (>), fenced code blocks (```),
//           horizontal rules (--- / ***).
//   Inline: **bold**, *italic* / _italic_, `code`, [text](url) links and
//           ![alt](url) images - http(s) URLs ONLY; any other scheme
//           (javascript:, data:, file:, ...) stays plain text.
//
// NOT supported, on purpose: nested lists, tables, inline HTML, reference-style
// links, setext headings. A post that needs more can be pasted as HTML on the
// platform side; keeping the subset small is what keeps it auditable.
//
// Safety model: the ENTIRE input is HTML-escaped FIRST (& < > "), and only then
// are markdown constructs applied, so no author-supplied HTML - <script> tags,
// event-handler attributes, anything - survives into the output. The same escape
// pre-encodes URL text for attribute position (" is already &quot;), so a crafted
// URL cannot break out of href/src. One consequence worth knowing: block parsing
// runs on the escaped text, which is why the blockquote marker below is `&gt;`,
// not `>` (and why a literal "&gt;" typed by the author cannot collide - its &
// escaped to &amp; first).
//
// Whitespace: a single newline inside a paragraph is a soft wrap (a space); a
// blank line is a paragraph break. Pure and deterministic - no disk, no network,
// no env reads.

const escapeHtml = (s) => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// Only http(s) may become a live link/image; every other scheme renders as the
// literal markdown text so a javascript:/data: payload is inert by construction.
const isHttpUrl = (url) => /^https?:\/\//i.test(url);

// Emphasis only - factored out so link LABELS get bold/italic too, while the
// already-rendered <a>/<img> tags (whose URLs may contain _ or *) never do.
const emphasize = (s) => s
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\*([^*]+)\*/g, '<em>$1</em>')
  .replace(/_([^_]+)_/g, '<em>$1</em>');

// Inline pass. `code` spans, images, and links are lifted out into NUL-delimited
// placeholders BEFORE the emphasis pass, for two reasons: a `**x**` inside
// backticks must stay literal, and a URL containing _ or * must not sprout <em>
// tags mid-href. The normalizer in mdToHtml strips real NULs from the input, so
// the placeholder channel cannot be forged by an author.
function renderInline(text) {
  const tokens = [];
  const stash = (html) => { tokens.push(html); return `\u0000${tokens.length - 1}\u0000`; };
  let s = text.replace(/`([^`]+)`/g, (_m, code) => stash(`<code>${code}</code>`));
  // Images before links: the two patterns differ only by the leading `!`.
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => (isHttpUrl(url) ? stash(`<img src="${url}" alt="${alt}">`) : m));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => (isHttpUrl(url) ? stash(`<a href="${url}">${emphasize(label)}</a>`) : m));
  s = emphasize(s);
  return s.replace(/\u0000(\d+)\u0000/g, (_m, n) => tokens[Number(n)]);
}

// Block-start predicates, all run against ESCAPED lines (see the header note).
// The (?!#) keeps ##### (five or more) out of the heading rule so it falls
// through to a paragraph instead of silently truncating to h4.
const RE_HEADING = /^(#{1,4})(?!#)\s+(.+)$/;
const RE_HR = /^(?:-{3,}|\*{3,})\s*$/;
const RE_UL = /^[-*]\s+(.+)$/;
const RE_OL = /^\d+\.\s+(.+)$/;
const RE_QUOTE = /^&gt;\s?(.*)$/;
const RE_FENCE = /^```/;

const startsBlock = (line) => RE_HEADING.test(line) || RE_HR.test(line) || RE_UL.test(line)
  || RE_OL.test(line) || RE_QUOTE.test(line) || RE_FENCE.test(line);

export function mdToHtml(md) {
  // Normalize: CRLF/CR -> LF, and strip NUL so the inline placeholder channel is
  // ours alone. Then escape EVERYTHING before any parsing - the whole safety
  // model hangs on this ordering.
  const src = escapeHtml(String(md ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, ''));
  const lines = src.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i += 1; continue; }

    if (RE_FENCE.test(line)) {
      // Fenced code: contents are emitted verbatim (already escaped), with no
      // inline processing. The info string after ``` is dropped. An unclosed
      // fence runs to EOF - swallowing the rest beats silently losing content.
      const body = [];
      i += 1;
      while (i < lines.length && !RE_FENCE.test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1; // step past the closing fence (or past EOF)
      out.push(`<pre><code>${body.join('\n')}</code></pre>`);
      continue;
    }

    const h = line.match(RE_HEADING);
    if (h) {
      out.push(`<h${h[1].length}>${renderInline(h[2].trim())}</h${h[1].length}>`);
      i += 1;
      continue;
    }

    // hr before list: `---` must not read as an empty `-` item (it cannot match
    // RE_UL anyway, which demands content after the marker, but order documents
    // the intent).
    if (RE_HR.test(line)) { out.push('<hr>'); i += 1; continue; }

    if (RE_QUOTE.test(line)) {
      // Consecutive > lines fold into ONE quote paragraph (soft-wrap semantics
      // inside the quote; no nested quotes - documented subset).
      const parts = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        const rest = lines[i].match(RE_QUOTE)[1].trim();
        if (rest !== '') parts.push(rest);
        i += 1;
      }
      out.push(`<blockquote><p>${renderInline(parts.join(' '))}</p></blockquote>`);
      continue;
    }

    if (RE_UL.test(line) || RE_OL.test(line)) {
      const ordered = RE_OL.test(line);
      const re = ordered ? RE_OL : RE_UL;
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>`);
      while (i < lines.length && re.test(lines[i])) {
        out.push(`<li>${renderInline(lines[i].match(re)[1].trim())}</li>`);
        i += 1;
      }
      out.push(`</${tag}>`);
      continue;
    }

    // Paragraph: soak up lines until a blank line or the start of another block;
    // single newlines inside are soft wraps, so they join with a space.
    const para = [];
    while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines[i])) {
      para.push(lines[i].trim());
      i += 1;
    }
    out.push(`<p>${renderInline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}
