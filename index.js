/**
 * @local/dsh-decision-plugin
 *
 * Unify Jev (TypeSafe via OpenRouter), Google Gemini Decision 1, and OpenAI
 * Decisions behind one typed `decision` tool. Every backend answers the same
 * three question primitives — yes/no, choice, and score — and returns
 * calibrated probabilities; this plugin normalizes the differing request and
 * response envelopes into one shape.
 *
 * API keys are stored as credential records (never in configuration) and are
 * read at call time. Each *source* owns one key, and each source may serve
 * several backends — see CREDENTIAL_SOURCES. See docs/DETAIL.md.
 */

/**
 * Backends this plugin can call. Each one can be reached through more than one
 * *route*: OpenRouter serves all three, while a vendor key reaches its own
 * model natively. See PROVIDER_DEFS for the per-route endpoint and model.
 */
const PROVIDERS = ["jev", "google", "openai"];

/**
 * Credential sources. A source owns exactly one API key and may serve one or
 * more backends, so enabling a provider is a matter of supplying the key of
 * any source that serves it — not of installing a separate plugin per vendor.
 *
 * Each source is read from two places, in order:
 *   1. its own record `decision/<source>` (written by decision:set-key), then
 *   2. any ambient reference in `envRefs` (the environment-variable namespace
 *      that `.credentials.yaml` `refs` and the process environment share).
 * Step 2 means an already-configured `TYPESAFE_API_KEY` needs no copy.
 */
const CREDENTIAL_SOURCES = {
  /** OpenRouter serves every decision model it routes, including all three below. */
  openrouter: {
    label: "OpenRouter",
    hint: "OpenRouter API key (sk-or-...). Serves jev, google, and openai — and any other decision model OpenRouter routes.",
    serves: ["jev", "google", "openai"],
    envRefs: ["OPENROUTER_API_KEY", "OPENROUTER_KEY"],
  },
  /** TypeSafe's own API, reached directly instead of through OpenRouter. */
  typesafe: {
    label: "TypeSafe",
    hint: "TypeSafe API key. Reaches jev directly on TypeSafe's own endpoint.",
    serves: ["jev"],
    envRefs: ["TYPESAFE_API_KEY", "TYPESAFE_KEY"],
  },
  /** Gemini Decision 1, straight from Google AI Studio. */
  google: {
    label: "Google AI Studio",
    hint: "Google AI Studio / Gemini API key. Serves the google backend natively.",
    serves: ["google"],
    envRefs: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  },
  /** GPT-6 Luna's Decisions endpoint. */
  openai: {
    label: "OpenAI",
    hint: "OpenAI API key (sk-...). Serves the openai backend natively.",
    serves: ["openai"],
    envRefs: ["OPENAI_API_KEY"],
  },
};

/** Credential source ids, in display order. */
const SOURCE_IDS = Object.keys(CREDENTIAL_SOURCES);

/** Question primitives shared by all three backends. */
const QUESTION_TYPES = ["noul", "choice", "score"];

/** Credential record key for one source's API key (`<owner>/<id>`). */
function credentialKeyFor(source) {
  return `decision/${source}`;
}

/** The reference grammar a `CredentialRef` must match (POSIX shell identifier). */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Read one source's API key. Its own record wins; otherwise the first set
 * ambient reference from the source definition is used.
 * @returns `{ apiKey, origin }` where origin is `record` or the reference name,
 *   or `undefined` when the source holds no key at all.
 */
async function readApiKey(ctx, source) {
  const credentials = ctx.get("credentials");
  if (credentials === undefined) return undefined;

  const record = await credentials.readRecord(credentialKeyFor(source));
  if (record !== undefined && record.kind === "api-key" && record.key !== undefined && record.key !== "") {
    return { apiKey: record.key, origin: "record" };
  }

  const definition = CREDENTIAL_SOURCES[source];
  for (const ref of definition?.envRefs ?? []) {
    if (!REF_PATTERN.test(ref)) continue;
    const resolved = await credentials.resolve(ref);
    if (resolved?.value !== undefined && resolved.value !== "") {
      return { apiKey: resolved.value, origin: ref };
    }
  }
  return undefined;
}

/** Store one source's API key as a durable `api-key` record. */
async function storeApiKey(ctx, source, value) {
  const credentials = ctx.get("credentials");
  if (credentials === undefined) {
    throw new Error("credentials service is unavailable in this profile");
  }
  await credentials.modifyRecord(credentialKeyFor(source), async () => ({
    kind: "api-key",
    key: value,
  }));
}

/** Remove one source's API key record; absent records are a no-op. */
async function clearApiKey(ctx, source) {
  const credentials = ctx.get("credentials");
  if (credentials === undefined) {
    throw new Error("credentials service is unavailable in this profile");
  }
  await credentials.deleteRecord(credentialKeyFor(source));
}

/**
 * Resolve which route serves a backend: the first configured source that both
 * serves it and that the backend defines a route for.
 * @returns `{ source, route, apiKey }`, or `undefined` when none is configured.
 */
async function resolveCredential(ctx, provider, preferredSource) {
  const order = preferredSource === undefined
    ? SOURCE_IDS
    : [preferredSource, ...SOURCE_IDS.filter((source) => source !== preferredSource)];
  for (const source of order) {
    const definition = CREDENTIAL_SOURCES[source];
    if (definition === undefined || !definition.serves.includes(provider)) continue;
    const route = PROVIDER_DEFS[provider].routes[source];
    if (route === undefined) continue;
    const found = await readApiKey(ctx, source);
    if (found !== undefined) return { source, route, apiKey: found.apiKey, origin: found.origin };
  }
  return undefined;
}

/**
 * Report every backend's availability. A backend is available when at least
 * one of its sources holds a key; a source may serve several backends.
 */
async function describeAvailability(ctx) {
  const sources = [];
  for (const source of SOURCE_IDS) {
    const definition = CREDENTIAL_SOURCES[source];
    const found = await readApiKey(ctx, source);
    sources.push({
      source,
      label: definition.label,
      configured: found !== undefined,
      origin: found === undefined ? null : found.origin,
      serves: [...definition.serves],
      envRefs: [...definition.envRefs],
    });
  }
  const providers = PROVIDERS.map((provider) => {
    const serving = sources.filter((entry) => entry.serves.includes(provider) && entry.configured);
    // Accepted input formats, per configured route; the union is what this
    // backend can read whichever route answers.
    const formats = [];
    for (const entry of serving) {
      const route = PROVIDER_DEFS[provider].routes[entry.source];
      if (route === undefined) continue;
      formats.push({ source: entry.source, model: route.model, accepts: [...route.accepts] });
    }
    const union = new Set();
    for (const entry of formats) for (const kind of entry.accepts) union.add(kind);
    return {
      provider,
      available: serving.length > 0,
      via: serving.map((entry) => entry.source),
      accepts: [...union],
      routes: formats,
    };
  });
  return { sources, providers };
}

