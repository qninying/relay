// STORY-010: the production stream names, in one place shared by the server
// and submitJobs (importing server.ts would start the server). The DLQ and
// review streams are siblings, matching workerProcess.ts's defaults.

const jobs = process.env.RELAY_STREAM_KEY ?? "relay:jobs";

export const STREAM_DEFAULTS = {
  jobs,
  group: "relay-workers",
  dlq: `${jobs}:dlq`,
  review: `${jobs}:review`,
};
