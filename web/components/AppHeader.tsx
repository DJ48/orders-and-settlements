'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';

/**
 * Shared across every authenticated page. Before this existed, only the dashboard had a sign-out
 * control — a user on the create-order or detail page had no way to log out without navigating
 * back to the dashboard first.
 */
export function AppHeader({ children }: { children?: React.ReactNode }) {
  const router = useRouter();

  async function handleLogout() {
    await api.logout().catch(() => {});
    router.push('/login');
  }

  return (
    <div className="mb-8 flex items-center justify-between">
      <Link href="/dashboard" className="text-lg font-semibold tracking-tight">
        Orders &amp; Settlements
      </Link>
      <div className="flex items-center gap-3">
        {children}
        <button
          onClick={handleLogout}
          className="rounded-md border border-black/15 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