// ---------------------------------------------------------------------------
// Wire adapters
//
// Two protocols cover all routes:
//   * "map"    — OpenRouter's Decisions API: `state` + `questions` map, answers
//                keyed by question name. Serves Jev, Gemini Decision 1, and the
//                OpenRouter-hosted OpenAI decision model alike.
//   * "array"  — OpenAI's native /v1/decisions: `input` + `questions` array,
//                answers returned in an array.
// ---------------------------------------------------------------------------

/** Build a request body in OpenRouter's map envelope. */
function buildMapRequest(model, state, questions) {
  const q = {};
  for (const question of questions) q[question.name] = adaptQuestionToMap(question);
  return { model, state, questions: q };
}

/** Parse an answers map keyed by question name into the normalized shape. */
function parseMapResponse(body, questions) {
  const byName = new Map(questions.map((question) => [question.name, question]));
  const out = {};
  for (const [name, raw] of Object.entries(body.answers ?? {})) {
    const question = byName.get(name);
    out[name] = question === undefined ? raw : normalizeMapAnswer(question, raw);
  }
  return out;
}

/** Build a request body in OpenAI's native array envelope. */
function buildArrayRequest(model, state, questions) {
  const input = typeof state === "string"
    ? state
    : [{ role: "user", content: [{ type: "input_text", text: JSON.stringify(state) }] }];
  return { model, input, questions: questions.map(adaptQuestionToOpenAI) };
}

/** Parse an OpenAI answers array into the normalized shape. */
function parseArrayResponse(body) {
  const out = {};
  for (const answer of body.answers ?? []) {
    if (answer === null || typeof answer !== "object" || typeof answer.name !== "string") continue;
    out[answer.name] = normalizeOpenAIAnswer(answer);
  }
  return out;
}

/** Bearer auth, used by OpenRouter and OpenAI. */
function bearerAuth(apiKey) {
  return { Authorization: `Bearer ${apiKey}` };
}

/**
 * Media kinds an input may carry, in the order a validation error lists them.
 * `text` covers strings and JSON state; the rest are the media parts a
 * Decisions endpoint may read from the top-level state array.
 */
const MEDIA_KINDS = ["text", "image", "audio", "video", "file"];

/**
 * Every route, with the input shapes its endpoint accepts. `text` always works;
 * the media kinds follow OpenRouter's endpoint capability table and each
 * vendor's own Decisions documentation. A request carrying a kind the route
 * does not list is rejected here, before it reaches the network, instead of
 * being refused by the upstream API as an opaque 400.
 *
 * A route names its credential source, endpoint, model, wire protocol, auth
 * header, and accepted input kinds. OpenRouter routes come first so a single
 * OpenRouter key can serve every backend without per-vendor keys.
 */
const PROVIDER_DEFS = {
  jev: {
    routes: {
      openrouter: {
        endpoint: "https://openrouter.ai/api/alpha/decisions",
        model: "typesafe/jev-1.14",
        protocol: "map",
        authHeader: bearerAuth,
        accepts: ["text", "image"],
      },
      // TypeSafe's own System One endpoint takes the same map envelope.
      typesafe: {
        endpoint: "https://api.typesafe.ai/v1/systemone",
        model: "jev-latest",
        protocol: "map",
        authHeader: bearerAuth,
        accepts: ["text", "image"],
      },
    },
  },

  google: {
    routes: {
      openrouter: {
        endpoint: "https://openrouter.ai/api/alpha/decisions",
        model: "google/gemini-decision-1",
        protocol: "map",
        authHeader: bearerAuth,
        accepts: ["text", "image", "audio", "video", "file"],
      },
      google: {
        endpoint: "https://generativelanguage.googleapis.com/v1beta/decisions",
        model: "gemini-decision-1",
        protocol: "map",
        authHeader(apiKey) {
          return { "x-goog-api-key": apiKey };
        },
        accepts: ["text", "image", "audio", "video", "file"],
      },
    },
  },

  openai: {
    routes: {
      openrouter: {
        endpoint: "https://openrouter.ai/api/alpha/decisions",
        model: "openai/gpt-6-luna-decisions",
        protocol: "map",
        authHeader: bearerAuth,
        accepts: ["text", "image"],
      },
      openai: {
        endpoint: "https://api.openai.com/v1/decisions",
        model: "gpt-6-luna",
        protocol: "array",
        authHeader: bearerAuth,
        accepts: ["text", "image"],
      },
    },
  },
};

/** Map a `state` content part to the media kind it carries. */
function mediaKindOfPart(part) {
  if (part === null || typeof part !== "object") return undefined;
  switch (part.type) {
    case "image_url":
    case "input_image":
      return "image";
    case "input_audio":
    case "audio":
      return "audio";
    case "video_url":
      return "video";
    case "file":
    case "document":
      return "file";
    default:
      return undefined;
  }
}

/**
 * Collect the media kinds an input actually carries.
 * Media parts are read from the top-level state array (and, for Jev, from
 * anywhere in the state tree), so the walk is recursive but bounded.
 * @returns a Set of kinds present; a plain string or JSON input yields none.
 */
function mediaKindsIn(state) {
  const found = new Set();
  const seen = new Set();
  const visit = (node, depth) => {
    if (node === null || typeof node !== "object" || depth > 12) return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        const kind = mediaKindOfPart(item);
        if (kind !== undefined) found.add(kind);
        visit(item, depth + 1);
      }
      return;
    }
    const kind = mediaKindOfPart(node);
    if (kind !== undefined) found.add(kind);
    for (const value of Object.values(node)) visit(value, depth + 1);
  };
  visit(state, 0);
  return found;
}

/**
 * Check an input against a route's accepted kinds.
 * @returns an error message naming the unsupported kinds and what this route
 *   does accept, or `undefined` when the input fits.
 */
function unsupportedInputs(route, provider, source, state) {
  const present = mediaKindsIn(state);
  if (present.size === 0) return undefined;
  const accepted = new Set(route.accepts ?? MEDIA_KINDS);
  const rejected = [...present].filter((kind) => !accepted.has(kind));
  if (rejected.length === 0) return undefined;
  const alternatives = PROVIDERS.filter((candidate) => candidate !== provider).filter((candidate) =>
    Object.values(PROVIDER_DEFS[candidate].routes).some(
      (other) => rejected.every((kind) => (other.accepts ?? MEDIA_KINDS).includes(kind)),
    ),
  );
  return (
    `The "${source}" route to "${provider}" does not accept ${rejected.join(" or ")} input; ` +
    `it accepts ${[...accepted].join(", ")}.` +
    (alternatives.length > 0
      ? ` Use provider ${alternatives.join(" or ")} for that input.`
      : " No configured route accepts that input.")
  );
}

