import { describe, it, expect } from "vitest";
import {
  AppError,
  AuthError,
  BusinessRuleError,
  InternalError,
  NotFoundError,
  PermissionError,
  ValidationError,
} from "./errors.js";

describe("AppError hierarchy", () => {
  it.each([
    [new AuthError(), 401, "AUTH_ERROR"],
    [new PermissionError(), 403, "PERMISSION_ERROR"],
    [new ValidationError(), 422, "VALIDATION_ERROR"],
    [new NotFoundError(), 404, "RESOURCE_NOT_FOUND"],
    [new BusinessRuleError("duplicate"), 409, "BUSINESS_RULE_ERROR"],
  ])("%s maps to status %i and default code %s", (err, status, code) => {
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(status);
    expect(err.code).toBe(code);
    expect(err.isOperational).toBe(true);
  });

  it("allows a specific code under a category, like DOCUMENT_NOT_FOUND", () => {
    const err = new NotFoundError("Document does not exist", "DOCUMENT_NOT_FOUND");
    expect(err.code).toBe("DOCUMENT_NOT_FOUND");
    expect(err.statusCode).toBe(404);
  });

  it("marks InternalError as non-operational and keeps the cause", () => {
    const cause = new Error("db exploded");
    const err = new InternalError(cause);
    expect(err.isOperational).toBe(false);
    expect(err.cause).toBe(cause);
  });

  it("uses the subclass name for debugging", () => {
    expect(new NotFoundError().name).toBe("NotFoundError");
  });
});
