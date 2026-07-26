#!/usr/bin/env node
// test/csv-parser.test.mjs - lib/util.mjs#parseCsvRows, the RFC-4180 CSV parser
// used by Ghost members-import (spec 30 review, MAJOR-1). The PRIOR parser was
// a naive split(',') with no quoted-field support, so a standard Ghost/
// Mailchimp/Excel member export (which quotes any field containing a comma or
// newline) was silently corrupted before being written into Ghost. This proves
// the replacement state-machine parser handles: a quoted comma, a fully-quoted
// row, an embedded newline inside a quoted field, an escaped "" -> " quote, CRLF
// line endings, blank-line/trailing-newline skipping, and that malformed input
// (an unterminated quote) degrades gracefully rather than throwing.
import assert from 'node:assert';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const { parseCsvRows } = await import('../lib/util.mjs');

try {
  // Plain unquoted CSV (regression: the pre-existing behavior must still work).
  const plain = parseCsvRows('email,name\na@x.com,Alice\nb@x.com,Bob\n');
  ok(plain.length === 2 && plain[0].email === 'a@x.com' && plain[0].name === 'Alice' && plain[1].email === 'b@x.com' && plain[1].name === 'Bob',
    `plain unquoted CSV still parses two rows - got ${JSON.stringify(plain)}`);

  // Quoted comma: a name containing a comma must stay ONE cell, not split into two.
  const quotedComma = parseCsvRows('email,name\njane@x.com,"Doe, Jane"\n');
  ok(quotedComma.length === 1 && quotedComma[0].email === 'jane@x.com' && quotedComma[0].name === 'Doe, Jane',
    `a quoted comma inside a field stays one cell (not split into a phantom column) - got ${JSON.stringify(quotedComma)}`);

  // Fully-quoted row: every field quoted, and the quotes themselves must NOT
  // leak into the value (a literal-quote email is what Ghost 422s on).
  const fullyQuoted = parseCsvRows('"email","name"\n"bob@x.com","Bob"\n');
  ok(fullyQuoted.length === 1 && fullyQuoted[0].email === 'bob@x.com' && fullyQuoted[0].name === 'Bob',
    `a fully-quoted row strips the quote characters from every cell - got ${JSON.stringify(fullyQuoted)}`);
  ok(!fullyQuoted[0].email.includes('"'), 'the quoted email carries no literal quote characters (would 422 against Ghost otherwise)');

  // Embedded newline inside a quoted field: must stay ONE row, not split into
  // a phantom extra row with a dangling/malformed remainder.
  const embeddedNewline = parseCsvRows('email,note\nsam@x.com,"line one\nline two"\nother@x.com,fine\n');
  ok(embeddedNewline.length === 2, `an embedded newline inside quotes does not create a phantom row - got ${embeddedNewline.length} rows: ${JSON.stringify(embeddedNewline)}`);
  ok(embeddedNewline[0].email === 'sam@x.com' && embeddedNewline[0].note === 'line one\nline two', `the embedded newline is preserved literally inside the note - got ${JSON.stringify(embeddedNewline[0])}`);
  ok(embeddedNewline[1].email === 'other@x.com' && embeddedNewline[1].note === 'fine', 'the row after the embedded newline parses normally');

  // Escaped quote: "" inside a quoted field -> a single literal ".
  const escapedQuote = parseCsvRows('email,name\njane@x.com,"Doe, ""Jane"" M."\n');
  ok(escapedQuote.length === 1 && escapedQuote[0].name === 'Doe, "Jane" M.',
    `an escaped "" unescapes to a single literal " - got ${JSON.stringify(escapedQuote)}`);

  // CRLF line endings (Excel exports).
  const crlf = parseCsvRows('email,name\r\na@x.com,Alice\r\nb@x.com,"Bob, Jr."\r\n');
  ok(crlf.length === 2 && crlf[0].name === 'Alice' && crlf[1].name === 'Bob, Jr.',
    `CRLF line endings parse correctly, including a quoted comma on a CRLF row - got ${JSON.stringify(crlf)}`);

  // Header case-insensitivity + whitespace trim (pre-existing behavior, kept).
  const headerCase = parseCsvRows('Email, Name \na@x.com,Alice\n');
  ok(headerCase.length === 1 && headerCase[0].email === 'a@x.com' && headerCase[0].name === 'Alice',
    `header keys are lower-cased and trimmed - got ${JSON.stringify(headerCase)}`);

  // Blank lines are skipped, a trailing newline does not produce a phantom row.
  const blankLines = parseCsvRows('email,name\n\na@x.com,Alice\n\nb@x.com,Bob\n');
  ok(blankLines.length === 2, `blank interior lines are skipped - got ${blankLines.length} rows: ${JSON.stringify(blankLines)}`);
  const noTrailingNewline = parseCsvRows('email,name\na@x.com,Alice');
  ok(noTrailingNewline.length === 1 && noTrailingNewline[0].email === 'a@x.com', 'a missing trailing newline still parses the last row');

  // Empty / whitespace-only input.
  ok(Array.isArray(parseCsvRows('')) && parseCsvRows('').length === 0, 'an empty string returns []');
  ok(Array.isArray(parseCsvRows('   \n  \n')) && parseCsvRows('   \n  \n').length === 0, 'a whitespace-only file returns []');

  // Malformed input (an unterminated quote) DEGRADES rather than throwing -
  // this is the "resilient, never crash the batch" contract members-import relies on.
  let malformedRows;
  assert.doesNotThrow(() => { malformedRows = parseCsvRows('email,note\na@x.com,"unterminated\nb@x.com,fine\n'); }, 'an unterminated quote does not throw');
  ok(Array.isArray(malformedRows) && malformedRows.length >= 1, `malformed input still returns an array of rows (degrade, not crash) - got ${JSON.stringify(malformedRows)}`);

  assert.ok(pass > 0, 'at least one assertion ran');
  console.log(`[csv-parser] OK - RFC-4180 quoted-comma/fully-quoted/embedded-newline/escaped-quote/CRLF/blank-line/malformed-degrade coverage (${pass} assertions).`);
} catch (err) {
  console.error(`[csv-parser] FAIL - ${err.message}`);
  console.error(err.stack);
  process.exitCode = 1;
}
