'use strict';

const intro = document.querySelector('#intro');
const video = document.querySelector('#intro-video');
const poster = document.querySelector('#poster');
const skipIntro = document.querySelector('#skip-intro');
const audioToggle = document.querySelector('#audio-toggle');
const audioIntro = new Audio('img/audio2.MP3');
const audioMain = new Audio('img/AUDIO1.MP3');
const audioOutro = new Audio('img/AUDIO3.MP3');
const audioMuted = localStorage.getItem('audio-muted') === 'true';
let activeAudio = audioIntro;
let audioStarted = false;
let audioBackgroundPaused = false;
let galleryVideoAudioOpen = false;
[audioIntro, audioMain, audioOutro].forEach((audio) => {
  audio.preload = 'auto';
  audio.volume = 0.35;
  audio.muted = audioMuted;
});
audioIntro.addEventListener('ended', () => playAudioTrack(audioMain));
audioMain.addEventListener('ended', () => playAudioTrack(audioOutro));
audioOutro.addEventListener('ended', () => playAudioTrack(audioIntro));
audioIntro.addEventListener('error', () => playAudioTrack(audioMain));
audioMain.addEventListener('error', () => playAudioTrack(audioOutro));
function startBackgroundAudio() {
  if (audioStarted) return;
  audioStarted = true;
  audioIntro.currentTime = 0;
  activeAudio = audioIntro;
  if (document.hidden || audioBackgroundPaused || galleryVideoAudioOpen) {
    audioBackgroundPaused = true;
    return;
  }
  const playback = activeAudio.play();
  if (playback) playback.then(() => {
    if (document.hidden || galleryVideoAudioOpen || audioBackgroundPaused) activeAudio.pause();
  }).catch(() => {});
}
function playAudioTrack(audio) {
  activeAudio = audio;
  if (document.hidden || audioBackgroundPaused || galleryVideoAudioOpen) {
    audioBackgroundPaused = true;
    return;
  }
  const playback = audio.play();
  if (playback) playback.then(() => {
    if (document.hidden || galleryVideoAudioOpen || audioBackgroundPaused) activeAudio.pause();
  }).catch(() => {});
}
function pauseBackgroundAudio() {
  if (!audioStarted) return;
  audioBackgroundPaused = true;
  [audioIntro, audioMain, audioOutro].forEach((audio) => audio.pause());
}
function resumeBackgroundAudio() {
  if (document.hidden || galleryVideoAudioOpen || !audioStarted || !audioBackgroundPaused) return;
  audioBackgroundPaused = false;
  const playback = activeAudio.play();
  if (playback) playback.then(() => {
    if (document.hidden || galleryVideoAudioOpen || audioBackgroundPaused) activeAudio.pause();
  }).catch(() => {});
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseBackgroundAudio();
  else resumeBackgroundAudio();
});
window.addEventListener('pagehide', pauseBackgroundAudio);
window.addEventListener('pageshow', resumeBackgroundAudio);
document.addEventListener('gallery-video-audio', (event) => {
  galleryVideoAudioOpen = event.detail.open;
  if (galleryVideoAudioOpen) pauseBackgroundAudio();
  else resumeBackgroundAudio();
});

function updateAudioToggle(muted) {
  audioToggle.classList.toggle('is-muted', muted);
  audioToggle.setAttribute('aria-pressed', String(muted));
  audioToggle.setAttribute('aria-label', muted ? 'Activar audio' : 'Silenciar audio');
}
audioToggle.addEventListener('click', () => {
  const muted = !audioIntro.muted;
  audioIntro.muted = muted;
  audioMain.muted = muted;
  audioOutro.muted = muted;
  localStorage.setItem('audio-muted', String(muted));
  updateAudioToggle(muted);
});
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const smallViewport = window.matchMedia('(max-width: 599px)');
const introFadeMs = 1400;
intro.style.setProperty('--intro-fade-duration', introFadeMs + 'ms');
let introFinished = false;
let introTimeout;

function showSkipIntro() {
  window.clearTimeout(introTimeout);
  skipIntro.hidden = false;
  skipIntro.classList.add('is-ready');
  skipIntro.focus({ preventScroll: true });
}

