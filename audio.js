// Web Audio API procedural sound synthesizer
class SoundManager {
    constructor() {
        this.ctx = null;
        this.enabled = true;
    }

    init() {
        if (!this.ctx) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (AudioContext) {
                this.ctx = new AudioContext();
            }
        }
        if (this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
    }

    playStep() {
        if (!this.enabled || !this.ctx) return;
        try {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            const now = this.ctx.currentTime;

            osc.type = 'triangle';
            osc.frequency.setValueAtTime(110 + Math.random() * 30, now);
            osc.frequency.exponentialRampToValueAtTime(40, now + 0.08);

            gain.gain.setValueAtTime(0.06, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

            osc.connect(gain);
            gain.connect(this.ctx.destination);

            osc.start(now);
            osc.stop(now + 0.08);
        } catch (e) {}
    }

    playLetterCollect(letter) {
        if (!this.enabled || !this.ctx) return;
        try {
            const now = this.ctx.currentTime;
            const chords = {
                'A': [440, 554.37, 659.25], // A major
                'C': [523.25, 659.25, 783.99], // C major
                'M': [659.25, 830.61, 987.77], // E major high
                'N': [587.33, 739.99, 880.00]  // D major high
            };
            const freqs = chords[letter] || [523.25, 659.25, 783.99];

            freqs.forEach((freq, idx) => {
                const osc = this.ctx.createOscillator();
                const gain = this.ctx.createGain();
                const delay = idx * 0.07;

                osc.type = 'sine';
                osc.frequency.setValueAtTime(freq, now + delay);
                osc.frequency.exponentialRampToValueAtTime(freq * 1.5, now + delay + 0.35);

                gain.gain.setValueAtTime(0, now + delay);
                gain.gain.linearRampToValueAtTime(0.18, now + delay + 0.05);
                gain.gain.exponentialRampToValueAtTime(0.001, now + delay + 0.4);

                osc.connect(gain);
                gain.connect(this.ctx.destination);

                osc.start(now + delay);
                osc.stop(now + delay + 0.45);
            });
        } catch (e) {}
    }

    playBump() {
        if (!this.enabled || !this.ctx) return;
        try {
            const now = this.ctx.currentTime;
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();

            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(90, now);
            osc.frequency.exponentialRampToValueAtTime(30, now + 0.1);

            gain.gain.setValueAtTime(0.08, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);

            osc.connect(gain);
            gain.connect(this.ctx.destination);

            osc.start(now);
            osc.stop(now + 0.1);
        } catch (e) {}
    }

    playVictory() {
        if (!this.enabled || !this.ctx) return;
        try {
            const now = this.ctx.currentTime;
            const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
            notes.forEach((freq, idx) => {
                const osc = this.ctx.createOscillator();
                const gain = this.ctx.createGain();
                const start = now + idx * 0.12;

                osc.type = 'triangle';
                osc.frequency.setValueAtTime(freq, start);

                gain.gain.setValueAtTime(0, start);
                gain.gain.linearRampToValueAtTime(0.2, start + 0.05);
                gain.gain.exponentialRampToValueAtTime(0.001, start + 0.6);

                osc.connect(gain);
                gain.connect(this.ctx.destination);

                osc.start(start);
                osc.stop(start + 0.65);
            });
        } catch (e) {}
    }

    playCountdownBeep(isFinal = false) {
        if (!this.enabled || !this.ctx) return;
        try {
            const now = this.ctx.currentTime;
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();

            osc.type = isFinal ? 'triangle' : 'sine';
            osc.frequency.setValueAtTime(isFinal ? 880 : 440, now);

            gain.gain.setValueAtTime(0, now);
            gain.gain.linearRampToValueAtTime(0.2, now + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, now + (isFinal ? 0.35 : 0.18));

            osc.connect(gain);
            gain.connect(this.ctx.destination);

            osc.start(now);
            osc.stop(now + (isFinal ? 0.4 : 0.2));
        } catch (e) {}
    }
}
