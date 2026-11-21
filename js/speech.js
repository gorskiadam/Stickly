// speech.js — voice dictation through the browser's Web Speech API.
// Knows nothing about notes: it reports what it hears and the capture bar decides.

/** Stop listening after this long without hearing anything. */
const SILENCE_MS = 7000;

function recognitionClass() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

/** Can this browser dictate at all? (Firefox, for one, cannot.) */
export function speechSupported() {
  return Boolean(recognitionClass());
}

/**
 * @param {object} handlers
 * @param {() => string} handlers.getLocale       e.g. 'en-US' or 'pl-PL'
 * @param {(text: string) => void} handlers.onInterim  words heard so far (may still change)
 * @param {(text: string) => void} handlers.onFinal    a finished phrase
 * @param {(listening: boolean) => void} handlers.onChange
 * @param {(kind: 'denied' | 'network' | 'no-mic' | 'failed') => void} handlers.onError
 * @returns {{ toggle: () => void, stop: () => void }}
 */
export function createDictation({ getLocale, onInterim, onFinal, onChange, onError }) {
  let recognition = null;
  let silenceTimer = 0;

  function start() {
    const Recognition = recognitionClass();
    if (!Recognition || recognition) return;

    const r = new Recognition();
    r.lang = getLocale();
    r.interimResults = true;
    r.maxAlternatives = 1;
    // One phrase per tap: say the task, and listening stops by itself when you
    // pause. (This is also the mode that behaves the same in every browser.)
    r.continuous = false;

    r.onresult = onResult;
    r.onerror = (event) => {
      const kind = errorKind(event.error);
      if (kind) onError(kind);
    };
    r.onend = () => {
      if (recognition !== r) return;
      recognition = null;
      clearTimeout(silenceTimer);
      onInterim('');
      onChange(false);
    };

    recognition = r;
    try {
      r.start();
    } catch {
      recognition = null;
      onError('failed');
      return;
    }
    onChange(true);
    restartSilenceTimer();
  }

  function onResult(event) {
    restartSilenceTimer();
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) onFinal(result[0].transcript);
      else interim += result[0].transcript;
    }
    onInterim(interim.trim());
  }

  function restartSilenceTimer() {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(stop, SILENCE_MS);
  }

  function stop() {
    if (recognition) recognition.stop(); // onend does the cleanup
  }

  return {
    toggle: () => (recognition ? stop() : start()),
    stop,
  };
}

/** Sort the API's error codes into what the user needs to know (or nothing). */
function errorKind(code) {
  if (code === 'not-allowed' || code === 'service-not-allowed') return 'denied';
  if (code === 'network') return 'network';       // Chrome sends speech to a server
  if (code === 'audio-capture') return 'no-mic';
  if (code === 'no-speech' || code === 'aborted') return null; // silence is not an error
  return 'failed';
}
