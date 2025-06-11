export function playAudioBuffer(buff) {
	const blob = new Blob([buff], { type: 'audio/wav' });
	const url = window.URL.createObjectURL(blob);
	const audio = new Audio();
	audio.src = url;
	audio.play();
}

function writeString(view, offset, string) {
	for (let i = 0; i < string.length; i++) {
		view.setUint8(offset + i, string.charCodeAt(i));
	}
}
function floatTo16BitPCM(view, offset, input) {
	for (let i = 0; i < input.length; i++, offset += 2) {
		const s = Math.max(-1, Math.min(1, input[i]));
		view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
	}
}

export function float32ToWav(samples, sampleRate = 16000) {
	const buffer = new ArrayBuffer(44 + samples.length * 2);
	const view = new DataView(buffer);

	// WAV header
	writeString(view, 0, 'RIFF');
	view.setUint32(4, 36 + samples.length * 2, true);
	writeString(view, 8, 'WAVE');

	// "fmt " sub-chunk
	writeString(view, 12, 'fmt ');
	view.setUint32(16, 16, true); // fmt chunk size
	view.setUint16(20, 1, true); // audio format (1 = PCM)
	view.setUint16(22, 1, true); // number of channels
	view.setUint32(24, sampleRate, true); // sample rate
	view.setUint32(28, sampleRate * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample

	// "data" sub-chunk
	writeString(view, 36, 'data');
	view.setUint32(40, samples.length * 2, true);

	// Write audio data
	floatTo16BitPCM(view, 44, samples);

	return buffer;
}
