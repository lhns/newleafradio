// Measures how far other devices playing the same song are ahead of this device, by listening to them.
// The microphone hears this device and the other devices. Both are located in a decoded slice of the song by
// cross-correlation, and this device is told apart by muting it for the last part of the recording.
// Microphone and output latency cancel out, because all devices are heard through the same microphone.
// The analysis runs in a worker loading this file, so it doesn't block the page.
// Uses onAbort from radio.js.

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
// this device is searched from this much before its playback position (latency) to this much after
const SYNC_OWN_LATENCY_S = 0.7;
const SYNC_OWN_AHEAD_S = 0.05;
const SYNC_OWN_CANDIDATES = 8;
// other devices are searched this close to this device (system clocks can differ by seconds)
const SYNC_OTHER_SEARCH_S = 5;
const SYNC_OTHER_CANDIDATES = 5;
const SYNC_PEAK_EXCLUSION_S = 0.01;
// room reflections arrive up to this much later than the direct sound
const SYNC_REFLECTION_S = 0.04;
// an earlier arrival at least this strong relative to a match is the direct sound, the match a reflection
const SYNC_DIRECT_RATIO = 0.6;
// matches this close to a stronger one are its side lobes (tonal music)
const SYNC_SIDELOBE_S = 0.0025;
// noise and similar parts of the song score up to ~14; this device is close to the microphone
const SYNC_MIN_SNR = 15;
const SYNC_OWN_MIN_SNR = 18;
// correlations are divided by the song part's energy, but at least this fraction of the average
const SYNC_ENERGY_FLOOR = 0.05;
const SYNC_OTHER_DEVICE_RATIO = 0.75;
// a second match this strong and further away is ambiguous (repeating music), so the result is rejected
const SYNC_AMBIGUOUS_RATIO = 0.8;
const SYNC_DEVICES_SPREAD_S = 0.5;
// a match counts as heard while muted if it is at least this strong relative to the strongest match of each part
const SYNC_HEARD_WHILE_MUTED_RATIO = 0.5;
// stricter for weaker matches of this device, which must be gone while muted
const SYNC_OWN_GONE_WHILE_MUTED_RATIO = 0.25;
// this device is looked for among weaker matches only down to this fraction of the strongest
const SYNC_OWN_MIN_RELATIVE = 0.4;
// a match of this device in sync with another device makes the song this much louder while unmuted
const SYNC_OWN_GAIN_RATIO = 1.3;
// samples the recorder collects before posting them to the main thread
const SYNC_RECORDER_BLOCK = 2048;
// matches of each kind in the summary that is logged after each measurement
const SYNC_SUMMARY_PEAKS = 3;
// with ?syncdebug, the recording, the reference and the summary are downloaded after each measurement
const SYNC_DEBUG = typeof location !== "undefined" && new URLSearchParams(location.search).has("syncdebug");

class SyncError extends Error {
}

const IS_SYNC_WORKER = typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope;
const ACOUSTIC_SYNC_SCRIPT = IS_SYNC_WORKER ? self.location.href : document.currentScript.src;

if (IS_SYNC_WORKER) {
    self.onmessage = ({data}) => {
        const summary = {};
        try {
            self.postMessage({result: analyzeRecording(data, summary), summary});
        } catch (error) {
            self.postMessage({error: {message: error.message, isSyncError: error instanceof SyncError}, summary});
        }
    };
}

// runs analyzeRecording in a worker, returns {result, summary}, its errors carry the summary
function analyzeInWorker(input, signal) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(ACOUSTIC_SYNC_SCRIPT);
        const finish = () => {
            worker.terminate();
            removeListener();
        };
        const removeListener = onAbort(signal, () => {
            finish();
            reject(signal.reason);
        });
        worker.onmessage = ({data}) => {
            finish();
            if (data.error) {
                const error = data.error.isSyncError ? new SyncError(data.error.message) : new Error(data.error.message);
                error.summary = data.summary;
                reject(error);
            } else {
                resolve(data);
            }
        };
        worker.onerror = event => {
            finish();
            reject(new Error(event.message));
        };
        worker.postMessage(input);
    });
}

