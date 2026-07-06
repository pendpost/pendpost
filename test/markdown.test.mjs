#!/usr/bin/env node
// test/markdown.test.mjs - the zero-dep markdown renderer (lib/markdown.mjs).
//
// Locks the documented subset (headings h1-h4, paragraphs, ul/ol, blockquotes,
// fenced code, hrs; bold/italic/code/links/images), the escape-first safety
// model (<script> is neutralized, a javascript: URL never becomes a link, a
// crafted URL cannot break out of href), the code-span protection (no emphasis
// inside backticks), and the soft-wrap rule (newline = space, blank line =
// paragraph break). Zero-dep node:assert.
import assert from 'node:assert';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };
const eq = (got, want, msg) => { assert.strictEqual(got, want, `${msg}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`); console.log(`  ok - ${msg}`); pass += 1; };

const { mdToHtml } = await import('../lib/markdown.mjs');

try {
  // ---- (1) block constructs ---------------------------------------------------
  eq(mdToHtml('# Title'), '<h1>Title</h1>', '# renders h1');
  eq(mdToHtml('## Two\n### Three\n#### Four'), '<h2>Two</h2>\n<h3>Three</h3>\n<h4>Four</h4>', '## ### #### render h2/h3/h4');
  eq(mdToHtml('##### Five'), '<p>##### Five</p>', 'five hashes is NOT a heading (subset stops at h4, no silent truncation)');
  eq(mdToHtml('- one\n- two\n* three'), '<ul>\n<li>one</li>\n<li>two</li>\n<li>three</li>\n</ul>', '- and * lines fold into one ul');
  eq(mdToHtml('1. one\n2. two'), '<ol>\n<li>one</li>\n<li>two</li>\n</ol>', 'numbered lines render an ol');
  eq(mdToHtml('> quoted\n> lines'), '<blockquote><p>quoted lines</p></blockquote>', 'consecutive > lines fold into one blockquote paragraph');
  eq(mdToHtml('---'), '<hr>', '--- renders hr');
  eq(mdToHtml('***'), '<hr>', '*** renders hr');
  eq(mdToHtml('```js\nconst x = 1 < 2;\n```'), '<pre><code>const x = 1 &lt; 2;</code></pre>', 'fenced code renders pre/code, escaped, info string dropped');
  eq(mdToHtml('```\n**not bold** [not](https://a.link)\n```'), '<pre><code>**not bold** [not](https://a.link)</code></pre>', 'no inline processing inside a fence');

  // ---- (2) inline constructs --------------------------------------------------
  eq(mdToHtml('**b**'), '<p><strong>b</strong></p>', '**bold** renders strong');
  eq(mdToHtml('*i* and _j_'), '<p><em>i</em> and <em>j</em></p>', '*italic* and _italic_ render em');
  eq(mdToHtml('`x < y`'), '<p><code>x &lt; y</code></p>', '`inline code` renders code, contents escaped');
  eq(mdToHtml('[text](https://example.com)'), '<p><a href="https://example.com">text</a></p>', 'https link renders an anchor');
  eq(mdToHtml('[text](http://example.com)'), '<p><a href="http://example.com">text</a></p>', 'http link renders an anchor');
  eq(mdToHtml('![alt text](https://example.com/i.png)'), '<p><img src="https://example.com/i.png" alt="alt text"></p>', 'https image renders img');
  eq(mdToHtml('`**x**`'), '<p><code>**x**</code></p>', 'emphasis inside backticks stays literal (code spans are lifted out first)');
  eq(mdToHtml('[go](https://ex.com/a_b_c)'), '<p><a href="https://ex.com/a_b_c">go</a></p>', 'underscores inside a URL never sprout em tags');

  // ---- (3) whitespace: soft wrap vs paragraph break ---------------------------
  eq(mdToHtml('line one\nline two'), '<p>line one line two</p>', 'a single newline inside a paragraph is a space');
  eq(mdToHtml('para one\n\npara two'), '<p>para one</p>\n<p>para two</p>', 'a blank line is a paragraph break');
  eq(mdToHtml('text\n# Head'), '<p>text</p>\n<h1>Head</h1>', 'a block start ends the paragraph even without a blank line');

  // ---- (4) escape-first safety ------------------------------------------------
  eq(mdToHtml('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>', 'a script tag is escaped, never emitted as HTML');
  const js = mdToHtml('[click](javascript:alert(1))');
  ok(!js.includes('<a') && js.includes('javascript:alert'), 'a javascript: link is NOT rendered as a link (stays plain text)');
  const img = mdToHtml('![x](file:///etc/passwd)');
  ok(!img.includes('<img') && img.includes('file:///etc/passwd'), 'a non-http image is NOT rendered as img (stays plain text)');
  const attr = mdToHtml('[x](https://a.b/"onmouseover="alert(1))');
  ok(!attr.includes('/"') && !attr.includes('="alert'), 'a quote in a URL is pre-escaped: no attribute breakout from href');
  ok(mdToHtml('<img src=x onerror=alert(1)>') === '<p>&lt;img src=x onerror=alert(1)&gt;</p>', 'inline HTML with an event handler is escaped, never live');

  // ---- (5) mixed document fixture ---------------------------------------------
  const doc = [
    '# Post title',
    '',
    'Intro with **bold**, *italic*, `code`, and a [link](https://example.com).',
    'Same paragraph after a soft wrap.',
    '',
    '## Section',
    '',
    '- first',
    '- second',
    '',
    '1. one',
    '2. two',
    '',
    '> A quote.',
    '',
    '---',
    '',
    '```',
    'const x = 1 < 2; // & stays escaped',
    '```',
    '',
    'Done.',
  ].join('\n');
  const want = [
    '<h1>Post title</h1>',
    '<p>Intro with <strong>bold</strong>, <em>italic</em>, <code>code</code>, and a <a href="https://example.com">link</a>. Same paragraph after a soft wrap.</p>',
    '<h2>Section</h2>',
    '<ul>',
    '<li>first</li>',
    '<li>second</li>',
    '</ul>',
    '<ol>',
    '<li>one</li>',
    '<li>two</li>',
    '</ol>',
    '<blockquote><p>A quote.</p></blockquote>',
    '<hr>',
    '<pre><code>const x = 1 &lt; 2; // &amp; stays escaped</code></pre>',
    '<p>Done.</p>',
  ].join('\n');
  eq(mdToHtml(doc), want, 'a mixed document renders every block in order');

  // ---- (6) purity + edges -----------------------------------------------------
  eq(mdToHtml(''), '', 'empty input renders empty output');
  eq(mdToHtml(null), '', 'null input renders empty output (no throw)');
  ok(mdToHtml(doc) === mdToHtml(doc), 'the same input always yields the same output (pure, deterministic)');
  eq(mdToHtml('```\nunclosed fence'), '<pre><code>unclosed fence</code></pre>', 'an unclosed fence runs to EOF rather than losing content');

  console.log(`[markdown] OK - documented subset round-trips, escape-first safety (script/javascript:/attr breakout neutralized), code-span protection, soft-wrap rules, mixed document, purity (${pass} assertions).`);
} catch (err) {
  console.error(`[markdown] FAIL: ${err.message}`);
  process.exitCode = 1;
}
