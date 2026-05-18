// src/lib/response.ts
import { AppError } from "./errors";

export interface SuccessResponse<T> {
  success: true;
  data: T;
  requestId: string;
}

export interface ErrorResponse {
  success: false;
  error: { code: string; message: string };
  requestId: string;
}

export type ApiResponse<T> = SuccessResponse<T> | ErrorResponse;

function generateRequestId(): string {
  return crypto.randomUUID();
}

export function success<T>(data: T): SuccessResponse<T> {
  return {
    success: true,
    data,
    requestId: generateRequestId(),
  };
}

export function failure(error: AppError): ErrorResponse {
  return {
    success: false,
    error: { code: error.code, message: error.message },
    requestId: generateRequestId(),
  };
}

export function handleApiError(err: unknown): Response {
  if (err instanceof AppError) {
    return Response.json(failure(err), { status: err.httpStatus });
  }

  const message = err instanceof Error ? err.message : "Unknown error";
  return Response.json(
    failure(new AppError("INTERNAL_ERROR", message, 500)),
    { status: 500 },
  );
}
