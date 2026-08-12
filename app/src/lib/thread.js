// thread.js - split an over-cap X text into thread parts, each within the hard
// cap. X refuses non-Premium posts over 280 chars via the API (the engine's
// TWEET_LIMIT mirrors this), so the only way to publish the WHOLE text is a
// reply chain (xReplyTo). Pure text transform: the composer materializes the
// parts as sibling posts the owner approves individually - nothing here posts.
//
// Cut preference per part, inside the cap window: paragraph break, then last
// sentence end, then last whitespace, then a hard cut (a single 280+ char token
// cannot be preserved any other way). Content is never rewritten - only cut.
export function splitTweetThread(text, cap = 280) {
  const parts = [];
  let rest = String(text || '').trim();
  while (rest.length > cap) {
    const win = rest.slice(0, cap + 1);
    let cut = -1;
    const para = win.lastIndexOf('\n\n');
    // A cut in the first third makes runt parts; prefer later break points.
    if (para > cap / 3) cut = para;
    if (cut === -1) {
      let end = -1;
      for (const m of win.matchAll(/[.!?]["')\]]?(?:\s|$)/g)) {
        if (m.index + m[0].length <= cap + 1) end = m.index + m[0].length;
      }
      if (end > cap / 3) cut = end;
    }
    if (cut === -1) {
      const ws = Math.max(win.lastIndexOf(' '), win.lastIndexOf('\n'));
      cut = ws > 0 ? ws : cap;
    }
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
