import { boolean, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, lms, updatedAt } from '../../db/lms-schema';

// Global identity. RLS makes a user visible only through a membership in the current tenant,
// or as the current user (app.user_id).
export const users = lms.table('users', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
