// Measures how far other devices playing the same song are ahead of this device, by listening to them.
// The microphone hears this device and the other devices. Both are located in a decoded slice of the song by
// cross-correlation, and this device is told apart by muting it for the last part of the recording.
// Microphone and output latency cancel out, because all devices are heard through the same microphone.

const SYNC_WARMUP_S = 0.3;
const SYNC_UNMUTED_S = 2;
// time for muting to reach the speaker (output latency, e.g. bluetooth)
const SYNC_GUARD_S = 0.5;
const SYNC_MUTED_S = 2;
// the reference covers this much of the song around the current position
const SYNC_REFERENCE_MARGIN_S = 10;
const SYNC_MAX_WHOLE_FILE_BYTES = 30 * 1024 * 1024;
const SYNC_ANALYSIS_RATE = 16000;
const SYNC_BAND_HZ = [300, 7000];
const SYNC_PHAT_BETA = 0.7;
// this device is searched this close to where its playback position says it should be (output latency, inaccuracies)
const SYNC_OWN_SEARCH_S = 1;
// other devices are searched this close to this device, then once more in the wider range
const SYNC_OTHER_SEARCH_S = [0.5, 1.5];
const SYNC_PEAK_EXCLUSION_S = 0.01;
// room reflections arrive up to this much later than the direct sound
const SYNC_REFLECTION_S = 0.04;
const SYNC_MIN_SNR = 7;
const SYNC_OTHER_DEVICE_RATIO = 0.75;
// this device is looked for among weaker matches only down to this fraction of the strongest
const SYNC_OWN_MIN_RELATIVE = 0.4;
// a match of this device in sync with another device makes the song this much louder while unmuted
const SYNC_OWN_GAIN_RATIO = 1.3;

class SyncError extends Error {
}

// Returns {offset, others}: offset is how many seconds the loudest other device is ahead in the song,
// others are the offsets of further devices that were heard.
// Must be called from a user gesture (microphone permission, AudioContext).
async function measureSongOffset(audio, src, signal) {
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new SyncError("Microphone not available");
    }
    const context = new AudioContext();
    let stream = null;
    try {
        const recordingSeconds = SYNC_WARMUP_S + SYNC_UNMUTED_S + SYNC_GUARD_S + SYNC_MUTED_S;
        const reference = loadReference(context, src, audio.currentTime, audio.duration, recordingSeconds, signal);
        reference.catch(() => {
        });

        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1}
            });
        } catch (error) {
            console.error(error);
            throw new SyncError("Microphone not available");
        }
        signal?.throwIfAborted();
        await context.resume();

        const recording = await record(context, stream, audio, signal);
        stream.getTracks().forEach(track => track.stop());
        stream = null;

        const {samples, startSeconds} = await reference;
        return analyzeRecording({...recording, reference: samples, referenceStart: startSeconds, rate: context.sampleRate});
    } finally {
        audio.muted = false;
        stream?.getTracks().forEach(track => track.stop());
        context.close().catch(() => {
        });
    }
}

async function record(context, stream, audio, signal) {
    await context.audioWorklet.addModule("recorder-worklet.js");
    signal?.throwIfAborted();
    const source = context.createMediaStreamSource(stream);
    const recorder = new AudioWorkletNode(context, "recorder");

    const chunks = [];
    let length = 0;
    let waiting = null;
    recorder.port.onmessage = ({data}) => {
        chunks.push(data);
        length += data.length;
        if (waiting && length >= waiting.samples) waiting.resolve();
    };
    const waitForSamples = samples => new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal?.addEventListener("abort", onAbort, {once: true});
        if (signal?.aborted) return onAbort();
        waiting = {
            samples, resolve: () => {
                waiting = null;
                signal?.removeEventListener("abort", onAbort);
                resolve();
            }
        };
        if (length >= samples) waiting.resolve();
    });

    source.connect(recorder);
    // the recorder only outputs silence, but has to be connected to be processed
    recorder.connect(context.destination);
    try {
        const rate = context.sampleRate;
        const unmutedStart = Math.round(SYNC_WARMUP_S * rate);
        const unmutedEnd = unmutedStart + Math.round(SYNC_UNMUTED_S * rate);
        await waitForSamples(unmutedStart);
        // the song position when the unmuted part started
        const position = audio.currentTime - (length - unmutedStart) / rate;
        await waitForSamples(unmutedEnd);
        audio.muted = true;
        const mutedStart = length + Math.round(SYNC_GUARD_S * rate);
        const mutedEnd = mutedStart + Math.round(SYNC_MUTED_S * rate);
        await waitForSamples(mutedEnd);
        audio.muted = false;

        const samples = new Float32Array(mutedEnd);
        let offset = 0;
        for (const chunk of chunks) {
            if (offset >= mutedEnd) break;
            samples.set(chunk.subarray(0, mutedEnd - offset), offset);
            offset += chunk.length;
        }
        return {
            unmuted: samples.subarray(unmutedStart, unmutedEnd),
            muted: samples.subarray(mutedStart, mutedEnd),
            mutedDelay: mutedStart - unmutedStart,
            position
        };
    } finally {
        recorder.port.onmessage = null;
        source.disconnect();
        recorder.disconnect();
    }
}

