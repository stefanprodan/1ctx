// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The capture graph: the microphone's stream into an AudioWorklet that
// hands its frames over in chunks. The context runs at the device's own
// rate, since Firefox refuses to join a stream to a context of another;
// the composer downsamples each chunk as it lands (dictation.ts), so a clip
// holds only its 16 kHz samples. No MediaRecorder, no container, no
// decode, and stop is at once.

// the processor, loaded from a Blob URL since the page has no script
// source to serve it from. It copies channel 0 of each 128-frame quantum
// (the node downmixes to one channel) into a buffer it hands over whole,
// about 40 ms at a time, so the page wakes some 25 times a second
const PROCESSOR = `
class DictationTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(2048);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("dictation-tap", DictationTap);
`;

export type Capture = {
  // the context's rate, the device's
  rate: number;
};

// a start under way: ready settles once the graph runs; cancel lets
// everything go at once, at any point, the graph included once it is up,
// so the browser's mic indicator goes off. Safe to call twice.
export type Pending = { ready: Promise<Capture>; cancel: () => void };

// the parts of the browser startCapture touches, so a test can hold
// each step: the permission prompt, the module load, the resume
type Track = {
  readonly readyState: string;
  stop(): void;
  addEventListener(type: "ended", fn: () => void): void;
};
type Stream = { getTracks(): Track[] };
export type CaptureContext = {
  readonly state: string;
  readonly sampleRate: number;
  onstatechange: (() => void) | null;
  resume(): Promise<void>;
  close(): Promise<void>;
  addModule(url: string): Promise<void>;
  // the stream into the tap, whose chunks go to onChunk
  wire(stream: Stream, onChunk: (chunk: Float32Array) => void): void;
};
export type CaptureParts = {
  context(): CaptureContext;
  getUserMedia(constraints: MediaStreamConstraints): Promise<Stream>;
  moduleUrl(): { url: string; revoke(): void };
};

const BROWSER: CaptureParts = {
  context() {
    const context = new AudioContext();
    return {
      get state() {
        return context.state as string;
      },
      get sampleRate() {
        return context.sampleRate;
      },
      set onstatechange(fn: (() => void) | null) {
        context.onstatechange = fn;
      },
      get onstatechange() {
        return context.onstatechange as (() => void) | null;
      },
      resume: () => context.resume(),
      close: () => context.close(),
      addModule: (url) => context.audioWorklet.addModule(url),
      wire(stream, onChunk) {
        const source = context.createMediaStreamSource(stream as MediaStream);
        const node = new AudioWorkletNode(context, "dictation-tap", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
          channelCountMode: "explicit",
          channelInterpretation: "speakers",
        });
        node.port.onmessage = (ev: MessageEvent<Float32Array>) =>
          onChunk(ev.data);
        source.connect(node);
        // its output is silence; joined to the destination so every
        // engine pulls the node, Safari included
        node.connect(context.destination);
      },
    };
  },
  getUserMedia: (constraints) =>
    navigator.mediaDevices.getUserMedia(constraints),
  moduleUrl() {
    const url = URL.createObjectURL(
      new Blob([PROCESSOR], { type: "text/javascript" }),
    );
    return { url, revoke: () => URL.revokeObjectURL(url) };
  },
};

const named = (name: string, message: string) =>
  Object.assign(new Error(message), { name });

// The context is made and resumed before anything is awaited: iOS Safari
// starts audio only inside the tap's gesture. A resume that fails ends the
// start at once, the prompt still up or not, and a context or a track not
// running just before ready fails, since a silent clip would never reach
// its five minutes.
// Cancel closes the context at once and settles ready; a grant that comes
// after it has its tracks stopped as they arrive. onEnd is the recording
// ending under the page: the device gone, or a call on iOS interrupting
// or suspending the context; never a cancel of ours.
export function startCapture(
  onChunk: (chunk: Float32Array) => void,
  onEnd: () => void,
  parts: CaptureParts = BROWSER,
): Pending {
  const context = parts.context();
  let resumed: Promise<void>;
  try {
    resumed = context.resume();
  } catch (err) {
    void context.close().catch(() => {});
    throw err;
  }
  let stream: Stream | null = null;
  let done = false;
  let gone: (err: Error) => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    gone = reject;
  });
  // a race lost to the cancel is never reported as unhandled
  cancelled.catch(() => {});
  const cancel = () => {
    if (done) return;
    done = true;
    for (const track of stream?.getTracks() ?? []) track.stop();
    if (context.state !== "closed") void context.close().catch(() => {});
    gone(named("AbortError", "the start was cancelled"));
  };
  const ended = () => {
    if (!done) onEnd();
  };
  // a context suspended once the graph runs stops feeding the tap, so
  // the clip would never reach its cap
  let live = false;
  const blocked = () => named("NotAllowedError", "the audio did not start");
  // WebKit's "interrupted" is not in the standard's type
  context.onstatechange = () => {
    const state = context.state;
    if (
      state === "interrupted" ||
      state === "closed" ||
      (live && state === "suspended")
    ) {
      ended();
    }
  };
  const started = resumed.then(
    () => {},
    () => {
      throw blocked();
    },
  );
  // a failed resume, watched from the tap, so it never waits on the prompt
  // and is never unhandled, whatever throws before it is raced
  const refused = started.then(() => new Promise<never>(() => {}));
  refused.catch(() => {});
  // each await races the cancel, so a cancel never waits on the browser
  function step<T>(work: Promise<T>): Promise<T> {
    return Promise.race([work, cancelled]);
  }
  const ready = (async () => {
    try {
      const asked = parts.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      // the grant is owned as it lands, so a cancel at any point after
      // stops its tracks, and one before has them stopped here
      void asked.then(
        (granted) => {
          stream = granted;
          for (const track of granted.getTracks()) {
            track.addEventListener("ended", ended);
            if (done) track.stop();
          }
        },
        () => {},
      );
      const got = await step(Promise.race([asked, refused]));
      await step(started);
      const script = parts.moduleUrl();
      try {
        await step(context.addModule(script.url));
      } finally {
        script.revoke();
      }
      // checked after the last await: either may have gone during it
      if (context.state !== "running") throw blocked();
      if (got.getTracks().some((track) => track.readyState === "ended")) {
        throw named("NotFoundError", "the microphone went");
      }
      context.wire(got, onChunk);
      live = true;
      return { rate: context.sampleRate };
    } catch (err) {
      cancel();
      throw err;
    }
  })();
  return { ready, cancel };
}
