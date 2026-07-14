# OpenAI Codex Fast

Adds a separate `openai-codex-fast` provider that delegates to Pi's built-in
`openai-codex` implementation with `serviceTier: "priority"`.

## Usage

Authenticate the built-in provider first:

```text
/login openai-codex
```

If you log in after Pi has already reported that Codex authentication is missing,
run `/reload` so the fast provider can register. Then select a fast model through
`/model`, for example:

```text
openai-codex-fast/gpt-5.6-sol
```

Normal `openai-codex/<model>` selections continue to use the default service
tier. Fast requests inherit effective routing overrides from the corresponding
built-in Codex model.

Fast mode is available for GPT-5.4, GPT-5.4 Mini, GPT-5.5, and the GPT-5.6
Luna, Terra, and Sol models. The extension restores a fast selection when a
session starts, reloads, resumes, forks, or is replaced. Navigating between
existing branches with `/tree` does not reconcile the selected model. Assistant
history uses the built-in Codex identity for compatibility; context-overflow
errors temporarily retain the fast-provider identity so Pi can compact and retry.

## Attribution

This extension is adapted from
[`2h2d-co/pi-openai-codex-fast`](https://github.com/2h2d-co/pi-openai-codex-fast)
and retains its MIT license in [LICENSE](LICENSE).
