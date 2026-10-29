import { expect, it } from "vitest";
import {
  trackVoiceOwnerRelease,
  waitForVoiceOwnerRelease,
} from "../src/voice-owner-lifecycle.js";

it("a new component owner waits for the previous instance to actually release its lock", async () => {
  let finish!: () => void;
  let resumed = false;
  const cleanup = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const tracked = trackVoiceOwnerRelease("same-account", cleanup);
  const newMount = waitForVoiceOwnerRelease("same-account").then(() => {
    resumed = true;
  });
  await Promise.resolve();
  expect(resumed).toBe(false);
  await waitForVoiceOwnerRelease("different-account");
  expect(resumed).toBe(false);
  finish();
  await tracked;
  await newMount;
  expect(resumed).toBe(true);
});

it("overlapping cleanup registrations do not drop an earlier pending release", async () => {
  let finish!: () => void;
  let resumed = false;
  void trackVoiceOwnerRelease(
    "overlap",
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  void trackVoiceOwnerRelease("overlap", Promise.resolve());
  const waiter = waitForVoiceOwnerRelease("overlap").then(() => {
    resumed = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(resumed).toBe(false);
  finish();
  await waiter;
  expect(resumed).toBe(true);
});
