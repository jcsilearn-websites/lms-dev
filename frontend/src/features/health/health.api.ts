import type { ErrorResponse, HealthLive, HealthReady } from '@lms/backend/contracts';
import { apiGet } from '../../shared/api/client';

export const fetchLive = () => apiGet<HealthLive | ErrorResponse>('/health/live');
export const fetchReady = () => apiGet<HealthReady | ErrorResponse>('/health/ready');
