const IPFS_CID = "bafybeicl6y6ln2rj5izxjjbrypuewxcos3fv5aq2y2a3dsnbcuvvapi2k4";
const FADE_STEP = 0.1;
const FADE_INTERVAL_MS = 500;
// the next song starts loading this long before the hour changes
const PREFETCH_MS = 60 * 1000;
const RETRY_DELAY_MS = 2000;
// a song that doesn't receive data for this long is reloaded. Longer than IPFS_STUCK_MS (ipfs.js), so a stuck
// download has already failed and replaced the IPFS client in the service worker, and the retry starts fresh.
const STALL_MS = 20 * 1000;
// attempts per song to stream it via the service worker, before the whole song is downloaded instead
const STREAMING_ATTEMPTS = 2;

let radioOn = false;
let checkWeatherFlag = false;
let lat = null;
let lng = null;
let filePathPrefix = "Normal";
let currentGame = "NewHorizons";
let maxVolume = 1;
let audioContext = null;
// seconds this device's playback is shifted from the wall clock, measured by the sync button
let syncOffset = 0;
// differences from the intended song position smaller than this are not corrected
const SYNC_TOLERANCE_S = 0.003;
// larger differences seek, smaller ones (and the time lost seeking) are made up by playing faster or slower
const SYNC_SEEK_THRESHOLD_S = 0.25;
const SYNC_RATE_CHANGE = 0.05;
// a seek pauses the playback until the new position is loaded; seeking again right after would land late again
const SYNC_SEEK_INTERVAL_MS = 10 * 1000;
// the lag between the playback and the intended position is averaged over this many readings, 10 ms apart
const SYNC_LAG_READINGS = 10;

// A session loads and plays one song. Aborting its signal cancels everything it started
// (weather requests, downloads, timers, fades) and tears down its audio element.
// The pending session is loading the next song while the current session's song keeps playing.
let pendingSession = null;
let currentSession = null;

class WeatherError extends Error {
}

if (!window.location.href.startsWith("file:")) {
    registerServiceWorker();
}

function onAbort(signal, callback) {
    if (signal.aborted) {
        callback();
        return () => {
        };
    }
    signal.addEventListener("abort", callback, {once: true});
    return () => signal.removeEventListener("abort", callback);
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const id = setTimeout(() => {
            removeListener();
            resolve();
        }, Math.max(0, ms));
        const removeListener = onAbort(signal, () => {
            clearTimeout(id);
            reject(signal.reason);
        });
    });
}

function waitForMedia(audio, eventName, signal) {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            audio.removeEventListener(eventName, onEvent);
            audio.removeEventListener("error", onError);
            removeListener();
        };
        const onEvent = () => {
            cleanup();
            resolve();
        };
        const onError = () => {
            cleanup();
            reject(new Error(`Media error ${audio.error?.code}: ${audio.error?.message}`));
        };
        audio.addEventListener(eventName, onEvent);
        audio.addEventListener("error", onError);
        const removeListener = onAbort(signal, () => {
            cleanup();
            reject(signal.reason);
        });
    });
}

function getAudioContext() {
    if (!audioContext) {
        audioContext = new AudioContext();
    }
    audioContext.resume().catch(error => console.error(error));
    return audioContext;
}

function nextHour(date) {
    const later = new Date(date);
    later.setMinutes(0, 0, 0);
    later.setHours(later.getHours() + 1);
    return later;
}

function playRadio() {
    radioOn = true;
    getAudioContext();
    startSession(new Date(), {showProgress: true, fadeOutPrevious: false});
}

function stopRadio() {
    radioOn = false;
    abortSession(pendingSession);
    abortSession(currentSession);
    setLoading(false);
}

function abortSession(session) {
    session?.controller.abort();
}

