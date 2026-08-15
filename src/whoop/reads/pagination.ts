type WhoopPage<T> = {
	readonly records: readonly T[];
	readonly next_token?: string | null;
};

/** Maximum pages a bounded application read will follow. */
const MAX_PAGES = 8;

/** Walks a WHOOP next-token chain until the caller has enough records. */
export async function collectPagesUntil<T>({
	readPage,
	isComplete,
}: {
	readonly readPage: (nextToken: string | undefined) => Promise<WhoopPage<T>>;
	readonly isComplete: (records: readonly T[]) => boolean;
}): Promise<T[]> {
	const records: T[] = [];
	let nextToken: string | undefined;

	for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
		const page = await readPage(nextToken);
		records.push(...page.records);

		if (isComplete(records) || !page.next_token) {
			break;
		}
		nextToken = page.next_token;
	}

	return records;
}
