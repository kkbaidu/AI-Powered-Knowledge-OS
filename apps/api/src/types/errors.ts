// Error categories from the architecture doc (section 20). A category is the
// default `code`; subclasses accept a more specific code such as
// DOCUMENT_NOT_FOUND so clients can branch on it.
export type ErrorCategory =
  | "AUTH_ERROR"
  | "PERMISSION_ERROR"
  | "VALIDATION_ERROR"
  | "RESOURCE_NOT_FOUND"
  | "BUSINESS_RULE_ERROR"
  | "AI_PROVIDER_ERROR"
  | "INTERNAL_ERROR";

export interface AppErrorOptions {
  code: string;
  message: string;
  statusCode: number;
  // Safe-to-expose structured info, e.g. field-level validation issues.
  details?: unknown;
  // false = a bug or infrastructure fault: log it, hide the message from clients.
  isOperational?: boolean;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;
  readonly isOperational: boolean;

  constructor(options: AppErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.details = options.details;
    this.isOperational = options.isOperational ?? true;
  }
}

export class AuthError extends AppError {
  constructor(message = "Authentication required", code = "AUTH_ERROR") {
    super({ code, message, statusCode: 401 });
  }
}

export class PermissionError extends AppError {
  constructor(message = "You do not have permission to do this", code = "PERMISSION_ERROR") {
    super({ code, message, statusCode: 403 });
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed", details?: unknown, code = "VALIDATION_ERROR") {
    super({ code, message, statusCode: 422, details });
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found", code = "RESOURCE_NOT_FOUND") {
    super({ code, message, statusCode: 404 });
  }
}

// The request is well-formed but violates a domain rule (duplicate email,
// cannot delete the last owner). 409 = conflict with current state.
export class BusinessRuleError extends AppError {
  constructor(message: string, code = "BUSINESS_RULE_ERROR") {
    super({ code, message, statusCode: 409 });
  }
}

export class AiProviderError extends AppError {
  constructor(message = "The AI provider is unavailable", cause?: unknown) {
    super({ code: "AI_PROVIDER_ERROR", message, statusCode: 502, cause });
  }
}

export class InternalError extends AppError {
  constructor(cause?: unknown) {
    super({
      code: "INTERNAL_ERROR",
      message: "Something went wrong",
      statusCode: 500,
      isOperational: false,
      cause,
    });
  }
}
