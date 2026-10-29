import { Link } from '@tanstack/react-router';
import { usePermissions } from '../auth/useMe';

/** Home. Members get the placeholder until courses exist; admins also get shortcuts to their tools. */
export function DashboardPage() {
  const { me, has } = usePermissions();
  const shortcuts = [
    {
      to: '/members',
      label: 'Members',
      hint: 'Invite, search and manage people',
      perm: 'member.read',
    },
    {
      to: '/imports',
      label: 'Bulk import',
      hint: 'Add students or faculty from a CSV file',
      perm: 'import.run',
    },
    {
      to: '/academics',
      label: 'Academic setup',
      hint: 'Years, terms, departments, batches',
      perm: 'academic.manage',
    },
  ].filter((s) => has(s.perm));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Welcome{me ? `, ${me.user.displayName}` : ''}</h1>
      <section
        aria-label="Your courses"
        className="rounded-md border border-dashed border-border p-8 text-center"
      >
        <p className="font-medium">Your courses will appear here</p>
        <p className="mt-1 text-sm text-muted-foreground">Courses are coming soon.</p>
      </section>
      {shortcuts.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-3">
          {shortcuts.map((s) => (
            <li key={s.to}>
              <Link
                to={s.to as '/'}
                className="block rounded-md border border-border bg-surface p-4 hover:bg-muted"
              >
                <span className="font-medium">{s.label}</span>
                <span className="mt-1 block text-sm text-muted-foreground">{s.hint}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
