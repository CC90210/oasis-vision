'use client';

import Link from 'next/link';
import { Globe, Wifi } from 'lucide-react';

export type ConsoleView = 'world' | 'wifi';

const VIEWS: Array<{ id: ConsoleView; href: string; label: string; title: string; icon: typeof Globe }> = [
  { id: 'world', href: '/', label: 'WORLD VIEW', title: 'World View — the global intelligence map', icon: Globe },
  { id: 'wifi', href: '/wifi', label: 'OASIS WIFI', title: 'OASIS WIFI — sense motion through WiFi signals', icon: Wifi },
];

/**
 * The bar across the top of the console that moves between its two views.
 * Each is its own route, so leaving the map releases its GPU context before
 * the WiFi scene takes one, and each view can be bookmarked.
 */
export default function ViewSwitcher({ active, compact = false }: { active: ConsoleView; compact?: boolean }) {
  return (
    <nav
      aria-label="Console view"
      className="flex items-center gap-[3px] p-[3px] rounded-xl border border-[var(--border-primary)] bg-[var(--bg-panel)] backdrop-blur-2xl shadow-[0_8px_32px_rgba(0,0,0,0.55)] pointer-events-auto"
    >
      {VIEWS.map((v) => {
        const on = v.id === active;
        const Icon = v.icon;
        return (
          <Link
            key={v.id}
            href={v.href}
            title={v.title}
            aria-current={on ? 'page' : undefined}
            prefetch={false}
            className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] font-mono font-bold tracking-[0.18em] transition-colors duration-200 ${
              on
                ? 'text-[var(--gold-light)] border border-[var(--border-active)] bg-[var(--gold-primary)]/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_14px_var(--gold-glow)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-transparent'
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            <span className={compact ? 'hidden xl:inline' : ''}>{v.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