async function startSession(startAt, options) {
    abortSession(pendingSession);
    const controller = new AbortController();
    const session = {controller, signal: controller.signal, startAt, ...options, audio: null, streamingAttempts: 0};
    const signal = session.signal;
    pendingSession = session;
    onAbort(signal, () => {
        if (pendingSession === session) {
            pendingSession = null;
            if (session.showProgress) setLoading(false);
        }
        if (currentSession === session) currentSession = null;
    });
    showProgress(session, "Loading");

    while (true) {
        // each attempt gets its own controller so a failed attempt can be cleaned up without ending the session
        const attempt = new AbortController();
        const removeListener = onAbort(signal, () => attempt.abort(signal.reason));
        try {
            await loadAndPlay(session, attempt.signal);
            return;
        } catch (error) {
            attempt.abort();
            removeListener();
            if (signal.aborted) return;
            if (error?.name === "NotAllowedError") {
                console.error("Playback was blocked by the browser", error);
                stopRadio();
                showStartButton();
                return;
            }
            console.error("Error playing song. Retrying...", error);
            showProgress(session, "Retrying");
            try {
                await sleep(RETRY_DELAY_MS, signal);
            } catch {
                return;
            }
        }
    }
}

async function loadAndPlay(session, signal) {
    const hour = session.startAt.getHours();
    const game = currentGame;
    let weather = filePathPrefix;
    if (checkWeatherFlag) {
        try {
            weather = await fetchCurrentWeather(session.startAt, signal);
        } catch (error) {
            if (signal.aborted) throw error;
            weatherFailed(error);
            weather = "Normal";
        }
    }

    showProgress(session, "Loading");
    const src = await loadSong(game, weather, hour, session, signal, p => {
        showProgress(session, Math.trunc(p * 100) + "%");
    });

    const audio = createAudio(src, session.startAt, signal);
    showProgress(session, "Connecting");
    audio.addEventListener("loadedmetadata", () => showProgress(session, "Buffering"), {once: true});

    const stallWatch = new AbortController();
    const removeListener = onAbort(signal, () => stallWatch.abort());
    try {
        await Promise.race([
            failOnStall(audio, stallWatch.signal),
            (async () => {
                // let the browser start buffering until the song is supposed to start
                await Promise.race([
                    waitForMedia(audio, "canplay", signal),
                    sleep(session.startAt.getTime() - Date.now(), signal)
                ]);
                await sleep(session.startAt.getTime() - Date.now(), signal);

                // start muted, the previous song keeps playing until this one is actually audible
                audio.muted = true;
                await Promise.all([waitForMedia(audio, "playing", signal), audio.play()]);
            })()
        ]);
    } finally {
        stallWatch.abort();
        removeListener();
    }

    await promote(session, audio);
}

// rejects if the audio needs more data but hasn't received any for STALL_MS
function failOnStall(audio, signal) {
    return new Promise((resolve, reject) => {
        let lastActivity = Date.now();
        // the browser stopped loading on purpose, e.g. while preloading or because of its preload policy
        let suspended = false;
        const onProgress = () => {
            lastActivity = Date.now();
            suspended = false;
        };
        const onSuspend = () => suspended = true;
        audio.addEventListener("progress", onProgress);
        audio.addEventListener("suspend", onSuspend);
        const id = setInterval(() => {
            if (suspended || audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
                lastActivity = Date.now();
            } else if (Date.now() - lastActivity > STALL_MS) {
                cleanup();
                reject(new Error(`No data received for ${STALL_MS / 1000} s`));
            }
        }, 1000);
        const cleanup = () => {
            clearInterval(id);
            audio.removeEventListener("progress", onProgress);
            audio.removeEventListener("suspend", onSuspend);
        };
        onAbort(signal, cleanup);
    });
}

function showProgress(session, text) {
    if (session.showProgress && pendingSession === session) {
        setLoading(text);
    }
}

async function promote(session, audio) {
    const previous = currentSession;
    if (previous?.audio && session.fadeOutPrevious) {
        try {
            await fadeTo(previous.audio, () => 0, session.signal);
        } catch (error) {
            if (currentSession === previous && previous.audio) previous.audio.volume = maxVolume;
            throw error;
        }
    }

    session.audio = audio;
    if (pendingSession === session) pendingSession = null;
    currentSession = session;
    abortSession(previous);
    if (session.showProgress) setLoading(false);

    audio.muted = false;
    fadeTo(audio, () => maxVolume, session.signal).catch(() => {
    });

    // e.g. the stream broke or stalled after playback started
    const restart = reason => {
        console.error("Error during playback. Restarting...", reason);
        if (radioOn && currentSession === session && !pendingSession) {
            startSession(new Date(), {showProgress: false, fadeOutPrevious: false});
        }
    };
    audio.addEventListener("error", () => restart(audio.error), {once: true});
    failOnStall(audio, session.signal).catch(restart);

    // a song that started late (e.g. slow download) still ends at its hour
    const songEnd = nextHour(session.startAt);
    sleep(songEnd.getTime() - PREFETCH_MS - Date.now(), session.signal).then(() => {
        if (radioOn && !pendingSession) {
            startSession(new Date(Math.max(songEnd.getTime(), Date.now())), {showProgress: false, fadeOutPrevious: true});
        }
    }, () => {
    });
}