/** Build a request body for one route. */
function buildRouteRequest(route, state, questions) {
  return route.protocol === "array"
    ? buildArrayRequest(route.model, state, questions)
    : buildMapRequest(route.model, state, questions);
}

/** Parse a response body for one route. */
function parseRouteResponse(route, body, questions) {
  return route.protocol === "array"
    ? parseArrayResponse(body)
    : parseMapResponse(body, questions);
}

/** Turn a normalized question into the map-envelope form. */
function adaptQuestionToMap(question) {
  const out = { type: question.type, instructions: question.instructions };
  if (question.type === "noul" || question.type === "choice") {
    out.criteria = question.options;
  } else if (question.type === "score") {
    out.criteria = question.levels;
  }
  return out;
}

/** Turn a normalized question into the OpenAI array-item form. */
function adaptQuestionToOpenAI(question) {
  if (question.type === "noul") {
    return { type: "predicate", name: question.name, instructions: question.instructions };
  }
  if (question.type === "choice") {
    return {
      type: "choice",
      name: question.name,
      instructions: question.instructions,
      choices: Object.entries(question.options).map(([value, description]) => ({ value, description })),
    };
  }
  // score
  return {
    type: "score",
    name: question.name,
    instructions: question.instructions,
    levels: question.levels.map((label, index) => ({ label: String(label), description: String(label), value: index })),
  };
}

/** Normalize a map-envelope answer (Jev, Gemini Decision 1, OpenRouter). */
function normalizeMapAnswer(question, raw) {
  if (raw === null || typeof raw !== "object") return raw;
  if (raw.type === "refusal") return { type: "refusal" };
  if (question.type === "noul") {
    return { type: "noul", probability: numberOrNull(raw.noul ?? raw.probability) };
  }
  const distribution = probabilitiesToMap(raw.probabilities ?? raw.options ?? raw.scores);
  if (question.type === "choice") {
    return {
      type: "choice",
      choice: raw.choice ?? null,
      confidence: numberOrNull(raw.confidence),
      probabilities: distribution ?? probabilitiesFromKeys(raw),
    };
  }
  // score: the response may carry a `legend` mapping level index -> label.
  const answer = {
    type: "score",
    score: numberOrNull(raw.score),
    confidence: numberOrNull(raw.confidence),
    probabilities: distribution ?? probabilitiesFromKeys(raw),
  };
  if (raw.legend !== null && typeof raw.legend === "object") answer.legend = { ...raw.legend };
  return answer;
}

/** Normalize an OpenAI answer (array form) into the shared shape. */
function normalizeOpenAIAnswer(answer) {
  switch (answer.type) {
    case "predicate":
      return { type: "noul", probability: numberOrNull(answer.probability) };
    case "choice":
      return {
        type: "choice",
        choice: answer.choice ?? null,
        confidence: numberOrNull(answer.confidence),
        probabilities: probabilitiesToMap(answer.probabilities),
      };
    case "score":
      return {
        type: "score",
        score: numberOrNull(answer.score),
        confidence: numberOrNull(answer.confidence),
        probabilities: probabilitiesToMap(answer.probabilities),
      };
    case "refusal":
      return { type: "refusal" };
    default:
      return answer;
  }
}

/** Coerce a possibly-missing number to null without throwing. */
function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Turn a probability array or a `{ value: probability }` map into a map. */
function probabilitiesToMap(probabilities) {
  if (probabilities === null || typeof probabilities !== "object") return null;
  if (Array.isArray(probabilities)) {
    const out = {};
    let found = false;
    for (const item of probabilities) {
      if (item === null || typeof item !== "object") continue;
      const value = item.value ?? item.label;
      const probability = numberOrNull(item.probability);
      if (value !== undefined && probability !== null) {
        out[String(value)] = probability;
        found = true;
      }
    }
    return found ? out : null;
  }
  // Map form: { optionValue: probability } — keep only numeric entries.
  const out = {};
  let found = false;
  for (const [key, value] of Object.entries(probabilities)) {
    const probability = numberOrNull(value);
    if (probability !== null) {
      out[key] = probability;
      found = true;
    }
  }
  return found ? out : null;
}

/**
 * Last resort: some providers return each option's probability on its own
 * field of the answer (e.g. `{ choice, payments: 0.74, frontend: 0.01 }`).
 * Recover those numeric fields, excluding the answer's own metadata.
 */
function probabilitiesFromKeys(raw) {
  const reserved = new Set(["type", "choice", "confidence", "score", "noul", "probability", "probabilities"]);
  const out = {};
  let found = false;
  for (const [key, value] of Object.entries(raw)) {
    if (reserved.has(key)) continue;
    const probability = numberOrNull(value);
    if (probability !== null) {
      out[key] = probability;
      found = true;
    }
  }
  return found ? out : null;
}

/** The normalized question object the tool accepts. */
function normalizeQuestion(raw) {
  if (raw === null || typeof raw !== "object") throw new Error("each question must be an object");
  const question = raw;
  if (typeof question.name !== "string" || question.name.length === 0) {
    throw new Error("each question needs a non-empty `name`");
  }
  if (!QUESTION_TYPES.includes(question.type)) {
    throw new Error(`question "${question.name}" has invalid type "${question.type}" (expected ${QUESTION_TYPES.join(", ")})`);
  }
  if (typeof question.instructions !== "string" || question.instructions.length === 0) {
    throw new Error(`question "${question.name}" needs a non-empty "instructions"`);
  }
  if (question.type === "choice") {
    if (question.options === null || typeof question.options !== "object" || Array.isArray(question.options)) {
      throw new Error(`choice question "${question.name}" needs an "options" map of value -> description`);
    }
    if (Object.keys(question.options).length < 2) {
      throw new Error(`choice question "${question.name}" needs at least two options`);
    }
  } else if (question.type === "score") {
    if (!Array.isArray(question.levels) || question.levels.length < 2) {
      throw new Error(`score question "${question.name}" needs a "levels" array of at least two ordered labels`);
    }
  }
  return {
    name: question.name,
    type: question.type,
    instructions: question.instructions,
    options: question.type === "choice" ? { ...question.options } : undefined,
    levels: question.type === "score" ? [...question.levels] : undefined,
  };
}

/**
 * Run one decision request end to end: resolve a route, validate the input
 * against it, call the endpoint, and parse the answers. Shared by the
 * `decision` tool and the `/decision` command so both behave identically.
 *
 * @param ctx - Host context.
 * @param cfg - resolved plugin config.
 * @param request - backend, optional route preference, state, and questions.
 * @returns `{ ok: true, result }` or `{ ok: false, message }`.
 */