// Decodes the part of the song around the given position as mono samples at the context's sample rate.
// Returns {samples, startSeconds}, startSeconds being the (estimated) song position of the first sample.
async function loadReference(context, src, position, duration, recordingSeconds, signal) {
    const probe = await fetch(src, {headers: {range: "bytes=0-1"}, signal});
    const type = probe.headers.get("content-type") || "";
    const isMp3 = type.includes("mpeg") || /\.mp3$/i.test(src);
    const total = Number(probe.headers.get("content-range")?.split("/")[1]);
    // mp3 frames can be decoded from anywhere, so only the bytes around the position are needed
    const mp3Range = size => {
        const bytesPerSecond = size / duration;
        const start = Math.max(0, Math.floor((position - SYNC_REFERENCE_MARGIN_S) * bytesPerSecond));
        const end = Math.min(size, Math.ceil((position + recordingSeconds + SYNC_REFERENCE_MARGIN_S) * bytesPerSecond));
        return [start, end];
    };

    let bytes;
    let startSeconds = 0;
    if (probe.status === 206 && total) {
        probe.body?.cancel().catch(() => {
        });
        if (isMp3) {
            const [start, end] = mp3Range(total);
            startSeconds = start / total * duration;
            const response = await fetch(src, {headers: {range: `bytes=${start}-${end - 1}`}, signal});
            if (!response.ok) throw new SyncError(`Error loading the song: ${response.status}`);
            bytes = await response.arrayBuffer();
            if (response.status === 200) bytes = bytes.slice(start, end);
        } else {
            if (total > SYNC_MAX_WHOLE_FILE_BYTES) throw new SyncError("This song is too large to sync");
            const response = await fetch(src, {signal});
            if (!response.ok) throw new SyncError(`Error loading the song: ${response.status}`);
            bytes = await response.arrayBuffer();
        }
    } else {
        // e.g. blob URLs, which ignore the range: the whole file is in memory anyway
        if (!probe.ok) throw new SyncError(`Error loading the song: ${probe.status}`);
        bytes = await probe.arrayBuffer();
        if (isMp3) {
            const [start, end] = mp3Range(bytes.byteLength);
            startSeconds = start / bytes.byteLength * duration;
            bytes = bytes.slice(start, end);
        }
    }
    signal?.throwIfAborted();

    let buffer;
    try {
        buffer = await context.decodeAudioData(bytes);
    } catch (error) {
        console.error(error);
        throw new SyncError("The song could not be decoded for syncing");
    }
    signal?.throwIfAborted();

    let start = 0;
    let end = buffer.length;
    if (!isMp3) {
        // the whole file was decoded, so only the part around the position is kept
        start = Math.max(0, Math.floor((position - SYNC_REFERENCE_MARGIN_S) * buffer.sampleRate));
        startSeconds = start / buffer.sampleRate;
        end = Math.min(buffer.length, Math.ceil((position + recordingSeconds + SYNC_REFERENCE_MARGIN_S) * buffer.sampleRate));
    }
    const mono = new Float32Array(Math.max(0, end - start));
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < mono.length; i++) mono[i] += data[start + i] / buffer.numberOfChannels;
    }
    return {samples: mono, startSeconds};
}

