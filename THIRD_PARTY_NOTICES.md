# Third-party notices

## Extracted pi-background-tasks code

Parts of this package were extracted and adapted from
`@sakiko233/pi-background-tasks` (the delegate/agent workflow surface), which
preserves the following ISC license:

> ISC License
>
> Copyright (c) 2026
>
> Permission to use, copy, modify, and/or distribute this software for any purpose
> with or without fee is hereby granted, provided that the above copyright notice
> and this permission notice appear in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
> REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
> FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
> INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
> OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
> TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
> THIS SOFTWARE.

## Anthropic system-prompt sanitization rules

This package does **not** ship the Anthropic attribution implementation. It ships
only a loader (`extensions/subagent-attribution.ts`) that re-exports
`@sakiko233/pi-agent-runtime/anthropic-attribution`. The implementation — and its
own third-party notice for rules derived from `ravshansbox/pi-anthropic-sps`
(MIT, Copyright (c) 2026 Ravshan) — lives in
[@sakiko233/pi-agent-runtime](https://github.com/SakikoTogawa233/pi-agent-runtime),
see its `THIRD_PARTY_NOTICES.md`.