async function runDecision(ctx, cfg, request) {
  const { provider, source: preferredSource, state, questions } = request;
  if (!PROVIDERS.includes(provider)) {
    return { ok: false, message: `Unknown provider "${provider}". Known providers: ${PROVIDERS.join(", ")}.` };
  }

  const credential = await resolveCredential(ctx, provider, preferredSource);
  if (credential === undefined) {
    const { sources, providers } = await describeAvailability(ctx);
    const serving = sources.filter((entry) => entry.serves.includes(provider));
    const names = serving.map((entry) => entry.source).join(" or ");
    const ready = providers.filter((entry) => entry.available).map((entry) => entry.provider);
    return {
      ok: false,
      message:
        `No configured key reaches "${provider}". Provide one of these keys with /decision-key: ${names}. ` +
        (ready.length === 0
          ? "No decision backend is currently available; configure at least one key."
          : `Available right now: ${ready.join(", ")}.`),
    };
  }
  const { source, route, apiKey } = credential;

  const incompatible = unsupportedInputs(route, provider, source, state);
  if (incompatible !== undefined) return { ok: false, message: incompatible };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const response = await fetch(route.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...route.authHeader(apiKey),
      },
      body: JSON.stringify(buildRouteRequest(route, state, questions)),
      signal: controller.signal,
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, message: `Provider "${provider}" returned non-JSON (HTTP ${response.status}): ${text.slice(0, 400)}` };
    }
    if (!response.ok) {
      const detail = body?.error?.message ?? body?.message ?? text.slice(0, 400);
      return { ok: false, message: `Provider "${provider}" failed (HTTP ${response.status}): ${detail}` };
    }
    return {
      ok: true,
      result: {
        provider,
        source,
        model: body.model ?? route.model,
        answers: parseRouteResponse(route, body, questions),
        usage: body.usage ?? null,
      },
    };
  } catch (error) {
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      message: aborted
        ? `Decision request to "${provider}" timed out after ${cfg.timeoutMs}ms`
        : `Decision request to "${provider}" failed: ${String(error?.message ?? error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Automatic reasoning participation
// ---------------------------------------------------------------------------

/** How much recent conversation text is offered to the decision model. */
const PROMPT_EVIDENCE_CHARS = 4000;

/** Extract the plain text of a message's content blocks. */
function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Ask the decision model which of the alternatives already named in the
 * conversation is the better next step.
 *
 * The candidate set is read from the most recent assistant text: a list the
 * model itself enumerated (numbered or bulleted lines) is taken as the
 * alternatives. When the conversation names fewer than two, automatic
 * participation would be guessing, so it stays silent.
 *
 * @param ctx - Host context.
 * @param cfg - resolved plugin config.
 * @param payload - the agent/pre-step payload.
 * @returns the context note to append, or `undefined` to add nothing.
 */
async function proposeNextChoice(ctx, cfg, payload) {
  const { agent, messages, signal } = payload;
  if (signal.aborted) return undefined;

  // Evidence: the recent conversation, newest last.
  const history = Array.isArray(messages) && messages.length > 0
    ? messages
    : (typeof agent?.session?.snapshotEvents === "function"
      ? agent.session.snapshotEvents().filter((event) => event.type === "user/message" || event.type === "assistant/message").map((event) => event.data)
      : []);
  const evidence = history
    .map((message) => messageText(message))
    .filter((text) => text.length > 0)
    .join("\n\n")
    .slice(-PROMPT_EVIDENCE_CHARS);
  if (evidence.length === 0) return undefined;

  const alternatives = extractAlternatives(evidence);
  if (alternatives.length < 2) return undefined;

  const options = {};
  for (const alternative of alternatives) options[alternative.id] = alternative.text;

  const outcome = await runDecision(ctx, cfg, {
    provider: cfg.defaultProvider,
    state: evidence,
    questions: [normalizeQuestion({
      name: "next",
      type: "choice",
      instructions: "Which of the listed next steps best advances the user's goal, given the conversation so far?",
      options,
    })],
  });
  if (!outcome.ok) return undefined;

  const answer = outcome.result.answers?.next;
  if (answer === undefined || answer === null || answer.type !== "choice") return undefined;
  if (answer.choice === null) return undefined;

  // A weak preference is worse than none: it would anchor the model on noise.
  const confidence = typeof answer.confidence === "number" ? answer.confidence : 0;
  if (confidence < AUTO_MODE_MIN_CONFIDENCE) return undefined;

  const chosen = options[answer.choice] ?? answer.choice;
  const ranked = Object.entries(answer.probabilities ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([value, probability]) => `${options[value] ?? value} (${percent(probability)})`);

  return [
    "Decision input — an advisory scoring of the next steps already named in this conversation.",
    `Chosen: ${chosen} (confidence ${percent(confidence)})`,
    ranked.length > 1 ? `Ranking: ${ranked.join("; ")}` : undefined,
    `Model: ${outcome.result.provider} / ${outcome.result.model}`,
    "This is evidence, not an instruction. Follow it only where it matches your own reading; if later evidence contradicts it, say so and take the better-supported path.",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

/**
 * Read the alternatives an assistant listed as numbered or bulleted items.
 * Each alternative keeps a short id for the decision request and the full text
 * for display.
 */
function extractAlternatives(text) {
  const found = [];
  const pattern = /^[ \t]*(?:[-*•]|\d+[.)])[ \t]+(.+)$/gmu;
  for (const match of text.matchAll(pattern)) {
    const item = match[1].trim();
    if (item.length === 0 || item.length > 300) continue;
    found.push(item);
  }
  // Only the most recent enumeration is the live question.
  const recent = found.slice(-AUTO_MODE_MAX_ALTERNATIVES);
  const result = [];
  for (const item of recent) {
    if (result.some((entry) => entry.text === item)) continue;
    result.push({ id: `option${result.length + 1}`, text: item });
  }
  return result;
}

/** Minimum confidence under which automatic participation stays silent. */
const AUTO_MODE_MIN_CONFIDENCE = 0.55;

/** Upper bound on alternatives sent in one automatic decision. */
const AUTO_MODE_MAX_ALTERNATIVES = 6;

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

/**
 * Parse a `/decision` line into one normalized question plus its state.
 *
 * Grammar (all parts optional except the question):
 *   [@provider | @source]  [choice: a = why | b = why]  [score: low | mid | high]  <question>
 *
 * A bare question is a `noul` (yes/no) question about that text. `choice:` and
 * `score:` describe the answer space; the remaining text is the instructions.
 *
 * @param rawInput - the text typed after `/decision`.
 * @param defaultProvider - backend used when no `@provider` is given.
 * @returns `{ provider, source, state, question }` or `{ error }`.
 */
function parseDecisionLine(rawInput, defaultProvider) {
  let rest = String(rawInput ?? "").trim();
  if (rest.length === 0) {
    return {
      error:
        "Usage: /decision [@provider] <question>, " +
        "or /decision [@provider] choice: a | b -- <question>, " +
        "or /decision [@provider] score: low | mid | high -- <question>. " +
        "A bare question is treated as yes/no.",
    };
  }

  let provider = defaultProvider;
  let source;

  // Leading @provider / @source token.
  const at = rest.match(/^@([a-z-]+)\s+/i);
  if (at !== null) {
    const name = at[1].toLowerCase();
    if (PROVIDERS.includes(name)) provider = name;
    else if (SOURCE_IDS.includes(name)) source = name;
    else {
      return { error: `Unknown backend "${name}". Providers: ${PROVIDERS.join(", ")}; sources: ${SOURCE_IDS.join(", ")}.` };
    }
    rest = rest.slice(at[0].length).trim();
  }

  let type = "noul";
  let options;
  let levels;

  // Answer-space clauses come first, then the question, separated by `--`:
  //   choice: a = why | b = why -- Which team should own this?
  //   score: low | mid | high -- How urgent is it?
  // Without a `--`, a clause line has no question and is rejected, because
  // nothing else reliably separates the last option from the question text.
  const clause = /^(choice|score):\s*/i.exec(rest);
  if (clause !== null) {
    const keyword = clause[1].toLowerCase();
    const body = rest.slice(clause[0].length);
    const split = body.indexOf(" -- ");
    const answerSpace = split === -1 ? body : body.slice(0, split);
    rest = split === -1 ? "" : body.slice(split + 4);

    const items = answerSpace.split("|").map((entry) => entry.trim()).filter(Boolean);
    if (keyword === "choice") {
      options = {};
      for (const entry of items) {
        const eq = entry.indexOf("=");
        const optionValue = (eq === -1 ? entry : entry.slice(0, eq)).trim();
        const description = eq === -1 ? "" : entry.slice(eq + 1).trim();
        if (optionValue.length === 0) continue;
        options[optionValue] = description.length > 0 ? description : optionValue;
      }
      if (Object.keys(options).length < 2) {
        return {
          error:
            "A choice needs at least two options and a `--` before the question: " +
            "/decision choice: a | b -- Which one?",
        };
      }
      type = "choice";
    } else {
      levels = items;
      if (levels.length < 2) {
        return {
          error:
            "A score needs at least two levels and a `--` before the question: " +
            "/decision score: low | mid | high -- How urgent?",
        };
      }
      type = "score";
    }
  }

  const instructions = rest.trim();
  if (instructions.length === 0) {
    return { error: "Add the question after the answer space, for example: /decision choice: yes | no Is this a bug?" };
  }

  return {
    provider,
    source,
    state: instructions,
    question: normalizeQuestion({
      name: "decision",
      type,
      instructions,
      ...(options === undefined ? {} : { options }),
      ...(levels === undefined ? {} : { levels }),
    }),
  };
}

/** Format a probability as a percentage with one decimal place. */
function percent(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "n/a";
}

/** Render one normalized answer for display under a slash command. */
function formatAnswer(question, answer) {
  if (answer === null || typeof answer !== "object") return String(answer);
  if (answer.type === "refusal") return "refused to answer — treat this as needing human review";

  if (answer.type === "noul") {
    const p = answer.probability;
    const verdict = typeof p === "number" && p >= 0.5 ? "yes" : "no";
    return `probably ${verdict} (p(yes) = ${percent(p)})`;
  }
  if (answer.type === "choice") {
    const parts = [`chose "${answer.choice}" (confidence ${percent(answer.confidence)})`];
    if (answer.probabilities !== null && typeof answer.probabilities === "object") {
      const ranked = Object.entries(answer.probabilities)
        .sort((a, b) => b[1] - a[1])
        .map(([value, probability]) => `${value} ${percent(probability)}`);
      if (ranked.length > 0) parts.push(ranked.join(", "));
    }
    return parts.join(" — ");
  }
  if (answer.type === "score") {
    const parts = [`score ${answer.score} on ${question.levels.length - 1} (confidence ${percent(answer.confidence)})`];
    if (answer.probabilities !== null && typeof answer.probabilities === "object") {
      const legend = answer.legend ?? {};
      const ranked = Object.entries(answer.probabilities)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([index, probability]) => `${legend[index] ?? index} ${percent(probability)}`);
      if (ranked.length > 0) parts.push(ranked.join(", "));
    }
    return parts.join(" — ");
  }
  return JSON.stringify(answer);
}

/** Render a whole decision result for a slash-command reply. */
function formatDecisionOutcome(question, result) {
  const answer = result.answers?.[question.name];
  const lines = [
    `${result.provider} (${result.model}, via ${result.source})`,
    "",
    `Q: ${question.instructions}`,
    `A: ${formatAnswer(question, answer)}`,
  ];
  const cost = result.usage?.cost;
  if (typeof cost === "number" && Number.isFinite(cost)) {
    lines.push("");
    lines.push(`cost $${cost.toFixed(8)}`);
  }
  return lines.join("\n");
}

/** One-line explanation of each reasoning mode, shown by /decision-status. */
const REASONING_MODE_NOTES = {
  off: "only the tool and the slash commands; no automatic participation",
  advisory: "the prompt asks the model to consult a choice before guessing",
  auto: "each step gets an advisory choice over the alternatives already listed",
};

/** The reasoning modes in their natural order, cheapest first. */
const REASONING_MODES = ["off", "advisory", "auto"];

/**
 * Render the availability snapshot as the text `/decision-status` shows.
 * @param snapshot - sources and providers read by describeAvailability.
 * @param mode - the reasoning gear currently in effect.
 */
function availabilityReport(snapshot, mode) {
  const lines = [];

  lines.push(`Reasoning mode: ${mode}`);
  lines.push("");
  for (const candidate of REASONING_MODES) {
    const marker = candidate === mode ? "▸" : " ";
    lines.push(`${marker} ${candidate}: ${REASONING_MODE_NOTES[candidate]}`);
  }
  lines.push("");
  lines.push("Switch with /decision-mode <off|advisory|auto>.");
  lines.push("");

  const ready = snapshot.providers.filter((entry) => entry.available).map((entry) => entry.provider);
  lines.push(ready.length === 0
    ? "No decision backend is configured."
    : `Available backends: ${ready.join(", ")}.`);

  for (const provider of snapshot.providers) {
    if (!provider.available) {
      lines.push(`- ${provider.provider}: not configured`);
      continue;
    }
    const routes = (provider.routes ?? [])
      .map((route) => `${route.accepts.join("/")} via ${route.source}`)
      .join("; ");
    lines.push(`- ${provider.provider}: ${routes}`);
  }

  const missing = snapshot.sources.filter((entry) => !entry.configured);
  if (missing.length > 0) {
    lines.push("");
    lines.push("To add a key, run:");
    for (const entry of missing) {
      const refs = entry.envRefs.length > 0 ? ` (or set ${entry.envRefs[0]})` : "";
      lines.push(`  /decision-key ${entry.source} <key>${refs}`);
    }
  }
  return lines.join("\n");
}

/**
 * Register the plugin's slash commands.
 * @param ctx - Host context.
 * @param cfg - resolved plugin config.
 * @param describeAvailability - reads the current source/backend snapshot.
 * @param refreshPromptState - re-reads availability for the prompt section.
 * @returns one disposer that unregisters every command.
 */
function registerDecisionCommands(ctx, cfg, gear, describeAvailability, refreshPromptState) {
  const disposers = [];

  // /decision — ask one decision model from the composer, in one command.
  disposers.push(
    ctx.commands.register({
      name: "decision",
      description: "Ask a decision model one question and print the calibrated answer",
      input: {
        hint: "[@provider] [choice: a | b -- | score: low | mid | high --] <question>",
      },
      handler: async (invocation) => {
        const parsed = parseDecisionLine(invocation.rawInput, cfg.defaultProvider);
        if (parsed.error !== undefined) return { kind: "error", text: parsed.error };

        const outcome = await runDecision(ctx, cfg, {
          provider: parsed.provider,
          source: parsed.source,
          state: parsed.state,
          questions: [parsed.question],
        });
        if (!outcome.ok) return { kind: "error", text: outcome.message };

        return { kind: "success", text: formatDecisionOutcome(parsed.question, outcome.result) };
      },
    }),
  );

  // /decision-mode — switch the reasoning gear at runtime.
  disposers.push(
    ctx.commands.register({
      name: "decision-mode",
      description: "Switch how the decision model takes part in reasoning: off, advisory, or auto",
      input: {
        hint: `<${REASONING_MODES.join("|")}>`,
      },
      handler: async (invocation) => {
        const requested = invocation.rawInput.trim().toLowerCase();
        if (requested.length === 0) {
          return {
            kind: "error",
            text:
              `Current mode: ${gear.mode}. Usage: /decision-mode <${REASONING_MODES.join("|")}>. ` +
              REASONING_MODES.map((candidate) => `${candidate} — ${REASONING_MODE_NOTES[candidate]}`).join("; ") + ".",
          };
        }
        if (!REASONING_MODES.includes(requested)) {
          return {
            kind: "error",
            text: `Unknown mode "${requested}". Choose one of: ${REASONING_MODES.join(", ")}.`,
          };
        }
        const previous = gear.mode;
        if (previous === requested) {
          return { kind: "success", text: `Reasoning mode already ${requested}.` };
        }

        // Apply live, then persist. Saving an ordinary config field restarts the
        // plugin, which rebuilds the gear from the saved row, so this order
        // keeps the current turn consistent either way.
        gear.mode = requested;
        const saved = await persistReasoningMode(ctx, requested);
        const change = `Reasoning mode: ${previous} → ${requested}. ${REASONING_MODE_NOTES[requested]}.`;
        return {
          kind: "success",
          text: saved.saved
            ? `${change} Saved to this bundle's config.`
            : `${change} NOT persisted — ${saved.reason}.`,
        };
      },
    }),
  );

  // /decision-status — what is configured, and which formats each backend reads.
  disposers.push(
    ctx.commands.register({
      name: "decision-status",
      description: "Show configured decision-model backends and the input formats each accepts",
      handler: async () => {
        try {
          return { kind: "success", text: availabilityReport(await describeAvailability(ctx), gear.mode) };
        } catch (error) {
          return { kind: "error", text: `Could not read decision configuration: ${String(error?.message ?? error)}` };
        }
      },
    }),
  );

  // /decision-key — store or remove a source's key without leaving the composer.
  disposers.push(
    ctx.commands.register({
      name: "decision-key",
      description: "Store or clear a decision-model API key for one source",
      input: {
        hint: `<${SOURCE_IDS.join("|")}> <key> | clear <source>`,
      },
      handler: async (invocation) => {
        const parts = invocation.rawInput.trim().split(/\s+/).filter(Boolean);
        if (parts.length === 0) {
          const sources = SOURCE_IDS.map((source) => `${source} (${CREDENTIAL_SOURCES[source].serves.join(", ")})`).join(", ");
          return {
            kind: "error",
            text: `Usage: /decision-key <source> <key> — or /decision-key clear <source>. Sources: ${sources}.`,
          };
        }

        // clear <source>
        if (parts[0] === "clear") {
          const source = parts[1];
          if (source === undefined) return { kind: "error", text: "Usage: /decision-key clear <source>." };
          if (!SOURCE_IDS.includes(source)) {
            return { kind: "error", text: `Unknown source "${source}". Known sources: ${SOURCE_IDS.join(", ")}.` };
          }
          try {
            await clearApiKey(ctx, source);
          } catch (error) {
            return { kind: "error", text: `Could not clear the key: ${String(error?.message ?? error)}` };
          }
          await refreshPromptState();
          return { kind: "success", text: `Removed the stored ${source} key.` };
        }

        // <source> <key>
        const [source, key] = parts;
        if (!SOURCE_IDS.includes(source)) {
          return { kind: "error", text: `Unknown source "${source}". Known sources: ${SOURCE_IDS.join(", ")}.` };
        }
        if (key === undefined) {
          return { kind: "error", text: `Usage: /decision-key ${source} <key>.` };
        }
        try {
          await storeApiKey(ctx, source, key);
        } catch (error) {
          return { kind: "error", text: `Could not store the key: ${String(error?.message ?? error)}` };
        }
        await refreshPromptState();
        // Never echo the key back; state what it unlocked instead.
        return {
          kind: "success",
          text: `Stored the ${source} key; enables: ${CREDENTIAL_SOURCES[source].serves.join(", ")}.`,
        };
      },
    }),
  );

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // ignore teardown errors
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Plugin export (function form)
// ---------------------------------------------------------------------------

