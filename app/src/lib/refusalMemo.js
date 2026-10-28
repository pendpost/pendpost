// A refused approve stays told on its card until the post itself changes. The approvals queue
// refetches every few seconds and the engine writes bookkeeping onto a post (verify reads,
// failure stamps), which changes its rev and can remount the card; the refusal used to vanish
// with it and Approve turned green again, inviting a click that cannot succeed.
//
// So a BLOCKING refusal is remembered per post (client + campaign + id) together with a
// signature of the post's publishable content. It is shown again for as long as that content
// is unchanged, and forgotten the moment the owner edits the post (the next Approve is then a
// fresh try). Module scope on purpose: it outlives a card remount, and a page reload starts clean.
const memo = new Map();

// The fields that decide whether an approve can pass: what is published and where.
const CONTENT_FIELDS = [
  'type', 'platforms', 'caption', 'title', 'description', 'body', 'link', 'image', 'imageUrl', 'altText',
  'xCaption', 'mastodonCaption', 'nostrCaption', 'tgCaption', 'dcCaption', 'ttCaption', 'redditText',
  'pinTitle', 'pinDescription', 'liDescription', 'spoilerText', 'mediaItems',
];

export function contentSignature(post) {
  if (!post) return '';
  const picked = CONTENT_FIELDS.map((k) => post[k] ?? null);
  picked.push(post.media?.path ?? null);
  return JSON.stringify(picked);
}

export const refusalKey = (post) => `${post?.clientId || ''}/${post?.campaign}/${post?.id}`;

export function readRefusal(key, signature) {
  const hit = memo.get(key);
  return hit && hit.signature === signature ? hit.alert : null;
}

export function rememberRefusal(key, signature, alert) {
  if (alert && alert.blocking) memo.set(key, { signature, alert });
  else memo.delete(key);
}

// Forget everything (tests start clean).
export function clearRefusals() { memo.clear(); }
