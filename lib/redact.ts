// Secret redaction. Applied to every preview BEFORE it is stored in SQLite or rendered,
// so likely secrets never leave the transcript files they came from.

interface Rule {
  kind: string;
  re: RegExp;
}

const RULES: Rule[] = [
  { kind: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{8,}/g },
  { kind: "openai-key", re: /sk-[A-Za-z0-9]{20,}/g },
  { kind: "aws-key-id", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { kind: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g },
  { kind: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { kind: "bearer", re: /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}/g },
  {
    kind: "env-assignment",
    // KEY=value pairs where the key looks secret-ish and the value is non-trivial.
    re: /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z0-9_]*)\s*[=:]\s*['"]?[^\s'"]{6,}['"]?/g,
  },
  {
    kind: "kv-secret",
    re: /\b(api[_-]?key|token|secret|password|passwd|client[_-]?secret)['"]?\s*[:=]\s*['"][^'"]{6,}['"]/gi,
  },
];

export function redact(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.re, (_m, g1) =>
      rule.kind === "env-assignment" && typeof g1 === "string"
        ? `${g1}=[REDACTED:${rule.kind}]`
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
