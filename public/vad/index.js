import { float32ToWav, playAudioBuffer } from './utils.js';

const SAMPLE_RATE = 16000;

export async function startVad(onAudioBuffer, onStatus) {
	const stream = await navigator.mediaDevices.getUserMedia({
		audio: {
			channelCount: 1,
			echoCancellation: true,
			autoGainControl: true,
			noiseSuppression: true,
			sampleRate: SAMPLE_RATE,
		},
	});
	window.stream = stream; // make stream global

	// from https://github.com/ricky0123/vad
	const micVad = await vad.MicVAD.new({
		stream,
		model: 'v5',
		onSpeechStart: () => {
			onStatus('Listening...');
		},
		onSpeechEnd: (audio) => {
			onStatus('Transcribing...');
			const buff = float32ToWav(audio, SAMPLE_RATE);
			// playAudioBuffer(buff);
			onAudioBuffer(buff);
		},
	});
	micVad.start();
}