// Finds this device (heard only in the unmuted part) and the other devices (heard in both parts) in the reference.
// mutedDelay is the number of samples from the start of the unmuted to the start of the muted part,
// position the song position at the start of the unmuted part and referenceStart the one of the reference.
function analyzeRecording({unmuted, muted, mutedDelay, position, reference, referenceStart, rate}) {
    const factor = Math.max(1, Math.round(rate / SYNC_ANALYSIS_RATE));
    const analysisRate = rate / factor;
    const u = decimate(unmuted, factor);
    const m = decimate(muted, factor);
    const s = decimate(reference, factor);
    const shift = Math.round(mutedDelay / factor);
    if (s.length < Math.max(u.length, m.length) + 2) throw new SyncError("The song could not be loaded for syncing");

    const n = nextPowerOfTwo(s.length + Math.max(u.length, m.length));
    const referenceSpectrum = spectrum(s, n);
    const zU = zScores(correlate(u, referenceSpectrum, n, analysisRate), s.length - u.length + 1);
    const zM = zScores(correlate(m, referenceSpectrum, n, analysisRate), s.length - m.length + 1);
    const exclusion = Math.round(SYNC_PEAK_EXCLUSION_S * analysisRate);
    const reflections = Math.round(SYNC_REFLECTION_S * analysisRate);
    const window = (center, seconds, length) => {
        const radius = Math.round(seconds * analysisRate);
        return [Math.max(0, center - radius), Math.min(length - 1, center + radius)];
    };

    // this device: matches near the expected position (playback position, output latency)
    const expected = Math.round((position - referenceStart) * analysisRate);
    const [ownFrom, ownTo] = window(expected, SYNC_OWN_SEARCH_S, zU.length);
    if (ownFrom > ownTo) throw new SyncError("The song could not be loaded for syncing");
    const candidates = findPeaks(zU, ownFrom, ownTo, exclusion, 8);
    if (!candidates.length || zU[candidates[0]] < SYNC_MIN_SNR) {
        throw new SyncError("Couldn't hear the song, turn the volume up");
    }
    const strongest = candidates[0];
    // a match is heard while muted if the muted part has a comparably strong match at the same position,
    // relative to the strongest match of each part, because the two parts' scores aren't comparable directly
    let mutedMax = 1e-9;
    for (let k = ownFrom + shift; k <= Math.min(ownTo + shift, zM.length - 1); k++) mutedMax = Math.max(mutedMax, zM[k]);
    const heardWhileMuted = (peak, factor) => peak + shift < zM.length
        && maxAround(zM, peak + shift, 2) / mutedMax >= factor * zU[peak] / zU[strongest];
    // how much louder the song is while unmuted, relative to the reference at the matched positions
    const gain = (signal, at) => rms(signal, 0, signal.length) / Math.max(rms(s, at, signal.length), 1e-9);

    let own;
    if (!heardWhileMuted(strongest, 0.5)) {
        own = strongest;
    } else if (gain(u, strongest) >= SYNC_OWN_GAIN_RATIO * gain(m, strongest + shift)) {
        // the strongest match is louder while this device plays: it is in sync with the other device
        own = strongest;
    } else {
        // the strongest match is another device: this device is a weaker match nearby that is gone while muted,
        // but not within the other device's reflections, which can't be told apart reliably
        const nearby = Math.round(SYNC_OTHER_SEARCH_S[0] * analysisRate);
        own = candidates.find(peak => Math.abs(peak - strongest) <= nearby && Math.abs(peak - strongest) > reflections
            && zU[peak] >= SYNC_MIN_SNR && zU[peak] >= SYNC_OWN_MIN_RELATIVE * zU[strongest] && !heardWhileMuted(peak, 0.25));
    }
    if (own === undefined) throw new SyncError("Couldn't hear this device's own speaker, turn the volume up");

    // other devices: heard while this device is muted
    let others = [];
    for (const seconds of SYNC_OTHER_SEARCH_S) {
        const [from, to] = window(own + shift, seconds, zM.length);
        const peaks = findPeaks(zM, from, to, exclusion, 5);
        if (peaks.length && zM[peaks[0]] >= SYNC_MIN_SNR) {
            others = peaks.filter(peak => zM[peak] >= SYNC_OTHER_DEVICE_RATIO * zM[peaks[0]]);
            break;
        }
    }
    if (!others.length) throw new SyncError("No other device heard");

    const ownPosition = own + parabolicOffset(zU, own);
    const offsetOf = peak => (peak + parabolicOffset(zM, peak) - shift - ownPosition) / analysisRate;
    return {offset: offsetOf(others[0]), others: others.slice(1).map(offsetOf)};
}

function rms(signal, from, length) {
    let sum = 0;
    const to = Math.min(signal.length, from + length);
    for (let i = Math.max(0, from); i < to; i++) sum += signal[i] * signal[i];
    return Math.sqrt(sum / Math.max(1, to - from));
}