function createAudio(src, startAt, signal) {
    const audio = new Audio();
    audio.preload = "auto";
    audio.loop = true;
    audio.volume = 0;
    audio.src = src;
    onAbort(signal, () => {
        // releases the media resource and cancels its pending requests
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
    });

    // seek before playback starts so the browser buffers the right part of the song
    audio.addEventListener("loadedmetadata", () => {
        if (Number.isFinite(audio.duration)) audio.currentTime = songPosition(audio.duration, startAt.getTime() / 1000);
    }, {once: true});

    // synchronize the playback to the current second of the hour, also after it paused to buffer
    audio.addEventListener("playing", () => syncAudio(audio, signal).catch(() => {
    }));
    return audio;
}

// Brings the playback to the song position of the current time.
// Large differences are seeked. Seeking pauses the playback until the new position is loaded,
// so the time lost (and small differences) are made up by playing slightly faster or slower.
async function syncAudio(audio, signal) {
    const duration = audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    // a newer sync replaces this one
    audio.syncController?.abort();
    const controller = new AbortController();
    audio.syncController = controller;
    const removeListener = onAbort(signal, () => controller.abort());
    // the latency estimate fluctuates, so it is read once
    const latency = outputLatency();
    // positive if the playback is behind
    const lagNow = () => signedWrap(songPosition(duration, Date.now() / 1000, latency) - audio.currentTime, duration);
    // currentTime advances in steps of up to ~20 ms, so the lag is averaged over the last readings
    const readings = [];
    const lag = () => {
        readings.push(lagNow());
        if (readings.length > SYNC_LAG_READINGS) readings.shift();
        return readings.reduce((sum, value) => sum + value, 0) / readings.length;
    };
    const measureLag = async () => {
        readings.length = 0;
        for (let i = 1; i < SYNC_LAG_READINGS; i++) {
            lag();
            await sleep(10, controller.signal);
        }
        return lag();
    };
    try {
        if (Math.abs(await measureLag()) > SYNC_SEEK_THRESHOLD_S && Date.now() - (audio.lastSeek ?? 0) > SYNC_SEEK_INTERVAL_MS) {
            audio.lastSeek = Date.now();
            const target = songPosition(duration, Date.now() / 1000, latency);
            audio.currentTime = target;
            console.log(`Seeked to ${target.toFixed(3)} s`);
            await waitForMedia(audio, "seeked", controller.signal);
            // the playback only continues once the new position is loaded
            for (let i = 0; i < 100 && Math.abs(signedWrap(audio.currentTime - target, duration)) < 0.05; i++) {
                await sleep(20, controller.signal);
            }
        }

        const initialLag = await measureLag();
        if (Math.abs(initialLag) <= SYNC_TOLERANCE_S) return;
        const direction = Math.sign(initialLag);
        // changing the rate also costs a little time, so the lag is measured against the clock until it is made up
        const deadline = Date.now() + (1.5 * Math.abs(initialLag) / SYNC_RATE_CHANGE + 2) * 1000;
        audio.playbackRate = 1 + direction * SYNC_RATE_CHANGE;
        try {
            while (lag() * direction > SYNC_TOLERANCE_S && Date.now() < deadline) {
                await sleep(10, controller.signal);
            }
        } finally {
            if (audio.syncController === controller) audio.playbackRate = 1;
        }
    } finally {
        removeListener();
    }
}

// the sound we play now is heard after the output latency
function outputLatency() {
    return audioContext?.outputLatency || 0;
}

// the position in the song that should be audible at the given time
function songPosition(duration, nowSeconds, latency = outputLatency()) {
    const secondOfHour = (nowSeconds + latency + syncOffset) % 3600;
    return wrap(secondOfHour, duration);
}

