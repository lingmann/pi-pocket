// One node per turn. Forward the worker's {type: "ack", samples} here, not an ack on receipt:
// at most two seconds of PCM can then be queued across the worklet, main thread, and worker.
// "flush" stops capture, sends the last short batch, then emits "flushed". Forward all audio
// before that marker to the worker before asking it to finish. "stop" discards the short batch.
class PocketVictorCapture extends AudioWorkletProcessor {
    constructor() {
        super();
        this.batchSize = Math.max(1, Math.round(sampleRate / 10));
        this.maxPending = this.batchSize * 20;
        this.pending = 0;
        this.buffer = new Float32Array(this.batchSize);
        this.used = 0;
        this.stopped = false;

        this.port.onmessage = ({ data }) => {
            if (data?.type === "ack") {
                if (Number.isSafeInteger(data.samples) && data.samples > 0) {
                    this.pending = Math.max(0, this.pending - data.samples);
                }
            } else if (data?.type === "flush" && !this.stopped) {
                this.stopped = true;

                if (this.sendBatch()) {
                    this.port.postMessage({ type: "flushed" });
                }

                this.buffer = null;
            } else if (data?.type === "stop") {
                this.stopped = true;
                this.used = 0;
                this.buffer = null;
            }
        };
    }

    sendBatch() {
        if (!this.used) {
            return true;
        }

        if (this.pending + this.used > this.maxPending) {
            this.stopped = true;
            this.buffer = null;
            this.used = 0;
            this.port.postMessage({
                type: "overload",
                message: "Speech recognition cannot keep up. Capture stopped; keep the draft.",
            });

            return false;
        }

        const samples =
            this.used === this.batchSize ? this.buffer : this.buffer.slice(0, this.used);

        this.pending += samples.length;
        this.used = 0;
        this.port.postMessage({ type: "audio", samples }, [samples.buffer]);
        this.buffer = this.stopped ? null : new Float32Array(this.batchSize);

        return true;
    }

    process(inputs) {
        if (this.stopped) {
            return false;
        }

        const channels = inputs[0];
        const frames = channels?.[0]?.length || 0;

        for (let frame = 0; frame < frames; frame++) {
            let mono = 0;

            for (const channel of channels) {
                mono += channel[frame];
            }

            this.buffer[this.used++] = mono / channels.length;

            if (this.used === this.batchSize && !this.sendBatch()) {
                return false;
            }
        }

        // Outputs stay silent: this node must never play microphone audio back to the speaker.
        return true;
    }
}

registerProcessor("pocket-victor-capture", PocketVictorCapture);
