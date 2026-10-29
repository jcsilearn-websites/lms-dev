import type { Member, MemberListResponse } from '@lms/backend/contracts';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { memberKeys } from './members.api';

type ListData = InfiniteData<MemberListResponse, string | undefined>;
const LIST_KEY = [...memberKeys.all, 'list'] as const;

/**
 * Precise cache updates after a change to ONE member: replace that row in every cached list page and
 * in the detail cache. Nothing is refetched: the response of the mutation is the new row.
 */
export function putMember(qc: QueryClient, member: Member): void {
  qc.setQueryData(memberKeys.detail(member.userId), member);
  qc.setQueriesData<ListData>({ queryKey: LIST_KEY }, (old) =>
    old
      ? {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            items: p.items.map((m) => (m.userId === member.userId ? { ...m, ...member } : m)),
          })),
        }
      : old,
  );
}

export function dropMember(qc: QueryClient, userId: string): void {
  qc.removeQueries({ queryKey: memberKeys.detail(userId) });
  qc.removeQueries({ queryKey: memberKeys.profile(userId) });
  qc.setQueriesData<ListData>({ queryKey: LIST_KEY }, (old) =>
    old
      ? {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            items: p.items.filter((m) => m.userId !== userId),
          })),
        }
      : old,
  );
}
