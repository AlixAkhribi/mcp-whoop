/** A caller deliberately stopped work that was still in progress. */
export class OperationCancelledError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OperationCancelledError";
	}
}

/** Whether an error represents caller cancellation rather than a failure. */
export function isCancellation(
	error: unknown,
): error is OperationCancelledError {
	return error instanceof OperationCancelledError;
}
