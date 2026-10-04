const IPFS_CID = "bafybeidq3jpqteqcirnnstx7pyrf4i2voaagrrhtaawlewvtv5heth5lqi";
const VERIFIED_FETCH_URL = "https://unpkg.com/@helia/verified-fetch@8.1.2/dist/index.min.js";
const FADE_STEP = 0.1;
const FADE_INTERVAL_MS = 500;
// the next song starts loading this long before the hour changes
const PREFETCH_MS = 60 * 1000;
const RETRY_DELAY_MS = 2000;

let radioOn = false;
let checkWeatherFlag = false;
let lat = null;
let lng = null;
let filePathPrefix = "Normal";
let currentGame = "NewHorizons";
let maxVolume = 1;
let audioContext = null;

// A session loads and plays one song. Aborting its signal cancels everything it started
// (weather requests, downloads, timers, fades) and tears down its audio element.
// The pending session is loading the next song while the current session's song keeps playing.
let pendingSession = null;
let currentSession = null;

class WeatherError extends Error {
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
    const session = {controller, signal: controller.signal, startAt, ...options, audio: null};
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
    const src = await loadSong(game, weather, hour, signal, p => {
        showProgress(session, Math.trunc(p * 100) + "%");
    });

    const audio = createAudio(src, session.startAt, signal);
    // let the browser start buffering until the song is supposed to start
    await Promise.race([
        waitForMedia(audio, "canplay", signal),
        sleep(session.startAt.getTime() - Date.now(), signal)
    ]);
    await sleep(session.startAt.getTime() - Date.now(), signal);

    // start muted, the previous song keeps playing until this one is actually audible
    audio.muted = true;
    await Promise.all([waitForMedia(audio, "playing", signal), audio.play()]);

    await promote(session, audio);
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

    // e.g. the stream broke after playback started
    audio.addEventListener("error", () => {
        console.error("Error during playback. Restarting...", audio.error);
        if (radioOn && currentSession === session && !pendingSession) {
            startSession(new Date(), {showProgress: false, fadeOutPrevious: false});
        }
    }, {once: true});

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
        syncAudio(audio, startAt.getTime() / 1000);
    }, {once: true});

    // synchronize the playback to the current second of hour
    let lastSync = 0;
    audio.addEventListener("playing", () => {
        const nowSeconds = Date.now() / 1000;
        if (nowSeconds - lastSync > 10) {
            lastSync = nowSeconds;
            const secondOffset = syncAudio(audio, nowSeconds);
            console.log("Track offset: " + secondOffset + "s");
        }
    });
    return audio;
}

function syncAudio(audio, nowSeconds) {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return null;
    // the sound we play now is heard after the output latency
    const latency = audioContext?.outputLatency || 0;
    const secondOfHour = (nowSeconds + latency) % 3600;
    const secondOffset = secondOfHour % audio.duration;
    audio.currentTime = secondOffset;
    return secondOffset;
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

async function loadSong(game, weather, hour24, signal, onProgress) {
    const hour12Suffix = (hour24 >= 12) ? 'PM' : 'AM';
    let hour12 = (hour24 > 12) ? hour24 - 12 : hour24;
    hour12 = (hour12 === 0) ? 12 : hour12;

    const ext = (game === "WildWorld") ? "m4a" : "mp3";
    const path = `${weather}${game}/${hour12}${hour12Suffix}.${ext}`;
    console.log(`Loading ${path}`);

    if (window.location.href.startsWith("file:")) {
        return `songs/${path}`;
    }

    console.log("Loading blob from IPFS...");
    const blob = await fetchIpfsBlob(`ipfs://${IPFS_CID}/${path}`, signal, onProgress);
    console.log("Loaded blob from IPFS");
    const blobUrl = URL.createObjectURL(blob);
    onAbort(signal, () => URL.revokeObjectURL(blobUrl));
    return blobUrl;
}

let verifiedFetchScript = null;
let verifiedFetchPromise = null;

function loadVerifiedFetchScript() {
    if (!verifiedFetchScript) {
        verifiedFetchScript = new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = VERIFIED_FETCH_URL;
            script.onload = resolve;
            script.onerror = () => {
                script.remove();
                verifiedFetchScript = null;
                reject(new Error("Failed to load " + VERIFIED_FETCH_URL));
            };
            document.head.append(script);
        });
    }
    return verifiedFetchScript;
}

function getVerifiedFetch() {
    if (!verifiedFetchPromise) {
        const promise = loadVerifiedFetchScript().then(() => HeliaVerifiedFetch.createVerifiedFetch({}));
        promise.catch(() => {
            if (verifiedFetchPromise === promise) verifiedFetchPromise = null;
        });
        verifiedFetchPromise = promise;
    }
    return verifiedFetchPromise;
}

async function resetVerifiedFetch(broken) {
    if (verifiedFetchPromise !== broken) return;
    verifiedFetchPromise = null;
    try {
        await (await broken).stop();
    } catch (error) {
        console.error(error);
    }
}

async function fetchIpfsBlob(ipfsUrl, signal, onProgress) {
    const verifiedFetchP = getVerifiedFetch();
    let response;
    try {
        const verifiedFetch = await verifiedFetchP;
        signal.throwIfAborted();
        // No abort signal is passed on purpose: an aborted request breaks the verifiedFetch instance
        // and all following requests hang. Cancelling the body instead stops the download.
        response = await verifiedFetch(ipfsUrl);
    } catch (error) {
        if (!signal.aborted) resetVerifiedFetch(verifiedFetchP);
        throw error;
    }
    if (!response.ok) {
        response.body?.cancel().catch(() => {
        });
        throw new Error(`Error loading ${ipfsUrl}: ${response.status} ${response.statusText}`);
    }

    const totalBytes = Number(response.headers.get("content-length"));
    const reader = response.body.getReader();
    const removeListener = onAbort(signal, () => reader.cancel().catch(() => {
    }));
    try {
        const chunks = [];
        let bytesRead = 0;
        while (true) {
            const {done, value} = await reader.read();
            signal.throwIfAborted();
            if (done) break;
            chunks.push(value);
            bytesRead += value.length;
            if (totalBytes && onProgress) onProgress(bytesRead / totalBytes);
        }
        return new Blob(chunks, {type: response.headers.get("content-type") || ""});
    } finally {
        removeListener();
    }
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
