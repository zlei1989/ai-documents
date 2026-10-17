export type ServiceErrorCode = 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL';

export class ServiceError extends Error {
  constructor(public code: ServiceErrorCode, message: string, public context?: Record<string, unknown>) {
    super(message);
    this.name = 'ServiceError';
  }
}

export function httpStatusOf(code: ServiceErrorCode): number {
  switch (code) {
    case 'VALIDATION': return 400;
    case 'NOT_FOUND': return 404;
    case 'CONFLICT': return 409;
    default: return 500;
  }
}