function maxAround(values, k, radius) {
    let max = -Infinity;
    for (let i = Math.max(0, k - radius); i <= Math.min(values.length - 1, k + radius); i++) max = Math.max(max, values[i]);
    return max;
}

function decimate(signal, factor) {
    const result = new Float64Array(Math.floor(signal.length / factor));
    for (let i = 0; i < result.length; i++) {
        let sum = 0;
        for (let j = 0; j < factor; j++) sum += signal[i * factor + j];
        result[i] = sum / factor;
    }
    return result;
}

function nextPowerOfTwo(value) {
    let n = 1;
    while (n < value) n *= 2;
    return n;
}

function spectrum(signal, n) {
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    re.set(signal);
    fft(re, im, false);
    return {re, im};
}

// c[k] = sum of x[i] * reference[i + k], with GCC-PHAT-beta weighting limited to the band that speakers reproduce
function correlate(x, referenceSpectrum, n, rate) {
    const {re: xRe, im: xIm} = spectrum(x, n);
    const {re: sRe, im: sIm} = referenceSpectrum;
    const [low, high] = SYNC_BAND_HZ;
    for (let bin = 0; bin < n; bin++) {
        const frequency = Math.min(bin, n - bin) * rate / n;
        if (frequency < low || frequency > high) {
            xRe[bin] = 0;
            xIm[bin] = 0;
            continue;
        }
        // conj(X) * S
        const re = xRe[bin] * sRe[bin] + xIm[bin] * sIm[bin];
        const im = xRe[bin] * sIm[bin] - xIm[bin] * sRe[bin];
        const weight = 1 / (Math.pow(Math.hypot(re, im), SYNC_PHAT_BETA) + 1e-12);
        xRe[bin] = re * weight;
        xIm[bin] = im * weight;
    }
    fft(xRe, xIm, true);
    return xRe;
}

// normalizes the valid lags of a correlation to mean 0 and standard deviation 1
function zScores(correlation, validLength) {
    const result = correlation.slice(0, Math.max(0, validLength));
    let mean = 0;
    for (const value of result) mean += value;
    mean /= result.length;
    let variance = 0;
    for (const value of result) variance += (value - mean) ** 2;
    const deviation = Math.sqrt(variance / result.length) || 1;
    for (let i = 0; i < result.length; i++) result[i] = (result[i] - mean) / deviation;
    return result;
}

// local maxima in [from, to], strongest first, at least `exclusion` apart
function findPeaks(values, from, to, exclusion, count) {
    const peaks = [];
    for (let k = from; k <= to; k++) {
        if ((k === from || values[k] >= values[k - 1]) && (k === to || values[k] > values[k + 1])) peaks.push(k);
    }
    peaks.sort((a, b) => values[b] - values[a]);
    const result = [];
    for (const peak of peaks) {
        if (result.every(other => Math.abs(other - peak) > exclusion)) result.push(peak);
        if (result.length >= count) break;
    }
    return result;
}

function parabolicOffset(values, k) {
    if (k <= 0 || k >= values.length - 1) return 0;
    const denominator = values[k - 1] - 2 * values[k] + values[k + 1];
    return denominator === 0 ? 0 : 0.5 * (values[k - 1] - values[k + 1]) / denominator;
}

// in-place iterative radix-2 FFT, re and im must have a power of two length
function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
    }
    for (let size = 2; size <= n; size *= 2) {
        const angle = (inverse ? 2 : -2) * Math.PI / size;
        const stepRe = Math.cos(angle);
        const stepIm = Math.sin(angle);
        const half = size / 2;
        for (let start = 0; start < n; start += size) {
            let wRe = 1;
            let wIm = 0;
            for (let k = 0; k < half; k++) {
                const a = start + k;
                const b = a + half;
                const tRe = re[b] * wRe - im[b] * wIm;
                const tIm = re[b] * wIm + im[b] * wRe;
                re[b] = re[a] - tRe;
                im[b] = im[a] - tIm;
                re[a] += tRe;
                im[a] += tIm;
                const nextRe = wRe * stepRe - wIm * stepIm;
                wIm = wRe * stepIm + wIm * stepRe;
                wRe = nextRe;
            }
        }
    }
    if (inverse) {
        for (let i = 0; i < n; i++) {
            re[i] /= n;
            im[i] /= n;
        }
    }
}
