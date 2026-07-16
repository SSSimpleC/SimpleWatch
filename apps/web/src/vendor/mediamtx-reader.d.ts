export {};

declare global {
  interface Window {
    MediaMTXWebRTCReader: new (options: {
      url: string;
      user: string;
      pass: string;
      token: string;
      onTrack: (event: RTCTrackEvent) => void;
      onError: (error: string) => void;
    }) => {
      close(): void;
      getPeerConnection(): RTCPeerConnection | null;
    };
  }
}
