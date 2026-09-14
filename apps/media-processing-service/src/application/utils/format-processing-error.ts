export interface FormattedProcessingError {
  message: string;
  stack?: string;
}

const MAX_PROCESS_STDERR_DETAIL_LENGTH = 8_000;

function formatErrorMessage(message: string, error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return message;
  }

  const stderr = (error as Record<string, unknown>)['stderr'];

  if (typeof stderr !== 'string' || stderr.trim() === '') {
    return message;
  }

  const normalizedStderr = stderr.trim();
  const stderrDetail =
    normalizedStderr.length > MAX_PROCESS_STDERR_DETAIL_LENGTH
      ? `[last ${MAX_PROCESS_STDERR_DETAIL_LENGTH} characters of process stderr]\n${normalizedStderr.slice(-MAX_PROCESS_STDERR_DETAIL_LENGTH)}`
      : normalizedStderr;

  return `${message}\nprocess stderr:\n${stderrDetail}`;
}

export function formatProcessingError(
  error: unknown,
): FormattedProcessingError {
  if (error instanceof Error) {
    return {
      message: formatErrorMessage(error.message, error),
      stack: error.stack,
    };
  }

  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;

    const message =
      typeof record['message'] === 'string'
        ? record['message']
        : JSON.stringify(error);

    const stack =
      typeof record['stack'] === 'string' ? record['stack'] : undefined;

    return { message: formatErrorMessage(message, error), stack };
  }

  return {
    message: String(error),
  };
}
