import arraybufferToAudiobuffer from 'https://cdn.jsdelivr.net/npm/arraybuffer-to-audiobuffer@0.0.5/+esm';

export function base64ToArrBuff(base64Str) {
	return Uint8Array.from(atob(base64Str), (c) => c.charCodeAt(0)).buffer;
}

const sounds = [];
let timeOutId = null;
let isSpeaking = false;
const playingSources = [];
const audioCtx = new AudioContext();
// handles playing audio queue
// implemented as functions because class implementation gets cleaned
// prematurely
export function queueSound(sound, setStatus) {
	sounds.push(sound);
	playNext(setStatus);
}

export function stopPlaying() {
	playingSources.forEach((source) => {
		try {
			source.stop();
		} catch (e) {
			console.error('Error stopping source:', e);
		}
		sounds.splice(0, sounds.length);
		if (timeOutId) clearTimeout(timeOutId);
	});
}

function playNext(setStatus) {
	if (!isSpeaking && sounds?.length > 0) {
		isSpeaking = true;
		setStatus('AI Speaking...');
		const arrayBuff = base64ToArrBuff(sounds.shift());
		arraybufferToAudiobuffer(arrayBuff, audioCtx).then((audioBuffer) => {
			const source = audioCtx.createBufferSource();
			source.buffer = audioBuffer;
			source.connect(audioCtx.destination);
			source.start();
			playingSources.push(source);
			source.onended = () => {
				isSpeaking = false;
				setStatus('Listening...');
			};
		});
	} else {
		timeOutId = setTimeout(() => playNext(setStatus), 1000);
	}
}
