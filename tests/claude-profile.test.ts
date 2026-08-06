import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readClaudeProfile, validateClaudeProfile, writeClaudeProfile } from "../src/claude-profile.ts";
import { makeSyntheticProfile } from "./helpers.ts";

test("validates a synthetic versioned profile", () => {
  const profile = makeSyntheticProfile();
  assert.equal(validateClaudeProfile(structuredClone(profile)).claudeCode.version, "2.1.220");
});

test("rejects credentials and version/hash drift", () => {
  const withCredential = structuredClone(makeSyntheticProfile()) as any;
  withCredential.request.headers.authorization = "Bearer should-not-exist";
  assert.throws(() => validateClaudeProfile(withCredential), /forbidden request\/credential fields/);

  const versionDrift = structuredClone(makeSyntheticProfile()) as any;
  versionDrift.request.headers["user-agent"] = "claude-cli/2.1.219 (external, sdk-cli)";
  assert.throws(() => validateClaudeProfile(versionDrift), /user-agent does not match/);

  const changedSystem = structuredClone(makeSyntheticProfile()) as any;
  changedSystem.request.systemTemplate[2].text += " changed";
  assert.throws(() => validateClaudeProfile(changedSystem), /system hash does not match/);

  const duplicateTools = structuredClone(makeSyntheticProfile()) as any;
  duplicateTools.request.defaultToolNames.push("Agent");
  assert.throws(() => validateClaudeProfile(duplicateTools), /must not contain duplicates/);
});

test("writes mode-0600 profiles and refuses loose permissions", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-anyrouter-profile-test-"));
  const path = join(directory, "profile.json");
  try {
    const profile = makeSyntheticProfile();
    const { local, hashes: _hashes, ...input } = profile;
    writeClaudeProfile(path, { ...input, local });
    assert.equal(readClaudeProfile(path).profile.local.deviceId, "a".repeat(64));
    assert.doesNotMatch(readFileSync(path, "utf8"), /authorization|x-api-key/i);
    chmodSync(path, 0o644);
    assert.throws(() => readClaudeProfile(path), /must not be accessible by group\/other/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
