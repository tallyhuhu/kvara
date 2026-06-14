import { useEffect } from "react";
import { ArrowUpRight, Bot, Building2, CalendarClock, ChevronDown, ShieldCheck, WalletCards } from "lucide-react";
import propertyHero from "../assets/property-hero.png";
import baseLogo from "../assets/brand-logos/base-mark.svg";
import metamaskLogo from "../assets/brand-logos/metamask-wordmark.svg";
import oneShotLogo from "../assets/brand-logos/oneshot-wordmark.svg";
import veniceLogo from "../assets/brand-logos/venice-wordmark.svg";

type Props = {
  onEnterApp: () => void;
};

const steps = [
  {
    eyebrow: "01 / Apartment",
    title: "Create the household",
    text: "Landlord, rent date, roommates, and Base USDC splits in one private rent room.",
    icon: Building2
  },
  {
    eyebrow: "02 / Permission",
    title: "Bounded once",
    text: "Each roommate grants a capped MetaMask Smart Accounts permission with a small adjustment buffer.",
    icon: ShieldCheck
  },
  {
    eyebrow: "03 / Agent",
    title: "Rent day runs itself",
    text: "The backend household agent waits for the due date and submits delegated payments through 1Shot.",
    icon: CalendarClock
  },
  {
    eyebrow: "04 / Changes",
    title: "Life gets recalculated",
    text: "Venice parses requests like temporary absences, proposes new splits, then the agent keeps the schedule.",
    icon: Bot
  }
];

const brands = [
  { title: "MetaMask", subtitle: "Smart Accounts Kit", logo: metamaskLogo, logoClass: "h-[46px] w-[106px]" },
  { title: "1Shot", subtitle: "Permissionless Relayer", logo: oneShotLogo, logoClass: "h-[34px] w-[106px]" },
  { title: "Venice", subtitle: "Private agent reasoning", logo: veniceLogo, logoClass: "h-[38px] w-[110px]" },
  { title: "Base", subtitle: "USDC mainnet payments", logo: baseLogo, logoClass: "h-[36px] w-[114px]" }
] as const;

