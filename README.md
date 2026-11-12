# dsh-decision

Unify three decision-model backends behind one DSH tool, slash command, and
programmable interface.

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin
that lets an agent — or a script — ask Jev, Google Gemini Decision 1, or OpenAI
Decisions typed questions and get calibrated probabilities instead of prose.

## What a decision model is

A decision model does not generate text. You send it a piece of evidence and one
or more typed questions, and it returns numbers: the probability of a condition,
the chosen option among a fixed set, or a position on an ordered scale. It is
cheap, fast, and calibrated — a good fit wherever a narrow judgment has to drive
a branch.

This plugin speaks three backends and normalizes them into one answer shape:

| Backend | Model | Reached via |
| --- | --- | --- |
| `jev` | `typesafe/jev-1.14` | OpenRouter, or TypeSafe directly |
| `google` | `gemini-decision-1` | OpenRouter, or Google AI Studio |
| `openai` | `gpt-6-luna` / `gpt-6-luna-decisions` | OpenRouter, or OpenAI |

A single OpenRouter key reaches all three. Vendor keys reach their own model
natively. See [docs/DETAIL.md](docs/DETAIL.md) for the route table.

## Install

```bash
git clone https://github.com/daibenzhe/dsh-decision.git
```

Then install the directory as a bundle: **Plugins → Add plugin**, or from an
agent session with the plugin manager available, install the absolute path of
this directory.

Set at least one API key:

```
/decision-key openrouter sk-or-...
```

Or export `OPENROUTER_API_KEY` / `TYPESAFE_API_KEY` / `GEMINI_API_KEY` /
`OPENAI_API_KEY` before launching DSH — ambient references are picked up
automatically.

## Use

### From the composer

```
/decision 这条工单是软件缺陷吗？
/decision choice: payments = 计费问题 | frontend = 前端问题 -- 该由哪个团队处理？
/decision score: 可延后 | 本周修 | 阻塞收入 -- 紧迫程度？
/decision @google 这个损坏严重吗？
```

### From the agent

The `decision` tool lets the model ask the same questions mid-reasoning. Set
`reasoningMode` to control how much the plugin participates:

| Mode | Behaviour |
| --- | --- |
| `off` | Only the tool and slash commands. |
| `advisory` (default) | The prompt asks the model to consult a choice before guessing. |
| `auto` | Each step gets an advisory choice over the alternatives already listed. |

Switch at runtime with `/decision-mode auto`; the choice is saved to this
bundle's config.

### Commands

| Command | Purpose |
| --- | --- |
| `/decision ...` | Run one decision |
| `/decision-mode <off\|advisory\|auto>` | Switch the reasoning gear and save it |
| `/decision-status` | Show the gear, configured backends, and accepted formats |
| `/decision-key <source> <key>` | Store a key (`clear` removes one) |

### From code

```js
const outcome = await ctx.decisionModels.classify({
  input: ticket,
  questions: [{
    name: "team",
    type: "choice",
    instructions: "Which team should own this?",
    options: { payments: "Billing", frontend: "UI", account: "Auth" },
  }],
});
if (outcome.ok && !outcome.uncertain) route(outcome.answers.team.choice);
```

The programmable interface is designed but not yet implemented — see
[docs/AUTOMATION.md](docs/AUTOMATION.md).

## Accepted input

`input` is a string or JSON state everywhere. Media parts go in a state array,
and what each backend reads differs:

| Backend | text | image | audio | video | file |
| --- | --- | --- | --- | --- | --- |
| `jev` | ✅ | ✅ | — | — | — |
| `openai` | ✅ | ✅ | — | — | — |
| `google` | ✅ | ✅ | ✅ | ✅ | ✅ |

A part a route cannot read is rejected before the request is sent, naming a
provider that can.

## Documentation

- [docs/DETAIL.md](docs/DETAIL.md) — full plugin reference: routes, formats,
  credentials, reasoning modes.
- [docs/AUTOMATION.md](docs/AUTOMATION.md) — design for wiring decisions into
  scheduled tasks, webhooks, and subagents.

## Licence

MIT