export const inject = ["tools", "credentials", "systemPrompt", "commands"];

/**
 * Placement for this plugin's prompt section. It sits at the end of the
 * built-in tool sections (TOOL_REPORT is 2900, TOOL_COMPUTER_USE is 3000).
 */
const DECISION_SECTION_ORDER = 2950;

/**
 * The prompt guidance, or an empty string while no backend holds a key.
 * A profile without credentials therefore sees no unusable advice.
 * @param available - backends currently holding a key.
 * @param mode - the reasoning participation mode.
 */
function decisionPromptText(available, mode = "advisory") {
  if (available.length === 0) return "";
  const lines = [
    "## Decision models",
    "",
    "A `decision` tool reaches fast decision models that answer typed questions with calibrated probabilities instead of prose.",
    "Use it when a narrow judgment has to drive a branch: classifying or routing an item, verifying a claim against evidence, or ranking options on an ordered scale.",
    "Prefer it over a chat model for those decisions; it is cheaper, faster, and returns numbers you can threshold directly.",
    "",
    "Each call sends one shared `input` (the evidence) plus one or more questions, and every question is one of:",
    "- `noul` — a yes/no question; returns the probability of yes. Read it against a threshold you choose.",
    "- `choice` — pick one option from `options`; returns the chosen value, its confidence, and per-option probabilities.",
    "- `score` — place the input on the ordered `levels`; returns the probability-weighted position and per-level probabilities.",
    "",
    "Questions in one call are evaluated independently against the same input. When one decision depends on another, send a second call after reading the first answer.",
    "Treat a `refusal` answer, and a low confidence, as a request for human review rather than as a result.",
  ];

  if (mode === "advisory") {
    lines.push(
      "",
      "### Consulting the decision model mid-reasoning",
      "Before committing to a branch whose outcome you would otherwise guess, call `decision` with a `choice` question over the concrete alternatives you are considering.",
      "Put the evidence for the choice in `input`, name each alternative in `options` with a one-line description of when it applies, and let the returned `choice` and `confidence` decide the branch.",
      "Do this when the alternatives are enumerable and the evidence is already in front of you.",
      "Do not call it for open-ended work, for steps you can settle by reading a file, or when a failure would only cost a cheap retry — those are better handled directly.",
      "A low `confidence`, or a `refusal`, means the evidence is insufficient: ask for more input or escalate rather than acting on a weak preference.",
    );
  } else if (mode === "auto") {
    lines.push(
      "",
      "### Decision-assisted steps",
      "This session runs in automatic mode: before each step the plugin may append a `Decision input` block naming the alternatives it scored.",
      "Treat a recommendation there as advisory evidence, not as an instruction.",
      "Follow it when it matches your own reading of the task; when it conflicts with later evidence in the conversation, say so and choose the better-supported path.",
    );
  }

  lines.push(
    "",
    "Accepted input differs by provider. `input` is a string or JSON state for every provider; media parts go in a state array:",
    "- `jev` and `openai` read text and images.",
    "- `google` reads text, images, audio, video, and documents (PDF, CSV, Office).",
    "A part the chosen provider cannot read is rejected before the request is sent, naming a provider that can.",
    "",
    `Available backends right now: ${available.join(", ")}. Omit \`provider\` to use the default.`,
  );
  return lines.join("\n");
}