// Returns {offset, others}: offset is how many seconds the loudest other device is ahead in the song,
// others are the offsets of further devices that were heard.
// getPosition returns the current song position, setMuted mutes this device.
// Must be called from a user gesture (microphone permission, AudioContext).
async function measureSongOffset({src, duration, getPosition, setMuted, signal}) {
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new SyncError("Microphone not available");
    }
    const context = new AudioContext();
    let stream = null;
    try {
        const factor = analysisFactor(context.sampleRate);
        const recordingSeconds = SYNC_WARMUP_S + SYNC_UNMUTED_S + SYNC_GUARD_S + SYNC_MUTED_S;
        const reference = loadReference(src, getPosition(), duration, recordingSeconds, context.sampleRate / factor, signal);
        reference.catch(() => {
        });
        const recorderLoaded = context.audioWorklet.addModule("recorder-worklet.js");
        recorderLoaded.catch(() => {
        });

        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1}
            });
        } catch (error) {
            console.error(error);
            throw new SyncError("Microphone not available");
        }
        signal.throwIfAborted();
        await context.resume();
        await recorderLoaded;

        const {samples, timing, ...recording} = await record(context, stream, getPosition, setMuted, signal);
        const {deviceId, groupId, ...settings} = stream.getAudioTracks()[0]?.getSettings() ?? {};
        stream.getTracks().forEach(track => track.stop());
        stream = null;

        const {samples: referenceSamples, startSeconds} = await reference;
        const input = {...recording, reference: referenceSamples, referenceStart: startSeconds, rate: context.sampleRate};
        const report = (outcome, summary) => {
            summary = {
                ...outcome, ...summary, ...timing, settings,
                outputLatency: context.outputLatency, baseLatency: context.baseLatency
            };
            console.debug("sync analysis", summary);
            try {
                if (SYNC_DEBUG) downloadSyncDebug(samples, input, summary);
            } catch (error) {
                console.error(error);
            }
        };
        try {
            const {result, summary} = await analyzeInWorker(input, signal);
            report({result}, summary);
            return result;
        } catch (error) {
            if (error.summary) report({error: error.message}, error.summary);
            throw error;
        }
    } finally {
        setMuted(false);
        stream?.getTracks().forEach(track => track.stop());
        context.close().catch(() => {
        });
    }
}

async function record(context, stream, getPosition, setMuted, signal) {
    const source = context.createMediaStreamSource(stream);
    const recorder = new AudioWorkletNode(context, "recorder", {processorOptions: {blockSize: SYNC_RECORDER_BLOCK}});

    const chunks = [];
    let length = 0;
    let onSamples = null;
    recorder.port.onmessage = ({data}) => {
        chunks.push(data);
        length += data.length;
        onSamples?.();
    };
    const waitForSamples = samples => new Promise((resolve, reject) => {
        const removeListener = onAbort(signal, () => {
            onSamples = null;
            reject(signal.reason);
        });
        onSamples = () => {
            if (length < samples) return;
            onSamples = null;
            removeListener();
            resolve();
        };
        if (!signal.aborted) onSamples();
    });

    source.connect(recorder);
    // the recorder only outputs silence, but has to be connected to be processed
    recorder.connect(context.destination);
    try {
        const rate = context.sampleRate;
        const unmutedStart = Math.round(SYNC_WARMUP_S * rate);
        const unmutedEnd = unmutedStart + Math.round(SYNC_UNMUTED_S * rate);
        // the song position when sample i was recorded
        const positionAt = i => getPosition() - (length - i) / rate;
        await waitForSamples(unmutedStart);
        const position = positionAt(unmutedStart);
        await waitForSamples(unmutedEnd);
        setMuted(true);
        const mutedStart = length + Math.round(SYNC_GUARD_S * rate);
        const mutedEnd = mutedStart + Math.round(SYNC_MUTED_S * rate);
        await waitForSamples(mutedEnd);
        setMuted(false);
        const endPosition = positionAt(mutedEnd);

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
            position,
            samples,
            // the song should advance as much as the recording, otherwise the playback rate changed or it was seeked
            timing: {
                unmutedStart, mutedStart, endPosition,
                driftMs: +((endPosition - position - (mutedEnd - unmutedStart) / rate) * 1000).toFixed(1)
            }
        };
    } finally {
        recorder.port.onmessage = null;
        source.disconnect();
        recorder.disconnect();
    }
}

