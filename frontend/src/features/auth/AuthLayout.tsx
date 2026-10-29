import type { ReactNode } from 'react';
import { hostKind } from '../../app/host';
import { Skeleton } from '../../shared/ui/states';
import { useTenantInfo } from '../tenant/useTenantInfo';

/** Frame of the public screens: the college name (its branding) above a card. */
export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  const info = useTenantInfo();
  const name = hostKind === 'admin' ? 'JCS iLearn platform' : info.data?.displayName;
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-4 py-8">
      <header className="text-center">
        {/* fixed height: no layout shift when the college name arrives */}
        <div className="flex min-h-7 items-center justify-center text-lg font-semibold">
          {name ?? <Skeleton className="h-6 w-48" />}
        </div>
        <h1 className="mt-2 text-2xl font-semibold">{title}</h1>
      </header>
      <section className="rounded-md border border-border bg-surface p-5">{children}</section>
    </main>
  );
}
