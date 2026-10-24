import { pino, type DestinationStream, type Logger } from 'pino';

export const REDACTED = '[redacted]';

// Pakistani CNIC (12345-1234567-1 or 13 digits) and phone numbers (+92 300 1234567, 0300-1234567).
const CNIC = /\b\d{5}-?\d{7}-?\d\b/g;
const PHONE = /(?:\+92|0092|0)[-\s]?\(?\d{2,3}\)?[-\s]?\d{7}\b/g;

export function scrubString(text: string): string {
  return text.replace(CNIC, REDACTED).replace(PHONE, REDACTED);
}

export function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, scrub(item, depth + 1)]),
  );
}

interface RequestLike {
  method: string;
  url: string;
  ip?: string;
}

/** Log only what is needed to trace a request; headers and bodies are never logged. */
export const serializers = {
  req: (req: RequestLike) => ({ method: req.method, url: scrubString(req.url), ip: req.ip }),
  res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
};

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      serializers,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'headers.authorization',
          'headers.cookie',
          'authorization',
        ],
        censor: REDACTED,
      },
      hooks: {
        logMethod(args, method) {
          method.apply(this, args.map((arg) => scrub(arg)) as Parameters<typeof method>);
        },
      },
    },
    destination,
  );
}
