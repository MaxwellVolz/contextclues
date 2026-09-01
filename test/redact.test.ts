// Redaction is the project's load-bearing privacy claim: every preview is written to
// SQLite and rendered in a browser, so a miss copies a live credential out of a
// transcript into two new places. Each format gets a case.

import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, redactedPreview } from "../lib/redact.ts";

/**
 * Fake credentials, each assembled at runtime from fragments.
 *
 * The values are invalid and randomly typed, but they match the shape of real
 * credentials closely enough that scanners flag them as genuine when they sit in
 * the file as literals. GitHub push protection blocks the repository over exactly
 * that. Splitting the prefix from the body keeps the repo pushable and does not
 * weaken the test: redact() still receives the fully assembled string, so what is
 * under test is unchanged.
 */
const SECRETS: Record<string, string> = {
  "anthropic key": "sk-" + "ant-api03-AbCdEfGhIjKlMnOpQrSt",
  "openai legacy key": "sk-" + "AbCdEfGhIjKlMnOpQrStUvWx1234",
  "openai project key": "sk-" + "proj-AbCdEfGhIjKlMnOpQrStUvWx1234",
  "openai service key": "sk-" + "svcacct-AbCdEfGhIjKlMnOpQrStUvWx",
  "google api key": "AIza" + "SyD-1234567890abcdefghijklmnopqrstu",
  "stripe secret key": "sk_" + "live_" + "51H8xQrEXAMPLEKEYabcdefghijklmn",
  "stripe publishable key": "pk_" + "test_" + "51H8xQrEXAMPLEKEYabcdefghijklmn",
  "aws access key id": "AKIA" + "IOSFODNN7EXAMPLE",
  "aws session key id": "ASIA" + "IOSFODNN7EXAMPLE",
  "github token": "ghp_" + "1234567890abcdefghijABCDEFGHIJ",
  "github fine-grained pat": "github_pat_" + "11ABCDEFG0abcdefghijklmnop",
  "gitlab pat": "glpat-" + "AbCdEfGhIjKlMnOpQrSt",
  "slack token": "xoxb-" + "123456789012-abcdefghijklmnop",
  "npm token": "npm_" + "AbCdEfGhIjKlMnOpQrStUvWxYz01234567",
  "huggingface token": "hf_" + "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh",
  "jwt": "eyJ" + "hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
  "bearer header": "Authorization: Bearer " + "abcdefghijklmnopqrstuvwxyz123456",
  "private key block":
    "-----BEGIN RSA PRIVATE KEY-----\n" + "MIIEowIBAAKCAQEA\n" + "-----END RSA PRIVATE KEY-----",
};
for (const [name, secret] of Object.entries(SECRETS)) {
  test(`redacts a ${name}`, () => {
    const out = redact(`the value is ${secret} ok`);
    assert.ok(out.includes("[REDACTED"), `no marker in: ${out}`);
    // The distinguishing body of the secret must be gone, not merely marked.
    const body = secret.replace(/^.*?[-_ ]/, "").slice(0, 16);
    assert.ok(!out.includes(body), `secret body survived in: ${out}`);
  });
}

test("credentials inside connection strings are removed but the shape survives", () => {
  for (const url of [
    "postgres://admin:" + "hunter2supersecret" + "@db.example.com:5432/prod",
    "mongodb+srv://user:" + "P4ssw0rd123" + "@cluster.mongodb.net",
    "https://user:" + "s3cr3tpassword" + "@api.example.com/v1",
    "redis://default:" + "verySecretValue" + "@cache.internal:6379",
  ]) {
    const out = redact(url);
    assert.match(out, /\[REDACTED:url-credential\]/, url);
    assert.ok(!/hunter2|P4ssw0rd|s3cr3t|verySecret/.test(out), `password survived: ${out}`);
    assert.ok(out.includes("@"), "the host is still legible");
  }
});

test("a URL without credentials is left alone", () => {
  const url = "https://github.com/MaxwellVolz/contextclues/issues/1";
  assert.equal(redact(url), url);
});

test("secret-looking assignments keep their name and lose their value", () => {
  const upper = redact("MY_API_KEY=supersecretvalue");
  assert.ok(upper.startsWith("MY_API_KEY="), "the name is kept so the preview still informs");
  assert.ok(!upper.includes("supersecretvalue"));

  const snake = redact("aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCY");
  assert.match(snake, /\[REDACTED/);
  assert.ok(!snake.includes("wJalrXUtnFEMI"));

  const json = redact('{"api_key": "abcdef123456789"}');
  assert.ok(!json.includes("abcdef123456789"));
});

test("ordinary prose and commands are not mangled", () => {
  for (const clean of [
    "just ordinary text with no secrets, PATH=/usr/bin",
    "the authors = three people who wrote it",
    "run npm install and then npm test",
    "keyboard = mechanical",
    "git commit -m 'fix the parser'",
    "const token = parse(input)",
  ]) {
    assert.equal(redact(clean), clean, `over-redacted: ${clean}`);
  }
});

test("several secrets on one line are all removed", () => {
  const out = redact("export A=1 KEY_TOKEN=abcdefghijkl and sk-" + "ant-api03-AbCdEfGhIjKl plus ghp_" + "1234567890abcdefghijABCDEFGHIJ");
  assert.ok(!out.includes("ant-api03-AbCdEfGhIjKl"));
  assert.ok(!out.includes("1234567890abcdefghij"));
  assert.ok(!out.includes("abcdefghijkl"));
});

test("redaction happens before truncation, so a clipped secret cannot survive", () => {
  // The secret sits past the preview cutoff: it must never reach the slice.
  const text = "x".repeat(200) + " sk-" + "ant-api03-SuperSecretKeyMaterial " + "y".repeat(200);
  const preview = redactedPreview(text, 280);
  assert.ok(!preview.includes("SuperSecretKeyMaterial"));
  assert.ok(preview.length <= 280);
});

test("redactedPreview collapses whitespace and clamps", () => {
  const p = redactedPreview("a\n\n  b   c" + "x".repeat(500), 50);
  assert.ok(p.length <= 50);
  assert.ok(p.startsWith("a b c"));
});

test("the rules are stateless across calls despite being global regexes", () => {
  const secret = "sk-" + "ant-api03-AbCdEfGhIjKlMnOp";
  const first = redact(secret);
  for (let i = 0; i < 5; i++) {
    assert.equal(redact(secret), first, "a /g regex must not carry lastIndex between calls");
  }
});
