import Vosk from 'https://cdn.jsdelivr.net/npm/vosk-browser@0.0.8/+esm';
import microphoneStream from 'https://cdn.jsdelivr.net/npm/microphone-stream@6.0.1/+esm';

const MicrophoneStream = microphoneStream.default;
const modelUrl = 'https://pub-4d12ee46898f4250ae956c0f184f3018.r2.dev/vosk-model-small-en-us-0.15.tar.gz';

class AudioStreamer {
	constructor(recognizer, options = {}) {
		this.recognizer = recognizer;
		this.options = { objectMode: true, ...options };
	}
	write(chunk) {
		if (!this.recognizer || !chunk) return;
		const buffer = chunk.getChannelData(0);
		if (buffer.byteLength > 0) {
			try {
				this.recognizer.acceptWaveform(chunk);
			} catch (error) {
				console.error('AudioStreamer: Error accepting waveform', error);
			}
		}
	}
}

export async function vosk(onTranscription, onStatus) {
	onStatus('loading model');

	const model = await Vosk.createModel(modelUrl);
	const recognizer = new model.KaldiRecognizer(48000);

	recognizer.on('result', (message) => {
		if (message.result.text) onTranscription(message.result.text);
	});

	// recognizer.on('partialresult', (message) => {
	// 	console.log('Vosk Partial:', message.result.partial);
	// });

	const currentRecognizer = recognizer;
	const audioStreamerInstance = new AudioStreamer(currentRecognizer);

	onStatus('model loaded');
	const mediaStream = await navigator.mediaDevices.getUserMedia({
		video: false,
		audio: {
			echoCancellation: true,
			noiseSuppression: true,
		},
	});

	const micStream = new MicrophoneStream({
		objectMode: true, // Important for getting AudioBuffer chunks
		bufferSize: 1024, // Or as recommended/needed
	});

	micStream.setStream(mediaStream);

	micStream.on('data', (chunk) => {
		audioStreamerInstance.write(chunk);
	});
	onStatus('mic ready');
}
