# pendpost.com structured data — Merchant-listings fix

> Hand-off note for the private `pendpost/site` repo (`web/`). Nothing in this
> OSS app repo emits structured data; the change described here is applied to the
> marketing site, not here.

## The problem

Google Search Console flagged pendpost.com with 4 "Merchant listings" issues:

- **Missing field `image`** (critical — blocks the rich result)
- Invalid object type for field `brand`
- Missing `hasMerchantReturnPolicy` (in `offers`)
- Missing `shippingDetails` (in `offers`)

These all come from marking the page up as a `Product` with `offers`. pendpost is
free, open-source, local-first software, so Google reads that as a shopping /
merchant listing and then demands shipping and return policies that don't exist
for a $0 download.

## The fix

Use the correct schema.org type — **`SoftwareApplication`** — instead of
`Product`. It isn't a `Product`, so the three non-critical warnings disappear by
construction; the only thing left to supply is a real `image`.

Replace the current `Product` JSON-LD in the page `<head>` with:

```json
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "pendpost",
  "description": "Free, open-source, local-first social media planner with an AI agent behind a human approval gate.",
  "url": "https://pendpost.com",
  "image": "<existing pendpost.com OG/social image URL — absolute, must 200>",
  "applicationCategory": "BusinessApplication",
  "operatingSystem": "macOS, Windows, Linux",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" }
}
```

This is minimal but rich-result-eligible: `offers` satisfies Google's "one of
offers / aggregateRating / review" requirement for the Software App result.

Notes:

- Replace the current `Product` block one-for-one — don't keep both.
- `image` is the only critical fix. Point it at the OG/social image the site
  already ships (absolute URL that returns 200).
- `hasMerchantReturnPolicy`, `shippingDetails`, and `brand` are intentionally
  dropped — they don't apply to a `SoftwareApplication`.

## Verify

1. Google **Rich Results Test** (`search.google.com/test/rich-results`) on the
   live URL → no Merchant-listings errors, valid parse.
2. **Validate Fix** in Search Console's Merchant listings report once deployed.