function wrap(value, length) {
    return ((value % length) + length) % length;
}

// wraps into [-length / 2, length / 2)
function signedWrap(value, length) {
    return wrap(value + length / 2, length) - length / 2;
}

async function syncWithNearbyDevice() {
    const session = currentSession;
    const audio = session?.audio;
    if (!radioOn || !audio || !Number.isFinite(audio.duration)) {
        setSyncStatus("Start the radio first");
        return;
    }
    const button = $('#sync')[0];
    button.disabled = true;
    setSyncStatus("Listening...");
    try {
        const {offset, others} = await measureSongOffset({
            src: audio.currentSrc,
            duration: audio.duration,
            getPosition: () => audio.currentTime,
            setMuted: muted => audio.muted = muted,
            signal: session.signal
        });
        session.signal.throwIfAborted();
        const offsetText = formatMs(offset);
        let status;
        if (Math.abs(offset) < SYNC_TOLERANCE_S) {
            status = `Already in sync (${offsetText})`;
        } else {
            await shiftPlayback(audio, offset, session.signal);
            status = `Shifted by ${offsetText}`;
        }
        if (others.length) {
            status += `. ${others.length + 1} other devices heard, the others are ${others.map(other => formatMs(other - offset)).join(", ")} apart`;
        }
        setSyncStatus(status);
    } catch (error) {
        if (session.signal.aborted) {
            setSyncStatus("");
        } else {
            console.error(error);
            setSyncStatus(error instanceof SyncError ? error.message : "Sync failed");
        }
    } finally {
        button.disabled = false;
    }
}

// Shifts the playback by offset seconds and keeps the shift for later songs.
async function shiftPlayback(audio, offset, signal) {
    const duration = audio.duration;
    syncOffset += signedWrap(audio.currentTime + offset - songPosition(duration, Date.now() / 1000), duration);
    // a shift is applied right away, even if the playback was seeked recently
    audio.lastSeek = 0;
    await syncAudio(audio, signal);
}

function formatMs(seconds) {
    const ms = Math.round(seconds * 1000);
    return `${ms >= 0 ? "+" : ""}${ms} ms`;
}

function setSyncStatus(text) {
    $('#sync-status')[0].textContent = text;
}

function fadeTo(audio, getTarget, signal) {
    return new Promise((resolve, reject) => {
        const id = setInterval(() => {
            const target = getTarget();
            const diff = target - audio.volume;
            if (Math.abs(diff) <= FADE_STEP) {
                audio.volume = target;
                clearInterval(id);
                removeListener();
                resolve();
            } else {
                audio.volume += Math.sign(diff) * FADE_STEP;
            }
        }, FADE_INTERVAL_MS);
        const removeListener = onAbort(signal, () => {
            clearInterval(id);
            reject(signal.reason);
        });
    });
}

async function loadSong(game, weather, hour24, session, signal, onProgress) {
    const hour12Suffix = (hour24 >= 12) ? 'PM' : 'AM';
    let hour12 = (hour24 > 12) ? hour24 - 12 : hour24;
    hour12 = (hour12 === 0) ? 12 : hour12;

    // MP4, because browsers seek exactly in it (mp3 audio repackaged by tools/fix-vbr-mp3.sh, or AAC)
    const path = `${weather}${game}/${hour12}${hour12Suffix}.m4a`;
    console.log(`Loading ${path}`);

    if (window.location.href.startsWith("file:")) {
        return `songs/${path}`;
    }

    // the service worker streams the song, so playback can start before the download finishes.
    // if streaming fails repeatedly, the next attempt downloads the whole song instead
    const allowServiceWorker = session.streamingAttempts++ < STREAMING_ATTEMPTS;
    return await getServiceWorkerUrl(`ipfs/${IPFS_CID}/${path}`, {allowServiceWorker, signal, onProgress});
}

function swapButtons() {
    if ($('#start')[0].style.display === "block") {
        $('#start')[0].style.display = "none";
        $('#stop')[0].style.display = "block"
    } else {
        showStartButton();
    }
}

function showStartButton() {
    $('#stop')[0].style.display = "none";
    $('#start')[0].style.display = "block";
}

