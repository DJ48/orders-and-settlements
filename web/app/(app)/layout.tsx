'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import type { User } from '@/lib/types';

/**
 * Shared shell for every authenticated page — a persistent sidebar rather than a top bar
 * repeated per page. Route groups don't affect the URL, so /dashboard, /orders/new, etc. are
 * unchanged; this only changes what wraps them.
 *
 * Also centralises the auth check: fetching the current user here means an expired session
 * redirects to /login before a page's own data fetch even runs, rather than only after.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    // A .then() chain, not an awaited call — setUser runs inside a callback after a real async
    // gap, so this doesn't trip the set-state-in-effect rule the way an awaited call would.
    api.me().then(setUser, (err) => {
      if (err instanceof ApiError && err.status === 401) router.push('/login');
    });
  }, [router]);

  async function handleLogout() {
    await api.logout().catch(() => {});
    router.push('/login');
  }

  const isDashboard = pathname === '/dashboard';

  return (
    <div className="flex min-h-full">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border-subtle bg-surface md:flex">
        <div className="px-6 py-6">
          <Link href="/dashboard" className="text-lg font-semibold tracking-tight">
            Orders <span className="text-accent">&amp;</span> Settlements
          </Link>
        </div>

        <nav className="flex-1 space-y-1 px-3">
          <Link
            href="/dashboard"
            className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              isDashboard
                ? 'bg-accent-soft text-accent'
                : 'text-foreground/70 hover:bg-surface-hover hover:text-foreground'
            }`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="shrink-0">
              <rect x="3" y="3" width="7" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
              <rect x="14" y="3" width="7" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
              <rect x="14" y="12" width="7" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
              <rect x="3" y="16" width="7" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
            </svg>
            Dashboard
          </Link>

          <Link
            href="/orders/new"
            className="flex items-center gap-2.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-foreground shadow-sm transition-opacity hover:opacity-90"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="shrink-0">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            New order
          </Link>
        </nav>

        <div className="border-t border-border-subtle px-3 py-4">
          <div className="flex items-center justify-between gap-2 rounded-lg px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{user?.name || user?.email || ' '}</p>
              {user?.name && <p className="truncate text-xs text-foreground/50">{user.email}</p>}
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="mt-1 w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-foreground/70 transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* This wrapper is what stacks the mobile bar above the content — without it, the bar
          and <main> were both direct children of the outer *row* flex container, so at mobile
          widths they sat side by side instead of stacked, squeezing main down to a sliver. */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile: the sidebar collapses entirely rather than a hamburger drawer — a bounded,
            honest tradeoff for a dashboard tool whose primary use is a desktop screen. */}
        <div className="flex items-center justify-between border-b border-border-subtle bg-surface px-4 py-3 md:hidden">
          <Link href="/dashboard" className="text-sm font-semibold">
            Orders &amp; Settlements
          </Link>
          <div className="flex items-center gap-3">
            <Link href="/orders/new" className="text-sm font-medium text-accent">
              New order
            </Link>
            <button onClick={handleLogout} className="text-sm text-foreground/60">
              Sign out
            </button>
          </div>
        </div>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
