/* global AudioContext, OfflineAudioContext, MediaStream */
import {
  MicrophoneGainProcessor,
  VoiceAudioGraph,
} from "../../apps/web/src/voice/audio-graph.ts";

// Test-only adapter: real browser DSP, synthetic buffers, no physical microphone or speaker.
export async function renderGain({
  direction,
  volume,
  master = 100,
  channels = 1,
  voices = 1,
  amplitude = 0.02,
}) {
  const offline = new OfflineAudioContext(channels, 48_000, 48_000);
  const donor = new AudioContext();
  const sourceTrack = donor
    .createMediaStreamDestination()
    .stream.getAudioTracks()[0];
  const trackCopies = [];
  const context = new Proxy(offline, {
    get(target, key) {
      if (key === "close") return () => Promise.resolve();
      if (key === "createMediaStreamSource")
        return () => {
          const buffer = offline.createBuffer(channels, 48_000, 48_000);
          for (let channel = 0; channel < channels; channel += 1) {
            const data = buffer.getChannelData(channel);
            const frequency = channel === 0 ? 330 : 550;
            for (let index = 0; index < data.length; index += 1)
              data[index] =
                amplitude *
                Math.sin((2 * Math.PI * frequency * index) / 48_000);
          }
          const source = offline.createBufferSource();
          source.buffer = buffer;
          source.start(0);
          return source;
        };
      if (key === "createMediaStreamDestination")
        return () => {
          const destination = offline.createGain();
          destination.connect(offline.destination);
          const clone = sourceTrack.clone();
          trackCopies.push(clone);
          Object.defineProperty(destination, "stream", {
            value: new MediaStream([clone]),
          });
          return destination;
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let graph;
  let processor;
  try {
    if (direction === "receive") {
      graph = new VoiceAudioGraph(context, master);
      for (let index = 0; index < voices; index += 1)
        graph.addTrack(String(index), sourceTrack, volume);
    } else {
      processor = new MicrophoneGainProcessor(volume, channels);
      await processor.init({
        kind: "audio",
        track: sourceTrack,
        audioContext: context,
      });
      processor.setSending(true);
    }
    const rendered = await offline.startRendering();
    const results = [];
    for (let channel = 0; channel < channels; channel += 1) {
      const samples = rendered.getChannelData(channel).slice(12_000, 40_000);
      let sum = 0;
      let peak = 0;
      let crossing = 0;
      for (let index = 0; index < samples.length; index += 1) {
        const value = samples[index];
        if (!Number.isFinite(value)) throw new Error("Non-finite audio output");
        sum += value * value;
        peak = Math.max(peak, Math.abs(value));
        if (index && value > 0 && samples[index - 1] <= 0) crossing += 1;
      }
      results.push({
        rms: Math.sqrt(sum / samples.length),
        peak,
        frequency: (crossing * 48_000) / samples.length,
      });
    }
    return { channels: results };
  } finally {
    await processor?.destroy();
    await graph?.destroy();
    sourceTrack.stop();
    trackCopies.forEach((track) => track.stop());
    await donor.close();
  }
}