async function fetchSong(src, init) {
    const response = await fetch(src, init);
    if (!response.ok) throw new SyncError(`Error loading the song: ${response.status}`);
    return response;
}

// Decodes the part of the song around the given position as mono samples at the given rate.
// Returns {samples, startSeconds}, startSeconds being the (estimated) song position of the first sample.
async function loadReference(src, position, duration, recordingSeconds, rate, signal) {
    // [start, end) of the needed part of the song, in units of unitsPerSecond
    const around = (unitsPerSecond, size) => [
        Math.max(0, Math.floor((position - SYNC_REFERENCE_MARGIN_S) * unitsPerSecond)),
        Math.min(size, Math.ceil((position + recordingSeconds + SYNC_REFERENCE_MARGIN_S) * unitsPerSecond))
    ];

    const probe = await fetchSong(src, {headers: {range: "bytes=0-1"}, signal});
    const size = Number(probe.headers.get("content-range")?.split("/")[1]);
    let whole = null;
    if (probe.status === 206 && size) {
        probe.body?.cancel().catch(() => {
        });
    } else {
        // e.g. blob URLs ignore the range: the whole file is in memory anyway
        whole = new Uint8Array(await probe.arrayBuffer());
    }
    const fileSize = whole ? whole.length : size;
    const read = async (start, end) => {
        if (whole) return whole.subarray(start, end);
        const response = await fetchSong(src, {headers: {range: `bytes=${start}-${end - 1}`}, signal});
        return new Uint8Array(await response.arrayBuffer());
    };

    // mp3 frames can be decoded from anywhere, so only the bytes around the position are needed
    const frames = await mp4Mp3Frames(read, fileSize);
    let bytes;
    let startSeconds = 0;
    if (frames) {
        const length = frames.end - frames.start;
        const [start, end] = around(length / duration, length);
        bytes = await read(frames.start + start, frames.start + end);
        // some browsers (Firefox) only decode data that starts with a frame
        const skipped = start > 0 ? mp3FrameStart(bytes) : 0;
        if (skipped < 0) throw new SyncError("The song could not be decoded for syncing");
        bytes = bytes.slice(skipped);
        startSeconds = (start + skipped) / length * duration;
    } else {
        if (fileSize > SYNC_MAX_WHOLE_FILE_BYTES) throw new SyncError("This song is too large to sync");
        bytes = (whole ?? await read(0, fileSize)).slice();
    }
    signal.throwIfAborted();

    let buffer;
    try {
        // decoded at the analysis rate right away, which keeps whole songs small
        buffer = await new OfflineAudioContext(1, 1, rate).decodeAudioData(bytes.buffer);
    } catch (error) {
        console.error(error);
        throw new SyncError("The song could not be decoded for syncing");
    }
    signal.throwIfAborted();

    let [start, end] = [0, buffer.length];
    if (!frames) {
        // the whole song was decoded, so only the part around the position is kept
        [start, end] = around(rate, buffer.length);
        startSeconds = start / rate;
    }
    const mono = new Float32Array(Math.max(0, end - start));
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < mono.length; i++) mono[i] += data[start + i];
    }
    for (let i = 0; i < mono.length; i++) mono[i] /= buffer.numberOfChannels;
    return {samples: mono, startSeconds};
}

// [start, end) of the mp3 frames in an MP4 file, which are stored back to back in its mdat box, or null (e.g. AAC)
async function mp4Mp3Frames(read, fileSize) {
    for (let offset = 0; offset + 8 <= fileSize;) {
        const header = await read(offset, Math.min(offset + 16, fileSize));
        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
        let size = view.getUint32(0);
        let headerSize = 8;
        if (size === 1) {
            // 64-bit size
            if (header.length < 16) return null;
            size = Number(view.getBigUint64(8));
            headerSize = 16;
        } else if (size === 0) {
            // the box extends to the end of the file
            size = fileSize - offset;
        }
        if (size < headerSize) return null;
        if (String.fromCharCode(...header.subarray(4, 8)) === "mdat") {
            const start = offset + headerSize;
            const end = Math.min(offset + size, fileSize);
            return mp3FrameStart(await read(start, Math.min(start + 4096, end))) === 0 ? {start, end} : null;
        }
        offset += size;
    }
    return null;
}

