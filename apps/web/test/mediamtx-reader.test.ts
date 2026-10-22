import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type Reader = { close(): void; getPeerConnection(): FakePeer | null };
type ReaderConstructor = new (options: {
  url: string;
  token: string;
  autoRetry: boolean;
  onTrack: (event: unknown) => void;
  onError: (error: string) => void;
}) => Reader;

const offer = [
  "v=0",
  "a=ice-ufrag:offer",
  "a=ice-pwd:password",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "a=rtpmap:96 H264/90000",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=rtpmap:111 opus/48000/2",
  // Advertised codecs make the initial feature-probe peers finish without a network call.
  "a=rtpmap:100 pcma/8000/2",
  "a=rtpmap:101 multiopus/48000/6",
  "a=rtpmap:102 L16/48000/2",
  "",
].join("\r\n");

class FakePeer {
  public connectionState = "connected";
  public ontrack: ((event: unknown) => void) | null = null;
  public onconnectionstatechange: (() => void) | null = null;
  public onicecandidate: ((event: unknown) => void) | null = null;
  public ondatachannel: ((event: unknown) => void) | null = null;
  public readonly addTransceiver = vi.fn();
  public readonly createDataChannel = vi.fn();
  public readonly createOffer = vi.fn(() => Promise.resolve({ sdp: offer }));
  public readonly setLocalDescription = vi.fn(() => Promise.resolve());
  public readonly setRemoteDescription = vi.fn(() => Promise.resolve());
  public readonly close = vi.fn(() => {
    this.connectionState = "closed";
    this.onconnectionstatechange?.();
  });
  public readonly setJitter = vi.fn();
  public readonly getReceivers = vi.fn(() => [
    {
      set jitterBufferTarget(value: number) {
        void value;
      },
    },
  ]);
}

function harness(postResponse?: Promise<Response>, deleteFails = false) {
  const peers: FakePeer[] = [];
  class Peer extends FakePeer {
    public constructor() {
      super();
      peers.push(this);
    }
  }
  const fetch = vi.fn((_url: string, init: RequestInit) => {
    if (init.method === "OPTIONS")
      return Promise.resolve(new Response(null, { status: 204 }));
    if (init.method === "POST")
      return (
        postResponse ??
        Promise.resolve(
          new Response("answer", {
            status: 201,
            headers: { Location: "/session/one" },
          }),
        )
      );
    if (init.method === "DELETE" && deleteFails)
      return Promise.reject(new Error("disconnected"));
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  const schedule = vi.fn();
  const window = { setTimeout: schedule } as unknown as {
    MediaMTXWebRTCReader: ReaderConstructor;
  };
  runInNewContext(
    readFileSync(resolve("apps/web/src/vendor/mediamtx-reader.js"), "utf8"),
    {
      window,
      RTCPeerConnection: Peer,
      RTCSessionDescription: class {
        public constructor(public readonly init: unknown) {}
      },
      fetch,
      URL,
      AbortController,
      AbortSignal,
      clearTimeout: vi.fn(),
    },
  );
  const onTrack = vi.fn();
  const onError = vi.fn();
  const reader = new window.MediaMTXWebRTCReader({
    url: "https://watch.example.test/program/test/whep",
    token: "temporary-token",
    autoRetry: false,
    onTrack,
    onError,
  });
  return { reader, peers, fetch, schedule, onTrack, onError };
}

describe("MediaMTX reader single recovery owner", () => {
  it("does not override the browser adaptive jitter buffer", async () => {
    const test = harness();
    await vi.waitFor(() =>
      expect(
        test.reader.getPeerConnection()?.setRemoteDescription,
      ).toHaveBeenCalledTimes(1),
    );
    expect(
      test.reader.getPeerConnection()?.getReceivers,
    ).not.toHaveBeenCalled();
    test.reader.close();
  });

  it("closes the peer and session exactly once and rejects late callbacks", async () => {
    const test = harness(undefined, true);
    await vi.waitFor(() =>
      expect(
        test.reader.getPeerConnection()?.setRemoteDescription,
      ).toHaveBeenCalledTimes(1),
    );
    const peer = test.reader.getPeerConnection()!;
    const staleTrack = peer.ontrack!;
    test.reader.close();
    test.reader.close();
    staleTrack({ track: { id: "late", kind: "video" } });
    await Promise.resolve();
    expect(test.reader.getPeerConnection()).toBeNull();
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(peer.ontrack).toBeNull();
    expect(test.onTrack).not.toHaveBeenCalled();
    expect(test.onError).not.toHaveBeenCalled();
    expect(
      test.fetch.mock.calls.filter(([, init]) => init.method === "DELETE"),
    ).toHaveLength(1);
    expect(test.fetch).toHaveBeenCalledWith(
      "https://watch.example.test/session/one",
      expect.objectContaining({
        method: "DELETE",
        headers: { Authorization: "Bearer temporary-token" },
      }),
    );
  });

  it("notifies one connection failure and never starts an internal retry", async () => {
    const test = harness();
    await vi.waitFor(() =>
      expect(
        test.reader.getPeerConnection()?.setRemoteDescription,
      ).toHaveBeenCalledTimes(1),
    );
    const peer = test.reader.getPeerConnection()!;
    const oldStateChange = peer.onconnectionstatechange!;
    peer.connectionState = "failed";
    oldStateChange();
    oldStateChange();
    expect(test.reader.getPeerConnection()).toBeNull();
    expect(test.onError).toHaveBeenCalledTimes(1);
    expect(test.schedule).not.toHaveBeenCalled();
    expect(peer.close).toHaveBeenCalledTimes(1);
    test.reader.close();
  });

  it("deletes a session created by a late POST after close without attaching its answer", async () => {
    let finish!: (value: Response) => void;
    const test = harness(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await vi.waitFor(() =>
      expect(
        test.fetch.mock.calls.some(([, init]) => init.method === "POST"),
      ).toBe(true),
    );
    const peer = test.reader.getPeerConnection()!;
    test.reader.close();
    finish(
      new Response("answer", {
        status: 201,
        headers: { Location: "/session/late" },
      }),
    );
    await vi.waitFor(() =>
      expect(
        test.fetch.mock.calls.filter(([, init]) => init.method === "DELETE"),
      ).toHaveLength(1),
    );
    expect(peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(test.onError).not.toHaveBeenCalled();
    expect(test.schedule).not.toHaveBeenCalled();
  });

  it("reports rejected WHEP authorization once without retry", async () => {
    const test = harness(Promise.resolve(new Response(null, { status: 401 })));
    await vi.waitFor(() => expect(test.onError).toHaveBeenCalledTimes(1));
    expect(test.onError.mock.calls[0]?.[0]).toContain("401");
    expect(test.schedule).not.toHaveBeenCalled();
    expect(test.reader.getPeerConnection()).toBeNull();
    test.reader.close();
  });

  it("does not forward session credentials to an unexpected Location origin", async () => {
    const test = harness(
      Promise.resolve(
        new Response("answer", {
          status: 201,
          headers: { Location: "https://other.example.test/session" },
        }),
      ),
    );
    await vi.waitFor(() => expect(test.onError).toHaveBeenCalledTimes(1));
    expect(test.onError.mock.calls[0]?.[0]).toContain("origin mismatch");
    expect(
      test.fetch.mock.calls.every(
        ([url]) => !url.includes("other.example.test"),
      ),
    ).toBe(true);
    test.reader.close();
  });
});
