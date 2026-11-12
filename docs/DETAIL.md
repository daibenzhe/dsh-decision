# Decision models

Unify three decision-model backends behind one DSH tool so an agent can ask
typed questions and receive calibrated probabilities instead of parsing prose.

## Accepted input formats

`input` is always a string or JSON state. A state array may also carry media
parts, and which kinds an endpoint reads differs:

| Backend | Route | text | image | audio | video | file (PDF/CSV/Office) |
| --- | --- | --- | --- | --- | --- | --- |
| `jev` | `openrouter` | ✅ | ✅ | — | — | — |
| `jev` | `typesafe` | ✅ | ✅ | — | — | — |
| `google` | `openrouter` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `google` | `google` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `openai` | `openrouter` | ✅ | ✅ | — | — | — |
| `openai` | `openai` | ✅ | ✅ | — | — | — |

A request carrying a kind its route does not accept is rejected before it
reaches the network, with a message naming the unsupported kind, what the route
does accept, and any provider that can read it. This avoids an opaque upstream
`400`.

Media parts use the Chat Completions shapes:

```json
{ "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBORw0KGgo..." } }
{ "type": "input_audio", "input_audio": { "data": "UklGRiQAAABXQVZF...", "format": "wav" } }
{ "type": "video_url", "video_url": { "url": "data:video/mp4;base64,AAAAIGZ0eXBpc29t..." } }
{ "type": "file", "file": { "file_data": "data:application/pdf;base64,JVBERi0xLjQK...", "filename": "invoice.pdf" } }
```

Each line above is one part on its own; a real `state` array holds them
together with the text items they accompany.

## Backends and routes

Each backend can be reached through more than one route. Each route is tried in
the order listed; the first one holding a key wins.

| Backend | OpenRouter | Vendor native |
| --- | --- | --- |
| `jev` | `typesafe/jev-1.14` | `jev-latest` at `api.typesafe.ai/v1/systemone` (TypeSafe) |
| `google` | `google/gemini-decision-1` | `gemini-decision-1` at `generativelanguage.googleapis.com/v1beta/decisions` |
| `openai` | `openai/gpt-6-luna-decisions` | `gpt-6-luna` at `api.openai.com/v1/decisions` |

Two wire protocols cover every route. OpenRouter and TypeSafe use the **map**
envelope (`state` + `questions` map, answers keyed by question name); Google's
native endpoint uses the same map shape; OpenAI's native endpoint uses the
**array** envelope (`input` + `questions` array). All are normalized to one
answer shape.

## Optional access

You do not have to enable all three, and you do not need all three keys. Each
backend is reachable when any source that serves it holds a key:

| Source | Serves | Ambient references checked |
| --- | --- | --- |
| `openrouter` | `jev`, `google`, `openai` | `OPENROUTER_API_KEY`, `OPENROUTER_KEY` |
| `typesafe` | `jev` (direct) | `TYPESAFE_API_KEY`, `TYPESAFE_KEY` |
| `google` | `google` (native) | `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` |
| `openai` | `openai` (native) | `OPENAI_API_KEY` |

A key is read from two places: the plugin's own record `decision/<source>`
(written by `decision:set-key`) first, then any of that source's ambient
references. A `TYPESAFE_API_KEY` already in `.credentials.yaml` or the process
environment therefore needs no copy — it is detected automatically.

Call `decision:list-providers` to see which sources hold a key, where the key
came from, and which backends are available.

## Question types

- `noul` — yes/no, returns the probability of yes.
- `choice` — pick one option, returns the chosen value plus per-option
  probabilities and a confidence score.
- `score` — place the input on an ordered scale, returns a probability-weighted
  position, per-level probabilities, and a confidence score. Some providers also
  return a `legend` mapping level index to label.

## Tools

- `decision` — ask one backend typed questions over shared `input`. An optional
  `source` picks the route (`openrouter`, `typesafe`, `google`, `openai`).
- `decision:set-key` — store a source's API key as a record.
- `decision:list-providers` — show configured sources, key origins, and
  available backends.
- `decision:clear-key` — remove a source's record, falling back to any ambient
  reference.

## Reasoning participation

The `reasoningMode` config decides how the decision model takes part in the
agent's reasoning:

| Mode | Behaviour |
| --- | --- |
| `off` | Only the explicit tool and slash commands. |
| `advisory` (default) | The prompt tells the model to consult `decision` with a `choice` question before committing to a branch it would otherwise guess. The model decides when. |
| `auto` | Before each step, the plugin reads the alternatives the conversation already enumerated, asks a `choice` question over them, and appends a `Decision input` note to that step. |

Set `reasoningMode` in the bundle's `config`:

```yaml
- insert:
    - id: dsh-decision-plugin
      name: '@local/dsh-decision-plugin'
      config:
        reasoningMode: auto
```

`auto` mode stays silent unless the evidence is worth acting on. It adds nothing
when the conversation names fewer than two alternatives, when the answer is a
refusal, or when confidence is below 0.55 — a weak preference would anchor the
model on noise. Its note is advisory: it tells the model to treat the
recommendation as evidence and to prefer better-supported later evidence. A
failed decision call never blocks the step.

The mode is also switchable at runtime with `/decision-mode`, which takes effect
on the next step and is written back to this bundle's own `config` row, so the
choice survives a plugin reload and a restart. The `config` value is the
starting gear; a profile that cannot save configuration reports that the change
lasts only until the next reload instead of silently discarding it.

## Slash commands

These run in the Host from the composer, without a model turn:

- `/decision <question>` — run one decision. A bare question is a yes/no
  question about that text.
- `/decision choice: a = why | b = why -- <question>` — pick one option.
- `/decision score: low | mid | high -- <question>` — place the input on an
  ordered scale.
- `/decision-mode <off|advisory|auto>` — switch the reasoning gear immediately
  and save it to this bundle's config.
- `/decision-status` — show the active reasoning mode, which backends are
  configured, which input formats each route accepts, and the command to add a
  missing key.
- `/decision-key <source> <key>` — store a key for `openrouter`, `typesafe`,
  `google`, or `openai`. The key is never echoed back.
- `/decision-key clear <source>` — remove a stored key.

Any `/decision` line accepts an optional leading `@provider` (or `@source`) to
choose the route, for example `/decision @google How damaged is it?`.

The `--` before the question separates the answer space from the question text,
so an option can contain any words.

## Credentials

API keys are never stored in configuration. They live in credential records
or ambient references, and are read per request, so rotating one takes effect
on the next call without a restart.

## Limits

- Jev is text and JSON only; it cannot score images.
- OpenAI supports text, images, and JSON.
- Gemini Decision 1 supports text, images, audio, video, and PDFs, but this
  plugin's tool currently passes text and JSON state only.
- Every route needs your own account and API key; no credentials ship with this
  plugin.
- A source reaches a backend only through its own model: OpenRouter routes bill
  to your OpenRouter account, while `typesafe`, `google`, and `openai` bill to
  their own accounts.
