# Tax test pack sign-off

Spec P2-10 BR-4. The accountant supplies at least 10 sample documents with the tax and withholding they expect (`docs/cutover/tax-samples.json`). `apps/api/src/acceptance/tax-pack.test.ts` runs every sample through the engine; every sample must match. Then the accountant signs here.

| Field        | Value                                                                                  |
| ------------ | -------------------------------------------------------------------------------------- |
| Signed by    | **Not signed yet.** The accountant has not supplied or reviewed the real pack.        |
| Date         |                                                                                        |
| Pack         | 11 synthetic samples written by the build. They exercise the runner and are not the accountant's pack. |
| Inputs       | H-02 (sales tax rules), H-03 (withholding rules), H-04 (invoice numbering) are answered by defaults and assumptions that the accountant has not yet confirmed. |

Replace the "Signed by" value with the accountant's name once every sample of the real pack matches.
