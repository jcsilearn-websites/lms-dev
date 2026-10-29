export type Status = 'pending' | 'up' | 'down';

export function StatusRow({
  label,
  text,
  status,
}: {
  label: string;
  text: string;
  status: Status;
}) {
  return (
    <li data-testid={`health-${status}`}>
      <strong>{label}:</strong> <span>{text}</span>
    </li>
  );
}
