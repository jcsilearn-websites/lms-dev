import { uuidv7 } from 'uuidv7';

/** All primary keys are UUIDv7, generated in the app (portable: no PG18-only uuidv7()). */
export const newId = (): string => uuidv7();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID_RE.test(value);
