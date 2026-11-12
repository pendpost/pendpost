import { marks as BRAND_MARKS } from './brand-marks.json';

// Platform brand marks. lucide dropped brand glyphs in 1.0, so every mark comes from
// ui/brand-marks.json, the one source pendpost.com copies too. Each is a 24x24 body drawn
// with fill=currentColor, so the theme-aware PLATFORM_META color drives it. Static data
// from this repo, never user input, so injecting it as markup is safe.
export function BrandMark({ name, size = 16, className = '', ...props }) {
  const labelled = props['aria-label'];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      role={labelled ? 'img' : undefined}
      aria-hidden={labelled ? undefined : true}
      data-brand={name}
      dangerouslySetInnerHTML={{ __html: BRAND_MARKS[name] || '' }}
      {...props}
    />
  );
}