const MP3_BITRATES_KBPS = {
    1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
};
// by version bits: 0 MPEG 2.5, 2 MPEG 2, 3 MPEG 1
const MP3_SAMPLE_RATES = {0: [11025, 12000, 8000], 2: [22050, 24000, 16000], 3: [44100, 48000, 32000]};

// length in bytes of the MPEG layer III frame starting at i, or 0 if there is no valid frame header
function mp3FrameLength(bytes, i) {
    if (i + 4 > bytes.length || bytes[i] !== 0xFF || (bytes[i + 1] & 0xE0) !== 0xE0) return 0;
    const version = (bytes[i + 1] >> 3) & 3;
    const layer = (bytes[i + 1] >> 1) & 3;
    const bitrateIndex = bytes[i + 2] >> 4;
    const sampleRateIndex = (bytes[i + 2] >> 2) & 3;
    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return 0;
    const bitrate = MP3_BITRATES_KBPS[version === 3 ? 1 : 2][bitrateIndex] * 1000;
    const sampleRate = MP3_SAMPLE_RATES[version][sampleRateIndex];
    const padding = (bytes[i + 2] >> 1) & 1;
    return Math.floor((version === 3 ? 144 : 72) * bitrate / sampleRate) + padding;
}

// offset of the first frame in a slice of an mp3, confirmed by the frame after it, or -1
function mp3FrameStart(bytes) {
    for (let i = 0; i + 4 <= bytes.length; i++) {
        const length = mp3FrameLength(bytes, i);
        if (length && mp3FrameLength(bytes, i + length)) return i;
    }
    return -1;
}

// the microphone recording is decimated by this factor for the analysis
function analysisFactor(rate) {
    return Math.max(1, Math.round(rate / SYNC_ANALYSIS_RATE));
}