function finishIntro() {
  if (introFinished) return;
  introFinished = true;
  window.clearTimeout(introTimeout);

  let revealTimeout;
  let revealed = false;
  const revealPage = () => {
    if (revealed) return;
    revealed = true;
    window.clearTimeout(revealTimeout);
    intro.removeEventListener('transitionend', onFadeEnd);
    const restoreFocus = document.activeElement === skipIntro;
    intro.hidden = true;
    video.pause();
    startBackgroundAudio();
    audioToggle.hidden = false;
    updateAudioToggle(audioIntro.muted);
    poster.inert = false;
    // Only start the sequence once the video overlay has completely faded out.
    document.body.classList.remove('intro-playing');
    document.body.classList.add('page-revealed');
    if (restoreFocus) poster.focus({ preventScroll: true });
  };
  const onFadeEnd = (event) => {
    if (event.target === intro && event.propertyName === 'opacity') revealPage();
  };

  intro.addEventListener('transitionend', onFadeEnd);
  // Fallback if the browser does not dispatch the transition event.
  revealTimeout = window.setTimeout(revealPage, introFadeMs + 100);
  intro.classList.add('is-leaving');
}

if (reducedMotion.matches) {
  intro.hidden = false;
  poster.inert = true;
  document.body.classList.add('intro-playing');
  showSkipIntro();
} else {
  intro.hidden = false;
  poster.inert = true;
  document.body.classList.add('intro-playing');
  skipIntro.hidden = true;
  // Keep the final video frame visible until the visitor chooses to continue.
  video.addEventListener('ended', showSkipIntro, { once: true });
  video.addEventListener('error', showSkipIntro, { once: true });
  skipIntro.addEventListener('click', () => {
    startBackgroundAudio();
    finishIntro();
  });
  video.muted = true;
  video.defaultPlaybackRate = 1.5;
  video.playbackRate = 1.5;
  const playback = video.play();
  if (playback) playback.catch(showSkipIntro);
}

reducedMotion.addEventListener('change', (event) => {
  if (event.matches) showSkipIntro();
});

let vhsGlitchTimeout;
let vhsSignalTimeout;
function scheduleVhsGlitch() {
  if (reducedMotion.matches) return;
  const minDelay = smallViewport.matches ? 5000 : 3000;
  const maxDelay = smallViewport.matches ? 15000 : 12000;
  const delay = minDelay + Math.random() * (maxDelay - minDelay);
  vhsGlitchTimeout = window.setTimeout(() => {
    document.body.classList.add('vhs-glitch-active');
    window.setTimeout(() => {
      document.body.classList.remove('vhs-glitch-active');
      scheduleVhsGlitch();
    }, 70 + Math.random() * 70);
  }, delay);
}
scheduleVhsGlitch();

function scheduleVhsSignalClear() {
  if (reducedMotion.matches) return;
  const minDelay = smallViewport.matches ? 3500 : 2200;
  const maxDelay = smallViewport.matches ? 9000 : 7500;
  vhsSignalTimeout = window.setTimeout(() => {
    document.body.classList.add('vhs-signal-clear');
    window.setTimeout(() => {
      document.body.classList.remove('vhs-signal-clear');
      scheduleVhsSignalClear();
    }, 90 + Math.random() * 180);
  }, minDelay + Math.random() * (maxDelay - minDelay));
}
scheduleVhsSignalClear();
reducedMotion.addEventListener('change', (event) => {
  if (event.matches) {
    window.clearTimeout(vhsGlitchTimeout);
    window.clearTimeout(vhsSignalTimeout);
    document.body.classList.remove('vhs-glitch-active');
    document.body.classList.remove('vhs-signal-clear');
  } else {
    scheduleVhsGlitch();
    scheduleVhsSignalClear();
  }
});

const button = document.querySelector('#say-no');
const counter = document.querySelector('#counter');
const apiBase = 'https://mafia-tacna-api.acunanuncamas.workers.dev/api/counter';
const TEST_MODE = new URLSearchParams(window.location.search).get('test') === '1';
if (TEST_MODE) document.querySelector('#test-mode-badge').hidden = false;
let testCounterValue = null;
let alreadyVoted = false;
let isSubmitting = false;
let pressTimeout;
let buttonSequenceActive = false;
const buttonLabel = button.querySelector('span');
const defaultButtonLabel = buttonLabel.textContent;
const buttonTiming = Object.freeze({ fade: 200, typing: 1350, signal: 240, suspense: 2000 });