/**
 * Persist the reasoning gear into the bundle's own config row so the choice
 * survives a plugin reload or a restart.
 *
 * The editor owns the profile file: it validates the candidate, serializes the
 * write against other profile changes, and rejects a value a higher layer
 * overrides. Writing this ordinary field restarts the plugin, which rebuilds
 * the gear from the saved value.
 *
 * @param ctx - Host context.
 * @param mode - the mode to save.
 * @returns `{ saved: true }`, or `{ saved: false, reason }` with a message
 *   suitable for showing the user.
 */
async function persistReasoningMode(ctx, mode) {
  const entry = ctx.fiber?.entry;
  const editor = ctx.get("configEditor");
  if (entry === undefined || editor === undefined) {
    return { saved: false, reason: "this profile cannot save configuration, so the change lasts only until the plugin reloads" };
  }
  try {
    await editor.edit(entry, (current) => ({ ...current, reasoningMode: mode }));
    return { saved: true };
  } catch (error) {
    return { saved: false, reason: `saving failed: ${String(error?.message ?? error)}` };
  }
}

export function apply(ctx, config) {
  const raw = config && typeof config === "object" ? config : {};
  const cfg = {
    defaultProvider: typeof raw.defaultProvider === "string" ? raw.defaultProvider : "jev",
    timeoutMs: Number.isInteger(raw.timeoutMs) && raw.timeoutMs >= 1000 ? raw.timeoutMs : 30000,
    /**
     * How the decision model participates in the model's reasoning:
     *   "off"      — only the explicit tool and commands.
     *   "advisory" — the prompt tells the model to consult `decision` before
     *                committing to a branch. The model decides when.
     *   "auto"     — before each step, the plugin itself runs a choice
     *                decision over the candidate next actions named in the
     *                conversation and injects the recommendation as context.
     */
    reasoningMode: ["off", "advisory", "auto"].includes(raw.reasoningMode) ? raw.reasoningMode : "advisory",
  };
  if (!PROVIDERS.includes(cfg.defaultProvider)) {
    throw new Error(`decision plugin: invalid defaultProvider "${cfg.defaultProvider}"`);
  }

  const disposers = [];

  // Prompt guidance. The section text is a provider evaluated on each
  // assembly, so the reported availability stays current: adding or removing a
  // key changes the guidance on the next step without a plugin reload. The
  // section renders an empty string while no backend holds a key, so an
  // unconfigured profile gets no unusable advice.
  const promptState = { available: [] };

  /** Re-read availability into promptState; safe to call at any time. */
  const refreshPromptState = async () => {
    try {
      const snapshot = await describeAvailability(ctx);
      promptState.available = snapshot.providers
        .filter((entry) => entry.available)
        .map((entry) => entry.provider);
    } catch {
      promptState.available = [];
    }
  };
  void refreshPromptState();

  // The reasoning gear is live state: /decision-mode changes it at runtime, and
  // both the prompt section and the pre-step listener read it on each use.
  const gear = { mode: cfg.reasoningMode };

  disposers.push(
    ctx.systemPrompt.section({
      name: "decision-models",
      order: DECISION_SECTION_ORDER,
      text: () => decisionPromptText(promptState.available, gear.mode),
    }),
  );

  // Automatic participation: before each step, score the alternatives the
  // conversation already named and append the recommendation as context. The
  // listener stays registered for the plugin's lifetime and reads the gear, so
  // switching to "auto" takes effect on the next step rather than a reload.
  // Every path it does not own returns the accepted decision unchanged, so the
  // other pre-step policy keeps its decision.
  disposers.push(
    ctx.on(
      "agent/pre-step",
      async (payload, next) => {
        const decision = await next();
        if (gear.mode !== "auto") return decision;
        if (decision.kind !== "enter" || payload.signal.aborted) return decision;
        try {
          const note = await proposeNextChoice(ctx, cfg, payload);
          if (note === undefined) return decision;
          const message = {
            role: "user",
            content: [{ type: "text", text: note }],
            source: { kind: "plugin", plugin: "dsh-decision-plugin" },
          };
          // Preserve every field the accepted decision carries, including
          // `startsRequestSeries`.
          return { ...decision, messages: [...decision.messages, message] };
        } catch {
          // A failed advisory call must never block the step.
          return decision;
        }
      },
      { global: true },
    ),
  );

  disposers.push(
    ctx.tools.register({
      name: "decision",
      description:
        "Ask a fast decision model (Jev, Google Gemini Decision 1, or OpenAI Decisions) typed questions — yes/no, choice, or score — over shared input state, and get calibrated probabilities back instead of prose. Use for routing, classification, verification, and ranking.",
      parameters: {
        type: "object",
        properties: {
          provider: {
            type: "string",
            enum: PROVIDERS,
            description:
              `Which decision backend to use. Defaults to "${cfg.defaultProvider}"; omit it to let the configured default decide. ` +
              "Only backends reachable through a configured key can run — call decision:list-providers to see which are available.",
          },
          source: {
            type: "string",
            enum: SOURCE_IDS,
            description:
              "Optional route preference: openrouter reaches every backend, while google and openai reach their own model natively. " +
              "Omit to use the first configured route. A source reaches a backend only through its own model.",
          },
          input: {
            description:
              "Shared evidence the questions are judged against: a string, or a JSON object/array of state. " +
              "An array may also carry media parts. Accepted formats differ by provider: " +
              "jev takes text (and images on TypeSafe's own endpoint); openai takes text and images; " +
              "google takes text, images, audio, video, and documents (PDF, CSV, Office). " +
              "A part the chosen route cannot read is rejected before the request is sent.",
          },
          questions: {
            type: "array",
            description:
              "One or more typed questions, evaluated against the shared input in a single request.",
            items: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "Unique key echoed back in the answer map.",
                },
                type: {
                  type: "string",
                  enum: QUESTION_TYPES,
                  description:
                    "noul = yes/no (returns probability of yes); choice = pick one option; score = place on an ordered scale.",
                },
                instructions: {
                  type: "string",
                  description: "The question in plain language.",
                },
                options: {
                  type: "object",
                  description:
                    "For choice only: a map of option value -> description of when it applies.",
                },
                levels: {
                  type: "array",
                  description:
                    "For score only: ordered labels from low to high.",
                  items: { type: "string" },
                },
              },
              required: ["name", "type", "instructions"],
            },
          },
        },
        required: ["input", "questions"],
      },
      output: {
        schema: {
          type: "object",
          properties: {
            provider: { type: "string" },
            answers: { type: "object" },
            usage: { type: "object" },
          },
        },
        render(args, value) {
          const v = value;
          return [{ type: "text", text: JSON.stringify(v, null, 2) }];
        },
      },
      async execute(args) {
        const provider = args.provider ?? cfg.defaultProvider;
        const questions = args.questions.map(normalizeQuestion);
        return (await runDecision(ctx, cfg, { provider, source: args.source, state: args.input, questions })).outcome;
      },
    }),
  );

  // Helper tool so the user can store a provider API key through the agent.
  disposers.push(
    ctx.tools.register({
      name: "decision:set-key",
      description:
        "Store the API key of one decision-model source: `openrouter` (serves jev, google, and openai), `typesafe` (serves jev directly on TypeSafe's own endpoint), `google`, or `openai`. Any key you provide enables exactly the backends that source serves; unconfigured backends stay unavailable. A key already present at an ambient reference such as TYPESAFE_API_KEY needs no copy here.",
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            enum: SOURCE_IDS,
            description: SOURCE_IDS.map((source) => `${source}: ${CREDENTIAL_SOURCES[source].hint}`).join(" "),
          },
          apiKey: { type: "string", description: "The secret API key to store." },
        },
        required: ["source", "apiKey"],
      },
      output: {
        schema: { type: "object", properties: { ok: { type: "boolean" }, serves: { type: "array" } } },
        render(args, value) {
          const v = value;
          const serves = Array.isArray(v?.serves) ? v.serves.join(", ") : "";
          return [{ type: "text", text: serves ? `Key stored for "${args.source}"; enables: ${serves}.` : "API key stored." }];
        },
      },
      async execute(args) {
        try {
          await storeApiKey(ctx, args.source, String(args.apiKey));
        } catch (error) {
          return { isError: true, error: { message: String(error?.message ?? error) } };
        }
        await refreshPromptState();
        return { ok: true, serves: [...CREDENTIAL_SOURCES[args.source].serves] };
      },
    }),
  );

  // Helper tool that reports which sources hold keys and which backends work.
  disposers.push(
    ctx.tools.register({
      name: "decision:list-providers",
      description:
        "Report which decision-model API keys are configured and which backends (jev, google, openai) are therefore available. Use before choosing a provider.",
      parameters: { type: "object", properties: {} },
      output: {
        schema: {
          type: "object",
          properties: { sources: { type: "array" }, providers: { type: "array" } },
        },
        render(args, value) {
          const v = value;
          const lines = [];
          for (const provider of v?.providers ?? []) {
            if (!provider.available) {
              lines.push(`${provider.provider}: not configured`);
              continue;
            }
            lines.push(`${provider.provider}: available via ${provider.via.join(", ")}`);
            for (const route of provider.routes ?? []) {
              lines.push(`  ${route.source} (${route.model}) accepts: ${route.accepts.join(", ")}`);
            }
          }
          for (const source of v?.sources ?? []) {
            if (source.configured) {
              lines.push(
                source.origin === "record"
                  ? `${source.source}: key from decision/${source.source}`
                  : `${source.source}: key from ${source.origin}`,
              );
            } else {
              const refs = Array.isArray(source.envRefs) && source.envRefs.length > 0
                ? `no key; looks for ${source.envRefs.join(", ")}`
                : "no key";
              lines.push(`${source.source}: ${refs}`);
            }
          }
          return [{ type: "text", text: lines.join("\n") }];
        },
      },
      async execute() {
        return describeAvailability(ctx);
      },
    }),
  );

  // Helper tool to remove a source's key when it is no longer wanted.
  disposers.push(
    ctx.tools.register({
      name: "decision:clear-key",
      description: "Remove the stored API key of one decision-model source (openrouter, google, or openai). Backends that no other source serves become unavailable.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", enum: SOURCE_IDS, description: "Which source's key to remove." },
        },
        required: ["source"],
      },
      output: {
        schema: { type: "object", properties: { ok: { type: "boolean" } } },
        render() {
          return [{ type: "text", text: "API key removed." }];
        },
      },
      async execute(args) {
        try {
          await clearApiKey(ctx, args.source);
        } catch (error) {
          return { isError: true, error: { message: String(error?.message ?? error) } };
        }
        await refreshPromptState();
        return { ok: true };
      },
    }),
  );

  // Human-facing slash commands. Both run in the Host without a model turn:
  // /decision-status reports configuration, and /decision-key manages keys so
  // the composer is enough to set the plugin up.
  disposers.push(registerDecisionCommands(ctx, cfg, gear, describeAvailability, refreshPromptState));

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // ignore teardown errors
      }
    }
  };
}