// Finds this device (heard only in the unmuted part) and the other devices (heard in both parts) in the reference.
// unmuted and muted are recorded at rate, the reference at rate / analysisFactor(rate).
// mutedDelay is the number of samples from the start of the unmuted to the start of the muted part,
// position the song position at the start of the unmuted part and referenceStart the one of the reference.
// summary is filled with details for diagnostics, also when an error is thrown.
function analyzeRecording({unmuted, muted, mutedDelay, position, reference, referenceStart, rate}, summary = {}) {
    const factor = analysisFactor(rate);
    const analysisRate = rate / factor;
    const dbfs = signal => +(20 * Math.log10(Math.max(rms(signal, 0, signal.length), 1e-9))).toFixed(1);
    Object.assign(summary, {
        rate, analysisRate, position, referenceStart, mutedDelay,
        unmutedLength: unmuted.length, mutedLength: muted.length, referenceLength: reference.length,
        unmutedDbfs: dbfs(unmuted), mutedDbfs: dbfs(muted), referenceDbfs: dbfs(reference),
        thresholds: {
            ownMinSnr: SYNC_OWN_MIN_SNR, minSnr: SYNC_MIN_SNR, ownLatencyS: SYNC_OWN_LATENCY_S, ownAheadS: SYNC_OWN_AHEAD_S,
            ownGoneWhileMuted: SYNC_OWN_GONE_WHILE_MUTED_RATIO, heardWhileMuted: SYNC_HEARD_WHILE_MUTED_RATIO
        }
    });
    const u = decimate(unmuted, factor);
    const m = decimate(muted, factor);
    const s = reference;
    const shift = Math.round(mutedDelay / factor);
    if (s.length < Math.max(u.length, m.length) + 2) throw new SyncError("The song could not be loaded for syncing");

    const n = nextPowerOfTwo(s.length + Math.max(u.length, m.length));
    const referenceSpectrum = spectrum(s, n);
    const zU = zScores(normalizeByEnergy(correlate(u, referenceSpectrum, n, analysisRate), s, u.length));
    const zM = zScores(normalizeByEnergy(correlate(m, referenceSpectrum, n, analysisRate), s, m.length));
    const exclusion = Math.round(SYNC_PEAK_EXCLUSION_S * analysisRate);
    const reflections = Math.round(SYNC_REFLECTION_S * analysisRate);

    // this device: matches shortly before the expected position (playback position minus latency)
    const expected = Math.round((position - referenceStart) * analysisRate);
    const ownFrom = Math.max(0, expected - Math.round(SYNC_OWN_LATENCY_S * analysisRate));
    const ownTo = Math.min(zU.length - 1, expected + Math.round(SYNC_OWN_AHEAD_S * analysisRate));
    // a match's offset from the expected position in ms and its scores in the unmuted and the muted part
    const describe = peak => ({
        ms: +((peak - expected) / analysisRate * 1000).toFixed(1),
        unmuted: +(zU[peak] ?? NaN).toFixed(1),
        muted: +maxIn(zM, peak + shift - 2, peak + shift + 2).toFixed(1)
    });
    const otherRadius = Math.round(SYNC_OTHER_SEARCH_S * analysisRate);
    Object.assign(summary, {
        expected, expectedSeconds: position - referenceStart,
        ownWindowMs: [(ownFrom - expected) / analysisRate * 1000, (ownTo - expected) / analysisRate * 1000],
        ownCandidates: findPeaks(zU, ownFrom, ownTo, exclusion, SYNC_SUMMARY_PEAKS).map(describe),
        // anywhere in the unmuted part, in case this device's latency is outside the window
        unmutedPeaks: findPeaks(zU, 0, zU.length - 1, exclusion, SYNC_SUMMARY_PEAKS).map(describe),
        otherPeaks: findPeaks(zM, Math.max(0, expected + shift - otherRadius), Math.min(zM.length - 1, expected + shift + otherRadius),
            exclusion, SYNC_SUMMARY_PEAKS).map(peak => describe(peak - shift))
    });
    if (ownFrom > ownTo) throw new SyncError("The song could not be loaded for syncing");
    const candidates = findPeaks(zU, ownFrom, ownTo, exclusion, SYNC_OWN_CANDIDATES);
    if (!candidates.length || zU[candidates[0]] < SYNC_OWN_MIN_SNR) {
        throw new SyncError("Couldn't hear the song, turn the volume up");
    }
    const strongest = candidates[0];
    // a match is heard while muted if the muted part has a comparably strong match at the same position,
    // relative to the strongest match of each part, because the two parts' scores aren't comparable directly
    const mutedMax = Math.max(maxIn(zM, ownFrom + shift, ownTo + shift), 1e-9);
    const heardWhileMuted = (peak, ratio) => peak + shift < zM.length
        && maxIn(zM, peak + shift - 2, peak + shift + 2) / mutedMax >= ratio * zU[peak] / zU[strongest];
    // how much louder the song is while unmuted, relative to the reference at the matched positions
    const gain = (signal, at) => rms(signal, 0, signal.length) / Math.max(rms(s, at, signal.length), 1e-9);

    // this device is the strongest match that is gone while muted (outside the strongest one's reflections),
    // otherwise the strongest match if the song is louder while unmuted (in sync with another device)
    let own = candidates.find(peak => zU[peak] >= SYNC_OWN_MIN_SNR && zU[peak] >= SYNC_OWN_MIN_RELATIVE * zU[strongest]
        && (peak === strongest || Math.abs(peak - strongest) > reflections)
        && !heardWhileMuted(peak, peak === strongest ? SYNC_HEARD_WHILE_MUTED_RATIO : SYNC_OWN_GONE_WHILE_MUTED_RATIO));
    if (own === undefined && gain(u, strongest) >= SYNC_OWN_GAIN_RATIO * gain(m, strongest + shift)) {
        own = strongest;
    }
    if (own === undefined) throw new SyncError("Couldn't hear this device's own speaker, turn the volume up");

    // other devices: heard while this device is muted
    const radius = Math.round(SYNC_OTHER_SEARCH_S * analysisRate);
    const peaks = findPeaks(zM, Math.max(0, own + shift - radius), Math.min(zM.length - 1, own + shift + radius),
        exclusion, SYNC_OTHER_CANDIDATES);
    if (!peaks.length || zM[peaks[0]] < SYNC_MIN_SNR) throw new SyncError("No other device heard");
    const spread = Math.round(SYNC_DEVICES_SPREAD_S * analysisRate);
    if (peaks.some(peak => Math.abs(peak - peaks[0]) > spread && zM[peak] >= SYNC_AMBIGUOUS_RATIO * zM[peaks[0]])) {
        throw new SyncError("Couldn't tell where the other device is (repeating music or several devices), try again in a moment");
    }
    const others = peaks.filter(peak => zM[peak] >= SYNC_OTHER_DEVICE_RATIO * zM[peaks[0]]);

    const sidelobes = Math.round(SYNC_SIDELOBE_S * analysisRate);
    own = directArrival(zU, own, reflections, sidelobes);
    others[0] = directArrival(zM, others[0], reflections, sidelobes);
    const ownPosition = own + parabolicOffset(zU, own);
    const offsetOf = peak => (peak + parabolicOffset(zM, peak) - shift - ownPosition) / analysisRate;
    summary.own = describe(own);
    summary.other = describe(others[0] - shift);
    return {offset: offsetOf(others[0]), others: others.slice(1).map(offsetOf)};
}

