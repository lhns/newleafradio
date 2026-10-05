// Posts the samples of the first input channel to the main thread.
// Silence is posted while the input has no data, so the recording stays continuous.
class RecorderProcessor extends AudioWorkletProcessor {
    process(inputs) {
        const channel = inputs[0]?.[0];
        this.port.postMessage(channel ? channel.slice() : new Float32Array(128));
        return true;
    }
}

registerProcessor("recorder", RecorderProcessor);
