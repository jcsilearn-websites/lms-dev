import { StatusRow } from '../../shared/ui/StatusRow';
import { useLiveness, useReadiness } from './useHealth';

export function HealthPanel() {
  const live = useLiveness();
  const ready = useReadiness();
  return (
    <>
      <h2>API health</h2>
      <ul>
        <StatusRow label="Liveness" text={live.text} status={live.status} />
        <StatusRow label="Readiness" text={ready.text} status={ready.status} />
      </ul>
    </>
  );
}
