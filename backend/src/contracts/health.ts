import { type Static, Type } from '@sinclair/typebox';

export const HealthLiveSchema = Type.Object({ status: Type.Literal('ok') });
export type HealthLive = Static<typeof HealthLiveSchema>;

export const HealthReadySchema = Type.Object({
  status: Type.Literal('ok'),
  db: Type.Literal('up'),
});
export type HealthReady = Static<typeof HealthReadySchema>;
