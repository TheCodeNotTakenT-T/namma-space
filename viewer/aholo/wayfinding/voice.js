/**
 * Voice: spoken directions and spoken search, using what the browser already has.
 *
 * Speaking uses the Web Speech synthesis API (works offline in most browsers). Listening uses the Web
 * Speech recognition API where it exists (Chrome, Edge, Safari); elsewhere the microphone button is hidden.
 * Nothing is recorded or sent by this code; the browser's own recogniser may use an online service.
 */

const STORAGE_KEY = 'namma:voice:v1';

export function createVoice() {
  const synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
  const Recognition = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
  let enabled = true, recognition = null, lastSpoken = '';
  try { enabled = localStorage.getItem(STORAGE_KEY) !== 'off'; } catch { /* private window: keep the default */ }

  /** An English voice if the system has one; the default voice otherwise. */
  function pickVoice() {
    const voices = synth?.getVoices() ?? [];
    return voices.find(voice => /^en[-_]IN/i.test(voice.lang)) ?? voices.find(voice => /^en/i.test(voice.lang)) ?? null;
  }

  return {
    canSpeak: Boolean(synth),
    canListen: Boolean(Recognition),
    enabled: () => enabled,
    setEnabled(on) {
      enabled = on;
      if (!on) synth?.cancel();
      try { localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off'); } catch { /* private window */ }
    },
    /** Say something. By default a new sentence replaces one still being spoken, so directions never pile up. */
    say(text, { force = false, interrupt = true } = {}) {
      lastSpoken = text;
      if (!synth || (!enabled && !force) || !text) return false;
      try {
        if (interrupt) synth.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        const voice = pickVoice();
        if (voice) utterance.voice = voice;
        utterance.rate = 1.02; utterance.pitch = 1;
        synth.speak(utterance);
        return true;
      } catch { return false; }
    },
    /** The last sentence handed to `say`, spoken or not (for tests and for captions). */
    last: () => lastSpoken,
    /**
     * Listen for one phrase. `onText(text, final)` is called as words arrive; `onEnd(error)` when it stops.
     * Returns a function that stops listening.
     */
    listen(onText, onEnd) {
      if (!Recognition) { onEnd?.('Voice search is not available in this browser.'); return () => {}; }
      recognition?.abort();
      recognition = new Recognition();
      recognition.lang = 'en-IN'; recognition.interimResults = true; recognition.maxAlternatives = 1;
      let finished = false;
      recognition.onresult = event => {
        const result = event.results[event.results.length - 1];
        onText(result[0].transcript.trim(), result.isFinal);
      };
      recognition.onerror = event => {
        finished = true;
        onEnd?.(event.error === 'not-allowed' ? 'Allow the microphone to search by voice.' : event.error === 'no-speech' ? 'I did not hear anything.' : 'Voice search stopped.');
      };
      recognition.onend = () => { if (!finished) onEnd?.(null); };
      try { recognition.start(); } catch { onEnd?.('Voice search could not start.'); }
      return () => recognition?.abort();
    },
  };
}
