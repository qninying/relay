// Test fixture: a worker that ignores SIGTERM, to prove the pool force-kills
// a process that won't stop instead of letting scale-down hang on it.
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
