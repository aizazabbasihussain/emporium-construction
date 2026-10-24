# files

Attachments behind one `FileStore` interface (spec P1-04). The driver is chosen with
`FILE_STORE_DRIVER`; each driver needs its own settings. Variable names only, never values:

| Driver     | Variables                                                                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `local`    | `FILE_STORE_LOCAL_DIR` (objects), `FILE_URL_SECRET` (16+ characters, signs links), `PUBLIC_API_URL` (optional, prefix of signed links) |
| `supabase` | `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (server only), `SUPABASE_STORAGE_BUCKET`                                                        |

A missing setting stops the API at startup with a message naming the variables.

Owning modules register the entity types whose files they own, once, at startup:

```ts
files.registerFileAccess('daily_report', async ({ actor, entityId, operation, db }) => canSee(...), {
  retainForever: false, // true for financial documents (BR-5)
});
```

The local driver serves its own signed links at `GET /files/blob?token=...`; that one route skips the
bearer-token hook (`config: { public: true }`) because the signature is its credential.
