import { useQuery } from '@tanstack/react-query';
import { describeHealth } from '../../shared/utils/describe-health';
import { fetchLive, fetchReady } from './health.api';

function useProbe(key: 'live' | 'ready', fetcher: typeof fetchLive) {
  const { data, error, isPending } = useQuery({
    queryKey: ['health', key],
    queryFn: fetcher,
    retry: false,
  });
  return describeHealth({
    isPending,
    failed: Boolean(error) || !data,
    ok: data?.ok,
    httpStatus: data?.status,
  });
}

export const useLiveness = () => useProbe('live', fetchLive);
export const useReadiness = () => useProbe('ready', fetchReady);