function setLoading(text) {
    const loading = !(text === null || text === false);
    const elem = $('#loading')[0];
    if (loading) elem.textContent = `(${text}) `;
    elem.style.display = loading ? "inline" : "none";
}

function weatherChanged(selected) {
    if (selected.id === "none") {
        $('#custom-weather-sub')[0].style.display = "none";
        checkWeatherFlag = false;
        filePathPrefix = "Normal";
        if (radioOn) playRadio();
    } else if (selected.id === "custom") {
        checkWeatherFlag = false;
        $('#custom-weather-sub')[0].style.display = "block";
        filePathPrefix = $('#custom-weather-sub').find(':checked')[0].id;
        if (radioOn) playRadio();
    } else if (selected.id === "dynamic") {
        checkWeatherFlag = true;
        $('#custom-weather-sub')[0].style.display = "none";
        if (!navigator.geolocation) {
            weatherFailed(new Error("Geolocation is not supported"));
            if (radioOn) playRadio();
            return;
        }
        navigator.geolocation.getCurrentPosition(pos => {
            lat = pos.coords.latitude;
            lng = pos.coords.longitude;
            if (radioOn && checkWeatherFlag) playRadio();
        }, error => {
            if (checkWeatherFlag) {
                weatherFailed(error);
                if (radioOn) playRadio();
            }
        });
    }
}

function customWeatherRequest(selected) {
    filePathPrefix = selected.id;
    if (radioOn) playRadio();
}

function setGame(selected) {
    currentGame = selected.value;
    console.log(currentGame);
    if (radioOn) playRadio();
}

function determineWeather(data) {
    let rainIcons = [
        'rain_sleet',
        'fzra',
        'rain_fzra',
        'snow_fzra',
        'sleet',
        'rain',
        'rain_showers',
        'rain_showers_hi',
        'tsra',
        'tsra_sct',
        'tsra_hi',
        'tornado',
        'hurricane',
        'tropical_storm'
    ];

    let snowIcons = [
        'snow',
        'rain_snow',
        'snow_sleet',
        'blizzard'
    ];

    let icon_name = data.icon.substring(data.icon.lastIndexOf('/') + 1, data.icon.indexOf('?'));
    if (icon_name.includes(',')) {
        icon_name = icon_name.substring(0, icon_name.indexOf(','));
    }
    console.log("Weather code: " + icon_name);
    if (snowIcons.includes(icon_name)) {
        return "Snow";
    } else if (rainIcons.includes(icon_name)) {
        return "Rain";
    } else {
        return "Normal";
    }
}

async function fetchJson(url, signal) {
    const response = await fetch(url, {signal});
    if (!response.ok) {
        throw new WeatherError(`Error loading ${url}: ${response.status} ${response.statusText}`);
    }
    return await response.json();
}

async function fetchCurrentWeather(date, signal) {
    if (lat === null || lng === null) {
        throw new WeatherError("Location is unknown");
    }
    const pointData = await fetchJson(`https://api.weather.gov/points/${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`, signal);
    console.log("Detected County Code: " + pointData.properties.county.substring(pointData.properties.county.lastIndexOf('/') + 1, pointData.properties.county.length));
    const forecast = await fetchJson(pointData.properties.forecastHourly, signal);
    // the song may be loaded before its hour starts
    const periods = forecast.properties.periods;
    const currentHour = periods.find(p => new Date(p.startTime) <= date && date < new Date(p.endTime)) ?? periods[0];
    const precipitation = determineWeather(currentHour);
    console.log("Interpreted Precipitaion: " + precipitation);
    return precipitation;
}

// falls back to no weather and tells the user about it
function weatherFailed(error) {
    console.error("Error determining the weather", error);
    checkWeatherFlag = false;
    filePathPrefix = "Normal";
    $('#weather-options').find('#none').prop('checked', true);
    $('#custom-weather-sub')[0].style.display = "none";
    showModal();
}

function shrinkModal() {
    $(".modal")[0].style.display = "none";
}

function showModal() {
    $(".modal")[0].style.display = "block";
}

function slideVolume(volume) {
    maxVolume = volume.value / 100;
    const audio = currentSession?.audio;
    if (audio) {
        audio.volume = maxVolume;
    }
}
