import pino, { type DestinationStream, type Logger } from 'pino';
import { redactPlaybackUrl } from '../core/video';

const SENSITIVE_KEYS = [
  'password',
  'token',
  'secret',
  'authorization',
  'cookie',
  'access_token',
  'refresh_token',
  'api_key',
  'DATABASE_URL',
  'DATABASE_APP_URL',
  'LMS_APP_PASSWORD',
];

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((k) => `*.${k}`),
];

export function createLogger(
  env: { LOG_LEVEL: string },
  stream?: DestinationStream,
  name = 'lms-api',
): Logger {
  const options = {
    name,
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    serializers: {
      // never log headers, query strings (may carry tokens) or bodies
      req: (req: { method: string; url: string }) => ({
        method: req.method,
        // a playback URL carries its credential in the path: it is logged as /video/play/[redacted]/...
        url: redactPlaybackUrl(req.url.split('?')[0] ?? ''),
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      err: pino.stdSerializers.err,
    },
  };
  return stream ? pino(options, stream) : pino(options);
}
