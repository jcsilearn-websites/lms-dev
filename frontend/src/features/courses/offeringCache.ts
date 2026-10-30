import type { OfferingDto, OfferingPage } from '@lms/backend/contracts';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { courseKeys } from './courses.api';

type ListData = InfiniteData<OfferingPage, string | undefined>;

/**
 * Precise cache update after a change to ONE offering: the detail cache and the row in every cached list page
 * (the admin list and "my courses"). Nothing is refetched: the response of the mutation is the new row.
 */
export function putOffering(qc: QueryClient, offering: OfferingDto): void {
  qc.setQueryData(courseKeys.offering(offering.id), offering);
  qc.setQueriesData<ListData>({ queryKey: courseKeys.offerings }, (old) => {
    if (!old || !('pages' in old)) return old;
    return {
      ...old,
      pages: old.pages.map((p) => ({
        ...p,
        items: p.items.map((o) => (o.id === offering.id ? { ...o, ...offering } : o)),
      })),
    };
  });
}

/** A new offering goes to the top of the cached admin lists (they are ordered by creation, newest last: only a refresh shows it in place). */
export function offeringsChanged(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: [...courseKeys.offerings, 'list'] });
}
