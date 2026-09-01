// Secret redaction. Applied to every preview BEFORE it is stored in SQLite or rendered,
// so likely secrets never leave the transcript files they came from.
//
// Redaction is deliberately eager: a preview is a 280-character hint, so over-redacting
// costs a little legibility while under-redacting copies a live credential into our
// database and onto a web page. When in doubt, scrub.

interface Rule {
  kind: string;
  re: RegExp;
  /** Replacement; defaults to a bare [REDACTED:kind] marker. */
  replace?: (m: string, ...groups: string[]) => string;
}

const RULES: Rule[] = [
  // ---- vendor-prefixed API keys ----
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g },
  // Stripe and friends: sk_live_… / pk_test_… / rk_live_…
  { kind: "stripe-key", re: /\b[sprk]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g },
  // OpenAI. Modern keys are sk-proj-… / sk-svcacct-… / sk-admin-…, so the character
  // class must allow the internal hyphens and underscores those prefixes introduce.
  { kind: "openai-key", re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { kind: "google-api-key", re: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { kind: "aws-key-id", re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { kind: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { kind: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{16,}\b/g },
  { kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "npm-token", re: /\bnpm_[A-Za-z0-9]{30,}\b/g },
  { kind: "huggingface-token", re: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g },
  {
    kind: "private-key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  },
  { kind: "bearer", re: /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}/g },

  // ---- credentials embedded in URLs ----
  // postgres://user:pw@host, mongodb+srv://…, https://user:pw@api… — connection strings
  // are extremely common in transcripts. Keep the scheme, host and user readable.
  {
    kind: "url-credential",
    re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s/@]+)@/gi,
    replace: (_m, scheme, user) => `${scheme}${user}:[REDACTED:url-credential]@`,
  },

  // ---- assignments whose name says "secret" ----
  {
    kind: "env-assignment",
    // SCREAMING_SNAKE names, e.g. MY_API_KEY=… — keep the name, drop the value.
    re: /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z0-9_]*)\s*[=:]\s*['"]?[^\s'"]{6,}['"]?/g,
    replace: (_m, name) => `${name}=[REDACTED:env-assignment]`,
  },
  {
    kind: "snake-assignment",
    // lower_snake_case ending in a secret-ish word, e.g. aws_secret_access_key = …
    // The trailing underscore requirement keeps ordinary prose ("authors = …") out.
    re: /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)*_(?:key|token|secret|password|passwd|credential)s?)\s*[=:]\s*['"]?[^\s'"]{6,}['"]?/gi,
    replace: (_m, name) => `${name}=[REDACTED:snake-assignment]`,
  },
  {
    kind: "kv-secret",
    re: /\b(api[_-]?key|token|secret|password|passwd|client[_-]?secret)['"]?\s*[:=]\s*['"][^'"]{6,}['"]/gi,
  },
];

export function redact(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.re, (m, ...groups) =>
      rule.replace
        ? rule.replace(m, ...(groups.filter((g) => typeof g === "string") as string[]))
        : `[REDACTED:${rule.kind}]`,
    );
  }
  return out;
}

/** Redact, collapse whitespace, and clamp to a preview length. */
export function redactedPreview(text: string, max = 280): string {
  const clean = redact(text).replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}
