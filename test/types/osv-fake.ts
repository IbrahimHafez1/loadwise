/** The part of fetch's Response the OSV client reads. */
export interface FakeOsvResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** One entry of an OSV querybatch request body. */
export interface OsvBatchQuery {
  package: { name: string; ecosystem: string };
  version: string;
  page_token?: string;
}

export function asResponse(fake: FakeOsvResponse): Response {
  // The fake implements only the members the OSV client reads, not the whole DOM Response.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- the fake implements only part of Response
  return fake as Response;
}

/** A request the fake OSV server received; `body` is the parsed JSON of a querybatch POST. */
export interface FakeOsvCall {
  url: string;
  body?: { queries: OsvBatchQuery[] };
}
