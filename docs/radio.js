let intervalNotSet = true;
let timer;
let fadeOutTimer;
let fadeInTimer;
let coffeeBreakFlag = true;
let checkWeatherFlag = false;
let lat = 0;
let lng = 0;
let filePathPrefix = "Normal";
let currentGame = "NewHorizons";
let maxVolume = 1;
let latency = 0;
let currentAbortControllers = [];
const audioContext = new AudioContext();
const asyncVerifiedFetch = HeliaVerifiedFetch.createVerifiedFetch({
    gateways: [/*'https://ipfs.lhns.de', */'https://trustless-gateway.link']
});

async function playRadio() {
    coffeeBreakFlag = false;
    const now = new Date();

    const later = new Date(now);
    later.setMilliseconds(0);
    later.setSeconds(0);
    later.setMinutes(0);
    later.setHours(now.getHours() + 1);
    console.log("Next song change: " + later);

    const timeToElapse = later.getTime() - now.getTime();
    console.log("Milliseconds before then: " + timeToElapse);

    if (checkWeatherFlag) {
        await updateCurrentWeather();
    }

    console.log("playing song...");
    const audio = await playSong(now.getHours());

    timer = setTimeout(function () {
        if (!coffeeBreakFlag) {
            fadeOut();
        }
    }, timeToElapse);
}

function abortOld(reason, except) {
    let newAbortControllers = [];
    for (const abortController of currentAbortControllers) {
        if (abortController === except) {
            newAbortControllers = newAbortControllers.concat([abortController]);
        } else {
            abortController.abort(reason);
        }
    }
    currentAbortControllers = newAbortControllers;
}

function stopRadio() {
    coffeeBreakFlag = true;
    clearInterval(fadeOutTimer);
    fadeOutTimer = null;
    clearInterval(fadeInTimer);
    fadeInTimer = null;
    clearTimeout(timer);
    abortOld("stop playback", null);
}

async function fetchIpfsBlob(ipfsUrl, signal) {
    try {
        const verifiedFetch = await asyncVerifiedFetch;
        const response = await verifiedFetch(ipfsUrl, {signal: signal});
        console.log(response);
        return await response.blob();
    } catch (error) {
        if (!signal.aborted) {
            console.error("Error loading blob from IPFS. Retrying...");
            console.error(error);
            await new Promise(r => setTimeout(r, 1000));
            return await fetchIpfs(ipfsUrl);
        }
    }
}

async function loadSong(game, weather, hour24, signal) {
    const hour12Suffix = (hour24 >= 12) ? 'PM' : 'AM';
    let hour12 = (hour24 > 12) ? hour24 - 12 : hour24;
    hour12 = (hour12 == 0) ? 12 : hour12;

    let ext = "mp3";
    if (currentGame === "WildWorld") {
        ext = "m4a";
    }

    const dirName = `${weather}${game}`;
    const fileName = `${hour12}${hour12Suffix}.${ext}`
    console.log(`Loading ${dirName}/${fileName}`);

    if (window.location.href.startsWith("file:")) {
        return `songs/${dirName}/${fileName}`;
    } else {
        const ipfsUrl = `ipfs://QmU8r6FoSr6YLaNCSn1yYVXoAcrEoM5pLNCYVqx8tCXFhA/${dirName}/${fileName}`;
        console.log("Loading blob from IPFS...");
        const blob = await fetchIpfsBlob(ipfsUrl);
        console.log("Loaded blob from IPFS");
        const blobUrl = URL.createObjectURL(blob, signal);
        signal.addEventListener("abort", () => {
            URL.revokeObjectURL(blobUrl);
        });
        return blobUrl;
    }
}

function syncAudio(audio, nowSeconds, latency) {
    const secondOfHour = (nowSeconds - latency) % 3600;
    const secondOffset = secondOfHour % audio.duration;
    audio.currentTime = secondOffset;
    return secondOffset
}

async function playSong(hour) {
    const abortController = new AbortController();
    currentAbortControllers = currentAbortControllers.concat([abortController]);
    const signal = abortController.signal;

    setLoading(true);
    const src = await loadSong(currentGame, filePathPrefix, hour, signal);
    setLoading(false);

    abortOld("stop playback", abortController);

    if (!signal.aborted) {
        const audio = document.createElement('audio');
        audio.id = 'current-song'
        audio.src = src;
        audio.volume = 0;
        audio.loop = true;
        document.body.append(audio);
        signal.addEventListener('abort', () => {
            audio.remove();
        });

        // synchronize the playback to the current second of hour
        let lastSync = 0;
        audio.addEventListener('playing', () => {
            const nowSeconds = Date.now() / 1000;
            if (nowSeconds - lastSync > 10) {
                lastSync = nowSeconds;
                const latency = audioContext.outputLatency;
                const secondOffset = syncAudio(audio, nowSeconds, latency);
                console.log("Track offset: " + secondOffset + "s (audio latency: " + latency + "s)");
            }
        });

        audio.play();
        fadeIn();

        return audio;
    }
}

