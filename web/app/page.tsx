import Link from 'next/link';

const FEATURES = [
  {
    title: 'Line items, computed for you',
    description: 'Add as many lines as an order needs — the subtotal and total are always derived server-side, never trusted from the browser.',
    icon: (
      <path d="M4 6h16M4 12h10M4 18h7" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    ),
  },
  {
    title: 'Partial payments, tracked exactly',
    description: "Record full or partial payments against any order. Over-payment is rejected before it happens, not caught afterward.",
    icon: (
      <>
        <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.75" />
        <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  },
  {
    title: 'Status that updates itself',
    description: 'Pending, partially paid, paid, or overdue — derived from payments and the due date, so it is never stale.',
    icon: (
      <path
        d="M12 8v4l3 2M12 21a9 9 0 100-18 9 9 0 000 18z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
];

export default function Home() {
  return (
    <main className="flex min-h-full flex-col">
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center px-6 py-20">
        <div className="max-w-2xl">
          <p className="mb-4 inline-flex w-fit items-center rounded-full bg-accent-soft px-3 py-1 text-xs font-medium text-accent">
            Orders &amp; Settlements
          </p>
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
            Know exactly what&apos;s <span className="text-accent">owed</span>, and what&apos;s been paid.
          </h1>
          <p className="mt-5 text-lg leading-relaxed text-foreground/60">
            Create orders with line items, record full or partial payments against them, and track
            what is still due — with status derived automatically, never guessed.
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/signup"
              className="rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground shadow-sm transition-opacity hover:opacity-90"
            >
              Create an account
            </Link>
            <Link
              href="/login"
              className="rounded-lg border border-black/15 px-5 py-2.5 text-sm font-medium transition-colors hover:bg-surface-hover dark:border-white/20"
            >
              Sign in
            </Link>
          </div>
        </div>

        <div className="mt-20 grid grid-cols-1 gap-6 sm:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-xl border border-border-subtle bg-surface p-5">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className="mb-3 text-accent">
                {f.icon}
              </svg>
              <h2 className="text-sm font-semibold">{f.title}</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-foreground/55">{f.description}</p>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
