import type { BrowserContext } from "@playwright/test";

/** Stable test identities; the runner still acquires fake-device gUM explicitly. */
export async function installStableMicrophones(
  context: BrowserContext,
  syntheticTone = false,
): Promise<void> {
  await context.addInitScript(
    ({ tone }) => {
      const nativeCapture = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      const inputs = ["voice-fixture-mic-a", "voice-fixture-mic-b"].map(
        (deviceId, index) => ({
          kind: "audioinput" as const,
          deviceId,
          groupId: `voice-fixture-group-${index}`,
          label: `Fixture microphone ${index === 0 ? "A" : "B"}`,
          toJSON() {
            return {
              kind: this.kind,
              deviceId: this.deviceId,
              groupId: this.groupId,
              label: this.label,
            };
          },
        }),
      );
      navigator.mediaDevices.enumerateDevices = () => Promise.resolve(inputs);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        if (!constraints?.audio || constraints.video)
          throw new Error("Only fake audio is allowed");
        const requested =
          typeof constraints.audio === "object" ? constraints.audio : {};
        const value = requested.deviceId;
        const exact =
          typeof value === "string"
            ? value
            : value && !Array.isArray(value)
              ? value.exact
              : undefined;
        const id = typeof exact === "string" ? exact : "default";
        const input = inputs.find((device) => device.deviceId === id);
        if (id !== "default" && !input)
          throw new DOMException(
            "Unknown fixture input",
            "OverconstrainedError",
          );
        const nativeConstraints = { ...requested };
        delete nativeConstraints.deviceId;
        const fake = await nativeCapture({
          audio: nativeConstraints,
          video: false,
        });
        let stream = fake;
        if (tone) {
          fake.getTracks().forEach((track) => track.stop());
          const fixture = window as unknown as {
            voiceNativeAudioContext?: typeof AudioContext;
            voiceFixtureContextObservations?: AudioContext[];
          };
          const Context = fixture.voiceNativeAudioContext ?? AudioContext;
          const donor = new Context({ sampleRate: 48_000 });
          fixture.voiceFixtureContextObservations?.push(donor);
          await donor.resume();
          const destination = donor.createMediaStreamDestination();
          destination.channelCount = 1;
          destination.channelCountMode = "explicit";
          const oscillator = donor.createOscillator();
          oscillator.frequency.value = id === inputs[1]!.deviceId ? 550 : 330;
          const gain = donor.createGain();
          gain.gain.value = 0.03;
          oscillator.connect(gain).connect(destination);
          oscillator.start();
          stream = destination.stream;
          const track = stream.getAudioTracks()[0]!;
          const stop = track.stop.bind(track);
          let stopped = false;
          track.stop = () => {
            if (stopped) return;
            stopped = true;
            stop();
            oscillator.stop();
            oscillator.disconnect();
            gain.disconnect();
            void donor.close();
          };
          const observations = (
            window as unknown as {
              voiceCaptureObservation?: { tracks: MediaStreamTrack[] };
            }
          ).voiceCaptureObservation;
          if (observations && !observations.tracks.includes(track))
            observations.tracks.push(track);
        }
        const track = stream.getAudioTracks()[0]!;
        const settings = track.getSettings.bind(track);
        track.getSettings = () => ({
          ...settings(),
          ...(tone ? { channelCount: 1 } : {}),
          deviceId: input?.deviceId ?? "default",
          groupId: input?.groupId ?? "unmapped-default-fixture-group",
        });
        return stream;
      };
    },
    { tone: syntheticTone },
  );
}