function fadeOut() {
    console.log('swapping songs');
    if (!fadeOutTimer) {
        fadeOutTimer = setInterval(function () {
            const audio = $('#current-song')[0];
            if (audio && !coffeeBreakFlag) {
                let currentVolume = audio.volume;
                if (currentVolume - .1 > 0) {
                    audio.volume -= .1;
                } else {
                    audio.volume = 0;
                    clearInterval(fadeOutTimer);
                    fadeOutTimer = null;
                    playRadio();
                }
            }
        }, 500);
    }
}

function fadeIn() {
    if (!fadeInTimer) {
        fadeInTimer = setInterval(function () {
            if (fadeOutTimer) {
                clearInterval(fadeInTimer);
                fadeInTimer = null;
            }
            const audio = $('#current-song')[0];
            if (audio && !coffeeBreakFlag) {
                const currentVolume = audio.volume;
                if (currentVolume + .1 < maxVolume) {
                    audio.volume += .1
                } else {
                    audio.volume = maxVolume;
                    clearInterval(fadeInTimer);
                    fadeInTimer = null;
                }
            }
        }, 500);
    }
}

function swapButtons() {
    if ($('#start')[0].style.display == "block") {
        $('#start')[0].style.display = "none";
        $('#stop')[0].style.display = "block"
    } else {
        $('#stop')[0].style.display = "none";
        $('#start')[0].style.display = "block";
    }
}

function setLoading(loading) {
    $('#loading')[0].style.display = loading ? "inline" : "none";
}

async function weatherChanged(selected) {
    if (selected.id == "none") {
        $('#custom-weather-sub')[0].style.display = "none";
        checkWeatherFlag = false;
        filePathPrefix = "Normal";
        if (!coffeeBreakFlag) {
            await playRadio();
        }
    } else if (selected.id == "custom") {
        checkWeatherFlag = false;
        $('#custom-weather-sub')[0].style.display = "block";
        filePathPrefix = $('#custom-weather-sub').find('.active')[0].id;
        if (!coffeeBreakFlag) {
            await playRadio();
        }
    } else if (selected.id == "dynamic") {
        checkWeatherFlag = true;
        $('#custom-weather-sub')[0].style.display = "none";
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(async function (pos) {
                lat = pos.coords.latitude;
                lng = pos.coords.longitude;
                try {
                    if (!coffeeBreakFlag) {
                        await playRadio();
                    }
                } catch (error) {
                    console.error(error);
                    showModal();
                }
            });
        }
    }
}

async function customWeatherRequest(selected) {
    filePathPrefix = selected.id;
    if (!coffeeBreakFlag) {
        await playRadio();
    }
}

async function setGame(selected) {
    currentGame = selected.value;
    console.log(currentGame);
    if (!coffeeBreakFlag) {
        await playRadio();
    }
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

async function updateCurrentWeather() {
    const pointData = await (await fetch(`https://api.weather.gov/points/${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`)).json();
    console.log("Detected County Code: " + pointData.properties.county.substring(pointData.properties.county.lastIndexOf('/') + 1, pointData.properties.county.length));
    const forecastUrl = pointData.properties.forecastHourly
    const forecast = await (await fetch(forecastUrl)).json();
    const currentHour = forecast.properties.periods[0];
    const precipitation = determineWeather(currentHour);
    console.log("Interpreted Precipitaion: " + precipitation);
    filePathPrefix = precipitation;
}

async function shrinkModal() {
    $(".modal")[0].style.display = "none";
    const weatherOptions = $('#weather-options');
    const currentSelection = weatherOptions.find('.active');
    currentSelection.removeClass('active');

    const newSelection = weatherOptions.find('#none').parent();
    newSelection.addClass('active');

    filePathPrefix = 'Normal';
    if (!coffeeBreakFlag) {
        await playRadio();
    }
}

function showModal() {
    $(".modal")[0].style.display = "block";
}

function slideVolume(volume) {
    clearInterval(fadeInTimer);
    fadeInTimer = 0;
    maxVolume = volume.value / 100;
    const audio = $('#current-song')[0];
    if (audio) {
        audio.volume = maxVolume;
    }
}
