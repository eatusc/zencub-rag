// Header and footer for the public search host, mirroring the chrome on
// zencub.com (~/code/zencub/src/components/marketing/MarketingHomeV2.tsx and
// src/components/public/PublicLayout.tsx).
//
// Every link points at the absolute zencub.com URL: this app is a different
// origin, and those routes do not exist here.

const SITE = "https://zencub.com";

const LOGO = "/brand/ZenCub_Horizontal-Straight_dark.png";

const FOOTER_LINKS = [
  { label: "About", href: `${SITE}/about` },
  { label: "Blog", href: `${SITE}/blog` },
  { label: "Pricing", href: `${SITE}/pricing` },
  { label: "Privacy", href: `${SITE}/privacy` },
  { label: "Terms", href: `${SITE}/terms` },
  { label: "Acceptable Use", href: `${SITE}/acceptable-use` },
  { label: "DMCA", href: `${SITE}/dmca` },
];

export function ZenCubHeader() {
  return (
    <nav className="flex items-center justify-between py-5 border-b border-zc-border">
      <a href={SITE} className="flex items-center no-underline" aria-label="ZenCub home">
        {/* Plain img rather than next/image: the logo is a fixed-size asset and
            this avoids depending on the image optimizer at runtime. */}
        <img src={LOGO} alt="ZenCub" width={120} height={32} style={{ height: "auto", width: 120 }} />
      </a>
      <div className="flex items-center gap-5 sm:gap-6 text-[13px]">
        <a
          href={`${SITE}/about`}
          className="hidden sm:inline text-zc-text-secondary hover:text-zc-text-primary no-underline"
        >
          About
        </a>
        <a
          href={`${SITE}/pricing`}
          className="hidden sm:inline text-zc-text-secondary hover:text-zc-text-primary no-underline"
        >
          Pricing
        </a>
        <a href={SITE} className="text-zc-gold no-underline">
          Try ZenCub &rarr;
        </a>
      </div>
    </nav>
  );
}

export function ZenCubFooter() {
  return (
    <footer className="border-t border-zc-border mt-16 pt-10 sm:pt-12 pb-8 grid sm:grid-cols-[auto_1fr] gap-6 sm:gap-12 items-end">
      <div>
        <a href={SITE} className="no-underline inline-block" aria-label="ZenCub home">
            <img src={LOGO} alt="ZenCub" width={120} height={32} style={{ height: "auto", width: 120 }} />
        </a>
        <div className="text-[12px] text-zc-text-dim mt-2">Watch it. Save it. Learn it.</div>
      </div>

      <div className="flex flex-wrap sm:justify-end gap-x-6 gap-y-2 text-[13px]">
        {FOOTER_LINKS.map((link) => (
          <a
            key={link.label}
            href={link.href}
            className="text-zc-text-secondary hover:text-zc-gold no-underline"
          >
            {link.label}
          </a>
        ))}
      </div>

      <div className="sm:col-span-2 mt-6 pt-5 border-t border-zc-border flex justify-between text-[11px] text-zc-text-dim tracking-wide">
        <span>&copy; 2026 ZenCub</span>
        <span>Made by Season Five Ventures</span>
      </div>
    </footer>
  );
}
