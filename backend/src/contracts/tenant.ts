import { type Static, Type } from '@sinclair/typebox';

/** #rrggbb, stored lowercase. */
export const HEX_COLOR_PATTERN = '^#[0-9a-fA-F]{6}$';

/**
 * GET /tenant/info (PUBLIC, resolved by Host) and the response of PATCH /tenant/branding.
 * Deliberately tiny: nothing but what the sign-in page needs to look like the college. No ids, no
 * status, no other settings. A test pins the exact shape.
 */
export const TenantInfoSchema = Type.Object(
  {
    slug: Type.String(),
    displayName: Type.String(),
    primaryColor: Type.String({ pattern: HEX_COLOR_PATTERN }),
  },
  { additionalProperties: false },
);
export type TenantInfo = Static<typeof TenantInfoSchema>;

/** PATCH /tenant/branding (tenant.manage). Logos come later with file storage. */
export const UpdateBrandingRequestSchema = Type.Object(
  {
    displayName: Type.String({ minLength: 1, maxLength: 80 }),
    primaryColor: Type.String({ pattern: HEX_COLOR_PATTERN }),
  },
  { additionalProperties: false },
);
export type UpdateBrandingRequest = Static<typeof UpdateBrandingRequestSchema>;
