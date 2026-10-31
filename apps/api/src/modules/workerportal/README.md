# workerportal

Worker self-service login (spec P1-22). An admin links a user holding the `worker` role to a worker
record; that user then reads only their own approved attendance, advances and wage lines under
`/me/worker/*`. Read-only for the worker. Public entry point: `index.ts`.