// One click listener: retain the physical press and coordinate only the visuals.
button.addEventListener('click', () => {
  window.clearTimeout(pressTimeout);
  button.classList.add('is-pressed');
  pressTimeout = window.setTimeout(() => button.classList.remove('is-pressed'), 240);
  runButtonSequence();
});

function waitForButtonPhase(duration, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Button sequence cancelled', 'AbortError'));
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException('Button sequence cancelled', 'AbortError'));
    };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, duration);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function typeRegistrationMessage(signal) {
  const message = 'REGISTRANDO TU RESPUESTA...';
  button.dataset.phase = 'registering';
  button.setAttribute('aria-label', 'Registrando tu respuesta');
  buttonLabel.textContent = '';
  if (reducedMotion.matches) {
    buttonLabel.textContent = message;
    await waitForButtonPhase(250, signal);
    return;
  }
  for (let length = 1; length <= message.length; length++) {
    buttonLabel.textContent = message.slice(0, length);
    await waitForButtonPhase(buttonTiming.typing / message.length, signal);
  }
}


function keepParticipationConfirmed() {
  button.classList.add('is-sequencing', 'is-confirmed');
  button.dataset.phase = 'confirmed';
  button.setAttribute('aria-busy', 'false');
  button.setAttribute('aria-label', 'Ya te sumaste');
  buttonLabel.textContent = 'YA TE SUMASTE ✓';
}

async function showAlreadyVotedMessage(signal, result) {
  // Hold the red registration state, then reveal the blue message and flip together.
  await waitForButtonPhase(buttonTiming.suspense, signal);
  button.dataset.phase = 'signal';
  button.classList.add('is-confirmed');
  button.setAttribute('aria-label', 'Ya te sumaste');
  buttonLabel.textContent = 'YA TE SUMASTE ✓';
  const signalPhase = waitForButtonPhase(
    reducedMotion.matches ? 0 : buttonTiming.signal, signal
  ).then(keepParticipationConfirmed);
  const counterPhase = result.animateCounter
    ? animateCounterTo(result.value)
    : Promise.resolve(false);
  const [, counterUpdated] = await Promise.all([signalPhase, counterPhase]);
  if (TEST_MODE && counterUpdated) testCounterValue = result.value;
}
async function runButtonSequence() {
  if (buttonSequenceActive || (!TEST_MODE && alreadyVoted && button.dataset.phase === 'confirmed')) return;
  if (TEST_MODE && button.dataset.phase === 'confirmed') {
    button.classList.remove('is-sequencing', 'is-confirmed');
    delete button.dataset.phase;
    button.removeAttribute('aria-busy');
    button.removeAttribute('aria-label');
    buttonLabel.textContent = defaultButtonLabel;
  }
  buttonSequenceActive = true;
  const controller = new AbortController();
  const originalAriaLabel = button.getAttribute('aria-label');
  button.classList.add('is-sequencing');
  button.dataset.phase = 'fading';
  button.setAttribute('aria-busy', 'true');
  // Start the request now, but reveal its counter value only at confirmation.
  const participation = submitParticipation().then((result) => {
    if (!result.confirmed) controller.abort();
    return result;
  });
  try {
    await waitForButtonPhase(reducedMotion.matches ? 0 : buttonTiming.fade, controller.signal);
    await typeRegistrationMessage(controller.signal);
    // Stay red until BOTH the typing and the authoritative result are ready.
    const result = await participation;
    if (result.confirmed) await showAlreadyVotedMessage(controller.signal, result);
  } catch (error) {
    if (error.name !== 'AbortError') console.error('Unable to animate participation:', error);
  } finally {
    controller.abort();
    // Only failures return to the original button; valid confirmations persist.
    if (button.dataset.phase !== 'confirmed') {
      buttonLabel.textContent = defaultButtonLabel;
      button.classList.remove('is-sequencing', 'is-confirmed');
      delete button.dataset.phase;
      button.removeAttribute('aria-busy');
      if (originalAriaLabel === null) button.removeAttribute('aria-label');
      else button.setAttribute('aria-label', originalAriaLabel);
    }
    buttonSequenceActive = false;
  }
}
function formatCounterValue(value) {
  // Reject empty values, booleans and malformed responses instead of showing zero.
  const isNumeric = typeof value === 'number' ||
    (typeof value === 'string' && /^\d+$/.test(value));
  const numericValue = isNumeric ? Number(value) : NaN;
  if (!Number.isSafeInteger(numericValue) || numericValue < 0 ||
      numericValue > 999999 || counter.querySelectorAll('span').length !== 6) {
    console.error('Invalid counter value or counter markup:', value);
    return null;
  }
  return String(numericValue).padStart(6, '0');
}

