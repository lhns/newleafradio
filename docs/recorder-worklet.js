// Posts the samples of the first input channel to the main thread, in blocks of processorOptions.blockSize.
// Silence is recorded while the input has no data, so the recording stays continuous.
class RecorderProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.blockSize = options.processorOptions.blockSize;
        this.block = new Float32Array(this.blockSize);
        this.length = 0;
    }

    process(inputs) {
        const channel = inputs[0]?.[0];
        const frames = channel?.length ?? 128;
        for (let i = 0; i < frames; i++) {
            this.block[this.length++] = channel ? channel[i] : 0;
            if (this.length === this.blockSize) {
                // the block's buffer is transferred, not copied
                this.port.postMessage(this.block, [this.block.buffer]);
                this.block = new Float32Array(this.blockSize);
                this.length = 0;
            }
        }
        return true;
    }
}

registerProcessor("recorder", RecorderProcessor);
