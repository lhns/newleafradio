var intervalNotSet = true;
var timer;
var fadeOutTimer;
var fadeInTimer;
var coffeeBreakFlag = true;
var checkWeatherFlag = false;
var lat = 0;
var lng = 0;
var filePathPrefix = "Normal";
var currentGame = "NewLeaf";
var maxVolume = 1;
var latency = 0;

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

    const audioCtx = new AudioContext();
    latency = audioCtx.outputLatency;
    console.log("Audio latency: " + latency + "s");

    console.log("playing song...");
    const audio = await playSong(now.getHours());

    timer = setTimeout(function () {
        if (!coffeeBreakFlag) {
            fadeOut(audio);
        }
    }, timeToElapse);
}

function stopRadio() {
    coffeeBreakFlag = true;
    clearInterval(fadeOutTimer);
    fadeOutTimer = null;
    clearInterval(fadeInTimer);
    fadeInTimer = null;
    clearTimeout(timer);

    const oldAudio = document.querySelector('audio');
    if (oldAudio) {
        oldAudio.abortController?.abort();
        oldAudio.remove();
    }
}

async function playSong(hour) {
    const prefix = filePathPrefix;
    const suffix = (hour >= 12) ? 'PM' : 'AM';
    hour = (hour > 12) ? hour - 12 : hour;
    hour = (hour == 0) ? 12 : hour;


    const oldAudio = document.querySelector('audio');
    if (oldAudio) {
        oldAudio.abortController?.abort();
        oldAudio.remove();
    }

    const audio = document.createElement('audio');
    audio.id = `current-song`

    const abortController = new AbortController();
    let ext = "mp3";
    if (currentGame === "WildWorld") {
        ext = "m4a";
    }
    const dirName = `${prefix}${currentGame}`;
    const fileName = `${hour}${suffix}.${ext}`
    console.log(`${dirName}/${fileName}`);

    setLoading(true);
    let src;
    //src = `https://cdn.glitch.me/a032b7da-b36c-4292-9322-7d4c98be233b%2F${dirName}_${fileName}`;
    if (window.location.href.startsWith("file:")) {
        src = `songs/${dirName}/${fileName}`;
    } else {
        const ipfsUrl = `ipfs://QmU8r6FoSr6YLaNCSn1yYVXoAcrEoM5pLNCYVqx8tCXFhA/${dirName}/${fileName}`;
        while (!src && !abortController.signal.aborted) {
            try {
                const response = await HeliaVerifiedFetch.verifiedFetch(ipfsUrl, {signal: abortController.signal});
                console.log(response);
                const blob = await response.blob();
                console.log("Loaded blob from IPFS");
                const blobUrl = URL.createObjectURL(blob);
                abortController.signal.addEventListener("abort", () => {
                    URL.revokeObjectURL(blobUrl);
                });
                src = blobUrl;
            } catch (error) {
                console.error(error);
                if (!abortController.signal.aborted) {
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        }
    }
    setLoading(false);

    audio.abortController = abortController;
    audio.src = src;
    audio.volume = 0;
    audio.loop = true;
    document.body.append(audio);

    audio.play();

    // synchronize the playback to the current second of hour
    let lastSync = 0;
    audio.addEventListener("playing", () => {
        const seconds = Date.now() / 1000;
        if (seconds - lastSync > 10) {
            const secondOfHour = (seconds - latency) % 3600;
            const secondOffset = secondOfHour % audio.duration;
            console.log("Second offset: " + secondOffset);
            lastSync = seconds;
            audio.currentTime = secondOffset;
        }
    });

    fadeIn(audio);
    return audio;
}

function fadeOut(audio) {
    console.log('swapping songs');
    if (!fadeOutTimer) {
        fadeOutTimer = setInterval(function () {
            if (!coffeeBreakFlag) {
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

function fadeIn(audio) {
    if (!fadeInTimer) {
        fadeInTimer = setInterval(function () {
            if (fadeOutTimer) {
                clearInterval(fadeInTimer);
                fadeInTimer = null;
            }
            if (!coffeeBreakFlag) {
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

function weatherChanged(selected) {
    if (selected.id == "none") {
        $('#custom-weather-sub')[0].style.display = "none";
        checkWeatherFlag = false;
        filePathPrefix = "Normal";
        if (!coffeeBreakFlag) {
            playRadio();
        }
    } else if (selected.id == "custom") {
        checkWeatherFlag = false;
        $('#custom-weather-sub')[0].style.display = "block";
        filePathPrefix = $('#custom-weather-sub').find('.active')[0].id;
        if (!coffeeBreakFlag) {
            playRadio();
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
                        playRadio();
                    }
                } catch {
                    showModal();
                }
            });
        }
    }
}

function customWeatherRequest(selected) {
    filePathPrefix = selected.id;
    if (!coffeeBreakFlag) {
        playRadio();
    }
}

function setGame(selected) {
    currentGame = selected.value;
    console.log(currentGame);
    if (!coffeeBreakFlag) {
        playRadio();
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

function shrinkModal() {
    $(".modal")[0].style.display = "none";
    const weatherOptions = $('#weather-options');
    const currentSelection = weatherOptions.find('.active');
    currentSelection.removeClass('active');

    const newSelection = weatherOptions.find('#none').parent();
    newSelection.addClass('active');

    filePathPrefix = 'Normal';
    if (!coffeeBreakFlag) {
        playRadio();
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
