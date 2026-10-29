import { text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, lms, updatedAt } from '../../db/lms-schema';

export const profileType = lms.enum('profile_type', ['student', 'faculty', 'staff']);

// One per membership (migration 0012). profile_type is a LABEL: it grants no permission.
export const memberProfiles = lms.table('member_profiles', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  membershipId: uuid('membership_id').notNull(),
  profileType: profileType('profile_type').notNull(),
  phone: text('phone'),
  designation: text('designation'),
  registerNumber: text('register_number'),
  employeeId: text('employee_id'),
  batchId: uuid('batch_id'),
  sectionId: uuid('section_id'),
  departmentId: uuid('department_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