function downloadSyncDebug(recording, {reference, referenceStart, rate}, summary) {
    const name = `sync-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const download = (blob, file) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${name}-${file}`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    };
    download(wavBlob(recording, rate), "recording.wav");
    download(wavBlob(reference, rate / analysisFactor(rate)), `reference-${referenceStart.toFixed(3)}s.wav`);
    download(new Blob([JSON.stringify(summary, null, 2)], {type: "application/json"}), "summary.json");
}

// mono 16-bit PCM WAV
function wavBlob(samples, rate) {
    const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
    const text = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
    text(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    text(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, samples.length * 2, true);
    samples.forEach((sample, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true));
    return new Blob([view.buffer], {type: "audio/wav"});
}

// reflections arrive later, so they match earlier song positions: the latest comparably strong match within the
// reflection time is the direct sound
function directArrival(values, peak, reflections, sidelobes) {
    let direct = peak;
    for (let k = peak + sidelobes; k <= Math.min(values.length - 2, peak + reflections); k++) {
        if (values[k] >= values[k - 1] && values[k] > values[k + 1] && values[k] >= SYNC_DIRECT_RATIO * values[peak]) direct = k;
    }
    return direct;
}

function rms(signal, from, length) {
    let sum = 0;
    const to = Math.min(signal.length, from + length);
    for (let i = Math.max(0, from); i < to; i++) sum += signal[i] * signal[i];
    return Math.sqrt(sum / Math.max(1, to - from));
}

// maximum of values[from..to], clamped to the array
function maxIn(values, from, to) {
    let max = -Infinity;
    for (let i = Math.max(0, from); i <= Math.min(values.length - 1, to); i++) max = Math.max(max, values[i]);
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

// divides each valid lag of a correlation by the energy of the reference part, so loud parts don't match everything
function normalizeByEnergy(correlation, reference, length) {
    const result = correlation.subarray(0, Math.max(0, reference.length - length + 1));
    let total = 0;
    for (const value of reference) total += value * value;
    const floor = SYNC_ENERGY_FLOOR * total * length / reference.length + 1e-12;
    let energy = 0;
    for (let i = 0; i < length; i++) energy += reference[i] * reference[i];
    for (let k = 0; k < result.length; k++) {
        result[k] /= Math.sqrt(Math.max(energy, floor));
        energy += (reference[k + length] ?? 0) ** 2 - reference[k] * reference[k];
    }
    return result;
}

// normalizes a correlation to mean 0 and standard deviation 1, in place
function zScores(result) {
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
            let swap = re[i];
            re[i] = re[j];
            re[j] = swap;
            swap = im[i];
            im[i] = im[j];
            im[j] = swap;
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
