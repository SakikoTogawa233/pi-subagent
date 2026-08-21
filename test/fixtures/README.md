# Registry fixtures

These are the exact npm tarballs used to reproduce and repair the locked transitive-runtime
installation topology without depending on the live registry during the regression test.

| package | version | SHA-512 |
| --- | --- | --- |
| `@sakiko233/pi-agent-runtime` | 0.1.0 | `99c57c28e8654f60447250fd75edbb8ed1ab072fccf42b0b2fa8a7674ccbc3029c0a3b54e922314ff3e98583c8455506b6dc325fa29a532fa30305423470cbbb` |
| `@sakiko233/pi-agent-runtime` | 0.1.1 | `b947798408aac2a7298bb3c8ffb94866b875795ca0bc0a8f8be0e5f69c88a58a50714c49abbc1e31ec3f992d8c7cc7c821263fdec3f0bbb68a19004c94a6f071` |
| `@sakiko233/pi-background-tasks` | 3.0.0 | `66ccf162a758844a13c852b052577a713910acaeb103b536f3834c6108ab1c40607e1cf27f6dc4939f6f3ad65e899f739feefc58b80f3bb881897ae4c74e46e6` |
| `@sakiko233/pi-subagent` | 0.1.0 | `f6bb0cd35e2db81914bf61dfc52b48267acc24ea14bb8b1eb8c70ecaef252e98dc9c93478075a363482d1db34d50727f2ce8be03cc00eb0df5b8d5478ed55fc8` |

The local fixture registry serves these immutable tarballs through normal npm metadata endpoints.
The repaired 0.1.1 consumer tarball is packed directly from the release-prepared working tree. The
published 0.1.0 consumer tarball remains immutable historical input for the stale-lock reproduction.