function updateCounter(value) {
  const formatted = formatCounterValue(value);
  if (formatted === null) return false;
  counter.querySelectorAll('span').forEach((cell, index) => {
    cell.textContent = formatted[index];
  });
  counter.dataset.value = formatted;
  counter.setAttribute('aria-label', `Contador con incrementos automáticos: ${formatted}`);
  return true;
}

async function animateCounterTo(value) {
  const formatted = formatCounterValue(value);
  if (formatted === null) return false;
  const previous = counter.dataset.value;
  if (reducedMotion.matches || !/^\d{6}$/.test(previous) ||
      Number(formatted) <= Number(previous)) return updateCounter(value);

  const cells = counter.querySelectorAll('span');
  let changed = 0;
  for (let index = 5; index >= 0; index--) {
    if (previous[index] === formatted[index]) continue;
    const cell = cells[index];
    cell.dataset.flipFrom = previous[index];
    cell.dataset.flipTo = formatted[index];
    cell.style.setProperty('--flip-delay', `${changed * 40}ms`);
    cell.classList.add('is-flipping');
    changed++;
  }
  await new Promise((resolve) => window.setTimeout(resolve, 460 + (changed - 1) * 40));
  cells.forEach((cell) => {
    cell.classList.remove('is-flipping');
    delete cell.dataset.flipFrom;
    delete cell.dataset.flipTo;
    cell.style.removeProperty('--flip-delay');
  });
  return updateCounter(value);
}

async function requestCounterApi(path = '', options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Counter API request failed: ${response.status}`);
    return await response.json();
  } finally {
    window.clearTimeout(timeout);
  }
}

async function loadCounterData() {
  // Independent requests: a status failure must not hide a valid counter response.
  const counterRequest = requestCounterApi()
    .then((data) => {
      if (updateCounter(data.value) && TEST_MODE) testCounterValue = Number(data.value);
    })
    .catch((error) => { console.error('Unable to load counter:', error); });
  const statusRequest = TEST_MODE ? Promise.resolve() : requestCounterApi('/status')
    .then((data) => {
      if (typeof data.alreadyVoted !== 'boolean') {
        throw new Error('Invalid participation status response');
      }
      alreadyVoted = alreadyVoted || data.alreadyVoted;
      if (alreadyVoted && !buttonSequenceActive) keepParticipationConfirmed();
    })
    .catch((error) => { console.error('Unable to load participation status:', error); });
  await Promise.all([counterRequest, statusRequest]);
}

async function submitParticipation() {
  if (TEST_MODE) {
    await initialCounterLoad;
    if (testCounterValue === null) {
      console.error('Unable to simulate participation: real counter is unavailable');
      return { confirmed: false };
    }
    const simulatedValue = testCounterValue + 1;
    if (formatCounterValue(simulatedValue) === null) return { confirmed: false };
    return { confirmed: true, value: simulatedValue, animateCounter: true };
  }
  if (alreadyVoted) return { confirmed: true, animateCounter: false };
  if (isSubmitting) return { confirmed: false };
  isSubmitting = true;
  try {
    // Wait for both initial reads, avoiding a late GET overwriting the POST result.
    await initialCounterLoad;
    if (alreadyVoted) return { confirmed: true, animateCounter: false };
    const data = await requestCounterApi('/increment', { method: 'POST' });
    if (data.success !== true && data.alreadyVoted !== true) {
      throw new Error('Participation was not accepted by the API');
    }
    if (formatCounterValue(data.value) === null) {
      throw new Error('Invalid participation counter response');
    }
    alreadyVoted = true;
    // Only a newly accepted vote reveals and animates the authoritative D1 value.
    return {
      confirmed: true,
      value: data.value,
      animateCounter: data.success === true
    };
  } catch (error) {
    console.error('Unable to submit participation:', error);
    return { confirmed: false };
  } finally {
    isSubmitting = false;
  }
}

const initialCounterLoad = loadCounterData();
