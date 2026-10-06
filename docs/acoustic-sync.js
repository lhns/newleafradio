// Measures how far other devices playing the same song are ahead of this device, by listening to them.
// The microphone hears this device and the other devices. Both are located in a decoded slice of the song by
// cross-correlation. This device is muted and unmuted in short slices while recording: it is the match that is gone
// while muted, the other devices are heard throughout.
// Microphone and output latency cancel out, because all devices are heard through the same microphone.
// The analysis runs in a worker loading this file, so it doesn't block the page.
// Uses onAbort from radio.js.

// the microphone can deliver silence at first (Firefox: ~0.5 s), the measurement waits this long for sound
const SYNC_MIC_TIMEOUT_S = 3;
// time after the microphone delivers sound before recording (output glitches when the microphone opens)
const SYNC_SETTLE_S = 0.5;
// this device is muted and unmuted every SYNC_SLICE_S while recording, an odd number of slices ends unmuted
const SYNC_RECORDING_S = 4.5;
const SYNC_SLICE_S = 0.5;
// time after each switch that isn't analyzed: a switch is heard after this device's latency, which is estimated from
// its match, with some jitter, and reverberates
const SYNC_SWITCH_GUARD_S = 0.15;
// the reference covers this much of the song around the current position
const SYNC_REFERENCE_MARGIN_S = 10;
const SYNC_MAX_WHOLE_FILE_BYTES = 30 * 1024 * 1024;
const SYNC_ANALYSIS_RATE = 16000;
const SYNC_BAND_HZ = [300, 7000];
const SYNC_PHAT_BETA = 0.7;
// this device is searched from this much before its playback position (latency) to this much after
const SYNC_OWN_LATENCY_S = 0.7;
const SYNC_OWN_AHEAD_S = 0.05;
// this device's latency is looked for at this many matches in its window
const SYNC_OWN_CANDIDATES = 3;
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
// devices are heard while muted with at least this score (the muted slices are short, see SYNC_RECORDING_S)
const SYNC_MUTED_MIN_SNR = 8;
// correlations are divided by the song part's energy, but at least this fraction of the average
const SYNC_ENERGY_FLOOR = 0.05;
const SYNC_OTHER_DEVICE_RATIO = 0.75;
// a second match this strong and further away is ambiguous (repeating music), so the result is rejected
const SYNC_AMBIGUOUS_RATIO = 0.8;
const SYNC_DEVICES_SPREAD_S = 0.5;
// a match of this device is at most this strong while muted, relative to unmuted. The other devices' matches are
// heard in both, but their strength differs between them (the slices contain different music) by up to ~4 times.
const SYNC_OWN_GONE_RATIO = 0.15;
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
async function measureSongOffset({src, getPosition, setMuted, signal}) {
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new SyncError("Microphone not available");
    }
    const context = new AudioContext();
    let stream = null;
    try {
        const factor = analysisFactor(context.sampleRate);
        const recordingSeconds = SYNC_MIC_TIMEOUT_S + SYNC_SETTLE_S + SYNC_RECORDING_S;
        const reference = loadReference(src, getPosition(), recordingSeconds, context.sampleRate / factor, signal);
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

        const {recording, start, toggles, timing} = await record(context, stream, getPosition, setMuted, signal);
        const {deviceId, groupId, ...settings} = stream.getAudioTracks()[0]?.getSettings() ?? {};
        stream.getTracks().forEach(track => track.stop());
        stream = null;

        const {samples: referenceSamples, startSeconds} = await reference;
        const input = {
            samples: recording.subarray(start), toggles, position: timing.position,
            reference: referenceSamples, referenceStart: startSeconds, rate: context.sampleRate
        };
        const report = (outcome, summary) => {
            summary = {
                ...outcome, ...summary, ...timing, start, settings,
                outputLatency: context.outputLatency, baseLatency: context.baseLatency
            };
            console.debug("sync analysis", summary);
            try {
                if (SYNC_DEBUG) downloadSyncDebug(recording, input, summary);
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
    // the first sample with sound: until the microphone runs, the recorder records exact zeros
    let micStart = -1;
    // the audio context's frame of the first sample
    let firstFrame = 0;
    let onSamples = null;
    recorder.port.onmessage = ({data: {samples, end}}) => {
        if (!length) firstFrame = end - samples.length;
        if (micStart < 0) {
            const i = samples.findIndex(sample => sample !== 0);
            if (i >= 0) micStart = length + i;
        }
        chunks.push(samples);
        length += samples.length;
        onSamples?.();
    };
    // resolves once done() returns true, which is checked whenever samples arrive
    const waitFor = done => new Promise((resolve, reject) => {
        const removeListener = onAbort(signal, () => {
            onSamples = null;
            reject(signal.reason);
        });
        onSamples = () => {
            if (!done()) return;
            onSamples = null;
            removeListener();
            resolve();
        };
        if (!signal.aborted) onSamples();
    });
    const waitForSamples = samples => waitFor(() => length >= samples);

    source.connect(recorder);
    // the recorder only outputs silence, but has to be connected to be processed
    recorder.connect(context.destination);
    try {
        const rate = context.sampleRate;
        const timeout = Math.round(SYNC_MIC_TIMEOUT_S * rate);
        await waitFor(() => micStart >= 0 || length >= timeout);
        if (micStart < 0) throw new SyncError("The microphone didn't deliver any sound");
        const start = micStart + Math.round(SYNC_SETTLE_S * rate);
        const end = start + Math.round(SYNC_RECORDING_S * rate);
        // the sample being recorded now, from the audio clock: the main thread can lag behind the recorder
        const now = () => Math.round(context.currentTime * rate) - firstFrame;
        // the song position when sample i was recorded
        const positionAt = i => getPosition() - (now() - i) / rate;
        await waitForSamples(start);
        const position = positionAt(start);
        // the samples (from start) at which this device was muted and unmuted
        const toggles = [];
        for (let k = 1; k < Math.round(SYNC_RECORDING_S / SYNC_SLICE_S); k++) {
            await waitForSamples(start + Math.round(k * SYNC_SLICE_S * rate));
            setMuted(k % 2 === 1);
            toggles.push(now() - start);
        }
        await waitForSamples(end);
        const endPosition = positionAt(end);

        const recording = new Float32Array(end);
        let offset = 0;
        for (const chunk of chunks) {
            if (offset >= end) break;
            recording.set(chunk.subarray(0, end - offset), offset);
            offset += chunk.length;
        }
        return {
            recording, start, toggles,
            // the song should advance as much as the recording, otherwise the playback rate changed or it was seeked
            timing: {
                micStart, position, endPosition,
                driftMs: +((endPosition - position - (end - start) / rate) * 1000).toFixed(1)
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
// Returns {samples, startSeconds}, startSeconds being the song position of the first sample.
async function loadReference(src, position, recordingSeconds, rate, signal) {
    const [from, to] = [position - SYNC_REFERENCE_MARGIN_S, position + recordingSeconds + SYNC_REFERENCE_MARGIN_S];

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

    // mp3 frames can be decoded from anywhere, so only the frames around the position are needed
    const frames = await mp4Mp3Frames(read, fileSize);
    let bytes;
    let startSeconds = 0;
    if (frames) {
        const {offsets, sizes, times} = frames;
        let first = 0;
        while (first + 1 < times.length && times[first + 1] <= from) first++;
        let last = first;
        while (last + 1 < times.length && times[last] < to) last++;
        bytes = (await read(offsets[first], offsets[last] + sizes[last])).slice();
        startSeconds = times[first];
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
        [start, end] = [Math.max(0, Math.floor(from * rate)), Math.min(end, Math.ceil(to * rate))];
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

// The frames of the mp3 track of an MP4 file from its sample tables, or null (e.g. AAC):
// {offsets, sizes, times}, times being the song positions of the frames (like currentTime, after the edit list).
async function mp4Mp3Frames(read, fileSize) {
    let moov = null;
    for (let offset = 0; !moov && offset + 8 <= fileSize;) {
        const box = mp4Box(await read(offset, Math.min(offset + 16, fileSize)), 0, fileSize - offset);
        if (!box) return null;
        if (box.type === "moov") moov = await read(offset, offset + box.end);
        offset += box.end;
    }
    if (!moov) return null;
    try {
        const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
        const u32 = i => view.getUint32(i);
        const root = mp4Box(moov, 0, moov.length);
        const trak = mp4Boxes(moov, root.start, root.end)
            .find(box => box.type === "trak" && mp4IsMp3(moov, mp4Find(moov, box, "mdia/minf/stbl/stsd")));
        if (!trak) return null;
        const table = type => mp4Find(moov, trak, `mdia/minf/stbl/${type}`);

        const mdhd = mp4Find(moov, trak, "mdia/mdhd");
        const timescale = u32(mdhd.start + (moov[mdhd.start] === 1 ? 20 : 12));
        // the edit list skips the encoder delay; empty edits are ignored
        let mediaTime = 0;
        const elst = mp4Find(moov, trak, "edts/elst");
        const v1 = elst && moov[elst.start] === 1;
        for (let i = 0; elst && i < u32(elst.start + 4); i++) {
            const entry = elst.start + 8 + i * (v1 ? 20 : 12);
            const time = v1 ? Number(view.getBigInt64(entry + 8)) : view.getInt32(entry + 4);
            if (time >= 0) {
                mediaTime = time;
                break;
            }
        }

        const stsz = table("stsz");
        const count = u32(stsz.start + 8);
        const sizes = Array.from({length: count}, (_, i) => u32(stsz.start + 4) || u32(stsz.start + 12 + 4 * i));

        const times = [];
        const stts = table("stts");
        for (let e = 0, time = -mediaTime; e < u32(stts.start + 4); e++) {
            for (let i = 0; i < u32(stts.start + 8 + 8 * e); i++, time += u32(stts.start + 12 + 8 * e)) {
                times.push(time / timescale);
            }
        }

        const stco = table("stco");
        const co64 = table("co64");
        const chunkOffset = c => stco ? u32(stco.start + 8 + 4 * c) : Number(view.getBigUint64(co64.start + 8 + 8 * c));
        const chunks = u32((stco ?? co64).start + 4);
        const offsets = [];
        const stsc = table("stsc");
        for (let e = 0, entries = u32(stsc.start + 4); e < entries; e++) {
            const entry = stsc.start + 8 + 12 * e;
            const end = e + 1 < entries ? u32(entry + 12) - 1 : chunks;
            for (let c = u32(entry) - 1; c < end; c++) {
                for (let i = 0, offset = chunkOffset(c); i < u32(entry + 4) && offsets.length < count; i++) {
                    offsets.push(offset);
                    offset += sizes[offsets.length - 1];
                }
            }
        }
        const backToBack = offsets.every((offset, i) => i === 0 || offset === offsets[i - 1] + sizes[i - 1]);
        return count > 0 && offsets.length === count && times.length === count && backToBack ? {offsets, sizes, times} : null;
    } catch (error) {
        // e.g. missing tables
        console.error(error);
        return null;
    }
}

// {type, start, end} of the MP4 box at offset in bytes, start being where its content starts, or null if none fits
function mp4Box(bytes, offset, end) {
    if (offset + 8 > Math.min(end, bytes.length)) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let size = view.getUint32(offset);
    let start = offset + 8;
    if (size === 1) {
        if (offset + 16 > bytes.length) return null;
        size = Number(view.getBigUint64(offset + 8));
        start += 8;
    } else if (size === 0) {
        // the box extends to the end
        size = end - offset;
    }
    if (offset + size < start || offset + size > end) return null;
    return {type: String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)), start, end: offset + size};
}

function mp4Boxes(bytes, start, end) {
    const boxes = [];
    for (let box; (box = mp4Box(bytes, start, end)); start = box.end) boxes.push(box);
    return boxes;
}

// the box at the path (e.g. "mdia/mdhd") below the given box, or undefined
function mp4Find(bytes, box, path) {
    for (const type of path.split("/")) box = box && mp4Boxes(bytes, box.start, box.end).find(child => child.type === type);
    return box;
}

// whether a sample description (stsd) is MPEG audio, by the object type in its decoder config
function mp4IsMp3(bytes, stsd) {
    // the mp4a entry has 28 bytes before its esds box
    const entry = stsd && mp4Box(bytes, stsd.start + 8, stsd.end);
    const esds = entry && mp4Boxes(bytes, entry.start + 28, entry.end).find(box => box.type === "esds");
    if (!esds) return false;
    // the content of the descriptor at i (after its tag and variable length size)
    const content = i => {
        for (i++; bytes[i++] & 0x80;) ;
        return i;
    };
    // the ES descriptor: ES id, flags for optional fields, then the decoder config descriptor
    let i = content(esds.start + 4) + 2;
    const flags = bytes[i++];
    if (flags & 0x80) i += 2;
    if (flags & 0x40) i += 1 + bytes[i];
    if (flags & 0x20) i += 2;
    const type = bytes[content(i)];
    return bytes[i] === 4 && (type === 0x6B || type === 0x69);
}

// the microphone recording is decimated by this factor for the analysis
function analysisFactor(rate) {
    return Math.max(1, Math.round(rate / SYNC_ANALYSIS_RATE));
}

// Finds this device (heard only while unmuted) and the other devices (heard while muted) in the reference.
// samples is the recording at rate, toggles are the samples at which this device was muted, unmuted, muted...,
// position is the song position at the first sample. The reference is at rate / analysisFactor(rate), referenceStart
// is its song position. summary is filled with details for diagnostics, also when an error is thrown.
function analyzeRecording({samples, toggles, position, reference, referenceStart, rate}, summary = {}) {
    const factor = analysisFactor(rate);
    const analysisRate = rate / factor;
    const dbfs = signal => +(20 * Math.log10(Math.max(rms(signal, 0, signal.length), 1e-9))).toFixed(1);
    Object.assign(summary, {
        rate, analysisRate, position, referenceStart, toggles, length: samples.length, referenceLength: reference.length,
        dbfs: dbfs(samples), referenceDbfs: dbfs(reference),
        thresholds: {
            ownMinSnr: SYNC_OWN_MIN_SNR, minSnr: SYNC_MIN_SNR, ownLatencyS: SYNC_OWN_LATENCY_S, ownAheadS: SYNC_OWN_AHEAD_S,
            ownGoneRatio: SYNC_OWN_GONE_RATIO, switchGuardS: SYNC_SWITCH_GUARD_S
        }
    });
    const x = decimate(samples, factor);
    // the microphone can be lowered while this device plays (ducking), so each slice is scaled to the same loudness
    const switches = [0, ...toggles.map(i => Math.round(i / factor)), x.length];
    for (let k = 0; k + 1 < switches.length; k++) {
        const loudness = Math.max(rms(x, switches[k], switches[k + 1] - switches[k]), 1e-9);
        for (let i = switches[k]; i < switches[k + 1]; i++) x[i] /= loudness;
    }
    // only the part of the reference where devices are looked for (this device's position minus its latency, other
    // devices around it), relative to which expected is the position at the start of the recording
    const position0 = Math.round((position - referenceStart) * analysisRate);
    const first = Math.max(0, position0 - Math.round((SYNC_OWN_LATENCY_S + SYNC_OTHER_SEARCH_S) * analysisRate));
    const s = reference.subarray(first, position0 + Math.round((SYNC_OWN_AHEAD_S + SYNC_OTHER_SEARCH_S) * analysisRate) + x.length);
    const expected = position0 - first;
    if (s.length < x.length + 2) throw new SyncError("The song could not be loaded for syncing");

    const n = nextPowerOfTwo(s.length + x.length);
    const referenceSpectrum = spectrum(s, n);
    // scores of the recording's parts ([from, to) at the analysis rate) at each position in the reference
    const correlateParts = parts => {
        const signal = new Float64Array(x.length);
        for (const [from, to] of parts) signal.set(x.subarray(from, to), from);
        return zScores(normalizeByEnergy(correlate(signal, referenceSpectrum, n, analysisRate), s, x.length));
    };
    // the parts while this device is heard unmuted and muted, if switches are heard `latency` samples after they're made
    const guard = Math.round(SYNC_SWITCH_GUARD_S * analysisRate);
    const slices = latency => {
        const edges = [0, ...toggles.map(i => Math.round(i / factor) + latency), x.length];
        const parts = {unmuted: [], muted: []};
        for (let k = 0; k + 1 < edges.length; k++) {
            const [from, to] = [Math.max(0, edges[k] + (k ? guard : 0)), Math.min(x.length, edges[k + 1])];
            if (from < to) parts[k % 2 ? "muted" : "unmuted"].push([from, to]);
        }
        return parts;
    };
    const exclusion = Math.round(SYNC_PEAK_EXCLUSION_S * analysisRate);
    const reflections = Math.round(SYNC_REFLECTION_S * analysisRate);
    const sidelobes = Math.round(SYNC_SIDELOBE_S * analysisRate);

    // this device: matches shortly before the expected position (playback position minus latency)
    const ownFrom = Math.max(0, expected - Math.round(SYNC_OWN_LATENCY_S * analysisRate));
    const ownTo = Math.min(s.length - x.length, expected + Math.round(SYNC_OWN_AHEAD_S * analysisRate));
    if (ownFrom > ownTo) throw new SyncError("The song could not be loaded for syncing");
    const ms = peak => +((peak - expected) / analysisRate * 1000).toFixed(1);
    const whole = correlateParts([[0, x.length]]);
    Object.assign(summary, {
        expected, expectedSeconds: position - referenceStart, referenceFirst: first,
        ownWindowMs: [ms(ownFrom), ms(ownTo)],
        // anywhere, in case this device's latency is outside the window
        peaks: findPeaks(whole, 0, whole.length - 1, exclusion, SYNC_SUMMARY_PEAKS).map(peak => ({ms: ms(peak), score: +whole[peak].toFixed(1)})),
        ownCandidates: []
    });

    // this device's latency (and so when the switches are heard) is tried for the strongest matches in its window:
    // this device is the strongest match near one of them that is gone while muted
    let best = null;
    let heard = false;
    for (const candidate of findPeaks(whole, ownFrom, ownTo, reflections, SYNC_OWN_CANDIDATES)) {
        const parts = slices(expected - candidate);
        const zU = correlateParts(parts.unmuted);
        const zM = correlateParts(parts.muted);
        const muted = peak => maxIn(zM, peak - 2, peak + 2);
        const gone = peak => {
            // a match close to a device heard while muted could be its reflection, which is scaled like its match
            const [nearby] = findPeaks(zM, peak - reflections, peak + reflections, exclusion, 1);
            const device = nearby !== undefined && zM[nearby] >= SYNC_MUTED_MIN_SNR;
            return muted(peak) <= SYNC_OWN_GONE_RATIO * zU[peak] * (device && zU[nearby] > zM[nearby] ? zM[nearby] / zU[nearby] : 1);
        };
        const matches = findPeaks(zU, Math.max(ownFrom, candidate - reflections), Math.min(ownTo, candidate + reflections),
            exclusion, SYNC_OWN_CANDIDATES).filter(peak => zU[peak] >= SYNC_OWN_MIN_SNR);
        heard ||= matches.length > 0;
        const own = matches.find(gone);
        summary.ownCandidates.push({
            ms: ms(candidate), score: +whole[candidate].toFixed(1),
            matches: matches.map(peak => ({ms: ms(peak), unmuted: +zU[peak].toFixed(1), muted: +muted(peak).toFixed(1)}))
        });
        if (own !== undefined && (!best || zU[own] > best.zU[best.own])) best = {own, zU, zM, muted, gone, parts, candidate};
    }
    if (!best) {
        throw new SyncError(heard ? "Couldn't tell this device apart from the others, they may already be in sync"
            : "Couldn't hear the song, turn the volume up");
    }
    const {zU, zM, muted, gone, parts} = best;
    const describe = peak => ({
        ms: ms(peak), score: +whole[peak].toFixed(1), unmuted: +zU[peak].toFixed(1), muted: +muted(peak).toFixed(1)
    });
    // the slices that were analyzed, in samples of the recording
    summary.slices = Object.fromEntries(Object.entries(parts).map(([key, list]) => [key, list.map(part => part.map(i => i * factor))]));
    summary.latencyMs = +((expected - best.candidate) / analysisRate * 1000).toFixed(1);
    summary.own = describe(best.own);
    // a stronger match in the window that is heard while muted but stronger unmuted is this device in sync with another
    // one, and the match gone while muted only its repetition (repeating music)
    if (findPeaks(zU, ownFrom, ownTo, exclusion, SYNC_OWN_CANDIDATES).some(peak => Math.abs(peak - best.own) > reflections
        && zU[peak] > zU[best.own] && zU[peak] > muted(peak) && !gone(peak))) {
        throw new SyncError("Couldn't tell this device apart from the others, they may already be in sync");
    }

    // other devices: heard in the whole recording, also while this device is muted
    const radius = Math.round(SYNC_OTHER_SEARCH_S * analysisRate);
    // without this device's match, which would hide matches close to it (its side lobes aren't heard while muted)
    const withoutOwn = whole.slice();
    withoutOwn.fill(-Infinity, best.own - 2, best.own + 3);
    const peaks = findPeaks(withoutOwn, Math.max(0, best.own - radius), Math.min(whole.length - 1, best.own + radius), exclusion, SYNC_OTHER_CANDIDATES)
        .filter(peak => muted(peak) >= SYNC_MUTED_MIN_SNR);
    summary.otherPeaks = peaks.slice(0, SYNC_SUMMARY_PEAKS).map(describe);
    // this device dilutes the scores of the whole recording
    if (!peaks.length || Math.max(whole[peaks[0]], muted(peaks[0])) < SYNC_MIN_SNR) {
        throw new SyncError("No other device heard (or it is in sync with this one)");
    }
    const spread = Math.round(SYNC_DEVICES_SPREAD_S * analysisRate);
    if (peaks.some(peak => Math.abs(peak - peaks[0]) > spread && whole[peak] >= SYNC_AMBIGUOUS_RATIO * whole[peaks[0]])) {
        throw new SyncError("Couldn't tell where the other device is (repeating music or several devices), try again in a moment");
    }
    const others = peaks.filter(peak => whole[peak] >= SYNC_OTHER_DEVICE_RATIO * whole[peaks[0]]);

    // earlier arrivals must belong to the same device: gone while muted for this device, heard while muted for others
    const own = directArrival(zU, best.own, reflections, sidelobes, gone);
    others[0] = directArrival(whole, others[0], reflections, sidelobes, peak => muted(peak) >= SYNC_MUTED_MIN_SNR);
    const ownPosition = own + parabolicOffset(zU, own);
    const offsetOf = peak => (peak + parabolicOffset(whole, peak) - ownPosition) / analysisRate;
    summary.own = describe(own);
    summary.other = describe(others[0]);
    return {offset: offsetOf(others[0]), others: others.slice(1).map(offsetOf)};
}

function downloadSyncDebug(recording, {reference, referenceStart, rate}, summary) {
    const name = `sync-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const download = (blob, file) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${name}-${file}`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    };
    // one file at a time, summary first: Firefox once saved an empty summary when it came right after the recordings
    const files = [
        () => download(new Blob([JSON.stringify(summary, null, 2)], {type: "application/json"}), "summary.json"),
        () => download(wavBlob(recording, rate), "recording.wav"),
        () => download(wavBlob(reference, rate / analysisFactor(rate)), `reference-${referenceStart.toFixed(3)}s.wav`)
    ];
    files.forEach((file, i) => setTimeout(file, i * 1000));
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
// reflection time is the direct sound, among the matches for which counts(k) is true
function directArrival(values, peak, reflections, sidelobes, counts = () => true) {
    let direct = peak;
    for (let k = peak + sidelobes; k <= Math.min(values.length - 2, peak + reflections); k++) {
        if (values[k] >= values[k - 1] && values[k] > values[k + 1] && values[k] >= SYNC_DIRECT_RATIO * values[peak] && counts(k)) {
            direct = k;
        }
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
        const weight = 1 / (Math.pow(re * re + im * im, SYNC_PHAT_BETA / 2) + 1e-12);
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
