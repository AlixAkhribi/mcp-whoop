import {
	fetchBodyMeasurements,
	type WhoopBodyMeasurements,
} from "@/whoop/api/data/body-measurements";
import { withAuthorizedWhoopAccess } from "@/whoop/auth/tokens/authorized";
import { BODY_MEASUREMENTS_SCOPES } from "@/whoop/auth/tokens/scopes";

/** Reads the current login's WHOOP body measurements. */
export async function readBodyMeasurements({
	signal,
}: {
	signal?: AbortSignal;
} = {}): Promise<WhoopBodyMeasurements> {
	return withAuthorizedWhoopAccess(
		BODY_MEASUREMENTS_SCOPES,
		({ accessToken, signal: requestSignal }) =>
			fetchBodyMeasurements(accessToken, { signal: requestSignal }),
		{ signal },
	);
}