export function LandingPage({ onEnterApp }: Props) {
  useEffect(() => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(".landing-reveal"));
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) entry.target.classList.add("is-visible");
        }
      },
      { threshold: 0.24 }
    );

    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, []);

  return (
    <main className="landing-shell relative isolate min-h-[100dvh] overflow-x-hidden bg-[#071a13] text-[#f7f2e8]">
      <img src={propertyHero} alt="" className="fixed inset-0 -z-20 h-full w-full object-cover" />
      <div className="fixed inset-0 -z-10 bg-[linear-gradient(90deg,rgba(5,24,17,0.95),rgba(5,24,17,0.68)_42%,rgba(5,24,17,0.2)_78%),linear-gradient(180deg,rgba(5,24,17,0.08),rgba(5,24,17,0.92))]" />

      <header className="pointer-events-none fixed inset-x-0 top-0 z-20 px-4 py-4 md:px-8">
        <div className="mx-auto flex max-w-[1520px] items-center justify-between">
          <div className="pointer-events-auto inline-flex items-center gap-2 border border-white/15 bg-[#061a13]/70 px-3 py-2 text-sm font-semibold backdrop-blur">
            <Building2 size={16} />
            Kvara
          </div>
          <button
            type="button"
            onClick={onEnterApp}
            className="pointer-events-auto inline-flex h-10 items-center gap-2 border border-white/25 bg-white/10 px-4 text-sm font-semibold text-white backdrop-blur transition hover:bg-white/20 active:translate-y-[1px]"
          >
            Open app
            <ArrowUpRight size={15} />
          </button>
        </div>
      </header>

      <section className="relative flex min-h-[100dvh] items-end px-4 pb-10 pt-24 md:px-8 md:pb-14">
        <div className="mx-auto w-full max-w-[1520px]">
          <div className="landing-reveal max-w-5xl">
            <p className="mb-5 max-w-xl text-sm font-semibold uppercase text-[#d8c7a3]">
              Shared apartments, autonomous rent
            </p>
            <h1 className="text-[18vw] font-semibold leading-[0.78] tracking-[0] sm:text-[15vw] lg:text-[9.7vw]">
              Kvara
            </h1>
            <p className="mt-7 max-w-xl text-xl leading-snug text-stone-100 md:text-2xl">
              Roommates grant bounded permissions once. The household agent handles rent when the month turns.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={onEnterApp}
                className="inline-flex h-12 items-center gap-2 bg-[#d8c7a3] px-5 text-sm font-bold uppercase text-[#061a13] transition hover:bg-[#ead8ae] active:translate-y-[1px]"
              >
                Enter autonomous rent
                <ArrowUpRight size={16} />
              </button>
              <a
                href="#how-it-works"
                className="inline-flex h-12 items-center gap-2 border border-white/25 bg-white/10 px-5 text-sm font-semibold text-white backdrop-blur transition hover:bg-white/20"
              >
                How it works
                <ChevronDown size={16} />
              </a>
            </div>
          </div>
        </div>
      </section>

      <section id="how-it-works" className="relative px-4 py-20 md:px-8 md:py-28">
        <div className="mx-auto grid max-w-[1520px] gap-10 lg:grid-cols-[0.82fr_1.18fr]">
          <div className="landing-reveal lg:sticky lg:top-28 lg:h-fit">
            <p className="text-sm font-semibold uppercase text-[#d8c7a3]">The rent ritual, redesigned</p>
            <h2 className="mt-4 max-w-xl text-5xl font-semibold leading-none md:text-7xl">
              No reminders. No pooled wallet.
            </h2>
          </div>

          <div className="space-y-5">
            {steps.map((step, index) => {
              const Icon = step.icon;
              return (
                <article
                  key={step.eyebrow}
                  className="landing-reveal step-window grid gap-5 border border-white/[0.16] bg-[#061a13]/72 p-5 backdrop-blur md:grid-cols-[80px_1fr]"
                  style={{ transitionDelay: `${index * 90}ms` }}
                >
                  <div className="grid h-14 w-14 place-items-center border border-[#d8c7a3]/55 text-[#d8c7a3]">
                    <Icon size={24} />
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase text-stone-400">{step.eyebrow}</p>
                    <h3 className="mt-2 text-3xl font-semibold leading-none text-white md:text-4xl">{step.title}</h3>
                    <p className="mt-4 max-w-2xl text-base leading-relaxed text-stone-300">{step.text}</p>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="relative px-4 py-16 md:px-8 md:py-24">
        <div className="landing-reveal mx-auto grid max-w-[1520px] gap-8 border border-white/[0.16] bg-[#061a13]/76 p-6 backdrop-blur md:grid-cols-[1fr_auto] md:items-end md:p-8">
          <div>
            <p className="text-sm font-semibold uppercase text-[#d8c7a3]">Demo apartment is waiting</p>
            <h2 className="mt-4 max-w-4xl text-5xl font-semibold leading-none md:text-7xl">
              Step into the future of rent payments.
            </h2>
          </div>
          <button
            type="button"
            onClick={onEnterApp}
            className="inline-flex h-14 w-fit items-center gap-3 bg-[#d8c7a3] px-6 text-sm font-bold uppercase text-[#061a13] transition hover:bg-[#ead8ae] active:translate-y-[1px]"
          >
            Launch rent desk
            <WalletCards size={18} />
          </button>
        </div>
      </section>

      <section className="relative px-4 pb-10 md:px-8 md:pb-14">
        <div className="landing-reveal mx-auto max-w-[1520px] border-t border-white/[0.16] pt-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {brands.map((brand) => (
              <BrandBadge key={brand.title} brand={brand} />
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}

function BrandBadge({ brand }: { brand: (typeof brands)[number] }) {
  return (
    <div className="brand-badge flex min-h-[112px] flex-col items-center justify-center border border-white/[0.14] bg-white/[0.075] px-5 py-5 text-center backdrop-blur transition hover:bg-white/[0.11]">
      <div className="flex h-12 w-full items-center justify-center">
        <img
          src={brand.logo}
          alt={`${brand.title} logo`}
          className={`${brand.logoClass} object-contain object-center`}
        />
      </div>
      <p className="mt-5 max-w-full truncate text-center text-xs font-semibold uppercase text-stone-400">
        {brand.subtitle}
      </p>
    </div>
  );
}
