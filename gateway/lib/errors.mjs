// One error type for the whole gateway. Every refusal carries a machine-readable
// code, an HTTP status, and a human sentence that can be shown in the console
// without translation. Refusals are the interesting output of this service.

export class GatewayError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
    this.details = details ?? null;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        status: this.status,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export const badRequest = (m, d) => new GatewayError(400, 'bad_request', m, d);
export const unauthorized = (m) => new GatewayError(401, 'unauthorized', m);
export const notFound = (m, d) => new GatewayError(404, 'not_found', m, d);
export const methodNotAllowed = (m) => new GatewayError(405, 'method_not_allowed', m);
export const conflict = (code, m, d) => new GatewayError(409, code, m, d);
export const payloadTooLarge = (m) => new GatewayError(413, 'payload_too_large', m);
export const unprocessable = (m, d) => new GatewayError(422, 'invalid_payload', m, d);
export const locked = (m, d) => new GatewayError(423, 'stop_latched', m, d);
export const tooManyRequests = (m, d) => new GatewayError(429, 'rate_limited', m, d);
export const unavailable = (m, d) => new GatewayError(503, 'unavailable', m, d);

export function isGatewayError(err) {
  return err instanceof GatewayError;
}
